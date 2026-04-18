package quality

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigResolvesActiveRanges(t *testing.T) {
	registry, err := LoadConfig(strings.NewReader(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "2026-04-01",
				"active_to": null
			},
			{
				"id": "rust",
				"label": "Rust",
				"github_query_fragment": "language:\"rust\"",
				"active_from": "2026-04-01",
				"active_to": "2026-04-15"
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "2026-04-01", "active_to": null },
			{ "value": 10, "active_from": "2026-04-10", "active_to": null }
		]
	}`))
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	if got := registry.Languages[0].ID; got != "go" {
		t.Fatalf("Languages[0].ID = %q, want %q", got, "go")
	}

	if got := registry.Languages[0].Label; got != "Go" {
		t.Fatalf("Languages[0].Label = %q, want %q", got, "Go")
	}

	if got := registry.Languages[0].GitHubQueryFragment; got != `language:"go"` {
		t.Fatalf("Languages[0].GitHubQueryFragment = %q, want %q", got, `language:"go"`)
	}

	earlyDate := mustParseDay(t, "2026-04-05")
	if got := registry.ExpectedRows(earlyDate); got != 2 {
		t.Fatalf("ExpectedRows(earlyDate) = %d, want %d", got, 2)
	}

	lateDate := mustParseDay(t, "2026-04-20")
	activeLanguages := registry.ActiveLanguages(lateDate)
	if len(activeLanguages) != 1 || activeLanguages[0].ID != "go" {
		t.Fatalf("ActiveLanguages(lateDate) = %#v, want only go", activeLanguages)
	}

	activeThresholds := registry.ActiveThresholds(lateDate)
	if len(activeThresholds) != 2 {
		t.Fatalf("len(ActiveThresholds(lateDate)) = %d, want %d", len(activeThresholds), 2)
	}
}

func TestLoadConfigRejectsLanguageContractViolations(t *testing.T) {
	_, err := LoadConfig(strings.NewReader(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [
			{
				"id": "",
				"label": "",
				"github_query_fragment": "",
				"active_from": "2026-04-01",
				"active_to": null
			},
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "2026-04-01",
				"active_to": null
			},
			{
				"id": "go",
				"label": "Go duplicate",
				"github_query_fragment": "language:\"golang\"",
				"active_from": "2026-04-01",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "2026-04-01", "active_to": null }
		]
	}`))
	if err == nil {
		t.Fatal("LoadConfig() error = nil, want contract validation error")
	}

	for _, snippet := range []string{
		"languages[0].id is required",
		"languages[0].label is required",
		"languages[0].github_query_fragment is required",
		`languages[2].id duplicates "go"`,
	} {
		if !strings.Contains(err.Error(), snippet) {
			t.Fatalf("LoadConfig() error = %q, want substring %q", err, snippet)
		}
	}
}

func TestLoadConfigRejectsLeadingOrTrailingWhitespace(t *testing.T) {
	_, err := LoadConfig(strings.NewReader(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [
			{
				"id": " go ",
				"label": "Go ",
				"github_query_fragment": " language:\"go\"",
				"active_from": "2026-04-01",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "2026-04-01", "active_to": null }
		]
	}`))
	if err == nil {
		t.Fatal("LoadConfig() error = nil, want canonical string validation error")
	}

	for _, snippet := range []string{
		"languages[0].id must not contain leading or trailing whitespace",
		"languages[0].label must not contain leading or trailing whitespace",
		"languages[0].github_query_fragment must not contain leading or trailing whitespace",
	} {
		if !strings.Contains(err.Error(), snippet) {
			t.Fatalf("LoadConfig() error = %q, want substring %q", err, snippet)
		}
	}
}

func TestLoadConfigRejectsThresholdAndDateViolations(t *testing.T) {
	_, err := LoadConfig(strings.NewReader(`{
		"timezone": "Europe/Berlin",
		"window_days": 7,
		"launch_date": "2026-04-01",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "2026-03-31",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": -1, "active_from": "2026-04-01", "active_to": null },
			{ "value": 0, "active_from": "2026-04-02", "active_to": "2026-04-01" }
		]
	}`))
	if err == nil {
		t.Fatal("LoadConfig() error = nil, want validation error")
	}

	for _, snippet := range []string{
		`timezone must be "UTC"`,
		"window_days must be 30",
		"languages[0]: active_from 2026-03-31 must be on or after launch_date 2026-04-01",
		"thresholds[0].value must be non-negative",
		"thresholds[1]: active_to 2026-04-01 must be on or after active_from 2026-04-02",
	} {
		if !strings.Contains(err.Error(), snippet) {
			t.Fatalf("LoadConfig() error = %q, want substring %q", err, snippet)
		}
	}
}

func TestLoadConfigFileAndDayMarshalJSON(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "metrics.json")
	if err := os.WriteFile(configPath, []byte(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [
			{
				"id": "go",
				"label": "Go",
				"github_query_fragment": "language:\"go\"",
				"active_from": "2026-04-01",
				"active_to": null
			}
		],
		"thresholds": [
			{ "value": 0, "active_from": "2026-04-01", "active_to": null }
		]
	}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	registry, err := LoadConfigFile(configPath)
	if err != nil {
		t.Fatalf("LoadConfigFile() error = %v", err)
	}

	payload, err := json.Marshal(registry.LaunchDate)
	if err != nil {
		t.Fatalf("MarshalJSON() error = %v", err)
	}

	if got := string(payload); got != `"2026-04-01"` {
		t.Fatalf("MarshalJSON() = %q, want %q", got, `"2026-04-01"`)
	}
}

func TestLoadConfigRejectsMissingDimensions(t *testing.T) {
	_, err := LoadConfig(strings.NewReader(`{
		"timezone": "UTC",
		"window_days": 30,
		"launch_date": "2026-04-01",
		"languages": [],
		"thresholds": []
	}`))
	if err == nil {
		t.Fatal("LoadConfig() error = nil, want missing dimension error")
	}

	for _, snippet := range []string{
		"at least one language is required",
		"at least one threshold is required",
	} {
		if !strings.Contains(err.Error(), snippet) {
			t.Fatalf("LoadConfig() error = %q, want substring %q", err, snippet)
		}
	}
}

func TestParseDayAndLoadConfigFileErrors(t *testing.T) {
	if _, err := ParseDay("2026/04/07"); err == nil {
		t.Fatal("ParseDay() error = nil, want parse failure")
	}

	if _, err := LoadConfigFile(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("LoadConfigFile() error = nil, want missing file error")
	}
}

func mustParseDay(t *testing.T, raw string) Day {
	t.Helper()

	day, err := ParseDay(raw)
	if err != nil {
		t.Fatalf("ParseDay(%q) error = %v", raw, err)
	}

	return day
}
