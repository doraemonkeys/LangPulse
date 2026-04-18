package quality

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	asyncWaitTimeout    = time.Second
	unexpectedSignalLag = 100 * time.Millisecond
)

type stubClock struct {
	now time.Time
}

func (c stubClock) Now() time.Time {
	return c.now
}

type fakeSearch struct {
	counts map[string]int
	err    error
	delay  time.Duration
	seen   []string
}

func (s *fakeSearch) CountRepositories(ctx context.Context, observedDate Day, query string) (int, error) {
	s.seen = append(s.seen, query)

	if s.delay > 0 {
		timer := time.NewTimer(s.delay)
		defer timer.Stop()

		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-timer.C:
		}
	}

	if s.err != nil {
		return 0, s.err
	}

	count, ok := s.counts[query]
	if !ok {
		return 0, fmt.Errorf("unexpected query %q", query)
	}

	return count, nil
}

type gatedSearch struct {
	result    int
	err       error
	started   chan struct{}
	release   chan struct{}
	startOnce sync.Once
	seen      []string
}

func (s *gatedSearch) CountRepositories(ctx context.Context, observedDate Day, query string) (int, error) {
	s.seen = append(s.seen, query)
	s.startOnce.Do(func() {
		close(s.started)
	})

	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-s.release:
	}

	if s.err != nil {
		return 0, s.err
	}

	return s.result, nil
}

type fakeIngest struct {
	createResult    CreatedRun
	heartbeatResult HeartbeatResult
	finalizeResult  FinalizeResult
	createCalls     []CreateRunRequest
	heartbeatCalls  []string
	rows            []RowUpsert
	finalizeCalls   []FinalizeRequest
	createErr       error
	heartbeatErr    error
	upsertErr       error
	finalizeErr     error
}

func (f *fakeIngest) CreateRun(ctx context.Context, request CreateRunRequest) (CreatedRun, error) {
	f.createCalls = append(f.createCalls, request)
	if f.createErr != nil {
		return CreatedRun{}, f.createErr
	}

	return f.createResult, nil
}

func (f *fakeIngest) HeartbeatRun(ctx context.Context, runID string) (HeartbeatResult, error) {
	f.heartbeatCalls = append(f.heartbeatCalls, runID)
	if f.heartbeatErr != nil {
		return HeartbeatResult{}, f.heartbeatErr
	}

	return f.heartbeatResult, nil
}

func (f *fakeIngest) UpsertRow(ctx context.Context, row RowUpsert) error {
	f.rows = append(f.rows, row)
	return f.upsertErr
}

func (f *fakeIngest) FinalizeRun(ctx context.Context, request FinalizeRequest) (FinalizeResult, error) {
	f.finalizeCalls = append(f.finalizeCalls, request)
	if f.finalizeErr != nil {
		return FinalizeResult{}, f.finalizeErr
	}

	return f.finalizeResult, nil
}

type exclusiveLeaseIngest struct {
	fakeIngest

	firstHeartbeatStarted  chan struct{}
	secondHeartbeatStarted chan struct{}
	releaseFirstHeartbeat  chan struct{}

	mu                      sync.Mutex
	heartbeatCallCount      int
	activeHeartbeats        int
	maxConcurrentHeartbeats int
	firstHeartbeatOnce      sync.Once
	secondHeartbeatOnce     sync.Once
}

func (f *exclusiveLeaseIngest) HeartbeatRun(ctx context.Context, runID string) (HeartbeatResult, error) {
	f.mu.Lock()
	f.heartbeatCallCount++
	callNumber := f.heartbeatCallCount
	f.activeHeartbeats++
	if f.activeHeartbeats > f.maxConcurrentHeartbeats {
		f.maxConcurrentHeartbeats = f.activeHeartbeats
	}
	f.heartbeatCalls = append(f.heartbeatCalls, runID)
	heartbeatErr := f.heartbeatErr
	heartbeatResult := f.heartbeatResult
	f.mu.Unlock()

	switch callNumber {
	case 1:
		f.firstHeartbeatOnce.Do(func() {
			close(f.firstHeartbeatStarted)
		})
		<-f.releaseFirstHeartbeat
	case 2:
		f.secondHeartbeatOnce.Do(func() {
			close(f.secondHeartbeatStarted)
		})
	}

	f.mu.Lock()
	f.activeHeartbeats--
	f.mu.Unlock()

	if heartbeatErr != nil {
		return HeartbeatResult{}, heartbeatErr
	}

	return heartbeatResult, nil
}

