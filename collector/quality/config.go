package quality

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/langpulse/collector/internal/cleanup"
)

const (
	RequiredTimezone   = "UTC"
	SnapshotWindowDays = 30
	dateLayout         = "2006-01-02"
)

var languageIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

type Day struct {
	time.Time
}

type Config struct {
	Timezone   string      `json:"timezone"`
	WindowDays int         `json:"window_days"`
	LaunchDate Day         `json:"launch_date"`
	Languages  []Language  `json:"languages"`
	Thresholds []Threshold `json:"thresholds"`
}

type Language struct {
	ID                  string `json:"id"`
	Label               string `json:"label"`
	GitHubQueryFragment string `json:"github_query_fragment"`
	ActiveFrom          Day    `json:"active_from"`
	ActiveTo            *Day   `json:"active_to"`
}

type Threshold struct {
	Value      int  `json:"value"`
	ActiveFrom Day  `json:"active_from"`
	ActiveTo   *Day `json:"active_to"`
}

func ParseDay(raw string) (Day, error) {
	timestamp, err := time.ParseInLocation(dateLayout, raw, time.UTC)
	if err != nil {
		return Day{}, fmt.Errorf("parse UTC date %q: %w", raw, err)
	}

	return Day{Time: timestamp.UTC()}, nil
}

func DayFromTime(now time.Time) Day {
	day, err := ParseDay(now.UTC().Format(dateLayout))
	if err != nil {
		panic(err)
	}

	return day
}

func (d Day) String() string {
	if d.IsZero() {
		return ""
	}

	return d.Time.UTC().Format(dateLayout)
}

func (d Day) AddDays(days int) Day {
	return Day{Time: d.Time.AddDate(0, 0, days).UTC()}
}

func (d Day) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

func (d *Day) UnmarshalJSON(payload []byte) error {
	var raw string
	if err := json.Unmarshal(payload, &raw); err != nil {
		return fmt.Errorf("decode UTC date: %w", err)
	}

	day, err := ParseDay(raw)
	if err != nil {
		return err
	}

	*d = day
	return nil
}

func LoadConfigFile(path string) (cfg Config, err error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open metrics config %q: %w", path, err)
	}
	defer func() {
		err = cleanup.Join(err, fmt.Sprintf("close metrics config %q", path), file.Close)
	}()

	cfg, err = LoadConfig(file)
	return cfg, err
}

func LoadConfig(reader io.Reader) (Config, error) {
	var registry Config

	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&registry); err != nil {
		return Config{}, fmt.Errorf("decode metrics config: %w", err)
	}

	if err := registry.Validate(); err != nil {
		return Config{}, err
	}

	return registry, nil
}

func (cfg Config) Validate() error {
	var problems []string

	if cfg.Timezone != RequiredTimezone {
		problems = append(problems, fmt.Sprintf("timezone must be %q", RequiredTimezone))
	}

	if cfg.WindowDays != SnapshotWindowDays {
		problems = append(problems, fmt.Sprintf("window_days must be %d", SnapshotWindowDays))
	}

	if cfg.LaunchDate.IsZero() {
		problems = append(problems, "launch_date is required")
	}

	if len(cfg.Languages) == 0 {
		problems = append(problems, "at least one language is required")
	}

	if len(cfg.Thresholds) == 0 {
		problems = append(problems, "at least one threshold is required")
	}

	languageIDs := map[string]struct{}{}
	for index := range cfg.Languages {
		language := cfg.Languages[index]

		if isBlankString(language.ID) {
			problems = append(problems, fmt.Sprintf("languages[%d].id is required", index))
		} else if strings.TrimSpace(language.ID) != language.ID {
			problems = append(problems, fmt.Sprintf("languages[%d].id must not contain leading or trailing whitespace", index))
		} else if !languageIDPattern.MatchString(language.ID) {
			problems = append(problems, fmt.Sprintf("languages[%d].id must be a stable slug", index))
		} else if _, exists := languageIDs[language.ID]; exists {
			problems = append(problems, fmt.Sprintf("languages[%d].id duplicates %q", index, language.ID))
		} else {
			languageIDs[language.ID] = struct{}{}
		}

		if isBlankString(language.Label) {
			problems = append(problems, fmt.Sprintf("languages[%d].label is required", index))
		} else if strings.TrimSpace(language.Label) != language.Label {
			problems = append(problems, fmt.Sprintf("languages[%d].label must not contain leading or trailing whitespace", index))
		}

		if isBlankString(language.GitHubQueryFragment) {
			problems = append(problems, fmt.Sprintf("languages[%d].github_query_fragment is required", index))
		} else if strings.TrimSpace(language.GitHubQueryFragment) != language.GitHubQueryFragment {
			problems = append(problems, fmt.Sprintf("languages[%d].github_query_fragment must not contain leading or trailing whitespace", index))
		}

		if err := validateActiveRange(language.ActiveFrom, language.ActiveTo, cfg.LaunchDate); err != nil {
			problems = append(problems, fmt.Sprintf("languages[%d]: %s", index, err))
		}
	}

	thresholdValues := map[int]struct{}{}
	for index := range cfg.Thresholds {
		threshold := cfg.Thresholds[index]

		if threshold.Value < 0 {
			problems = append(problems, fmt.Sprintf("thresholds[%d].value must be non-negative", index))
		} else if _, exists := thresholdValues[threshold.Value]; exists {
			problems = append(problems, fmt.Sprintf("thresholds[%d].value duplicates %d", index, threshold.Value))
		} else {
			thresholdValues[threshold.Value] = struct{}{}
		}

		if err := validateActiveRange(threshold.ActiveFrom, threshold.ActiveTo, cfg.LaunchDate); err != nil {
			problems = append(problems, fmt.Sprintf("thresholds[%d]: %s", index, err))
		}
	}

	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}

	return nil
}

func isBlankString(value string) bool {
	return strings.TrimSpace(value) == ""
}

func (cfg Config) ActiveLanguages(observedDate Day) []Language {
	active := make([]Language, 0, len(cfg.Languages))
	for _, language := range cfg.Languages {
		if isActiveOn(observedDate, language.ActiveFrom, language.ActiveTo) {
			active = append(active, language)
		}
	}

	return active
}

func (cfg Config) ActiveThresholds(observedDate Day) []Threshold {
	active := make([]Threshold, 0, len(cfg.Thresholds))
	for _, threshold := range cfg.Thresholds {
		if isActiveOn(observedDate, threshold.ActiveFrom, threshold.ActiveTo) {
			active = append(active, threshold)
		}
	}

	return active
}

func (cfg Config) ExpectedRows(observedDate Day) int {
	return len(cfg.ActiveLanguages(observedDate)) * len(cfg.ActiveThresholds(observedDate))
}

func isActiveOn(observedDate Day, activeFrom Day, activeTo *Day) bool {
	if observedDate.Before(activeFrom.Time) {
		return false
	}

	if activeTo != nil && observedDate.After(activeTo.Time) {
		return false
	}

	return true
}

func validateActiveRange(activeFrom Day, activeTo *Day, launchDate Day) error {
	if activeFrom.IsZero() {
		return errors.New("active_from is required")
	}

	if activeFrom.Before(launchDate.Time) {
		return fmt.Errorf("active_from %s must be on or after launch_date %s", activeFrom, launchDate)
	}

	if activeTo != nil && activeTo.Before(activeFrom.Time) {
		return fmt.Errorf("active_to %s must be on or after active_from %s", activeTo, activeFrom)
	}

	return nil
}
