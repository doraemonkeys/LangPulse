package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"net/http"
	"net/http/httptest"

	"github.com/langpulse/collector/quality"
)

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

type ingestRunFixture struct {
	RunID          string
	ObservedAt     time.Time
	FinalStatus    quality.FinalStatus
	PublishedAt    *time.Time
	AllowRowUpsert bool
}

func TestExecuteRunsCollectorPipeline(t *testing.T) {
	today := time.Now().UTC()
	observedDate := today.Format("2006-01-02")
	launchDate := today.AddDate(0, 0, -7).Format("2006-01-02")

	configPath := filepath.Join(t.TempDir(), "metrics.json")
	if err := os.WriteFile(configPath, []byte(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "`+launchDate+`",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "`+launchDate+`",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "`+launchDate+`", "active_to": null }
		]
	}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	githubServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := json.NewEncoder(writer).Encode(map[string]any{
			"total_count":        33,
			"incomplete_results": false,
		}); err != nil {
			t.Fatalf("Encode(github) error = %v", err)
		}
	}))
	defer githubServer.Close()

	publishedAt := today.Add(time.Minute)
	ingestServer := newIngestRunServer(t, ingestRunFixture{
		RunID:          "run-1",
		ObservedAt:     today,
		FinalStatus:    quality.FinalStatusComplete,
		PublishedAt:    &publishedAt,
		AllowRowUpsert: true,
	})
	defer ingestServer.Close()

	environment := map[string]string{
		envGitHubToken:   "github-secret",
		envGitHubBaseURL: githubServer.URL,
		envIngestBaseURL: ingestServer.URL,
		envIngestToken:   "ingest-secret",
	}

	var output strings.Builder
	err := execute(
		context.Background(),
		[]string{"-config", configPath, "-observed-date", observedDate},
		func(key string) string { return environment[key] },
		&output,
	)
	if err != nil {
		t.Fatalf("execute() error = %v", err)
	}

	if got := output.String(); !strings.Contains(got, "run_id=run-1") {
		t.Fatalf("execute() output = %q, want run summary", got)
	}
}

func TestRunMainWritesErrorsAndExitCode(t *testing.T) {
	var stdout strings.Builder
	var stderr strings.Builder

	code := runMain(
		context.Background(),
		nil,
		func(string) string { return "" },
		&stdout,
		&stderr,
	)

	if code != 1 {
		t.Fatalf("runMain() = %d, want %d", code, 1)
	}

	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want empty stdout on error", stdout.String())
	}

	if !strings.Contains(stderr.String(), envGitHubToken+" is required") {
		t.Fatalf("stderr = %q, want missing credential message", stderr.String())
	}
}

func TestExecuteReturnsConfigLoadError(t *testing.T) {
	err := execute(
		context.Background(),
		[]string{"-config", filepath.Join(t.TempDir(), "missing.json"), "-observed-date", time.Now().UTC().Format("2006-01-02")},
		func(key string) string {
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
		},
		&strings.Builder{},
	)
	if err == nil || !strings.Contains(err.Error(), "open metrics config") {
		t.Fatalf("execute() error = %v, want config load error", err)
	}
}

func TestRunMainReturnsSuccessAndNoStderr(t *testing.T) {
	today := time.Now().UTC()
	observedDate := today.Format("2006-01-02")
	launchDate := today.AddDate(0, 0, -7).Format("2006-01-02")

	configPath := filepath.Join(t.TempDir(), "metrics.json")
	if err := os.WriteFile(configPath, []byte(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "`+launchDate+`",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "`+launchDate+`",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "`+launchDate+`", "active_to": null }
		]
	}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	githubServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`{"total_count":1,"incomplete_results":false}`))
	}))
	defer githubServer.Close()

	publishedAt := today.Add(time.Minute)
	ingestServer := newIngestRunServer(t, ingestRunFixture{
		RunID:          "run-main",
		ObservedAt:     today,
		FinalStatus:    quality.FinalStatusComplete,
		PublishedAt:    &publishedAt,
		AllowRowUpsert: true,
	})
	defer ingestServer.Close()

	environment := map[string]string{
		envGitHubToken:   "github-secret",
		envGitHubBaseURL: githubServer.URL,
		envIngestBaseURL: ingestServer.URL,
		envIngestToken:   "ingest-secret",
	}

	var stdout strings.Builder
	var stderr strings.Builder
	code := runMain(
		context.Background(),
		[]string{"-config", configPath, "-observed-date", observedDate},
		func(key string) string { return environment[key] },
		&stdout,
		&stderr,
	)

	if code != 0 {
		t.Fatalf("runMain() = %d, want %d", code, 0)
	}

	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty stderr", stderr.String())
	}

	if !strings.Contains(stdout.String(), "run_id=run-main") {
		t.Fatalf("stdout = %q, want run summary", stdout.String())
	}
}