func (f *exclusiveLeaseIngest) MaxConcurrentHeartbeats() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.maxConcurrentHeartbeats
}

func TestRunnerRunCollectsTheActiveCartesianProduct(t *testing.T) {
	now := time.Date(2026, 4, 7, 10, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0, 10)
	observedDate := mustParseDay(t, "2026-04-07")

	queryZero := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)
	queryTen := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[1], observedDate)

	search := &fakeSearch{
		counts: map[string]int{
			queryZero: 101,
			queryTen:  42,
		},
		delay: 40 * time.Millisecond,
	}
	publishedAt := now.Add(2 * time.Minute)
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-1",
			AttemptNo:      3,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(30 * time.Millisecond),
		},
		heartbeatResult: HeartbeatResult{
			LeaseExpiresAt: now.Add(5 * time.Minute),
		},
		finalizeResult: FinalizeResult{
			Status:      FinalStatusComplete,
			PublishedAt: &publishedAt,
		},
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	result, err := runner.Run(context.Background(), registry, observedDate)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if len(ingest.createCalls) != 1 || ingest.createCalls[0].ExpectedRows != 2 {
		t.Fatalf("createCalls = %#v, want expected_rows=2", ingest.createCalls)
	}

	if len(ingest.rows) != 2 {
		t.Fatalf("len(rows) = %d, want %d", len(ingest.rows), 2)
	}

	if len(ingest.heartbeatCalls) < 2 {
		t.Fatalf("len(heartbeatCalls) = %d, want at least %d", len(ingest.heartbeatCalls), 2)
	}

	if len(ingest.finalizeCalls) != 1 || ingest.finalizeCalls[0].Status != FinalStatusComplete {
		t.Fatalf("finalizeCalls = %#v, want one complete finalize", ingest.finalizeCalls)
	}

	if result.RunID != "run-1" || result.RowsWritten != 2 {
		t.Fatalf("result = %#v, want run_id=run-1 rows=2", result)
	}

	if result.PublishedAt == nil || !result.PublishedAt.Equal(publishedAt) {
		t.Fatalf("PublishedAt = %v, want %v", result.PublishedAt, publishedAt)
	}
}

func TestRunnerRunStopsLeaseMaintainerBeforeFinalizingCompletedRun(t *testing.T) {
	now := time.Date(2026, 4, 7, 10, 30, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)
	observedDate := mustParseDay(t, "2026-04-07")
	expectedQuery := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)
	publishedAt := now.Add(time.Minute)

	search := &gatedSearch{
		result:  99,
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	ingest := &exclusiveLeaseIngest{
		fakeIngest: fakeIngest{
			createResult: CreatedRun{
				RunID:          "run-success-exclusive",
				AttemptNo:      1,
				ObservedAt:     now,
				LeaseExpiresAt: now.Add(20 * time.Millisecond),
			},
			heartbeatResult: HeartbeatResult{
				LeaseExpiresAt: now.Add(5 * time.Minute),
			},
			finalizeResult: FinalizeResult{
				Status:      FinalStatusComplete,
				PublishedAt: &publishedAt,
			},
		},
		firstHeartbeatStarted:  make(chan struct{}),
		secondHeartbeatStarted: make(chan struct{}),
		releaseFirstHeartbeat:  make(chan struct{}),
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	outcomes := make(chan runOutcome, 1)
	go func() {
		result, runErr := runner.Run(context.Background(), registry, observedDate)
		outcomes <- runOutcome{result: result, err: runErr}
	}()

	waitForSignal(t, ingest.firstHeartbeatStarted, "the first lease heartbeat to start")
	close(search.release)
	assertSignalStaysPending(t, ingest.secondHeartbeatStarted, "the terminal lease refresh")
	close(ingest.releaseFirstHeartbeat)

	outcome := waitForRunOutcome(t, outcomes)
	if outcome.err != nil {
		t.Fatalf("Run() error = %v, want nil", outcome.err)
	}

	if ingest.MaxConcurrentHeartbeats() != 1 {
		t.Fatalf("MaxConcurrentHeartbeats() = %d, want %d", ingest.MaxConcurrentHeartbeats(), 1)
	}

	if len(ingest.heartbeatCalls) != 2 {
		t.Fatalf("len(heartbeatCalls) = %d, want %d", len(ingest.heartbeatCalls), 2)
	}

	if len(search.seen) != 1 || search.seen[0] != expectedQuery {
		t.Fatalf("search.seen = %#v, want [%q]", search.seen, expectedQuery)
	}

	if outcome.result.PublishedAt == nil || !outcome.result.PublishedAt.Equal(publishedAt) {
		t.Fatalf("PublishedAt = %v, want %v", outcome.result.PublishedAt, publishedAt)
	}
}

func TestRunnerRunFinalizesFailedAttemptOnSearchError(t *testing.T) {
	now := time.Date(2026, 4, 7, 11, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)

	search := &fakeSearch{
		err: errors.New("github unavailable"),
	}
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-2",
			AttemptNo:      1,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(5 * time.Minute),
		},
		heartbeatResult: HeartbeatResult{
			LeaseExpiresAt: now.Add(10 * time.Minute),
		},
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	_, err = runner.Run(context.Background(), registry, mustParseDay(t, "2026-04-07"))
	if err == nil {
		t.Fatal("Run() error = nil, want search failure")
	}

	if len(ingest.finalizeCalls) != 1 || ingest.finalizeCalls[0].Status != FinalStatusFailed {
		t.Fatalf("finalizeCalls = %#v, want one failed finalize", ingest.finalizeCalls)
	}

	if !strings.Contains(ingest.finalizeCalls[0].ErrorSummary, "github unavailable") {
		t.Fatalf("ErrorSummary = %q, want github error", ingest.finalizeCalls[0].ErrorSummary)
	}
}

