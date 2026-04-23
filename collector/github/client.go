package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"github.com/langpulse/collector/internal/errjoin"
	"github.com/langpulse/collector/quality"
)

const (
	defaultBaseURL     = "https://api.github.com"
	defaultUserAgent   = "langpulse-collector"
	defaultMaxAttempts = 6
	defaultBaseBackoff = 2 * time.Second
	defaultMaxBackoff  = 2 * time.Minute

	// defaultLowRemainingThreshold triggers a cooperative pause when GitHub
	// reports we are about to exhaust the search bucket. Parking every worker
	// at the shared limiter avoids the classic "three workers race for the
	// last two tokens" pattern that produces avoidable 429s at the tail of a
	// window.
	defaultLowRemainingThreshold = 3

	// rateLimitResourceSearch is the only X-RateLimit-Resource value we act
	// on. Mixing core (5000/h) and search (30/min) buckets under one pacer
	// would misclassify the bucket and over-throttle core-bound traffic.
	rateLimitResourceSearch = "search"
)

// DefaultRequestsPerMinute sits 10% below GitHub's documented 30 req/min
// search allowance. Pacing exactly at the ceiling reliably tripped 403s in
// production: GitHub's sliding window does not align with our 2s cadence, so
// window tails routinely left remaining=1–2 with a multi-second gap to reset,
// and the cooperative pause could not retract reservations already parked on
// the shared limiter. The extra headroom lets those tails drain without
// overshoot. Exported so the CLI layer can reuse the same fallback when
// constructing an external limiter, keeping exactly one source of truth for
// the default pacing value.
const DefaultRequestsPerMinute = 27

// DefaultRequestBurst is the default burst size paired with
// DefaultRequestsPerMinute. burst=1 keeps pacing monotonic in the default
// path; operators who tolerate occasional 429s in exchange for parallelism
// can raise it via the CLI. Exported alongside DefaultRequestsPerMinute so
// the CLI fallback stays in lockstep with NewClient's built-in default.
const DefaultRequestBurst = 1

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
	// limiter is shared across goroutines when the Runner parallelizes search
	// calls. A low-remaining response mutates this limiter so every worker that
	// subsequently reaches Wait() observes the pause. Workers already parked on
	// a prior reservation keep their originally-scheduled wake time
	// (rate.Limiter computes timeToAct at reservation entry and never pulls it
	// forward in response to later ReserveN calls); with burst=1 this is at
	// most one worker ahead, which bounds the blast radius.
	limiter  *rate.Limiter
	interval time.Duration
	// logger emits retry + rate-limit diagnostics. Defaults to a discard
	// handler so tests stay silent; the CLI wires in a stderr logger so
	// operators watching CI logs can see 429s and backoff durations in real
	// time instead of only on final failure.
	logger *slog.Logger
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
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	for _, option := range options {
		option(client)
	}

	if client.limiter == nil {
		interval := time.Minute / time.Duration(DefaultRequestsPerMinute)
		client.limiter = rate.NewLimiter(rate.Every(interval), DefaultRequestBurst)
		client.interval = interval
	} else if client.interval == 0 {
		// WithRateLimit accepted an externally constructed limiter. Recover
		// the steady-state interval so the low-remaining path can cover the
		// reset window based on the caller's configured pace.
		client.interval = intervalFromLimit(client.limiter.Limit())
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

// WithLogger injects a structured logger for retry + rate-limit diagnostics.
// Passing nil is a no-op so callers can forward an optional logger without
// defensive branching. The discard default in NewClient guarantees Client
// methods never panic when the option is omitted.
func WithLogger(logger *slog.Logger) Option {
	return func(client *Client) {
		if logger != nil {
			client.logger = logger
		}
	}
}

// WithRateLimit injects an externally constructed limiter. Typical production
// wiring is rate.NewLimiter(rate.Every(2*time.Second), 1) for 30 req/min.
// Passing rate.NewLimiter(rate.Inf, 1) disables pacing, which tests rely on.
func WithRateLimit(limiter *rate.Limiter) Option {
	return func(client *Client) {
		if limiter == nil {
			return
		}

		client.limiter = limiter
		client.interval = intervalFromLimit(limiter.Limit())
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

		c.logger.Warn(
			"github retry scheduled",
			slog.Int("attempt", attempt),
			slog.Int("max_attempts", c.maxAttempts),
			slog.Duration("delay", delay),
			slog.String("observed_date", observedDate.String()),
			slog.String("error", err.Error()),
		)

		if err := c.sleep(ctx, delay); err != nil {
			return 0, fmt.Errorf("sleep before github retry: %w", err)
		}
	}

	return 0, errors.New("github retry policy exhausted")
}

func (c *Client) executeRequest(ctx context.Context, query string, attempt int) (count int, retryAfter time.Duration, err error) {
	// Block all workers uniformly at the shared pacer before building the
	// request. Rate-limit budget is consumed pre-flight so a low-remaining
	// response observed mid-flight can reshape the limiter for siblings
	// waiting behind us.
	if err := c.limiter.Wait(ctx); err != nil {
		return 0, -1, fmt.Errorf("rate limiter wait: %w", err)
	}

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

	c.applyRateLimitHeaders(response.Header)

	var payload responsePayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return 0, -1, fmt.Errorf("decode github response: %w", err)
	}

	if payload.IncompleteResults {
		return 0, -1, ErrIncompleteResults
	}

	return payload.TotalCount, -1, nil
}