func TestExecuteReturnsCollectorError(t *testing.T) {
	today := time.Now().UTC()
	observedDate := today.Format("2006-01-02")
	launchDate := today.AddDate(0, 0, -7).Format("2006-01-02")

	configPath := filepath.Join(t.TempDir(), "metrics.json")
	if err := os.WriteFile(configPath, []byte(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "`+launchDate+`",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "`+launchDate+`",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "`+launchDate+`", "active_to": null }
		]
	}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	githubServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`{"total_count":1,"incomplete_results":true}`))
	}))
	defer githubServer.Close()

	ingestServer := newIngestRunServer(t, ingestRunFixture{
		RunID:       "run-error",
		ObservedAt:  today,
		FinalStatus: quality.FinalStatusFailed,
	})
	defer ingestServer.Close()

	err := execute(
		context.Background(),
		[]string{"-config", configPath, "-observed-date", observedDate},
		func(key string) string {
			switch key {
			case envGitHubToken:
				return "github-secret"
			case envGitHubBaseURL:
				return githubServer.URL
			case envIngestBaseURL:
				return ingestServer.URL
			case envIngestToken:
				return "ingest-secret"
			default:
				return ""
			}
		},
		&strings.Builder{},
	)
	if err == nil || !strings.Contains(err.Error(), "incomplete results") {
		t.Fatalf("execute() error = %v, want collector error", err)
	}
}

func TestRunWithSettingsReturnsClientConstructionErrors(t *testing.T) {
	configPath := writeMetricsConfig(t, time.Now().UTC())
	observedDate := mustObservedDate(t, time.Now().UTC().Format("2006-01-02"))

	err := runWithSettings(context.Background(), settings{
		ConfigPath:    configPath,
		ObservedDate:  observedDate,
		GitHubToken:   "",
		IngestBaseURL: "https://ingest.example",
		IngestToken:   "ingest-secret",
	}, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "github token is required") {
		t.Fatalf("runWithSettings(missing github token) error = %v, want github client error", err)
	}

	err = runWithSettings(context.Background(), settings{
		ConfigPath:   configPath,
		ObservedDate: observedDate,
		GitHubToken:  "github-secret",
		IngestToken:  "ingest-secret",
	}, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "ingest base URL is required") {
		t.Fatalf("runWithSettings(missing ingest base URL) error = %v, want ingest client error", err)
	}
}

// TestRunWithSettingsAppliesRateLimitAndConcurrency covers the branch that
// actually threads the CLI's rpm/burst/concurrency into github.WithRateLimit
// and quality.WithConcurrency. A regression here is invisible from the
// resolveSettings unit tests (which only validate parsing, not wiring).
func TestRunWithSettingsAppliesRateLimitAndConcurrency(t *testing.T) {
	now := time.Now().UTC()
	configPath := writeMetricsConfig(t, now)
	observedDate := now.Format("2006-01-02")

	githubServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`{"total_count":1,"incomplete_results":false}`))
	}))
	defer githubServer.Close()

	publishedAt := now.Add(time.Minute)
	ingestServer := newIngestRunServer(t, ingestRunFixture{
		RunID:          "run-tuned",
		ObservedAt:     now,
		FinalStatus:    quality.FinalStatusComplete,
		PublishedAt:    &publishedAt,
		AllowRowUpsert: true,
	})
	defer ingestServer.Close()

	var stdout strings.Builder
	err := runWithSettings(context.Background(), settings{
		ConfigPath:              configPath,
		ObservedDate:            mustObservedDate(t, observedDate),
		GitHubToken:             "github-secret",
		GitHubBaseURL:           githubServer.URL,
		IngestBaseURL:           ingestServer.URL,
		IngestToken:             "ingest-secret",
		GitHubRequestsPerMinute: 600, // 10 req/sec: fast enough not to stall the test
		GitHubRequestBurst:      5,
		Concurrency:             2,
	}, &stdout)
	if err != nil {
		t.Fatalf("runWithSettings() error = %v", err)
	}

	if !strings.Contains(stdout.String(), "run_id=run-tuned") {
		t.Fatalf("stdout = %q, want tuned run summary", stdout.String())
	}
}

