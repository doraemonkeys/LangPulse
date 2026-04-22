package github

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/time/rate"

	"github.com/langpulse/collector/quality"
)

type stubClock struct {
	now time.Time
}

func (c stubClock) Now() time.Time { return c.now }

// unlimited returns a limiter that never blocks. Tests whose focus lies
// outside the rate-limit path use it to stay fast and deterministic.
func unlimited() *rate.Limiter {
	return rate.NewLimiter(rate.Inf, 1)
}

func TestNewClientRequiresToken(t *testing.T) {
	if _, err := NewClient(""); err == nil {
		t.Fatal("NewClient() error = nil, want missing token error")
	}
}

func TestNewClientDefaultsToBuiltInLimiter(t *testing.T) {
	client, err := NewClient("token")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if client.limiter == nil {
		t.Fatal("NewClient() limiter = nil, want default limiter constructed")
	}

	expectedInterval := time.Minute / time.Duration(DefaultRequestsPerMinute)
	if client.interval != expectedInterval {
		t.Fatalf("NewClient() interval = %s, want %s", client.interval, expectedInterval)
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
		WithRateLimit(unlimited()),
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
		WithRateLimit(unlimited()),
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
		WithRateLimit(unlimited()),
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
		WithRateLimit(unlimited()),
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
	client, err := NewClient("token", WithRateLimit(unlimited()))
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
		WithRateLimit(unlimited()),
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
	client, err := NewClient("token", WithBaseURL("://bad-url"), WithRateLimit(unlimited()))
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

// TestLimiterWaitIsCalledOncePerRequest drives the client through a narrow
// limiter (1 token, burst 1, refill every 40ms) and verifies that N sequential
// requests take at least (N-1) * interval wall time, the observable signature
// of N-1 Wait() blocks.
func TestLimiterWaitIsCalledOncePerRequest(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		hits.Add(1)
		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        1,
			"incomplete_results": false,
		}); err != nil {
			t.Fatalf("Encode() error = %v", err)
		}
	}))
	defer server.Close()

	const (
		interval       = 40 * time.Millisecond
		requests       = 4
		expectedBlocks = requests - 1
	)

	limiter := rate.NewLimiter(rate.Every(interval), 1)
	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithRateLimit(limiter),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	start := time.Now()
	for i := 0; i < requests; i++ {
		if _, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go"); err != nil {
			t.Fatalf("CountRepositories() error = %v", err)
		}
	}
	elapsed := time.Since(start)

	// Each of the (requests-1) subsequent Wait() calls must block for at
	// least `interval`. The first request drains the burst with no wait. A
	// looser lower bound leaves room for scheduler jitter but still catches a
	// regression where Wait is skipped entirely.
	minElapsed := time.Duration(expectedBlocks) * interval
	if elapsed < minElapsed {
		t.Fatalf("elapsed = %s, want >= %s (%d Wait blocks of %s)", elapsed, minElapsed, expectedBlocks, interval)
	}

	if int(hits.Load()) != requests {
		t.Fatalf("server hits = %d, want %d", hits.Load(), requests)
	}
}

// TestLowRemainingTriggersActiveSleep verifies that a 2xx response with
// X-RateLimit-Resource=search and remaining<threshold pushes the shared
// limiter's next token out to the advertised reset time, so a subsequent
// Wait() blocks until that window opens.
//
// GitHub emits X-RateLimit-Reset in whole unix seconds, so the test must use
// a reset offset of at least one second. Otherwise the Unix() truncation
// wipes the gap out before the client can act on it.
func TestLowRemainingTriggersActiveSleep(t *testing.T) {
	// resetOffset is chosen so the observable stall is much larger than
	// scheduler jitter but the whole test still completes well under a second.
	const resetOffset = 2 * time.Second

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		resetAt := time.Now().UTC().Add(resetOffset).Unix()
		writer.Header().Set("X-RateLimit-Resource", "search")
		writer.Header().Set("X-RateLimit-Remaining", "2")
		writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt, 10))
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        1,
			"incomplete_results": false,
		})
	}))
	defer server.Close()

	// interval=10ms, burst=2 is narrow enough that applyRateLimitHeaders has
	// to reserve ~200 tokens to cover the reset gap, exercising the full
	// cumulative-shift path.
	limiter := rate.NewLimiter(rate.Every(10*time.Millisecond), 2)
	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithRateLimit(limiter),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	// Deadline guards against a regression where the pause is infinite.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := client.CountRepositories(ctx, mustDay(t, "2026-04-07"), "language:go"); err != nil {
		t.Fatalf("CountRepositories(primer) error = %v", err)
	}

	start := time.Now()
	if _, err := client.CountRepositories(ctx, mustDay(t, "2026-04-07"), "language:go"); err != nil {
		t.Fatalf("CountRepositories(post-low-remaining) error = %v", err)
	}
	elapsed := time.Since(start)

	// The Reset header rounds down to a whole second, so the effective gap is
	// between (resetOffset - 1s) and resetOffset. Half of the floor is still
	// orders of magnitude larger than the sub-ms speed of a bypassed limiter.
	minElapsed := (resetOffset - time.Second) / 2
	if elapsed < minElapsed {
		t.Fatalf("elapsed = %s, want >= %s (low-remaining should have stalled Wait)", elapsed, minElapsed)
	}
}

