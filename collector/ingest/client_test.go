package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/langpulse/collector/quality"
)

func TestNewClientRequiresCredentials(t *testing.T) {
	if _, err := NewClient("", "token"); err == nil {
		t.Fatal("NewClient() error = nil, want missing base URL error")
	}

	if _, err := NewClient("https://example.com", ""); err == nil {
		t.Fatal("NewClient() error = nil, want missing token error")
	}
}

func TestClientRoundTripsLifecycleRequests(t *testing.T) {
	now := time.Date(2026, 4, 7, 9, 0, 0, 0, time.UTC)
	publishedAt := now.Add(3 * time.Minute).Format(time.RFC3339)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("Authorization = %q, want %q", got, "Bearer secret")
		}

		switch request.URL.EscapedPath() {
		case "/internal/quality-runs":
			payload := mustDecodeJSONMap(t, request.Body, "create")

			if payload["observed_date"] != "2026-04-07" || int(payload["expected_rows"].(float64)) != 2 {
				t.Fatalf("create payload = %#v, want observed_date and expected_rows", payload)
			}

			mustEncodeJSONMap(t, writer, map[string]any{
				"run": map[string]any{
					"run_id":           "run/1",
					"attempt_no":       2,
					"status":           "running",
					"observed_at":      now.Format(time.RFC3339),
					"lease_expires_at": now.Add(10 * time.Minute).Format(time.RFC3339),
				},
			}, "create")

		case "/internal/quality-runs/run%2F1/heartbeat":
			if request.Method != http.MethodPost {
				t.Fatalf("heartbeat method = %s, want POST", request.Method)
			}

			mustEncodeJSONMap(t, writer, map[string]any{
				"run": map[string]any{
					"run_id":           "run/1",
					"attempt_no":       2,
					"status":           "running",
					"observed_at":      now.Format(time.RFC3339),
					"lease_expires_at": now.Add(20 * time.Minute).Format(time.RFC3339),
				},
			}, "heartbeat")

		case "/internal/quality-runs/run%2F1/rows:batch":
			if request.Method != http.MethodPost {
				t.Fatalf("batch method = %s, want POST", request.Method)
			}

			payload := mustDecodeJSONMap(t, request.Body, "rows:batch")

			rows, ok := payload["rows"].([]any)
			if !ok || len(rows) != 1 {
				t.Fatalf("rows payload = %#v, want one row", payload["rows"])
			}

			row := rows[0].(map[string]any)
			if row["language_id"] != "go/lang" || int(row["threshold_value"].(float64)) != 10 {
				t.Fatalf("row identifier = %#v, want language=go/lang threshold=10", row)
			}
			if int(row["count"].(float64)) != 55 || row["collected_at"] == "" {
				t.Fatalf("row payload = %#v, want count and collected_at", row)
			}

			mustEncodeJSONMap(t, writer, map[string]any{
				"run": map[string]any{
					"run_id":           "run/1",
					"attempt_no":       2,
					"status":           "running",
					"observed_at":      now.Format(time.RFC3339),
					"lease_expires_at": now.Add(20 * time.Minute).Format(time.RFC3339),
					"actual_rows":      1,
				},
			}, "rows:batch")

		case "/internal/quality-runs/run%2F1/finalize":
			payload := mustDecodeJSONMap(t, request.Body, "finalize")

			if payload["status"] != string(quality.FinalStatusComplete) {
				t.Fatalf("finalize payload = %#v, want complete status", payload)
			}

			mustEncodeJSONMap(t, writer, map[string]any{
				"run": map[string]any{
					"run_id":           "run/1",
					"attempt_no":       2,
					"status":           quality.FinalStatusComplete,
					"observed_at":      now.Format(time.RFC3339),
					"lease_expires_at": now.Add(20 * time.Minute).Format(time.RFC3339),
				},
				"published_at": publishedAt,
			}, "finalize")

		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	createdRun, err := client.CreateRun(context.Background(), quality.CreateRunRequest{
		ObservedDate: mustDay(t, "2026-04-07"),
		ExpectedRows: 2,
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}

	if createdRun.RunID != "run/1" || createdRun.AttemptNo != 2 {
		t.Fatalf("CreateRun() = %#v, want run_id and attempt_no", createdRun)
	}

	heartbeat, err := client.HeartbeatRun(context.Background(), createdRun.RunID)
	if err != nil {
		t.Fatalf("HeartbeatRun() error = %v", err)
	}

	if !heartbeat.LeaseExpiresAt.After(createdRun.LeaseExpiresAt) {
		t.Fatalf("HeartbeatRun() lease = %v, want later than %v", heartbeat.LeaseExpiresAt, createdRun.LeaseExpiresAt)
	}

	if err := client.UpsertRows(context.Background(), []quality.RowUpsert{{
		RunID:          createdRun.RunID,
		LanguageID:     "go/lang",
		ThresholdValue: 10,
		Count:          55,
		CollectedAt:    now,
	}}); err != nil {
		t.Fatalf("UpsertRows() error = %v", err)
	}

	finalized, err := client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:  createdRun.RunID,
		Status: quality.FinalStatusComplete,
	})
	if err != nil {
		t.Fatalf("FinalizeRun() error = %v", err)
	}

	if finalized.PublishedAt == nil || finalized.Status != quality.FinalStatusComplete {
		t.Fatalf("FinalizeRun() = %#v, want published_at and complete status", finalized)
	}
}

func TestClientReturnsStructuredAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"error":{"code":"publication_exists","message":"already published"}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CreateRun(context.Background(), quality.CreateRunRequest{
		ObservedDate: mustDay(t, "2026-04-07"),
		ExpectedRows: 1,
	})
	if err == nil {
		t.Fatal("CreateRun() error = nil, want API error")
	}

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("CreateRun() error = %T, want *APIError", err)
	}

	if apiErr.StatusCode != http.StatusConflict || apiErr.Code != "publication_exists" || !strings.Contains(apiErr.Message, "already published") {
		t.Fatalf("APIError = %#v, want structured conflict error", apiErr)
	}
}

func TestAPIErrorFormattingAndFallbackParsing(t *testing.T) {
	if got := (&APIError{StatusCode: http.StatusBadRequest, Message: "broken"}).Error(); got != "ingest request failed with status 400: broken" {
		t.Fatalf("APIError.Error() = %q, want plain formatting", got)
	}

	if got := (&APIError{StatusCode: http.StatusConflict, Code: "publication_exists", Message: "already published"}).Error(); got != "ingest request failed with status 409 (publication_exists): already published" {
		t.Fatalf("APIError.Error() = %q, want coded formatting", got)
	}

	response := &http.Response{
		StatusCode: http.StatusConflict,
		Body:       io.NopCloser(strings.NewReader(`{"error":{"code":"publication_exists","message":"already published"}}`)),
	}
	err := decodeAPIError(response)

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("decodeAPIError() error = %T, want *APIError", err)
	}

	if apiErr.StatusCode != http.StatusConflict || apiErr.Code != "publication_exists" || apiErr.Message != "already published" {
		t.Fatalf("APIError = %#v, want nested worker envelope parsing", apiErr)
	}

	response = &http.Response{
		StatusCode: http.StatusBadGateway,
		Body:       io.NopCloser(strings.NewReader("gateway down")),
	}
	err = decodeAPIError(response)

	if !errors.As(err, &apiErr) {
		t.Fatalf("decodeAPIError() error = %T, want *APIError", err)
	}

	if apiErr.StatusCode != http.StatusBadGateway || apiErr.Message != "gateway down" {
		t.Fatalf("APIError = %#v, want plain-text fallback", apiErr)
	}
}

