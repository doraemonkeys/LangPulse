package errjoin

import (
	"errors"
	"strings"
	"testing"
)

func TestJoinReturnsOriginalErrorWhenCleanupSucceeds(t *testing.T) {
	original := errors.New("original")

	err := Join(original, "close resource", func() error {
		return nil
	})

	if !errors.Is(err, original) {
		t.Fatalf("Join() error = %v, want original error", err)
	}
}

func TestJoinReturnsOriginalErrorWhenCleanupIsNil(t *testing.T) {
	original := errors.New("original")

	err := Join(original, "close resource", nil)

	if !errors.Is(err, original) {
		t.Fatalf("Join() error = %v, want original error", err)
	}
}

func TestJoinReturnsWrappedCleanupErrorWhenOriginalIsNil(t *testing.T) {
	cleanupErr := errors.New("close failed")

	err := Join(nil, "close resource", func() error {
		return cleanupErr
	})

	if !errors.Is(err, cleanupErr) {
		t.Fatalf("Join() error = %v, want cleanup error", err)
	}
	if !strings.Contains(err.Error(), "close resource") {
		t.Fatalf("Join() error = %q, want operation context", err)
	}
}

func TestJoinReturnsCleanupErrorWithoutExtraContextWhenOperationIsBlank(t *testing.T) {
	cleanupErr := errors.New("close failed")

	err := Join(nil, "", func() error {
		return cleanupErr
	})

	if !errors.Is(err, cleanupErr) {
		t.Fatalf("Join() error = %v, want cleanup error", err)
	}
	if err.Error() != cleanupErr.Error() {
		t.Fatalf("Join() error = %q, want bare cleanup error", err)
	}
}

func TestJoinPreservesBothErrors(t *testing.T) {
	original := errors.New("original")
	cleanupErr := errors.New("close failed")

	err := Join(original, "close resource", func() error {
		return cleanupErr
	})

	if !errors.Is(err, original) {
		t.Fatalf("Join() error = %v, want original error", err)
	}
	if !errors.Is(err, cleanupErr) {
		t.Fatalf("Join() error = %v, want cleanup error", err)
	}
}
