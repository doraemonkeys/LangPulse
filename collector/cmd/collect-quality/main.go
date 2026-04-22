package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"github.com/langpulse/collector/github"
	"github.com/langpulse/collector/ingest"
	"github.com/langpulse/collector/quality"
)

const (
	envConfigPath              = "LANGPULSE_CONFIG_PATH"
	envObservedDate            = "LANGPULSE_OBSERVED_DATE"
	envGitHubToken             = "GITHUB_TOKEN"
	envGitHubBaseURL           = "GITHUB_API_BASE_URL"
	envIngestBaseURL           = "LANGPULSE_INGEST_BASE_URL"
	envIngestToken             = "LANGPULSE_INGEST_TOKEN"
	envGitHubRequestsPerMinute = "LANGPULSE_GITHUB_REQUESTS_PER_MINUTE"
	envGitHubRequestBurst      = "LANGPULSE_GITHUB_REQUEST_BURST"
	envCollectorConcurrency    = "LANGPULSE_COLLECTOR_CONCURRENCY"
)

type settings struct {
	ConfigPath              string
	ObservedDate            quality.Day
	GitHubToken             string
	GitHubBaseURL           string
	IngestBaseURL           string
	IngestToken             string
	GitHubRequestsPerMinute int
	GitHubRequestBurst      int
	Concurrency             int
}