func TestDecodeAPIErrorStatusTextFallbacks(t *testing.T) {
	testCases := []struct {
		name       string
		statusCode int
		body       string
		wantCode   string
		wantMsg    string
	}{
		{
			name:       "nested envelope falls back to status text when message is blank",
			statusCode: http.StatusConflict,
			body:       `{"error":{"code":"publication_exists","message":" "}}`,
			wantCode:   "publication_exists",
			wantMsg:    http.StatusText(http.StatusConflict),
		},
		{
			name:       "invalid payload falls back to status text when body is empty",
			statusCode: http.StatusServiceUnavailable,
			body:       "",
			wantMsg:    http.StatusText(http.StatusServiceUnavailable),
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			err := decodeAPIError(&http.Response{
				StatusCode: testCase.statusCode,
				Body:       io.NopCloser(strings.NewReader(testCase.body)),
			})

			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("decodeAPIError() error = %T, want *APIError", err)
			}

			if apiErr.StatusCode != testCase.statusCode || apiErr.Code != testCase.wantCode || apiErr.Message != testCase.wantMsg {
				t.Fatalf("APIError = %#v, want status=%d code=%q message=%q", apiErr, testCase.statusCode, testCase.wantCode, testCase.wantMsg)
			}
		})
	}
}

func TestCreateRunAndFinalizeRejectMalformedTimestamps(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/quality-runs":
			_, _ = writer.Write([]byte(`{"run":{"run_id":"run-1","attempt_no":1,"status":"running","observed_at":"invalid","lease_expires_at":"2026-04-07T10:00:00Z"}}`))
		case "/internal/quality-runs/run-1/finalize":
			_, _ = writer.Write([]byte(`{"run":{"run_id":"run-1","status":"complete"},"published_at":"invalid"}`))
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CreateRun(context.Background(), quality.CreateRunRequest{
		ObservedDate: mustDay(t, "2026-04-07"),
		ExpectedRows: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "parse create run observed_at") {
		t.Fatalf("CreateRun() error = %v, want observed_at parse error", err)
	}

	_, err = client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:  "run-1",
		Status: quality.FinalStatusComplete,
	})
	if err == nil || !strings.Contains(err.Error(), "parse finalize published_at") {
		t.Fatalf("FinalizeRun() error = %v, want published_at parse error", err)
	}
}

func TestCreateRunAndHeartbeatDecodeErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/quality-runs":
			_, _ = writer.Write([]byte(`{"run":{"run_id":"run-1","attempt_no":1,"status":"running","observed_at":"2026-04-07T10:00:00Z","lease_expires_at":"invalid"}}`))
		case "/internal/quality-runs/run-1/heartbeat":
			_, _ = writer.Write([]byte(`not-json`))
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CreateRun(context.Background(), quality.CreateRunRequest{
		ObservedDate: mustDay(t, "2026-04-07"),
		ExpectedRows: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "parse create run lease_expires_at") {
		t.Fatalf("CreateRun() error = %v, want lease_expires_at parse error", err)
	}

	_, err = client.HeartbeatRun(context.Background(), "run-1")
	if err == nil || !strings.Contains(err.Error(), "decode heartbeat response") {
		t.Fatalf("HeartbeatRun() error = %v, want decode error", err)
	}
}

func TestCreateRunDecodeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/quality-runs" {
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
		_, _ = writer.Write([]byte(`not-json`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CreateRun(context.Background(), quality.CreateRunRequest{
		ObservedDate: mustDay(t, "2026-04-07"),
		ExpectedRows: 1,
	})
	if err == nil || !strings.Contains(err.Error(), "decode create run response") {
		t.Fatalf("CreateRun() error = %v, want decode error", err)
	}
}

func TestFinalizeRunDecodeAndRequestBuildErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`not-json`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:  "run-1",
		Status: quality.FinalStatusComplete,
	})
	if err == nil || !strings.Contains(err.Error(), "decode finalize response") {
		t.Fatalf("FinalizeRun() error = %v, want decode error", err)
	}

	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`{"run":{"run_id":"run-1","status":"running"}}`))
	}))
	defer server.Close()

	client, err = NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:  "run-1",
		Status: quality.FinalStatusComplete,
	})
	if err == nil || !strings.Contains(err.Error(), "parse finalize status") {
		t.Fatalf("FinalizeRun() error = %v, want finalize status error", err)
	}

	client, err = NewClient("://bad-url", "secret")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:  "run-1",
		Status: quality.FinalStatusComplete,
	})
	if err == nil || !strings.Contains(err.Error(), "build ingest request") {
		t.Fatalf("FinalizeRun() error = %v, want build request error", err)
	}
}