// TestLowRemainingIgnoredForNonSearchResource guards against mis-classifying
// the core (5000/h) bucket as search (30/min). Returning a low-remaining signal
// on a non-search resource must not disturb the limiter, otherwise every
// core-bucket call would starve search-paced traffic.
func TestLowRemainingIgnoredForNonSearchResource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		resetAt := time.Now().UTC().Add(10 * time.Second).Unix()
		writer.Header().Set("X-RateLimit-Resource", "core")
		writer.Header().Set("X-RateLimit-Remaining", "1")
		writer.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt, 10))
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        1,
			"incomplete_results": false,
		})
	}))
	defer server.Close()

	// rate.Inf means any SetLimitAt/SetBurstAt(0) would become immediately
	// observable as a Wait stall. If Wait stays instantaneous we've proven
	// the non-search branch is a no-op.
	limiter := rate.NewLimiter(rate.Inf, 1)
	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithRateLimit(limiter),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if _, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go"); err != nil {
		t.Fatalf("CountRepositories(primer) error = %v", err)
	}

	start := time.Now()
	if _, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go"); err != nil {
		t.Fatalf("CountRepositories(follow-up) error = %v", err)
	}
	elapsed := time.Since(start)

	// 50ms is huge relative to rate.Inf and local loopback RTT. A stall
	// would dwarf it.
	if elapsed > 50*time.Millisecond {
		t.Fatalf("elapsed = %s, want near-zero (core-bucket headers must not adjust limiter)", elapsed)
	}
}

// TestApplyRateLimitHeadersIgnoresMalformedValues covers the defensive
// branches that shield the shared limiter from corrupt or absent headers
// (GHE variants, buggy proxies, clock-skewed responses). Each row asserts
// that applyRateLimitHeaders leaves the limiter untouched, i.e. subsequent
// ReserveN availability is unchanged by the header contents.
func TestApplyRateLimitHeadersIgnoresMalformedValues(t *testing.T) {
	testCases := []struct {
		name    string
		headers http.Header
	}{
		{
			name: "missing remaining",
			headers: http.Header{
				"X-Ratelimit-Resource": []string{"search"},
				"X-Ratelimit-Reset":    []string{strconv.FormatInt(time.Now().Add(time.Minute).Unix(), 10)},
			},
		},
		{
			name: "unparseable remaining",
			headers: http.Header{
				"X-Ratelimit-Resource":  []string{"search"},
				"X-Ratelimit-Remaining": []string{"not-a-number"},
				"X-Ratelimit-Reset":     []string{strconv.FormatInt(time.Now().Add(time.Minute).Unix(), 10)},
			},
		},
		{
			name: "unparseable reset",
			headers: http.Header{
				"X-Ratelimit-Resource":  []string{"search"},
				"X-Ratelimit-Remaining": []string{"1"},
				"X-Ratelimit-Reset":     []string{"not-unix"},
			},
		},
		{
			name: "reset already in past",
			headers: http.Header{
				"X-Ratelimit-Resource":  []string{"search"},
				"X-Ratelimit-Remaining": []string{"1"},
				"X-Ratelimit-Reset":     []string{strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)},
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			limiter := rate.NewLimiter(rate.Every(time.Second), 1)
			client := &Client{limiter: limiter, interval: time.Second, clock: realClock{}}
			tokensBefore := limiter.Tokens()

			client.applyRateLimitHeaders(testCase.headers)

			// No observable limiter state change means the defensive branch
			// short-circuited cleanly. We read Tokens() via a second call;
			// a drain would knock it well below pre-call value.
			if got := limiter.Tokens(); got < tokensBefore-0.1 {
				t.Fatalf("limiter.Tokens() = %f, want >= %f (malformed header should be no-op)", got, tokensBefore-0.1)
			}
		})
	}
}

