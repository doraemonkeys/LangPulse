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
	// finalizeFailureTimeout bounds the detached context used to mark a run
	// failed after a cancellation (SIGINT, test deadline) has already propagated
	// through the caller's ctx. Without a detached deadline, the run would leak
	// in `running` state until the Worker's lease sweeper reaps it.
	finalizeFailureTimeout = 30 * time.Second
)

type leaseController struct {
	cancel context.CancelFunc
	done   <-chan struct{}
	errors <-chan error
}

func startLeaseController(
	parent context.Context,
	clock Clock,
	ingest RunIngestor,
	runID string,
	leaseExpiresAt time.Time,
	cancelWork context.CancelFunc,
) leaseController {
	ctx, cancel := context.WithCancel(parent)
	leaseErrors := make(chan error, 1)
	leaseDone := make(chan struct{})

	go func() {
		defer close(leaseDone)
		maintainLease(ctx, clock, ingest, runID, leaseExpiresAt, leaseErrors, cancelWork)
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

func maintainLease(
	ctx context.Context,
	clock Clock,
	ingest RunIngestor,
	runID string,
	leaseExpiresAt time.Time,
	leaseErrors chan<- error,
	cancelWork context.CancelFunc,
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
			// Filter shutdown-origin errors: if ctx was already cancelled,
			// lease.Stop() reaped a heartbeat that was mid-flight. That's not a
			// lease failure — the caller is tearing us down.
			if ctx.Err() != nil {
				return
			}
			select {
			case leaseErrors <- err:
			default:
			}
			// Propagate the failure to the caller's work ctx so in-flight
			// search/upsert calls abort immediately instead of waiting for the
			// next row-loop iteration's PendingError() poll.
			if cancelWork != nil {
				cancelWork()
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

func (r Runner) finalizeFailure(runID string, original error) error {
	if original == nil {
		return nil
	}

	// Detached from the caller's ctx: if the run was aborted because the parent
	// ctx was cancelled (SIGINT, harness deadline), we still need to mark the
	// run failed server-side. Inheriting the cancelled ctx would leak the run in
	// `running` state until the Worker's lease sweeper reaps it.
	ctx, cancel := context.WithTimeout(context.Background(), finalizeFailureTimeout)
	defer cancel()

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
