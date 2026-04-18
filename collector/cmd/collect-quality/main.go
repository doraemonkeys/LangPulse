package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/langpulse/collector/github"
	"github.com/langpulse/collector/ingest"
	"github.com/langpulse/collector/quality"
)

const (
	envConfigPath    = "LANGPULSE_CONFIG_PATH"
	envObservedDate  = "LANGPULSE_OBSERVED_DATE"
	envGitHubToken   = "GITHUB_TOKEN"
	envGitHubBaseURL = "GITHUB_API_BASE_URL"
	envIngestBaseURL = "LANGPULSE_INGEST_BASE_URL"
	envIngestToken   = "LANGPULSE_INGEST_TOKEN"
)

type settings struct {
	ConfigPath    string
	ObservedDate  quality.Day
	GitHubToken   string
	GitHubBaseURL string
	IngestBaseURL string
	IngestToken   string
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
	if err := execute(ctx, args, getenv, stdout); err != nil {
		if _, writeErr := fmt.Fprintln(stderr, err); writeErr != nil {
			return 1
		}
		return 1
	}

	return 0
}

func execute(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer) error {
	options, err := resolveSettings(args, getenv, time.Now().UTC())
	if err != nil {
		return err
	}

	return runWithSettings(ctx, options, stdout)
}

func runWithSettings(ctx context.Context, options settings, stdout io.Writer) error {
	registry, err := quality.LoadConfigFile(options.ConfigPath)
	if err != nil {
		return err
	}

	githubClient, err := github.NewClient(
		options.GitHubToken,
		github.WithBaseURL(options.GitHubBaseURL),
	)
	if err != nil {
		return err
	}

	ingestClient, err := ingest.NewClient(options.IngestBaseURL, options.IngestToken)
	if err != nil {
		return err
	}

	runner, err := quality.NewRunner(githubClient, ingestClient, nil)
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

	if err := flags.Parse(args); err != nil {
		return settings{}, err
	}

	observedDate, err := quality.ParseDay(*observedDateValue)
	if err != nil {
		return settings{}, err
	}

	options := settings{
		ConfigPath:    *configPath,
		ObservedDate:  observedDate,
		GitHubToken:   strings.TrimSpace(getenv(envGitHubToken)),
		GitHubBaseURL: strings.TrimSpace(*githubBaseURL),
		IngestBaseURL: strings.TrimSpace(*ingestBaseURL),
		IngestToken:   strings.TrimSpace(getenv(envIngestToken)),
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

	if len(problems) > 0 {
		return settings{}, errors.New(strings.Join(problems, "; "))
	}

	return options, nil
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