func TestRunWithSettingsReturnsWriterError(t *testing.T) {
	now := time.Now().UTC()
	configPath := writeMetricsConfig(t, now)
	observedDate := now.Format("2006-01-02")

	githubServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = writer.Write([]byte(`{"total_count":1,"incomplete_results":false}`))
	}))
	defer githubServer.Close()

	publishedAt := now.Add(time.Minute)
	ingestServer := newIngestRunServer(t, ingestRunFixture{
		RunID:          "run-write",
		ObservedAt:     now,
		FinalStatus:    quality.FinalStatusComplete,
		PublishedAt:    &publishedAt,
		AllowRowUpsert: true,
	})
	defer ingestServer.Close()

	err := runWithSettings(context.Background(), settings{
		ConfigPath:    configPath,
		ObservedDate:  mustObservedDate(t, observedDate),
		GitHubToken:   "github-secret",
		GitHubBaseURL: githubServer.URL,
		IngestBaseURL: ingestServer.URL,
		IngestToken:   "ingest-secret",
	}, failingWriter{})
	if err == nil || !strings.Contains(err.Error(), "write collector summary") {
		t.Fatalf("runWithSettings(writer failure) error = %v, want writer error", err)
	}
}

func mustObservedDate(t *testing.T, raw string) quality.Day {
	t.Helper()

	day, err := quality.ParseDay(raw)
	if err != nil {
		t.Fatalf("ParseDay(%q) error = %v", raw, err)
	}

	return day
}

func newIngestRunServer(t *testing.T, fixture ingestRunFixture) *httptest.Server {
	t.Helper()

	observedAt := fixture.ObservedAt.UTC()
	createPayload := map[string]any{
		"run": encodeIngestRun(fixture.RunID, "running", observedAt, observedAt.Add(10*time.Minute)),
	}
	heartbeatPayload := map[string]any{
		"run": encodeIngestRun(fixture.RunID, "running", observedAt, observedAt.Add(20*time.Minute)),
	}
	finalizePayload := map[string]any{
		"run":          encodeIngestRun(fixture.RunID, string(fixture.FinalStatus), observedAt, observedAt.Add(20*time.Minute)),
		"published_at": nil,
	}
	if fixture.PublishedAt != nil {
		finalizePayload["published_at"] = fixture.PublishedAt.UTC().Format(time.RFC3339)
	}

	// The runner now writes via the Google AIP-style batch endpoint rather
	// than the per-row path, so the fixture accepts a single rows:batch call
	// and echoes the heartbeat-shaped run payload the collector expects.
	rowsBatchPayload := map[string]any{
		"run": encodeIngestRun(fixture.RunID, "running", observedAt, observedAt.Add(20*time.Minute)),
	}

	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/quality-runs":
			mustEncodeJSONPayload(t, writer, createPayload, "create")
		case "/internal/quality-runs/" + fixture.RunID + "/heartbeat":
			mustEncodeJSONPayload(t, writer, heartbeatPayload, "heartbeat")
		case "/internal/quality-runs/" + fixture.RunID + "/rows:batch":
			if !fixture.AllowRowUpsert {
				t.Fatalf("unexpected path %q", request.URL.Path)
			}
			mustEncodeJSONPayload(t, writer, rowsBatchPayload, "rows:batch")
		case "/internal/quality-runs/" + fixture.RunID + "/finalize":
			mustEncodeJSONPayload(t, writer, finalizePayload, "finalize")
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
}

func encodeIngestRun(runID string, status string, observedAt time.Time, leaseExpiresAt time.Time) map[string]any {
	return map[string]any{
		"run_id":           runID,
		"attempt_no":       1,
		"status":           status,
		"observed_at":      observedAt.UTC().Format(time.RFC3339),
		"lease_expires_at": leaseExpiresAt.UTC().Format(time.RFC3339),
	}
}

func mustEncodeJSONPayload(t *testing.T, writer http.ResponseWriter, payload map[string]any, operation string) {
	t.Helper()

	if err := json.NewEncoder(writer).Encode(payload); err != nil {
		t.Fatalf("Encode(%s) error = %v", operation, err)
	}
}

func writeMetricsConfig(t *testing.T, now time.Time) string {
	t.Helper()

	launchDate := now.AddDate(0, 0, -7).Format("2006-01-02")
	configPath := filepath.Join(t.TempDir(), "metrics.json")
	if err := os.WriteFile(configPath, []byte(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "`+launchDate+`",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "`+launchDate+`",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "`+launchDate+`", "active_to": null }
		]
	}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	return configPath
}
