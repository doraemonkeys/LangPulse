package github

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/langpulse/collector/quality"
)

type stubClock struct {
	now time.Time
}

func (c stubClock) Now() time.Time { return c.now }

func TestNewClientRequiresToken(t *testing.T) {
	if _, err := NewClient(""); err == nil {
		t.Fatal("NewClient() error = nil, want missing token error")
	}
}

func TestCountRepositoriesUsesEscapedQueryAndHeaders(t *testing.T) {
	query := "language:protocol buffers is:public"
	var rawQuery string

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		rawQuery = request.URL.RawQuery

		if got := request.Header.Get("Authorization"); got != "Bearer token" {
			t.Fatalf("Authorization = %q, want %q", got, "Bearer token")
		}

		if got := request.Header.Get("X-GitHub-Api-Version"); got != "2022-11-28" {
			t.Fatalf("X-GitHub-Api-Version = %q, want %q", got, "2022-11-28")
		}

		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        17,
			"incomplete_results": false,
		}); err != nil {
			t.Fatalf("Encode() error = %v", err)
		}
	}))
	defer server.Close()

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	count, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), query)
	if err != nil {
		t.Fatalf("CountRepositories() error = %v", err)
	}

	if count != 17 {
		t.Fatalf("CountRepositories() = %d, want %d", count, 17)
	}

	if !strings.Contains(rawQuery, url.QueryEscape(query)) {
		t.Fatalf("RawQuery = %q, want escaped query %q", rawQuery, url.QueryEscape(query))
	}
}

func TestCountRepositoriesRetriesWithinObservedDate(t *testing.T) {
	attempts := 0
	var sleeps []time.Duration

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempts++
		if attempts == 1 {
			writer.Header().Set("Retry-After", "3")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"message":"slow down"}`))
			return
		}

		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        9,
			"incomplete_results": false,
		}); err != nil {
			t.Fatalf("Encode() error = %v", err)
		}
	}))
	defer server.Close()

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithClock(stubClock{now: time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)}),
		WithSleep(func(ctx context.Context, duration time.Duration) error {
			sleeps = append(sleeps, duration)
			return nil
		}),
		WithRetryPolicy(2, time.Second, 10*time.Second),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	count, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go")
	if err != nil {
		t.Fatalf("CountRepositories() error = %v", err)
	}

	if count != 9 {
		t.Fatalf("CountRepositories() = %d, want %d", count, 9)
	}

	if attempts != 2 {
		t.Fatalf("attempts = %d, want %d", attempts, 2)
	}

	if len(sleeps) != 1 || sleeps[0] != 3*time.Second {
		t.Fatalf("sleeps = %#v, want [3s]", sleeps)
	}
}

func TestCountRepositoriesStopsAtDayBoundary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Retry-After", "30")
		writer.WriteHeader(http.StatusTooManyRequests)
		_, _ = writer.Write([]byte(`{"message":"slow down"}`))
	}))
	defer server.Close()

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithClock(stubClock{now: time.Date(2026, 4, 7, 23, 59, 45, 0, time.UTC)}),
		WithSleep(func(ctx context.Context, duration time.Duration) error {
			t.Fatalf("sleep() called with %s, want no retry sleep", duration)
			return nil
		}),
		WithRetryPolicy(2, time.Second, time.Minute),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go")
	if err == nil || !strings.Contains(err.Error(), quality.ErrRetryWindowClosed.Error()) {
		t.Fatalf("CountRepositories() error = %v, want retry window closed", err)
	}
}

func TestCountRepositoriesRejectsIncompleteResults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        1,
			"incomplete_results": true,
		}); err != nil {
			t.Fatalf("Encode() error = %v", err)
		}
	}))
	defer server.Close()

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go")
	if err == nil || err.Error() != ErrIncompleteResults.Error() {
		t.Fatalf("CountRepositories() error = %v, want %v", err, ErrIncompleteResults)
	}
}

func TestCountRepositoriesRejectsBlankQuery(t *testing.T) {
	client, err := NewClient("token")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "   ")
	if err == nil || !strings.Contains(err.Error(), "github search query is required") {
		t.Fatalf("CountRepositories() error = %v, want blank query error", err)
	}
}

func TestRetryDelayAndDecodeAPIErrorHelpers(t *testing.T) {
	now := time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)
	headers := http.Header{}
	headers.Set("Retry-After", "1")
	headers.Set("X-RateLimit-Reset", strconv.FormatInt(now.Add(8*time.Second).Unix(), 10))

	if delay := retryDelay(headers, now, 3, time.Second, 30*time.Second); delay != 8*time.Second {
		t.Fatalf("retryDelay() = %s, want %s", delay, 8*time.Second)
	}

	if !shouldRetry(http.StatusInternalServerError) || shouldRetry(http.StatusUnauthorized) {
		t.Fatal("shouldRetry() returned unexpected values")
	}

	response := &http.Response{
		StatusCode: http.StatusBadRequest,
		Body:       io.NopCloser(strings.NewReader("plain failure")),
	}
	if err := decodeAPIError(response); err == nil || !strings.Contains(err.Error(), "plain failure") {
		t.Fatalf("decodeAPIError() error = %v, want plain text message", err)
	}

	headers = http.Header{}
	headers.Set("Retry-After", now.Add(4*time.Second).Format(http.TimeFormat))
	if delay := retryDelay(headers, now, 1, 5*time.Second, 10*time.Second); delay != 5*time.Second {
		t.Fatalf("retryDelay(http-date) = %s, want %s", delay, 5*time.Second)
	}

	response = &http.Response{
		StatusCode: http.StatusForbidden,
		Body:       io.NopCloser(strings.NewReader(`{"message":"forbidden"}`)),
	}
	if err := decodeAPIError(response); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("decodeAPIError(json message) error = %v, want JSON message", err)
	}
}

func TestSleepWithContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := sleepWithContext(ctx, time.Second); err == nil {
		t.Fatal("sleepWithContext() error = nil, want context cancellation")
	}

	if err := sleepWithContext(context.Background(), 0); err != nil {
		t.Fatalf("sleepWithContext(0) error = %v, want nil", err)
	}
}

func TestCountRepositoriesStopsOnNonRetryableError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"message":"bad credentials"}`))
	}))
	defer server.Close()

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithRetryPolicy(3, time.Second, time.Minute),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go")
	if err == nil || !strings.Contains(err.Error(), "bad credentials") {
		t.Fatalf("CountRepositories() error = %v, want non-retryable API error", err)
	}
}

func TestCountRepositoriesRejectsInvalidBaseURLAndStructuredErrors(t *testing.T) {
	client, err := NewClient("token", WithBaseURL("://bad-url"))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go")
	if err == nil || !strings.Contains(err.Error(), "build github request") {
		t.Fatalf("CountRepositories() error = %v, want invalid URL error", err)
	}

	response := &http.Response{
		StatusCode: http.StatusForbidden,
		Body:       io.NopCloser(strings.NewReader(`{"code":"secondary_rate_limit","error":"wait"}`)),
	}
	if err := decodeAPIError(response); err == nil || !strings.Contains(err.Error(), "secondary_rate_limit") {
		t.Fatalf("decodeAPIError(structured) error = %v, want code in message", err)
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
