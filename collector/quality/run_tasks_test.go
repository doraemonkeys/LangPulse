package quality

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// siblingCancelSearch fans one deterministic failure and verifies that sibling
// workers observe ctx cancellation. Without sharing state across workers we
// could not distinguish "sibling ran to completion" from "sibling aborted on
// ctx.Done()", which is the concurrency guarantee under test.
type siblingCancelSearch struct {
	failQuery       string
	failErr         error
	siblingStarted  chan struct{}
	siblingStartErr error

	mu         sync.Mutex
	siblingErr error
	seen       []string
}

func (s *siblingCancelSearch) CountRepositories(ctx context.Context, observedDate Day, query string) (int, error) {
	s.mu.Lock()
	s.seen = append(s.seen, query)
	s.mu.Unlock()

	if query == s.failQuery {
		// Hold long enough for the sibling worker to start and park on ctx.Done().
		select {
		case <-s.siblingStarted:
		case <-time.After(asyncWaitTimeout):
			return 0, s.siblingStartErr
		}
		return 0, s.failErr
	}

	// Sibling worker: announce that we're waiting on ctx so the failing worker
	// can be sure errgroup cancellation actually races into us.
	close(s.siblingStarted)
	<-ctx.Done()

	s.mu.Lock()
	s.siblingErr = ctx.Err()
	s.mu.Unlock()

	return 0, ctx.Err()
}

func (s *siblingCancelSearch) observedSiblingErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.siblingErr
}

func TestRunnerRunConcurrentSearchFailureCancelsSiblings(t *testing.T) {
	now := time.Date(2026, 4, 7, 14, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0, 10)
	observedDate := mustParseDay(t, "2026-04-07")

	failQuery := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[0], observedDate)
	siblingQuery := BuildSearchQuery(registry.WindowDays, registry.Languages[0], registry.Thresholds[1], observedDate)

	search := &siblingCancelSearch{
		failQuery:      failQuery,
		failErr:        errors.New("github unavailable"),
		siblingStarted: make(chan struct{}),
	}
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-concurrent-fail",
			AttemptNo:      1,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(5 * time.Minute),
		},
		heartbeatResult: HeartbeatResult{
			LeaseExpiresAt: now.Add(10 * time.Minute),
		},
	}

	// workerCount=2 guarantees both tasks run concurrently so the sibling
	// actually sees the errgroup-originated cancellation.
	runner, err := NewRunner(search, ingest, stubClock{now: now}, WithConcurrency(2))
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	_, err = runner.Run(context.Background(), registry, observedDate)
	if err == nil || !strings.Contains(err.Error(), "github unavailable") {
		t.Fatalf("Run() error = %v, want github failure", err)
	}

	if got := search.observedSiblingErr(); !errors.Is(got, context.Canceled) {
		t.Fatalf("sibling ctx.Err() = %v, want context.Canceled", got)
	}

	if len(ingest.finalizeCalls) != 1 || ingest.finalizeCalls[0].Status != FinalStatusFailed {
		t.Fatalf("finalizeCalls = %#v, want exactly one failed finalize", ingest.finalizeCalls)
	}

	// No row batch should have been written: collectRows returned an error
	// before reaching the UpsertRows call site.
	if ingest.upsertBatches != 0 {
		t.Fatalf("upsertBatches = %d, want 0 (error aborts before batch write)", ingest.upsertBatches)
	}

	if seen := len(search.seen); seen != 2 {
		t.Fatalf("len(search.seen) = %d, want 2 (both workers scheduled)", seen)
	}

	// Sanity: both queries were observed, in either order.
	seenSet := map[string]bool{}
	for _, query := range search.seen {
		seenSet[query] = true
	}
	if !seenSet[failQuery] || !seenSet[siblingQuery] {
		t.Fatalf("seen queries = %#v, want both fail and sibling", search.seen)
	}
}

func TestRunnerRunWritesAllRowsInSingleBatch(t *testing.T) {
	now := time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)
	registry := loadRunnerConfig(t, 0, 10, 100)
	observedDate := mustParseDay(t, "2026-04-07")

	counts := map[string]int{}
	for _, threshold := range registry.Thresholds {
		query := BuildSearchQuery(registry.WindowDays, registry.Languages[0], threshold, observedDate)
		counts[query] = 10 + threshold.Value
	}

	search := &fakeSearch{counts: counts}
	publishedAt := now.Add(2 * time.Minute)
	ingest := &fakeIngest{
		createResult: CreatedRun{
			RunID:          "run-single-batch",
			AttemptNo:      1,
			ObservedAt:     now,
			LeaseExpiresAt: now.Add(5 * time.Minute),
		},
		heartbeatResult: HeartbeatResult{
			LeaseExpiresAt: now.Add(10 * time.Minute),
		},
		finalizeResult: FinalizeResult{
			Status:      FinalStatusComplete,
			PublishedAt: &publishedAt,
		},
	}

	runner, err := NewRunner(search, ingest, stubClock{now: now}, WithConcurrency(3))
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	result, err := runner.Run(context.Background(), registry, observedDate)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	expectedRows := len(registry.Languages) * len(registry.Thresholds)
	if ingest.upsertBatches != 1 {
		t.Fatalf("upsertBatches = %d, want exactly 1 end-of-run batch", ingest.upsertBatches)
	}

	if len(ingest.rows) != expectedRows {
		t.Fatalf("len(rows) = %d, want %d", len(ingest.rows), expectedRows)
	}

	if result.RowsWritten != expectedRows {
		t.Fatalf("RowsWritten = %d, want %d", result.RowsWritten, expectedRows)
	}
}

func TestWithConcurrencyNormalizesNonPositiveValues(t *testing.T) {
	testCases := []struct {
		name  string
		value int
		want  int
	}{
		{name: "zero falls back to default", value: 0, want: DefaultWorkerConcurrency},
		{name: "negative falls back to default", value: -3, want: DefaultWorkerConcurrency},
		{name: "explicit positive is honored", value: 7, want: 7},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runner, err := NewRunner(&fakeSearch{}, &fakeIngest{}, stubClock{}, WithConcurrency(testCase.value))
			if err != nil {
				t.Fatalf("NewRunner() error = %v", err)
			}
			if runner.workerCount != testCase.want {
				t.Fatalf("workerCount = %d, want %d", runner.workerCount, testCase.want)
			}
		})
	}
}
