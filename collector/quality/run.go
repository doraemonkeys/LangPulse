package quality

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	maxErrorSummaryLength = 1024
	maxLeaseHeartbeatWait = 30 * time.Second
)

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
	UpsertRow(ctx context.Context, row RowUpsert) error
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
	search RepositoryCounter
	ingest RunIngestor
	clock  Clock
}

type leaseController struct {
	cancel context.CancelFunc
	done   <-chan struct{}
	errors <-chan error
}

type realClock struct{}

func (realClock) Now() time.Time {
	return time.Now().UTC()
}

func startLeaseController(
	parent context.Context,
	clock Clock,
	ingest RunIngestor,
	runID string,
	leaseExpiresAt time.Time,
) leaseController {
	ctx, cancel := context.WithCancel(parent)
	leaseErrors := make(chan error, 1)
	leaseDone := make(chan struct{})

	go func() {
		defer close(leaseDone)
		maintainLease(ctx, clock, ingest, runID, leaseExpiresAt, leaseErrors)
	}()

	return leaseController{
		cancel: cancel,
		done:   leaseDone,
		errors: leaseErrors,
	}
}

func (c leaseController) PendingError() error {
	return pollLeaseError(c.errors)
}

func (c leaseController) Stop() error {
	if c.cancel != nil {
		c.cancel()
	}

	// Terminal run mutations must wait until the background renewer has stopped
	// touching the ingestor so ownership transfers back to the caller cleanly.
	if c.done != nil {
		<-c.done
	}

	return pollLeaseError(c.errors)
}

func NewRunner(search RepositoryCounter, ingest RunIngestor, clock Clock) (Runner, error) {
	switch {
	case search == nil:
		return Runner{}, errors.New("repository counter is required")
	case ingest == nil:
		return Runner{}, errors.New("run ingestor is required")
	case clock == nil:
		clock = realClock{}
	}

	return Runner{
		search: search,
		ingest: ingest,
		clock:  clock,
	}, nil
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

	lease := startLeaseController(ctx, r.clock, r.ingest, createdRun.RunID, createdRun.LeaseExpiresAt)
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

	failRun := func(original error) error {
		if original == nil {
			return nil
		}

		// Finalization is the last owner of the run state. Stopping the lease
		// goroutine first preserves a single ordered stream of ingestor writes.
		leaseErr := stopLease()
		finalizeErr := r.finalizeFailure(ctx, createdRun.RunID, original)
		return errors.Join(finalizeErr, leaseErr)
	}

	for _, language := range activeLanguages {
		for _, threshold := range activeThresholds {
			if err := lease.PendingError(); err != nil {
				return result, failRun(fmt.Errorf("lease heartbeat failed for run %s: %w", createdRun.RunID, err))
			}

			query := BuildSearchQuery(registry.WindowDays, language, threshold, observedDate)
			count, err := r.search.CountRepositories(ctx, observedDate, query)
			if err != nil {
				return result, failRun(fmt.Errorf("collect %s threshold %d: %w", language.ID, threshold.Value, err))
			}

			if err := r.ingest.UpsertRow(ctx, RowUpsert{
				RunID:          createdRun.RunID,
				LanguageID:     language.ID,
				ThresholdValue: threshold.Value,
				Count:          count,
				CollectedAt:    r.clock.Now().UTC(),
			}); err != nil {
				return result, failRun(fmt.Errorf("store %s threshold %d: %w", language.ID, threshold.Value, err))
			}

			result.RowsWritten++
		}
	}

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

func ValidateObservedDate(now time.Time, observedDate Day, launchDate Day) error {
	if observedDate.Before(launchDate.Time) {
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

	dayClosesAt := observedDate.AddDays(1).Time
	remaining := dayClosesAt.Sub(now.UTC())
	if remaining <= 0 {
		return 0, false
	}

	if proposedDelay >= remaining {
		return 0, false
	}

	return proposedDelay, true
}

func summarizeError(err error) string {
	if err == nil {
		return ""
	}

	// The Worker stores diagnostics alongside run history, so the collector keeps
	// the summary bounded instead of sending arbitrarily large payloads.
	summary := strings.TrimSpace(err.Error())
	if len(summary) <= maxErrorSummaryLength {
		return summary
	}

	return strings.TrimSpace(summary[:maxErrorSummaryLength])
}

func (r Runner) finalizeFailure(ctx context.Context, runID string, original error) error {
	if original == nil {
		return nil
	}

	if _, err := r.ingest.HeartbeatRun(ctx, runID); err != nil {
		return errors.Join(original, fmt.Errorf("refresh lease before finalizing run %s: %w", runID, err))
	}

	if _, err := r.ingest.FinalizeRun(ctx, FinalizeRequest{
		RunID:        runID,
		Status:       FinalStatusFailed,
		ErrorSummary: summarizeError(original),
	}); err != nil {
		return errors.Join(original, fmt.Errorf("finalize failed run %s: %w", runID, err))
	}

	return original
}

func maintainLease(
	ctx context.Context,
	clock Clock,
	ingest RunIngestor,
	runID string,
	leaseExpiresAt time.Time,
	leaseErrors chan<- error,
) {
	currentLease := leaseExpiresAt.UTC()

	for {
		wait := nextLeaseHeartbeatDelay(clock.Now(), currentLease)
		timer := time.NewTimer(wait)

		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		heartbeat, err := ingest.HeartbeatRun(ctx, runID)
		if err != nil {
			select {
			case leaseErrors <- err:
			default:
			}
			return
		}

		currentLease = heartbeat.LeaseExpiresAt.UTC()
	}
}

func nextLeaseHeartbeatDelay(now time.Time, leaseExpiresAt time.Time) time.Duration {
	remaining := leaseExpiresAt.UTC().Sub(now.UTC())
	if remaining <= 0 {
		return 0
	}

	wait := remaining / 2
	if wait > maxLeaseHeartbeatWait {
		return maxLeaseHeartbeatWait
	}

	return wait
}

func pollLeaseError(leaseErrors <-chan error) error {
	select {
	case err := <-leaseErrors:
		return err
	default:
		return nil
	}
}

func sameDay(left Day, right Day) bool {
	return left.Equal(right.Time)
}
