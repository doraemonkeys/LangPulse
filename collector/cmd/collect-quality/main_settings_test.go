package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/langpulse/collector/quality"
)

func TestResolveSettingsRequiresServiceCredentials(t *testing.T) {
	_, err := resolveSettings(nil, func(string) string { return "" }, time.Now().UTC())
	if err == nil {
		t.Fatal("resolveSettings() error = nil, want missing credential error")
	}

	for _, snippet := range []string{
		envGitHubToken + " is required",
		envIngestBaseURL + " is required",
		envIngestToken + " is required",
	} {
		if !strings.Contains(err.Error(), snippet) {
			t.Fatalf("resolveSettings() error = %q, want substring %q", err, snippet)
		}
	}
}

func TestResolveSettingsUsesEnvDefaultsAndConfigDiscovery(t *testing.T) {
	tempDir := t.TempDir()
	configDir := filepath.Join(tempDir, "config")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}

	configPath := filepath.Join(configDir, "metrics.json")
	if err := os.WriteFile(configPath, []byte("{}"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	previousWorkingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() error = %v", err)
	}
	t.Cleanup(func() {
		if restoreErr := os.Chdir(previousWorkingDirectory); restoreErr != nil {
			t.Fatalf("restore working directory: %v", restoreErr)
		}
	})

	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("Chdir() error = %v", err)
	}

	now := time.Date(2026, 4, 7, 10, 0, 0, 0, time.UTC)
	environment := map[string]string{
		envObservedDate:  "2026-04-07",
		envGitHubToken:   "github-secret",
		envGitHubBaseURL: "https://github.example",
		envIngestBaseURL: "https://ingest.example",
		envIngestToken:   "ingest-secret",
	}

	options, err := resolveSettings([]string{"-github-api-base-url", "https://override.example"}, func(key string) string {
		return environment[key]
	}, now)
	if err != nil {
		t.Fatalf("resolveSettings() error = %v", err)
	}

	if options.ConfigPath != filepath.Clean("config/metrics.json") {
		t.Fatalf("ConfigPath = %q, want discovered config path", options.ConfigPath)
	}

	if options.GitHubBaseURL != "https://override.example" {
		t.Fatalf("GitHubBaseURL = %q, want flag override", options.GitHubBaseURL)
	}

	if options.ObservedDate.String() != "2026-04-07" {
		t.Fatalf("ObservedDate = %s, want 2026-04-07", options.ObservedDate)
	}
}

func TestResolveConfigPathPrefersExplicitEnvironment(t *testing.T) {
	path := resolveConfigPath(func(key string) string {
		if key == envConfigPath {
			return "/tmp/custom.json"
		}

		return ""
	})

	if path != "/tmp/custom.json" {
		t.Fatalf("resolveConfigPath() = %q, want custom path", path)
	}
}

// TestBuildRateLimiterProducesRequestedPace exercises the helper directly so
// the rpm->interval conversion is covered even when no end-to-end CLI path
// sets a non-zero rpm.
func TestBuildRateLimiterProducesRequestedPace(t *testing.T) {
	limiter := buildRateLimiter(60, 4)
	if limiter == nil {
		t.Fatal("buildRateLimiter(60, 4) returned nil")
	}

	// 60 rpm = 1 req/sec = rate.Every(time.Second). Limit should reflect it.
	if got := limiter.Limit(); got < 0.99 || got > 1.01 {
		t.Fatalf("limiter.Limit() = %v, want ~1 token/sec", got)
	}
	if got := limiter.Burst(); got != 4 {
		t.Fatalf("limiter.Burst() = %d, want 4", got)
	}
}

// TestBuildRateLimiterFallsBackOnZeroArguments guards the defensive path
// callers might hit if they pass this helper a 0 sentinel directly (via a
// future refactor). The helper should not divide by zero or return nil.
func TestBuildRateLimiterFallsBackOnZeroArguments(t *testing.T) {
	limiter := buildRateLimiter(0, 0)
	if limiter == nil {
		t.Fatal("buildRateLimiter(0, 0) returned nil")
	}
	if limiter.Burst() < 1 {
		t.Fatalf("limiter.Burst() = %d, want >= 1 (sentinel fallback)", limiter.Burst())
	}
}

// TestParseNonNegativeIntRejectsNegatives and malformed inputs covers the
// defensive env-parsing branch that keeps a stray "-1" in an env var from
// crashing the CLI.
func TestParseNonNegativeIntRejectsNegatives(t *testing.T) {
	if got := parseNonNegativeInt("-5"); got != 0 {
		t.Fatalf("parseNonNegativeInt(\"-5\") = %d, want 0 sentinel", got)
	}

	if got := parseNonNegativeInt("not-an-int"); got != 0 {
		t.Fatalf("parseNonNegativeInt(\"not-an-int\") = %d, want 0 sentinel", got)
	}

	if got := parseNonNegativeInt("  42  "); got != 42 {
		t.Fatalf("parseNonNegativeInt(\"  42  \") = %d, want 42", got)
	}
}