// applyRateLimitHeaders mutates the shared limiter in response to GitHub's
// X-RateLimit-* signals. It only acts on the search bucket. Missing headers
// (GHE / proxies) are tolerated as a no-op because the static pacer is
// already conservative.
//
// Why not the obvious SetBurstAt(resetAt, 0)? Setting burst=0 makes Wait(n=1)
// return an immediate "exceeds limiter's burst" error instead of blocking. We
// need a pause, not a failure. The reliable primitive for pausing all workers
// queued on a shared limiter is to drive the internal token counter negative
// enough that the next refill-based Wait naturally lands past resetAt.
// ReserveN(now, 1) in a loop does exactly that: each call subtracts one token
// and bumps the next timeToAct by one interval, so we stop once the
// cumulative shift covers the window-reset distance.
func (c *Client) applyRateLimitHeaders(headers http.Header) {
	if headers.Get("X-RateLimit-Resource") != rateLimitResourceSearch {
		return
	}

	remaining, err := strconv.Atoi(strings.TrimSpace(headers.Get("X-RateLimit-Remaining")))
	if err != nil {
		return
	}

	if remaining >= defaultLowRemainingThreshold {
		return
	}

	reset, err := strconv.ParseInt(strings.TrimSpace(headers.Get("X-RateLimit-Reset")), 10, 64)
	if err != nil {
		return
	}

	resetAt := time.Unix(reset, 0).UTC()
	now := c.clock.Now().UTC()
	gap := resetAt.Sub(now)
	if gap <= 0 || c.interval <= 0 {
		// Window already open or limiter is unlimited. Nothing meaningful to
		// gate in either case.
		return
	}

	burst := c.limiter.Burst()
	if burst <= 0 {
		// ReserveN(n=1) fails for a zero-burst limiter. Nothing we can do
		// without constructing a new limiter, which would drop other
		// workers' in-flight reservations.
		return
	}

	// Each ReserveN(now, 1) beyond the initial burst pushes the "next token
	// available" marker forward by one interval. The +burst absorbs the
	// tokens already present in the bucket so the net shift of the next
	// satisfiable Wait is >= gap.
	reservations := int(gap/c.interval) + burst
	for i := 0; i < reservations; i++ {
		reservation := c.limiter.ReserveN(now, 1)
		if !reservation.OK() {
			break
		}
	}

	// Warn mirrors the retry-scheduled log's level: both events explain an
	// otherwise-silent multi-second stall, so an incident responder filtering
	// on level=warn should catch either signal without a second query.
	//
	// planned_reservations (vs. a counter of actually-executed ReserveN calls)
	// is intentional: when ReserveN returns !OK the loop bails early, so the
	// field advertises the intended pause magnitude rather than masking a
	// degenerate burst with a partial count.
	c.logger.Warn(
		"github rate limit near exhaustion",
		slog.Int("remaining", remaining),
		slog.Time("reset_at", resetAt),
		slog.Duration("gap", gap),
		slog.Int("planned_reservations", reservations),
	)
}

// intervalFromLimit inverts rate.Every so SetLimitAt can restore pacing after
// a low-remaining pause. rate.Inf (unlimited) has no meaningful interval, so
// we report zero. The caller treats zero as "no pacing configured".
func intervalFromLimit(limit rate.Limit) time.Duration {
	if limit <= 0 || limit == rate.Inf {
		return 0
	}

	return time.Duration(float64(time.Second) / float64(limit))
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