func main() {
	os.Exit(runMain(context.Background(), os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func runMain(
	ctx context.Context,
	args []string,
	getenv func(string) string,
	stdout io.Writer,
	stderr io.Writer,
) int {
	// stderr owns both error messages and structured progress logs. Keeping
	// logs off stdout preserves the "stdout is the summary contract" promise
	// callers rely on to parse run_id/rows lines.
	logger := slog.New(slog.NewTextHandler(stderr, nil))
	if err := execute(ctx, args, getenv, stdout, logger); err != nil {
		if _, writeErr := fmt.Fprintln(stderr, err); writeErr != nil {
			return 1
		}
		return 1
	}

	return 0
}

func execute(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer, logger *slog.Logger) error {
	options, err := resolveSettings(args, getenv, time.Now().UTC())
	if err != nil {
		return err
	}

	return runWithSettings(ctx, options, stdout, logger)
}

func runWithSettings(ctx context.Context, options settings, stdout io.Writer, logger *slog.Logger) error {
	registry, err := quality.LoadConfigFile(options.ConfigPath)
	if err != nil {
		return err
	}

	githubOptions := []github.Option{
		github.WithBaseURL(options.GitHubBaseURL),
		github.WithLogger(logger.With(slog.String("component", "github"))),
	}
	// rpm==0 or burst==0 means "trust github.NewClient's built-in defaults".
	// Only build a limiter when operators explicitly tuned at least one knob,
	// so there's exactly one place that owns the default pacing value.
	if options.GitHubRequestsPerMinute > 0 || options.GitHubRequestBurst > 0 {
		limiter := buildRateLimiter(options.GitHubRequestsPerMinute, options.GitHubRequestBurst)
		githubOptions = append(githubOptions, github.WithRateLimit(limiter))
	}

	githubClient, err := github.NewClient(options.GitHubToken, githubOptions...)
	if err != nil {
		return err
	}

	ingestClient, err := ingest.NewClient(options.IngestBaseURL, options.IngestToken)
	if err != nil {
		return err
	}

	runnerOptions := []quality.Option{
		quality.WithLogger(logger.With(slog.String("component", "runner"))),
	}
	if options.Concurrency > 0 {
		runnerOptions = append(runnerOptions, quality.WithConcurrency(options.Concurrency))
	}

	runner, err := quality.NewRunner(githubClient, ingestClient, nil, runnerOptions...)
	if err != nil {
		return err
	}

	result, err := runner.Run(ctx, registry, options.ObservedDate)
	if err != nil {
		return err
	}

	if _, err := fmt.Fprintf(
		stdout,
		"run_id=%s attempt_no=%d rows=%d observed_at=%s\n",
		result.RunID,
		result.AttemptNo,
		result.RowsWritten,
		result.ObservedAt.Format(time.RFC3339),
	); err != nil {
		return fmt.Errorf("write collector summary: %w", err)
	}

	return nil
}

// buildRateLimiter constructs a *rate.Limiter from resolved rpm/burst settings.
// Zero values on either field fall back to the github package's exported
// defaults so there is exactly one source of truth for the default pacing
// values shared between NewClient's built-in path and this CLI fallback.
func buildRateLimiter(requestsPerMinute int, burst int) *rate.Limiter {
	effectiveRPM := requestsPerMinute
	if effectiveRPM <= 0 {
		// Fallback path: github.NewClient would apply the same default when
		// no limiter is passed in, but once the CLI decides to inject a
		// limiter we must produce a valid one, so reuse the same exported
		// constant rather than hard-coding the number twice.
		effectiveRPM = github.DefaultRequestsPerMinute
	}

	effectiveBurst := burst
	if effectiveBurst <= 0 {
		effectiveBurst = github.DefaultRequestBurst
	}

	interval := time.Minute / time.Duration(effectiveRPM)
	return rate.NewLimiter(rate.Every(interval), effectiveBurst)
}

func resolveSettings(args []string, getenv func(string) string, now time.Time) (settings, error) {
	flags := flag.NewFlagSet("collect-quality", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	defaultObservedDate := strings.TrimSpace(getenv(envObservedDate))
	if defaultObservedDate == "" {
		defaultObservedDate = quality.DayFromTime(now.UTC()).String()
	}

	defaultConfigPath := resolveConfigPath(getenv)
	configPath := flags.String("config", defaultConfigPath, "path to config/metrics.json")
	observedDateValue := flags.String("observed-date", defaultObservedDate, "target UTC date in YYYY-MM-DD")
	githubBaseURL := flags.String("github-api-base-url", strings.TrimSpace(getenv(envGitHubBaseURL)), "GitHub API base URL")
	ingestBaseURL := flags.String("ingest-base-url", strings.TrimSpace(getenv(envIngestBaseURL)), "ingest API base URL")

	// 0 on rpm/burst is a sentinel meaning "use client default" ? env parse
	// errors also collapse to 0 so a malformed env var can't crash the CLI.
	defaultRPM := parseNonNegativeInt(getenv(envGitHubRequestsPerMinute))
	defaultBurst := parseNonNegativeInt(getenv(envGitHubRequestBurst))
	defaultConcurrency := parseNonNegativeInt(getenv(envCollectorConcurrency))
	if defaultConcurrency == 0 {
		defaultConcurrency = quality.DefaultWorkerConcurrency
	}

	requestsPerMinute := flags.Int("github-requests-per-minute", defaultRPM, "GitHub search requests per minute (0 = client default)")
	requestBurst := flags.Int("github-request-burst", defaultBurst, "GitHub search limiter burst size (0 = client default)")
	concurrency := flags.Int("concurrency", defaultConcurrency, "parallel GitHub search workers")

	if err := flags.Parse(args); err != nil {
		return settings{}, err
	}

	observedDate, err := quality.ParseDay(*observedDateValue)
	if err != nil {
		return settings{}, err
	}

	options := settings{
		ConfigPath:              *configPath,
		ObservedDate:            observedDate,
		GitHubToken:             strings.TrimSpace(getenv(envGitHubToken)),
		GitHubBaseURL:           strings.TrimSpace(*githubBaseURL),
		IngestBaseURL:           strings.TrimSpace(*ingestBaseURL),
		IngestToken:             strings.TrimSpace(getenv(envIngestToken)),
		GitHubRequestsPerMinute: *requestsPerMinute,
		GitHubRequestBurst:      *requestBurst,
		Concurrency:             *concurrency,
	}

	var problems []string
	if options.ConfigPath == "" {
		problems = append(problems, "config path is required")
	}
	if options.GitHubToken == "" {
		problems = append(problems, envGitHubToken+" is required")
	}
	if options.IngestBaseURL == "" {
		problems = append(problems, envIngestBaseURL+" is required")
	}
	if options.IngestToken == "" {
		problems = append(problems, envIngestToken+" is required")
	}
	if options.GitHubRequestsPerMinute < 0 {
		problems = append(problems, "--github-requests-per-minute must be >= 0")
	}
	if options.GitHubRequestBurst < 0 {
		problems = append(problems, "--github-request-burst must be >= 0")
	}
	if options.Concurrency < 1 {
		problems = append(problems, "--concurrency must be >= 1")
	}

	if len(problems) > 0 {
		return settings{}, errors.New(strings.Join(problems, "; "))
	}

	return options, nil
}

// parseNonNegativeInt keeps env parsing defensive: a missing, blank, or
// malformed variable collapses to 0 (the "use default" sentinel) instead of
// bubbling an error up to the CLI entry point. The downstream validation in
// resolveSettings still rejects negative flag values supplied explicitly.
func parseNonNegativeInt(raw string) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0
	}

	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed < 0 {
		return 0
	}

	return parsed
}

func resolveConfigPath(getenv func(string) string) string {
	if configured := strings.TrimSpace(getenv(envConfigPath)); configured != "" {
		return configured
	}

	candidates := []string{
		filepath.Clean("config/metrics.json"),
		filepath.Clean("../config/metrics.json"),
	}

	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	return candidates[0]
}