func TestResolveSettingsParsesRateLimitAndConcurrencyFromEnv(t *testing.T) {
	environment := map[string]string{
		envGitHubToken:             "github-secret",
		envIngestBaseURL:           "https://ingest.example",
		envIngestToken:             "ingest-secret",
		envObservedDate:            "2026-04-07",
		envGitHubRequestsPerMinute: "45",
		envGitHubRequestBurst:      "3",
		envCollectorConcurrency:    "8",
	}

	options, err := resolveSettings(nil, func(key string) string { return environment[key] }, time.Now().UTC())
	if err != nil {
		t.Fatalf("resolveSettings() error = %v", err)
	}

	if options.GitHubRequestsPerMinute != 45 {
		t.Fatalf("GitHubRequestsPerMinute = %d, want %d", options.GitHubRequestsPerMinute, 45)
	}
	if options.GitHubRequestBurst != 3 {
		t.Fatalf("GitHubRequestBurst = %d, want %d", options.GitHubRequestBurst, 3)
	}
	if options.Concurrency != 8 {
		t.Fatalf("Concurrency = %d, want %d", options.Concurrency, 8)
	}
}

func TestResolveSettingsParsesRateLimitAndConcurrencyFromFlags(t *testing.T) {
	environment := map[string]string{
		envGitHubToken:   "github-secret",
		envIngestBaseURL: "https://ingest.example",
		envIngestToken:   "ingest-secret",
		envObservedDate:  "2026-04-07",
	}

	args := []string{
		"-github-requests-per-minute", "60",
		"-github-request-burst", "2",
		"-concurrency", "6",
	}

	options, err := resolveSettings(args, func(key string) string { return environment[key] }, time.Now().UTC())
	if err != nil {
		t.Fatalf("resolveSettings() error = %v", err)
	}

	if options.GitHubRequestsPerMinute != 60 {
		t.Fatalf("GitHubRequestsPerMinute = %d, want %d", options.GitHubRequestsPerMinute, 60)
	}
	if options.GitHubRequestBurst != 2 {
		t.Fatalf("GitHubRequestBurst = %d, want %d", options.GitHubRequestBurst, 2)
	}
	if options.Concurrency != 6 {
		t.Fatalf("Concurrency = %d, want %d", options.Concurrency, 6)
	}
}

// TestResolveSettingsFlagsOverrideEnv mirrors the precedence semantics already
// applied to --github-api-base-url: flag wins when both are present.
func TestResolveSettingsFlagsOverrideEnv(t *testing.T) {
	environment := map[string]string{
		envGitHubToken:             "github-secret",
		envIngestBaseURL:           "https://ingest.example",
		envIngestToken:             "ingest-secret",
		envObservedDate:            "2026-04-07",
		envGitHubRequestsPerMinute: "10",
		envGitHubRequestBurst:      "1",
		envCollectorConcurrency:    "2",
	}

	args := []string{
		"-github-requests-per-minute", "90",
		"-github-request-burst", "5",
		"-concurrency", "12",
	}

	options, err := resolveSettings(args, func(key string) string { return environment[key] }, time.Now().UTC())
	if err != nil {
		t.Fatalf("resolveSettings() error = %v", err)
	}

	if options.GitHubRequestsPerMinute != 90 {
		t.Fatalf("GitHubRequestsPerMinute = %d, want flag override %d", options.GitHubRequestsPerMinute, 90)
	}
	if options.GitHubRequestBurst != 5 {
		t.Fatalf("GitHubRequestBurst = %d, want flag override %d", options.GitHubRequestBurst, 5)
	}
	if options.Concurrency != 12 {
		t.Fatalf("Concurrency = %d, want flag override %d", options.Concurrency, 12)
	}
}

// TestResolveSettingsDefaultsWhenUnset guarantees unset rpm/burst stay at the
// "use client default" sentinel (0) while concurrency falls back to its own
// CLI default so the Runner's fan-out remains predictable out of the box.
func TestResolveSettingsDefaultsWhenUnset(t *testing.T) {
	environment := map[string]string{
		envGitHubToken:   "github-secret",
		envIngestBaseURL: "https://ingest.example",
		envIngestToken:   "ingest-secret",
		envObservedDate:  "2026-04-07",
	}

	options, err := resolveSettings(nil, func(key string) string { return environment[key] }, time.Now().UTC())
	if err != nil {
		t.Fatalf("resolveSettings() error = %v", err)
	}

	if options.GitHubRequestsPerMinute != 0 {
		t.Fatalf("GitHubRequestsPerMinute = %d, want 0 sentinel", options.GitHubRequestsPerMinute)
	}
	if options.GitHubRequestBurst != 0 {
		t.Fatalf("GitHubRequestBurst = %d, want 0 sentinel", options.GitHubRequestBurst)
	}
	if options.Concurrency != quality.DefaultWorkerConcurrency {
		t.Fatalf("Concurrency = %d, want default %d", options.Concurrency, quality.DefaultWorkerConcurrency)
	}
}

func TestResolveSettingsRejectsInvalidInputs(t *testing.T) {
	_, err := resolveSettings([]string{"-observed-date", "2026/04/07"}, func(key string) string {
		switch key {
		case envGitHubToken:
			return "github-secret"
		case envIngestBaseURL:
			return "https://ingest.example"
		case envIngestToken:
			return "ingest-secret"
		default:
			return ""
		}
	}, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "parse UTC date") {
		t.Fatalf("resolveSettings(invalid observed date) error = %v, want date parse error", err)
	}

	_, err = resolveSettings([]string{"-unknown-flag"}, func(key string) string {
		switch key {
		case envGitHubToken:
			return "github-secret"
		case envIngestBaseURL:
			return "https://ingest.example"
		case envIngestToken:
			return "ingest-secret"
		default:
			return ""
		}
	}, time.Now().UTC())
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("resolveSettings(invalid flag) error = %v, want flag parse error", err)
	}
}
