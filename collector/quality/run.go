package quality

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
)

// DefaultWorkerConcurrency is the collector's default GitHub-search fan-out,
// shared between the CLI entry point and the Runner so both layers agree on a
// single source of truth. Kept small because the shared rate limiter caps
// steady-state throughput at 30 req/min — more workers only flattens
// first-packet RTT, not throughput.
const DefaultWorkerConcurrency = 4

var (
	ErrBeforeLaunchDate          = errors.New("collector target date precedes launch date")
	ErrObservedDateNotCurrentUTC = errors.New("collector target date must match the current UTC date")
	ErrRetryWindowClosed         = errors.New("retry window closed")
)

type Clock interface {
	Now() time.Time
}

type RepositoryCounter interface {
	CountRepositories(ctx context.Context, observedDate Day, query string) (int, error)
}

type RunIngestor interface {
	CreateRun(ctx context.Context, request CreateRunRequest) (CreatedRun, error)
	HeartbeatRun(ctx context.Context, runID string) (HeartbeatResult, error)
	UpsertRows(ctx context.Context, rows []RowUpsert) error
	FinalizeRun(ctx context.Context, request FinalizeRequest) (FinalizeResult, error)
}

type CreateRunRequest struct {
	ObservedDate Day
	ExpectedRows int
}

type CreatedRun struct {
	RunID          string
	AttemptNo      int
	ObservedAt     time.Time
	LeaseExpiresAt time.Time
}

type HeartbeatResult struct {
	LeaseExpiresAt time.Time
}

type RowUpsert struct {
	RunID          string
	LanguageID     string
	ThresholdValue int
	Count          int
	CollectedAt    time.Time
}

type FinalStatus string

const (
	FinalStatusComplete FinalStatus = "complete"
	FinalStatusFailed   FinalStatus = "failed"
	FinalStatusExpired  FinalStatus = "expired"
)

type FinalizeRequest struct {
	RunID        string
	Status       FinalStatus
	ErrorSummary string
}

type FinalizeResult struct {
	Status      FinalStatus
	PublishedAt *time.Time
}

type RunResult struct {
	RunID       string
	AttemptNo   int
	ObservedAt  time.Time
	RowsWritten int
	PublishedAt *time.Time
}

type Runner struct {
	search      RepositoryCounter
	ingest      RunIngestor
	clock       Clock
	workerCount int
}

// Option mutates a Runner during construction. Functional options keep
// NewRunner's positional signature stable while letting the CLI wire in
// settings like concurrency without breaking downstream callers.
type Option func(*Runner)

// WithConcurrency overrides the worker fan-out used during the search phase.
// Values <= 0 fall back to DefaultWorkerConcurrency so callers can pass a
// 0-sentinel for "not configured" without bespoke branching.
func WithConcurrency(workerCount int) Option {
	return func(runner *Runner) {
		if workerCount <= 0 {
			runner.workerCount = DefaultWorkerConcurrency
			return
		}
		runner.workerCount = workerCount
	}
}

type realClock struct{}

func (realClock) Now() time.Time {
	return time.Now().UTC()
}

func NewRunner(search RepositoryCounter, ingest RunIngestor, clock Clock, options ...Option) (Runner, error) {
	switch {
	case search == nil:
		return Runner{}, errors.New("repository counter is required")
	case ingest == nil:
		return Runner{}, errors.New("run ingestor is required")
	case clock == nil:
		clock = realClock{}
	}

	runner := Runner{
		search:      search,
		ingest:      ingest,
		clock:       clock,
		workerCount: DefaultWorkerConcurrency,
	}

	for _, option := range options {
		option(&runner)
	}

	return runner, nil
}

