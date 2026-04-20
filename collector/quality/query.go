package quality

import (
	"fmt"
	"strings"
)

func BuildSearchQuery(windowDays int, language Language, threshold Threshold, observedDate Day) string {
	from := observedDate.AddDays(-(windowDays - 1))

	// The config owns GitHub qualifier semantics so multi-token languages and
	// future syntax changes do not get reinterpreted by collector code.
	parts := []string{
		language.GitHubQueryFragment,
		"is:public",
		fmt.Sprintf("pushed:>=%s", from),
	}

	if threshold.Value > 0 {
		parts = append(parts, fmt.Sprintf("stars:>=%d", threshold.Value))
	}

	return strings.Join(parts, " ")
}
