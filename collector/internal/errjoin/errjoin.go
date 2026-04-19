package errjoin

import (
	"errors"
	"fmt"
)

// Join preserves the primary error while surfacing cleanup failures from
// deferred resource ownership hand-offs.
func Join(err error, operation string, cleanup func() error) error {
	if cleanup == nil {
		return err
	}

	cleanupErr := cleanup()
	if cleanupErr == nil {
		return err
	}

	if operation != "" {
		cleanupErr = fmt.Errorf("%s: %w", operation, cleanupErr)
	}

	return errors.Join(err, cleanupErr)
}
