package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/langpulse/collector/internal/cleanup"
	"github.com/langpulse/collector/quality"
)

const defaultClientUserAgent = "langpulse-collector"

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

type Option func(*Client)

type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

type runRecordPayload struct {
	RunID          string `json:"run_id"`
	AttemptNo      int    `json:"attempt_no"`
	Status         string `json:"status"`
	ObservedAt     string `json:"observed_at"`
	LeaseExpiresAt string `json:"lease_expires_at"`
}

type runPayload struct {
	Run runRecordPayload `json:"run"`
}

type finalizePayload struct {
	Run         runRecordPayload `json:"run"`
	PublishedAt *string          `json:"published_at"`
}

type errorPayload struct {
	Error *errorDetailPayload `json:"error"`
}

type errorDetailPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type legacyErrorPayload struct {
	Code    string `json:"code"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

func NewClient(baseURL string, token string, options ...Option) (*Client, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, errors.New("ingest base URL is required")
	}

	if strings.TrimSpace(token) == "" {
		return nil, errors.New("ingest token is required")
	}

	client := &Client{
		baseURL:    strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:      strings.TrimSpace(token),
		httpClient: http.DefaultClient,
	}

	for _, option := range options {
		option(client)
	}

	return client, nil
}

func WithHTTPClient(httpClient *http.Client) Option {
	return func(client *Client) {
		if httpClient != nil {
			client.httpClient = httpClient
		}
	}
}

func (c *Client) CreateRun(ctx context.Context, request quality.CreateRunRequest) (created quality.CreatedRun, err error) {
	response, err := c.sendJSON(ctx, http.MethodPost, "/internal/quality-runs", map[string]any{
		"observed_date": request.ObservedDate.String(),
		"expected_rows": request.ExpectedRows,
	})
	if err != nil {
		return quality.CreatedRun{}, err
	}
	defer func() {
		err = cleanup.Join(err, "close create run response body", response.Body.Close)
	}()

	var payload runPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return quality.CreatedRun{}, fmt.Errorf("decode create run response: %w", err)
	}

	observedAt, err := time.Parse(time.RFC3339, payload.Run.ObservedAt)
	if err != nil {
		return quality.CreatedRun{}, fmt.Errorf("parse create run observed_at: %w", err)
	}

	leaseExpiresAt, err := time.Parse(time.RFC3339, payload.Run.LeaseExpiresAt)
	if err != nil {
		return quality.CreatedRun{}, fmt.Errorf("parse create run lease_expires_at: %w", err)
	}

	created = quality.CreatedRun{
		RunID:          payload.Run.RunID,
		AttemptNo:      payload.Run.AttemptNo,
		ObservedAt:     observedAt.UTC(),
		LeaseExpiresAt: leaseExpiresAt.UTC(),
	}

	return created, nil
}

func (c *Client) HeartbeatRun(ctx context.Context, runID string) (heartbeat quality.HeartbeatResult, err error) {
	response, err := c.sendJSON(ctx, http.MethodPost, "/internal/quality-runs/"+url.PathEscape(runID)+"/heartbeat", map[string]any{})
	if err != nil {
		return quality.HeartbeatResult{}, err
	}
	defer func() {
		err = cleanup.Join(err, "close heartbeat response body", response.Body.Close)
	}()

	var payload runPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return quality.HeartbeatResult{}, fmt.Errorf("decode heartbeat response: %w", err)
	}

	leaseExpiresAt, err := time.Parse(time.RFC3339, payload.Run.LeaseExpiresAt)
	if err != nil {
		return quality.HeartbeatResult{}, fmt.Errorf("parse heartbeat lease_expires_at: %w", err)
	}

	heartbeat = quality.HeartbeatResult{
		LeaseExpiresAt: leaseExpiresAt.UTC(),
	}

	return heartbeat, nil
}

func (c *Client) UpsertRow(ctx context.Context, row quality.RowUpsert) (err error) {
	path := strings.Join([]string{
		"/internal/quality-runs",
		url.PathEscape(row.RunID),
		"rows",
		url.PathEscape(row.LanguageID),
		strconv.Itoa(row.ThresholdValue),
	}, "/")

	response, err := c.sendJSON(ctx, http.MethodPut, path, map[string]any{
		"count":        row.Count,
		"collected_at": row.CollectedAt.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	defer func() {
		err = cleanup.Join(err, "close upsert row response body", response.Body.Close)
	}()

	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		return fmt.Errorf("drain upsert row response: %w", err)
	}

	return nil
}

func (c *Client) FinalizeRun(ctx context.Context, request quality.FinalizeRequest) (finalized quality.FinalizeResult, err error) {
	payload := map[string]any{
		"status": request.Status,
	}
	if request.ErrorSummary != "" {
		payload["error_summary"] = request.ErrorSummary
	}

	response, err := c.sendJSON(ctx, http.MethodPost, "/internal/quality-runs/"+url.PathEscape(request.RunID)+"/finalize", payload)
	if err != nil {
		return quality.FinalizeResult{}, err
	}
	defer func() {
		err = cleanup.Join(err, "close finalize response body", response.Body.Close)
	}()

	var decoded finalizePayload
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return quality.FinalizeResult{}, fmt.Errorf("decode finalize response: %w", err)
	}

	status, err := parseFinalizeStatus(decoded.Run.Status)
	if err != nil {
		return quality.FinalizeResult{}, err
	}

	var publishedAt *time.Time
	if decoded.PublishedAt != nil {
		parsed, err := time.Parse(time.RFC3339, *decoded.PublishedAt)
		if err != nil {
			return quality.FinalizeResult{}, fmt.Errorf("parse finalize published_at: %w", err)
		}

		parsedUTC := parsed.UTC()
		publishedAt = &parsedUTC
	}

	finalized = quality.FinalizeResult{
		Status:      status,
		PublishedAt: publishedAt,
	}

	return finalized, nil
}

func (c *Client) sendJSON(ctx context.Context, method string, path string, payload any) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode request body: %w", err)
	}

	endpoint := c.baseURL + path
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build ingest request: %w", err)
	}

	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", defaultClientUserAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("execute ingest request: %w", err)
	}

	if response.StatusCode >= http.StatusBadRequest {
		return nil, cleanup.Join(decodeAPIError(response), "close ingest error response body", response.Body.Close)
	}

	return response, nil
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("ingest request failed with status %d (%s): %s", e.StatusCode, e.Code, e.Message)
	}

	return fmt.Sprintf("ingest request failed with status %d: %s", e.StatusCode, e.Message)
}

func decodeAPIError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8*1024))

	var payload errorPayload
	if err := json.Unmarshal(body, &payload); err == nil && payload.Error != nil {
		message := strings.TrimSpace(payload.Error.Message)
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}

		return &APIError{
			StatusCode: response.StatusCode,
			Code:       strings.TrimSpace(payload.Error.Code),
			Message:    message,
		}
	}

	var legacyPayload legacyErrorPayload
	if err := json.Unmarshal(body, &legacyPayload); err != nil {
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}

		return &APIError{
			StatusCode: response.StatusCode,
			Message:    message,
		}
	}

	message := strings.TrimSpace(legacyPayload.Error)
	if message == "" {
		message = strings.TrimSpace(legacyPayload.Message)
	}
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}

	return &APIError{
		StatusCode: response.StatusCode,
		Code:       strings.TrimSpace(legacyPayload.Code),
		Message:    message,
	}
}

func parseFinalizeStatus(raw string) (quality.FinalStatus, error) {
	status := quality.FinalStatus(strings.TrimSpace(raw))
	switch status {
	case quality.FinalStatusComplete, quality.FinalStatusFailed:
		return status, nil
	default:
		return "", fmt.Errorf("parse finalize status: unexpected status %q", raw)
	}
}