func TestRunnerRunStopsLeaseMaintainerBeforeFinalizingFailedRun(t *testing.T) {
	now := time.Date(2026, 4, 7, 11, 30, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)
	observedDate := mustParseDay(t, "2026-04-07")
	expectedQuery := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)

	search := &gatedSearch{
		err:     errors.New("github unavailable"),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	ingest := &exclusiveLeaseIngest{
		fakeIngest: fakeIngest{
			createResult: CreatedRun{
				RunID:          "run-failure-exclusive",
				AttemptNo:      1,
				ObservedAt:     now,
				LeaseExpiresAt: now.Add(20 * time.Millisecond),
			},
			heartbeatResult: HeartbeatResult{
				LeaseExpiresAt: now.Add(5 * time.Minute),
			},
		},
		firstHeartbeatStarted:  make(chan struct{}),
		secondHeartbeatStarted: make(chan struct{}),
		releaseFirstHeartbeat:  make(chan struct{}),
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	outcomes := make(chan runOutcome, 1)
	go func() {
		result, runErr := runner.Run(context.Background(), registry, observedDate)
		outcomes <- runOutcome{result: result, err: runErr}
	}()

	waitForSignal(t, ingest.firstHeartbeatStarted, "the first lease heartbeat to start")
	close(search.release)
	assertSignalStaysPending(t, ingest.secondHeartbeatStarted, "the failure-path lease refresh")
	close(ingest.releaseFirstHeartbeat)

	outcome := waitForRunOutcome(t, outcomes)
	if outcome.err == nil || !strings.Contains(outcome.err.Error(), "github unavailable") {
		t.Fatalf("Run() error = %v, want github failure", outcome.err)
	}

	if ingest.MaxConcurrentHeartbeats() != 1 {
		t.Fatalf("MaxConcurrentHeartbeats() = %d, want %d", ingest.MaxConcurrentHeartbeats(), 1)
	}

	if len(ingest.finalizeCalls) != 1 || ingest.finalizeCalls[0].Status != FinalStatusFailed {
		t.Fatalf("finalizeCalls = %#v, want one failed finalize", ingest.finalizeCalls)
	}

	if len(search.seen) != 1 || search.seen[0] != expectedQuery {
		t.Fatalf("search.seen = %#v, want [%q]", search.seen, expectedQuery)
	}
}

func TestNewRunnerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewRunner(nil, &fakeIngest{}, stubClock{}); err == nil {
		t.Fatal("NewRunner(nil search) error = nil, want validation error")
	}

	if _, err := NewRunner(&fakeSearch{}, nil, stubClock{}); err == nil {
		t.Fatal("NewRunner(nil ingest) error = nil, want validation error")
	}

	runner, err := NewRunner(&fakeSearch{}, &fakeIngest{}, nil)
	if err != nil {
		t.Fatalf("NewRunner(nil clock) error = %v", err)
	}

	if runner.clock.Now().IsZero() {
		t.Fatal("runner.clock.Now() = zero time, want real clock value")
	}
}

