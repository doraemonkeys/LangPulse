package quality

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type ctxBlockingHeartbeatIngest struct {
	fakeIngest

	started  chan struct{}
	doneOnce sync.Once
}

func (c *ctxBlockingHeartbeatIngest) HeartbeatRun(ctx context.Context, runID string) (HeartbeatResult, error) {
	c.heartbeatCalls = append(c.heartbeatCalls, runID)
	c.doneOnce.Do(func() {
		close(c.started)
	})

	<-ctx.Done()
	return HeartbeatResult{}, ctx.Err()
}

func TestMaintainLeaseDoesNotReportErrorOnContextCancel(t *testing.T) {
	now := time.Date(2026, 4, 7, 14, 0, 0, 0, time.UTC)
	ingest := &ctxBlockingHeartbeatIngest{
		started: make(chan struct{}),
	}

	leaseErrors := make(chan error, 1)
	var cancelWorkCalls int
	cancelWork := func() {
		cancelWorkCalls++
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		maintainLease(
			ctx,
			stubClock{now: now},
			ingest,
			"run-shutdown",
			now.Add(10*time.Millisecond),
			leaseErrors,
			cancelWork,
		)
	}()

	waitForSignal(t, ingest.started, "the heartbeat to start")
	// Simulate lease.Stop() cancelling the lease goroutine mid-heartbeat. The
	// returned ctx-origin error is our own, and must not be surfaced as a lease
	// failure (or trigger a spurious work-ctx cancellation).
	cancel()

	select {
	case <-done:
	case <-time.After(asyncWaitTimeout):
		t.Fatal("maintainLease did not return after ctx cancel")
	}

	if err := pollLeaseError(leaseErrors); err != nil {
		t.Fatalf("pollLeaseError() = %v, want nil for shutdown-origin ctx cancel", err)
	}

	if cancelWorkCalls != 0 {
		t.Fatalf("cancelWork invocations = %d, want 0 for shutdown-origin ctx cancel", cancelWorkCalls)
	}
}

type sequencedHeartbeatIngest struct {
	fakeIngest

	mu          sync.Mutex
	calls       int
	firstErr    error
	laterResult HeartbeatResult
}

func (s *sequencedHeartbeatIngest) HeartbeatRun(_ context.Context, runID string) (HeartbeatResult, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	s.heartbeatCalls = append(s.heartbeatCalls, runID)
	s.mu.Unlock()

	if call == 1 {
		return HeartbeatResult{}, s.firstErr
	}
	return s.laterResult, nil
}

type ctxObservingSearch struct {
	mu       sync.Mutex
	observed bool
}

func (s *ctxObservingSearch) CountRepositories(ctx context.Context, _ Day, _ string) (int, error) {
	<-ctx.Done()
	s.mu.Lock()
	s.observed = true
	s.mu.Unlock()
	return 0, ctx.Err()
}

func (s *ctxObservingSearch) ObservedContextCancel() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.observed
}

func TestRunnerRunAbortsRowUpsertOnLeaseHeartbeatFailure(t *testing.T) {
	now := time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0)
	observedDate := mustParseDay(t, "2026-04-07")

	search := &ctxObservingSearch{}
	ingest := &sequencedHeartbeatIngest{
		fakeIngest: fakeIngest{
			createResult: CreatedRun{
				RunID:          "run-abort",
				AttemptNo:      1,
				ObservedAt:     now,
				LeaseExpiresAt: now.Add(20 * time.Millisecond),
			},
			finalizeResult: FinalizeResult{Status: FinalStatusFailed},
		},
		firstErr:    errors.New("lease revoked"),
		laterResult: HeartbeatResult{LeaseExpiresAt: now.Add(5 * time.Minute)},
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	_, err = runner.Run(context.Background(), registry, observedDate)
	if err == nil || !strings.Contains(err.Error(), "lease heartbeat failed") {
		t.Fatalf("Run() error = %v, want lease heartbeat failure", err)
	}

	if !search.ObservedContextCancel() {
		t.Fatal("CountRepositories did not observe ctx cancellation triggered by lease failure")
	}

	if len(ingest.finalizeCalls) != 1 {
		t.Fatalf("finalizeCalls = %#v, want exactly one finalize", ingest.finalizeCalls)
	}
	if ingest.finalizeCalls[0].Status != FinalStatusFailed {
		t.Fatalf("finalize status = %v, want %v", ingest.finalizeCalls[0].Status, FinalStatusFailed)
	}
	// The persisted ErrorSummary must name the real lease failure. Without this
	// assertion an earlier regression slipped through where D1 stored only the
	// cascaded `context canceled` that our own cancelWork() triggered.
	if !strings.Contains(ingest.finalizeCalls[0].ErrorSummary, "lease revoked") {
		t.Fatalf("ErrorSummary = %q, want it to name the lease failure", ingest.finalizeCalls[0].ErrorSummary)
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

	if err := runner.finalizeFailure("run-1", nil); err != nil {
		t.Fatalf("finalizeFailure(nil) error = %v, want nil", err)
	}

	ingest := &fakeIngest{
		heartbeatErr: errors.New("heartbeat denied"),
	}
	runner, err = NewRunner(&fakeSearch{}, ingest, stubClock{})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	err = runner.finalizeFailure("run-2", errors.New("search failed"))
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

	err = runner.finalizeFailure("run-3", errors.New("search failed"))
	if err == nil || !strings.Contains(err.Error(), "cannot finalize") {
		t.Fatalf("finalizeFailure(finalize error) = %v, want joined finalize error", err)
	}
}