func TestHeartbeatRunPropagatesSendJSONError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"error":{"code":"run_conflict","message":"lease expired"}}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.HeartbeatRun(context.Background(), "run-1")
	if err == nil || !strings.Contains(err.Error(), "lease expired") {
		t.Fatalf("HeartbeatRun() error = %v, want API error", err)
	}
}

func TestFinalizeRunIncludesErrorSummaryWhenPresent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/quality-runs/run-1/finalize" {
			t.Fatalf("unexpected path %q", request.URL.Path)
		}

		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("Decode(finalize) error = %v", err)
		}

		if payload["status"] != string(quality.FinalStatusFailed) || payload["error_summary"] != "query exhausted retries" {
			t.Fatalf("finalize payload = %#v, want failed status and error_summary", payload)
		}

		if err := json.NewEncoder(writer).Encode(map[string]any{
			"run": map[string]any{
				"run_id":           "run-1",
				"status":           quality.FinalStatusFailed,
				"attempt_no":       1,
				"observed_at":      "2026-04-07T10:00:00Z",
				"lease_expires_at": "2026-04-07T10:15:00Z",
			},
		}); err != nil {
			t.Fatalf("Encode(finalize) error = %v", err)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	finalized, err := client.FinalizeRun(context.Background(), quality.FinalizeRequest{
		RunID:        "run-1",
		Status:       quality.FinalStatusFailed,
		ErrorSummary: "query exhausted retries",
	})
	if err != nil {
		t.Fatalf("FinalizeRun() error = %v", err)
	}

	if finalized.Status != quality.FinalStatusFailed || finalized.PublishedAt != nil {
		t.Fatalf("FinalizeRun() = %#v, want failed status without publication", finalized)
	}
}

func TestSendJSONRejectsUnencodablePayload(t *testing.T) {
	client, err := NewClient("https://example.com", "secret")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	response, err := client.sendJSON(context.Background(), http.MethodPost, "/internal/quality-runs", map[string]any{
		"invalid": func() {},
	})
	if response != nil {
		defer func() {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Fatalf("close response body: %v", closeErr)
			}
		}()
	}
	if err == nil || !strings.Contains(err.Error(), "encode request body") {
		t.Fatalf("sendJSON() error = %v, want encode error", err)
	}
}

func TestSendJSONPropagatesTransportFailures(t *testing.T) {
	client, err := NewClient("https://example.com", "secret", WithHTTPClient(&http.Client{
		Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network unavailable")
		}),
	}))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	response, err := client.sendJSON(context.Background(), http.MethodPost, "/internal/quality-runs", map[string]any{
		"observed_date": "2026-04-07",
	})
	if response != nil {
		defer func() {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Fatalf("close response body: %v", closeErr)
			}
		}()
	}
	if err == nil || !strings.Contains(err.Error(), "execute ingest request") || !strings.Contains(err.Error(), "network unavailable") {
		t.Fatalf("sendJSON() error = %v, want transport error", err)
	}
}

func mustDecodeJSONMap(t *testing.T, reader io.Reader, operation string) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.NewDecoder(reader).Decode(&payload); err != nil {
		t.Fatalf("Decode(%s) error = %v", operation, err)
	}

	return payload
}

func mustEncodeJSONMap(t *testing.T, writer io.Writer, payload map[string]any, operation string) {
	t.Helper()

	if err := json.NewEncoder(writer).Encode(payload); err != nil {
		t.Fatalf("Encode(%s) error = %v", operation, err)
	}
}

func mustDay(t *testing.T, raw string) quality.Day {
	t.Helper()

	day, err := quality.ParseDay(raw)
	if err != nil {
		t.Fatalf("ParseDay(%q) error = %v", raw, err)
	}

	return day
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