func TestRunnerRunStopsUsingRunWhenHeartbeatFails(t *testing.T) {
	now := time.Date(2026, 4, 7, 12, 30, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)
	observedDate := mustParseDay(t, "2026-04-07")
	query := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)

	search := &fakeSearch{
		counts: map[string]int{query: 10},
		delay:  40 * time.Millisecond,
	}
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-3",
			AttemptNo:      1,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(20 * time.Millisecond),
		},
		heartbeatErr: errors.New("lease expired"),
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	_, err = runner.Run(context.Background(), registry, observedDate)
	if err == nil || !strings.Contains(err.Error(), "lease heartbeat failed") {
		t.Fatalf("Run() error = %v, want heartbeat failure", err)
	}

	if len(ingest.finalizeCalls) != 0 {
		t.Fatalf("finalizeCalls = %#v, want no further run usage after heartbeat failure", ingest.finalizeCalls)
	}
}

func TestRunnerRunReturnsLeaseRefreshErrorBeforeFinalize(t *testing.T) {
	now := time.Date(2026, 4, 7, 13, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)
	observedDate := mustParseDay(t, "2026-04-07")
	query := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)

	search := &fakeSearch{
		counts: map[string]int{query: 9},
	}
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-4",
			AttemptNo:      1,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(10 * time.Minute),
		},
		heartbeatErr: errors.New("cannot refresh lease"),
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	_, err = runner.Run(context.Background(), registry, observedDate)
	if err == nil || !strings.Contains(err.Error(), "refresh lease before finalizing") {
		t.Fatalf("Run() error = %v, want refresh lease error", err)
	}
}

func TestValidateObservedDateAndRetryGuards(t *testing.T) {
	launchDate := mustParseDay(t, "2026-04-01")
	now := time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)

	if err := ValidateObservedDate(now, mustParseDay(t, "2026-04-07"), launchDate); err != nil {
		t.Fatalf("ValidateObservedDate() error = %v, want nil", err)
	}

	if err := ValidateObservedDate(now, mustParseDay(t, "2026-03-31"), launchDate); !errors.Is(err, ErrBeforeLaunchDate) {
		t.Fatalf("ValidateObservedDate(before launch) error = %v, want ErrBeforeLaunchDate", err)
	}

	if err := ValidateObservedDate(now, mustParseDay(t, "2026-04-06"), launchDate); !errors.Is(err, ErrObservedDateNotCurrentUTC) {
		t.Fatalf("ValidateObservedDate(not current day) error = %v, want ErrObservedDateNotCurrentUTC", err)
	}

	if delay, ok := ClampRetryDelay(
		time.Date(2026, 4, 7, 23, 59, 50, 0, time.UTC),
		mustParseDay(t, "2026-04-07"),
		5*time.Second,
	); !ok || delay != 5*time.Second {
		t.Fatalf("ClampRetryDelay(within day) = (%s, %t), want (5s, true)", delay, ok)
	}

	if _, ok := ClampRetryDelay(
		time.Date(2026, 4, 7, 23, 59, 50, 0, time.UTC),
		mustParseDay(t, "2026-04-07"),
		10*time.Second,
	); ok {
		t.Fatal("ClampRetryDelay(cross boundary) ok = true, want false")
	}
}

