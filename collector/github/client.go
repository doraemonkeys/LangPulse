package github

import (
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

	"github.com/langpulse/collector/internal/errjoin"
	"github.com/langpulse/collector/quality"
)

const (
	defaultBaseURL     = "https://api.github.com"
	defaultUserAgent   = "langpulse-collector"
	defaultMaxAttempts = 6
	defaultBaseBackoff = 2 * time.Second
	defaultMaxBackoff  = 2 * time.Minute
)

var ErrIncompleteResults = errors.New("github search returned incomplete results")

type sleepFunc func(context.Context, time.Duration) error

// Clock abstracts time retrieval for retry/backoff calculations so tests can
// advance time deterministically.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

type Client struct {
	baseURL     string
	token       string
	httpClient  *http.Client
	clock       Clock
	sleep       sleepFunc
	maxAttempts int
	baseBackoff time.Duration
	maxBackoff  time.Duration
}

type Option func(*Client)

type responsePayload struct {
	TotalCount        int  `json:"total_count"`
	IncompleteResults bool `json:"incomplete_results"`
}

type apiErrorPayload struct {
	Code    string `json:"code"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

func NewClient(token string, options ...Option) (*Client, error) {
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("github token is required")
	}

	client := &Client{
		baseURL:     defaultBaseURL,
		token:       strings.TrimSpace(token),
		httpClient:  http.DefaultClient,
		clock:       realClock{},
		sleep:       sleepWithContext,
		maxAttempts: defaultMaxAttempts,
		baseBackoff: defaultBaseBackoff,
		maxBackoff:  defaultMaxBackoff,
	}

	for _, option := range options {
		option(client)
	}

	client.baseURL = strings.TrimRight(client.baseURL, "/")
	return client, nil
}

func WithBaseURL(baseURL string) Option {
	return func(client *Client) {
		if trimmed := strings.TrimSpace(baseURL); trimmed != "" {
			client.baseURL = trimmed
		}
	}
}

func WithHTTPClient(httpClient *http.Client) Option {
	return func(client *Client) {
		if httpClient != nil {
			client.httpClient = httpClient
		}
	}
}

func WithClock(clock Clock) Option {
	return func(client *Client) {
		if clock != nil {
			client.clock = clock
		}
	}
}

func WithSleep(sleep sleepFunc) Option {
	return func(client *Client) {
		if sleep != nil {
			client.sleep = sleep
		}
	}
}

func WithRetryPolicy(maxAttempts int, baseBackoff time.Duration, maxBackoff time.Duration) Option {
	return func(client *Client) {
		if maxAttempts > 0 {
			client.maxAttempts = maxAttempts
		}

		if baseBackoff > 0 {
			client.baseBackoff = baseBackoff
		}

		if maxBackoff > 0 {
			client.maxBackoff = maxBackoff
		}
	}
}

func (c *Client) CountRepositories(ctx context.Context, observedDate quality.Day, query string) (int, error) {
	trimmedQuery := strings.TrimSpace(query)
	if trimmedQuery == "" {
		return 0, errors.New("github search query is required")
	}

	for attempt := 1; attempt <= c.maxAttempts; attempt++ {
		count, retryDelay, err := c.executeRequest(ctx, trimmedQuery, attempt)
		if err == nil {
			return count, nil
		}

		if retryDelay < 0 || attempt == c.maxAttempts {
			return 0, err
		}

		delay, ok := quality.ClampRetryDelay(c.clock.Now(), observedDate, retryDelay)
		if !ok {
			return 0, fmt.Errorf("%w: %w", quality.ErrRetryWindowClosed, err)
		}

		if err := c.sleep(ctx, delay); err != nil {
			return 0, fmt.Errorf("sleep before github retry: %w", err)
		}
	}

	return 0, errors.New("github retry policy exhausted")
}

func (c *Client) executeRequest(ctx context.Context, query string, attempt int) (count int, retryAfter time.Duration, err error) {
	endpoint := fmt.Sprintf("%s/search/repositories?q=%s&per_page=1", c.baseURL, url.QueryEscape(query))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, -1, fmt.Errorf("build github request: %w", err)
	}

	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("User-Agent", defaultUserAgent)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, -1, fmt.Errorf("execute github request: %w", err)
	}

	if response.StatusCode != http.StatusOK {
		apiErr := decodeAPIError(response)
		apiErr = errjoin.Join(apiErr, "close github response body", response.Body.Close)
		if !shouldRetry(response.StatusCode) {
			return 0, -1, apiErr
		}

		return 0, retryDelay(response.Header, c.clock.Now(), attempt, c.baseBackoff, c.maxBackoff), apiErr
	}

	defer func() {
		err = errjoin.Join(err, "close github response body", response.Body.Close)
	}()

	var payload responsePayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return 0, -1, fmt.Errorf("decode github response: %w", err)
	}

	if payload.IncompleteResults {
		return 0, -1, ErrIncompleteResults
	}

	return payload.TotalCount, -1, nil
}

func shouldRetry(statusCode int) bool {
	if statusCode == http.StatusForbidden || statusCode == http.StatusTooManyRequests {
		return true
	}

	return statusCode >= http.StatusInternalServerError
}

func retryDelay(headers http.Header, now time.Time, attempt int, baseBackoff time.Duration, maxBackoff time.Duration) time.Duration {
	delay := baseBackoff
	for currentAttempt := 1; currentAttempt < attempt; currentAttempt++ {
		delay *= 2
		if delay >= maxBackoff {
			delay = maxBackoff
			break
		}
	}

	if rawRetryAfter := strings.TrimSpace(headers.Get("Retry-After")); rawRetryAfter != "" {
		if parsedSeconds, err := strconv.Atoi(rawRetryAfter); err == nil {
			delay = time.Duration(parsedSeconds) * time.Second
		} else if parsedTime, err := http.ParseTime(rawRetryAfter); err == nil {
			delay = parsedTime.Sub(now.UTC())
		}
	}

	if rawReset := strings.TrimSpace(headers.Get("X-RateLimit-Reset")); rawReset != "" {
		if parsedUnix, err := strconv.ParseInt(rawReset, 10, 64); err == nil {
			resetDelay := time.Unix(parsedUnix, 0).UTC().Sub(now.UTC())
			if resetDelay > delay {
				delay = resetDelay
			}
		}
	}

	if delay < baseBackoff {
		delay = baseBackoff
	}

	if delay > maxBackoff {
		delay = maxBackoff
	}

	return delay
}

func decodeAPIError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8*1024))

	var payload apiErrorPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}

		return fmt.Errorf("github search failed with status %d: %s", response.StatusCode, message)
	}

	message := strings.TrimSpace(payload.Error)
	if message == "" {
		message = strings.TrimSpace(payload.Message)
	}
	if message == "" {
		message = http.StatusText(response.StatusCode)
	}

	if payload.Code != "" {
		return fmt.Errorf("github search failed with status %d (%s): %s", response.StatusCode, payload.Code, message)
	}

	return fmt.Errorf("github search failed with status %d: %s", response.StatusCode, message)
}

func sleepWithContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