func (r Runner) Run(ctx context.Context, registry Config, observedDate Day) (result RunResult, err error) {
	if err := registry.Validate(); err != nil {
		return RunResult{}, err
	}

	if err := ValidateObservedDate(r.clock.Now(), observedDate, registry.LaunchDate); err != nil {
		return RunResult{}, err
	}

	activeLanguages := registry.ActiveLanguages(observedDate)
	activeThresholds := registry.ActiveThresholds(observedDate)

	createdRun, err := r.ingest.CreateRun(ctx, CreateRunRequest{
		ObservedDate: observedDate,
		ExpectedRows: len(activeLanguages) * len(activeThresholds),
	})
	if err != nil {
		return RunResult{}, fmt.Errorf("create ingest run: %w", err)
	}

	// workCtx scopes the repository-count + row-upsert calls so the lease
	// goroutine can abort them the moment a real heartbeat failure is observed,
	// instead of letting them finish against a stale/revoked lease.
	workCtx, cancelWorkCtx := context.WithCancel(ctx)
	defer cancelWorkCtx()

	lease := startLeaseController(ctx, r.clock, r.ingest, createdRun.RunID, createdRun.LeaseExpiresAt, cancelWorkCtx)
	leaseStopped := false
	stopLease := func() error {
		if leaseStopped {
			return nil
		}

		leaseStopped = true
		if stopErr := lease.Stop(); stopErr != nil {
			return fmt.Errorf("lease heartbeat failed for run %s: %w", createdRun.RunID, stopErr)
		}

		return nil
	}
	defer func() {
		if stopErr := stopLease(); stopErr != nil {
			err = errors.Join(err, stopErr)
		}
	}()

	result = RunResult{
		RunID:      createdRun.RunID,
		AttemptNo:  createdRun.AttemptNo,
		ObservedAt: createdRun.ObservedAt.UTC(),
	}

	// finalizeFailure intentionally runs on a detached ctx so the run is marked
	// failed even when the caller's ctx has been cancelled; threading ctx here
	// would reintroduce the leak the detach was introduced to fix.
	//nolint:contextcheck
	failRun := func(original error) error {
		if original == nil {
			return nil
		}

		// Finalization is the last owner of the run state. Stopping the lease
		// goroutine first preserves a single ordered stream of ingestor writes.
		leaseErr := stopLease()
		// When the lease goroutine cancels workCtx, row-loop callers observe
		// context.Canceled and forward that as `original`. The real root cause
		// lives in `leaseErr` — store it first so D1's ErrorSummary reflects the
		// actual lease failure instead of the cascaded cancellation.
		cause := original
		if leaseErr != nil {
			cause = errors.Join(leaseErr, original)
		}
		finalizeErr := r.finalizeFailure(createdRun.RunID, cause)
		return errors.Join(finalizeErr, leaseErr)
	}

	tasks := buildRunTasks(registry, activeLanguages, activeThresholds, observedDate)

	rows, err := r.collectRows(workCtx, tasks, createdRun.RunID, observedDate, lease)
	if err != nil {
		return result, failRun(err)
	}

	// Skip the batch call when there are no active (language, threshold) pairs.
	// UpsertRows enforces a non-empty contract; sending an empty batch here
	// would be a redundant round-trip and a semantic lie ("we collected nothing
	// on purpose" vs. "there was nothing to collect").
	if len(rows) > 0 {
		if err := r.ingest.UpsertRows(workCtx, rows); err != nil {
			return result, failRun(fmt.Errorf("store rows for run %s: %w", createdRun.RunID, err))
		}
	}

	result.RowsWritten = len(rows)

	if err := stopLease(); err != nil {
		return result, err
	}

	if _, err := r.ingest.HeartbeatRun(ctx, createdRun.RunID); err != nil {
		return result, fmt.Errorf("refresh lease before finalizing run %s: %w", createdRun.RunID, err)
	}

	finalized, err := r.ingest.FinalizeRun(ctx, FinalizeRequest{
		RunID:  createdRun.RunID,
		Status: FinalStatusComplete,
	})
	if err != nil {
		return result, fmt.Errorf("finalize run %s: %w", createdRun.RunID, err)
	}

	result.PublishedAt = finalized.PublishedAt
	return result, nil
}