func TestNextLeaseHeartbeatDelayAndSummarizeError(t *testing.T) {
	now := time.Date(2026, 4, 7, 12, 0, 0, 0, time.UTC)
	if delay := nextLeaseHeartbeatDelay(now, now.Add(2*time.Hour)); delay != maxLeaseHeartbeatWait {
		t.Fatalf("nextLeaseHeartbeatDelay(long lease) = %s, want %s", delay, maxLeaseHeartbeatWait)
	}

	if delay := nextLeaseHeartbeatDelay(now, now.Add(10*time.Second)); delay != 5*time.Second {
		t.Fatalf("nextLeaseHeartbeatDelay(short lease) = %s, want %s", delay, 5*time.Second)
	}

	if delay := nextLeaseHeartbeatDelay(now, now); delay != 0 {
		t.Fatalf("nextLeaseHeartbeatDelay(expired lease) = %s, want %s", delay, 0*time.Second)
	}

	longError := errors.New(strings.Repeat("x", maxErrorSummaryLength+10))
	if got := len(summarizeError(longError)); got != maxErrorSummaryLength {
		t.Fatalf("len(summarizeError(longError)) = %d, want %d", got, maxErrorSummaryLength)
	}

	if got := summarizeError(nil); got != "" {
		t.Fatalf("summarizeError(nil) = %q, want empty string", got)
	}

	if err := pollLeaseError(make(chan error)); err != nil {
		t.Fatalf("pollLeaseError(empty) = %v, want nil", err)
	}

	leaseErrors := make(chan error, 1)
	leaseErrors <- errors.New("lease lost")
	if err := pollLeaseError(leaseErrors); err == nil || err.Error() != "lease lost" {
		t.Fatalf("pollLeaseError(buffered) = %v, want lease error", err)
	}
}

func TestFinalizeFailureHandlesNilAndFinalizeErrors(t *testing.T) {
	runner, err := NewRunner(&fakeSearch{}, &fakeIngest{}, stubClock{})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	if err := runner.finalizeFailure(context.Background(), "run-1", nil); err != nil {
		t.Fatalf("finalizeFailure(nil) error = %v, want nil", err)
	}

	ingest := &fakeIngest{
		heartbeatErr: errors.New("heartbeat denied"),
	}
	runner, err = NewRunner(&fakeSearch{}, ingest, stubClock{})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	err = runner.finalizeFailure(context.Background(), "run-2", errors.New("search failed"))
	if err == nil || !strings.Contains(err.Error(), "refresh lease before finalizing") {
		t.Fatalf("finalizeFailure(refresh error) = %v, want joined refresh error", err)
	}

	ingest = &fakeIngest{
		heartbeatResult: HeartbeatResult{LeaseExpiresAt: time.Now().UTC().Add(time.Minute)},
		finalizeErr:     errors.New("cannot finalize"),
	}
	runner, err = NewRunner(&fakeSearch{}, ingest, stubClock{})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	err = runner.finalizeFailure(context.Background(), "run-3", errors.New("search failed"))
	if err == nil || !strings.Contains(err.Error(), "cannot finalize") {
		t.Fatalf("finalizeFailure(finalize error) = %v, want joined finalize error", err)
	}
}

func loadConfigFixture(t *testing.T, raw string) Config {
	t.Helper()

	config, err := LoadConfig(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	return config
}

func loadRunnerConfig(t *testing.T, thresholdValues ...int) Config {
	t.Helper()

	thresholds := make([]string, 0, len(thresholdValues))
	for _, thresholdValue := range thresholdValues {
		thresholds = append(
			thresholds,
			fmt.Sprintf(`{ "value": %d, "active_from": "2026-04-01", "active_to": null }`, thresholdValue),
		)
	}

	return loadConfigFixture(t, fmt.Sprintf(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [
			{ "id": "go", "label": "Go", "github_query_fragment": "language:\"go\"", "active_from": "2026-04-01", "active_to": null }
		],
		"thresholds": [%s]
	}`, strings.Join(thresholds, ",")))
}

type runOutcome struct {
	result RunResult
	err    error
}

func waitForSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()

	select {
	case <-signal:
	case <-time.After(asyncWaitTimeout):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func assertSignalStaysPending(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()

	select {
	case <-signal:
		t.Fatalf("%s started before the lease maintainer released the ingestor", description)
	case <-time.After(unexpectedSignalLag):
	}
}

func waitForRunOutcome(t *testing.T, outcomes <-chan runOutcome) runOutcome {
	t.Helper()

	select {
	case outcome := <-outcomes:
		return outcome
	case <-time.After(asyncWaitTimeout):
		t.Fatal("timed out waiting for Run() to finish")
		return runOutcome{}
	}
}