// TestApplyRateLimitHeadersSkipsZeroBurstLimiter ensures the ReserveN loop
// bails out on a degenerate burst=0 limiter instead of spinning forever. Such
// a limiter can only be constructed by explicit caller misconfiguration; we
// treat it as a no-op so a future operator injecting one does not get an
// infinite hang.
func TestApplyRateLimitHeadersSkipsZeroBurstLimiter(t *testing.T) {
	limiter := rate.NewLimiter(rate.Every(time.Second), 0)
	client := &Client{limiter: limiter, interval: time.Second, clock: realClock{}}

	headers := http.Header{
		"X-Ratelimit-Resource":  []string{"search"},
		"X-Ratelimit-Remaining": []string{"1"},
		"X-Ratelimit-Reset":     []string{strconv.FormatInt(time.Now().Add(time.Minute).Unix(), 10)},
	}

	done := make(chan struct{})
	go func() {
		client.applyRateLimitHeaders(headers)
		close(done)
	}()

	select {
	case <-done:
		// expected: function returns without spinning
	case <-time.After(time.Second):
		t.Fatal("applyRateLimitHeaders did not return for burst=0 limiter within 1s")
	}
}

// TestWithRateLimitNilIsNoOp guards the option against accidental nil pointers.
// The default limiter must survive a nil injection.
func TestWithRateLimitNilIsNoOp(t *testing.T) {
	client, err := NewClient("token", WithRateLimit(nil))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if client.limiter == nil {
		t.Fatal("NewClient(WithRateLimit(nil)) dropped the default limiter")
	}
}

// TestIntervalFromLimitHandlesSentinels covers the two edge limits we care
// about: rate.Inf (unlimited) and a finite pacing limit.
func TestIntervalFromLimitHandlesSentinels(t *testing.T) {
	if got := intervalFromLimit(rate.Inf); got != 0 {
		t.Fatalf("intervalFromLimit(rate.Inf) = %s, want 0 (unlimited)", got)
	}

	if got := intervalFromLimit(rate.Every(2 * time.Second)); got != 2*time.Second {
		t.Fatalf("intervalFromLimit(rate.Every(2s)) = %s, want 2s", got)
	}

	if got := intervalFromLimit(0); got != 0 {
		t.Fatalf("intervalFromLimit(0) = %s, want 0", got)
	}
}

// TestCountRepositoriesLogsRetryOn429 proves operators watching CI logs can
// see why the collector is pausing. The log line carries the clamped delay,
// the attempt number, and the upstream status code so a 429 is distinguishable
// from a 5xx at a glance.
func TestCountRepositoriesLogsRetryOn429(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempts++
		if attempts == 1 {
			writer.Header().Set("Retry-After", "2")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"message":"slow down"}`))
			return
		}

		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        4,
			"incomplete_results": false,
		}); err != nil {
			t.Fatalf("Encode() error = %v", err)
		}
	}))
	defer server.Close()

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	client, err := NewClient(
		"token",
		WithBaseURL(server.URL),
		WithHTTPClient(server.Client()),
		WithClock(stubClock{now: time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)}),
		WithSleep(func(context.Context, time.Duration) error { return nil }),
		WithRetryPolicy(2, time.Second, 10*time.Second),
		WithRateLimit(unlimited()),
		WithLogger(logger),
	)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if _, err := client.CountRepositories(context.Background(), mustDay(t, "2026-04-07"), "language:go"); err != nil {
		t.Fatalf("CountRepositories() error = %v", err)
	}

	got := logBuf.String()
	for _, want := range []string{
		`msg="github retry scheduled"`,
		"attempt=1",
		"max_attempts=2",
		"delay=2s",
		"status 429",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("log output = %q, want it to contain %q", got, want)
		}
	}
}

// TestApplyRateLimitHeadersLogsNearExhaustion guards the operator-visible
// warning that the pacer has stalled every worker until the next reset window.
// Without this log line the stall is invisible and looks like a hang.
func TestApplyRateLimitHeadersLogsNearExhaustion(t *testing.T) {
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	resetAt := time.Date(2026, 4, 7, 12, 0, 30, 0, time.UTC)
	client := &Client{
		limiter:  rate.NewLimiter(rate.Every(2*time.Second), 1),
		interval: 2 * time.Second,
		clock:    stubClock{now: time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)},
		logger:   logger,
	}

	headers := http.Header{
		"X-Ratelimit-Resource":  []string{"search"},
		"X-Ratelimit-Remaining": []string{"1"},
		"X-Ratelimit-Reset":     []string{strconv.FormatInt(resetAt.Unix(), 10)},
	}
	client.applyRateLimitHeaders(headers)

	got := logBuf.String()
	for _, want := range []string{
		`level=WARN`,
		`msg="github rate limit near exhaustion"`,
		"remaining=1",
		"planned_reservations=",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("log output = %q, want it to contain %q", got, want)
		}
	}
}

// TestWithLoggerNilIsNoOp guards the option against accidental nil loggers.
// Passing nil must leave the discard default in place so Client methods never
// panic on log calls.
func TestWithLoggerNilIsNoOp(t *testing.T) {
	client, err := NewClient("token", WithLogger(nil))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if client.logger == nil {
		t.Fatal("NewClient(WithLogger(nil)) dropped the discard default logger")
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