// runTask flattens the (language, threshold) cartesian product so the worker
// pool can treat each search call as an independent unit. Pre-computing the
// query once avoids duplicating the BuildSearchQuery call in the hot loop.
type runTask struct {
	language  Language
	threshold Threshold
	query     string
}

func buildRunTasks(registry Config, languages []Language, thresholds []Threshold, observedDate Day) []runTask {
	tasks := make([]runTask, 0, len(languages)*len(thresholds))
	for _, language := range languages {
		for _, threshold := range thresholds {
			tasks = append(tasks, runTask{
				language:  language,
				threshold: threshold,
				query:     BuildSearchQuery(registry.WindowDays, language, threshold, observedDate),
			})
		}
	}
	return tasks
}

// collectRows fans search calls out across a worker pool, collects results
// under a mutex, and returns the full batch once every worker finishes.
// errgroup preserves the first real error — sibling workers observe
// context.Canceled after that, and we ignore their cascade when reporting the
// root cause (failRun re-orders leaseErr ahead of original via the caller).
func (r Runner) collectRows(
	ctx context.Context,
	tasks []runTask,
	runID string,
	observedDate Day,
	lease leaseController,
) ([]RowUpsert, error) {
	if leaseErr := lease.PendingError(); leaseErr != nil {
		return nil, fmt.Errorf("lease heartbeat failed for run %s: %w", runID, leaseErr)
	}

	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(r.workerCount)

	var (
		rowsMu sync.Mutex
		rows   = make([]RowUpsert, 0, len(tasks))
	)

	for _, task := range tasks {
		group.Go(func() error {
			// groupCtx is the errgroup-derived ctx: if any sibling worker
			// returns an error, groupCtx is cancelled and CountRepositories
			// observes it immediately instead of burning another GitHub token.
			count, err := r.search.CountRepositories(groupCtx, observedDate, task.query)
			if err != nil {
				return fmt.Errorf("collect %s threshold %d: %w", task.language.ID, task.threshold.Value, err)
			}

			rowsMu.Lock()
			rows = append(rows, RowUpsert{
				RunID:          runID,
				LanguageID:     task.language.ID,
				ThresholdValue: task.threshold.Value,
				Count:          count,
				CollectedAt:    r.clock.Now().UTC(),
			})
			rowsMu.Unlock()
			return nil
		})
	}

	if err := group.Wait(); err != nil {
		return nil, err
	}

	if leaseErr := lease.PendingError(); leaseErr != nil {
		return nil, fmt.Errorf("lease heartbeat failed for run %s: %w", runID, leaseErr)
	}

	return rows, nil
}

func ValidateObservedDate(now time.Time, observedDate Day, launchDate Day) error {
	if observedDate.Before(launchDate) {
		return fmt.Errorf("%w: observed_date=%s launch_date=%s", ErrBeforeLaunchDate, observedDate, launchDate)
	}

	currentUTCDate := DayFromTime(now.UTC())
	if !sameDay(currentUTCDate, observedDate) {
		return fmt.Errorf("%w: observed_date=%s current_utc_date=%s", ErrObservedDateNotCurrentUTC, observedDate, currentUTCDate)
	}

	return nil
}

func ClampRetryDelay(now time.Time, observedDate Day, proposedDelay time.Duration) (time.Duration, bool) {
	if proposedDelay < 0 {
		proposedDelay = 0
	}

	if !sameDay(DayFromTime(now.UTC()), observedDate) {
		return 0, false
	}

	dayClosesAt := observedDate.AddDays(1).UTC()
	remaining := dayClosesAt.Sub(now.UTC())
	if remaining <= 0 {
		return 0, false
	}

	if proposedDelay >= remaining {
		return 0, false
	}

	return proposedDelay, true
}

func sameDay(left Day, right Day) bool {
	return left.Equal(right)
}
