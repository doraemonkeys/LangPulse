import metricsJson from "../../config/metrics.json";
import { QUALITY_METRIC, UTC_TIMEZONE, WINDOW_DAYS } from "./constants";
import type {
  LanguageRegistryEntry,
  MetricsRegistry,
  PublicLanguageEntry,
  PublicThresholdEntry,
  ThresholdRegistryEntry,
} from "./types";
import { assertUtcDate, compareUtcDates } from "./time";

const LANGUAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertCanonicalString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  if (value.trim() !== value) {
    throw new Error(`${fieldName} must not contain leading or trailing whitespace.`);
  }

  return value;
}

function assertNullableUtcDate(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }

  return assertUtcDate(value, fieldName);
}

function assertDateWindow(activeFrom: string, activeTo: string | null, fieldName: string): void {
  if (activeTo !== null && compareUtcDates(activeFrom, activeTo) > 0) {
    throw new Error(`${fieldName}.active_to must be on or after active_from.`);
  }
}

function assertLaunchDateFloor(activeFrom: string, launchDate: string, fieldName: string): void {
  if (compareUtcDates(activeFrom, launchDate) < 0) {
    throw new Error(`${fieldName}.active_from must be on or after launch_date.`);
  }
}

function parseLanguageRegistryEntry(
  input: unknown,
  index: number,
  launchDate: string,
): LanguageRegistryEntry {
  if (typeof input !== "object" || input === null) {
    throw new Error(`languages[${index}] must be an object.`);
  }

  const entry = input as Record<string, unknown>;
  const parsed: LanguageRegistryEntry = {
    id: assertCanonicalString(entry.id, `languages[${index}].id`),
    label: assertCanonicalString(entry.label, `languages[${index}].label`),
    github_query_fragment: assertCanonicalString(
      entry.github_query_fragment,
      `languages[${index}].github_query_fragment`,
    ),
    active_from: assertUtcDate(entry.active_from, `languages[${index}].active_from`),
    active_to: assertNullableUtcDate(entry.active_to, `languages[${index}].active_to`),
  };

  if (!LANGUAGE_ID_PATTERN.test(parsed.id)) {
    throw new Error(`languages[${index}].id must be a stable slug.`);
  }

  assertLaunchDateFloor(parsed.active_from, launchDate, `languages[${index}]`);
  assertDateWindow(parsed.active_from, parsed.active_to, `languages[${index}]`);
  return parsed;
}

function parseThresholdRegistryEntry(
  input: unknown,
  index: number,
  launchDate: string,
): ThresholdRegistryEntry {
  if (typeof input !== "object" || input === null) {
    throw new Error(`thresholds[${index}] must be an object.`);
  }

  const entry = input as Record<string, unknown>;
  const value = entry.value;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`thresholds[${index}].value must be a non-negative integer.`);
  }

  const parsed: ThresholdRegistryEntry = {
    value: value as number,
    active_from: assertUtcDate(entry.active_from, `thresholds[${index}].active_from`),
    active_to: assertNullableUtcDate(entry.active_to, `thresholds[${index}].active_to`),
  };

  assertLaunchDateFloor(parsed.active_from, launchDate, `thresholds[${index}]`);
  assertDateWindow(parsed.active_from, parsed.active_to, `thresholds[${index}]`);
  return parsed;
}

function assertUniqueLanguageIds(languages: LanguageRegistryEntry[]): void {
  const seen = new Set<string>();
  for (const language of languages) {
    if (seen.has(language.id)) {
      throw new Error(`language.id must remain unique. Duplicate id: ${language.id}`);
    }

    seen.add(language.id);
  }
}

function assertUniqueThresholdValues(thresholds: ThresholdRegistryEntry[]): void {
  const seen = new Set<number>();
  for (const threshold of thresholds) {
    if (seen.has(threshold.value)) {
      throw new Error(`threshold values must remain unique. Duplicate value: ${threshold.value}`);
    }

    seen.add(threshold.value);
  }
}

export function loadMetricsRegistry(input: unknown): MetricsRegistry {
  if (typeof input !== "object" || input === null) {
    throw new Error("metrics registry must be an object.");
  }

  const registry = input as Record<string, unknown>;
  if (registry.timezone !== UTC_TIMEZONE) {
    throw new Error(`timezone must stay fixed at ${UTC_TIMEZONE}.`);
  }

  if (registry.window_days !== WINDOW_DAYS) {
    throw new Error(`window_days must stay fixed at ${WINDOW_DAYS}.`);
  }

  const languagesInput = registry.languages;
  const thresholdsInput = registry.thresholds;
  if (!Array.isArray(languagesInput) || !Array.isArray(thresholdsInput)) {
    throw new Error("languages and thresholds must be arrays.");
  }

  const launchDate = assertUtcDate(registry.launch_date, "launch_date");
  const parsed: MetricsRegistry = {
    timezone: UTC_TIMEZONE,
    window_days: WINDOW_DAYS,
    launch_date: launchDate,
    languages: languagesInput.map((entry, index) =>
      parseLanguageRegistryEntry(entry, index, launchDate),
    ),
    thresholds: thresholdsInput.map((entry, index) =>
      parseThresholdRegistryEntry(entry, index, launchDate),
    ),
  };

  if (parsed.languages.length === 0 || parsed.thresholds.length === 0) {
    throw new Error(`${QUALITY_METRIC} requires at least one language and one threshold.`);
  }

  assertUniqueLanguageIds(parsed.languages);
  assertUniqueThresholdValues(parsed.thresholds);
  return parsed;
}

export const metricsRegistry = loadMetricsRegistry(metricsJson);

export function isEntryActiveOnDate(
  observedDate: string,
  activeFrom: string,
  activeTo: string | null,
): boolean {
  if (compareUtcDates(observedDate, activeFrom) < 0) {
    return false;
  }

  return activeTo === null || compareUtcDates(observedDate, activeTo) <= 0;
}

export function getActiveLanguages(
  registry: MetricsRegistry,
  observedDate: string,
): LanguageRegistryEntry[] {
  return registry.languages.filter((language) =>
    isEntryActiveOnDate(observedDate, language.active_from, language.active_to),
  );
}

export function getActiveThresholds(
  registry: MetricsRegistry,
  observedDate: string,
): ThresholdRegistryEntry[] {
  return registry.thresholds.filter((threshold) =>
    isEntryActiveOnDate(observedDate, threshold.active_from, threshold.active_to),
  );
}

export function getExpectedRowCount(registry: MetricsRegistry, observedDate: string): number {
  return getActiveLanguages(registry, observedDate).length * getActiveThresholds(registry, observedDate).length;
}

export function findLanguageById(
  registry: MetricsRegistry,
  languageId: string,
): LanguageRegistryEntry | undefined {
  return registry.languages.find((language) => language.id === languageId);
}

export function findThresholdByValue(
  registry: MetricsRegistry,
  thresholdValue: number,
): ThresholdRegistryEntry | undefined {
  return registry.thresholds.find((threshold) => threshold.value === thresholdValue);
}

export function toPublicLanguages(registry: MetricsRegistry): PublicLanguageEntry[] {
  return registry.languages.map(({ id, label, active_from, active_to }) => ({
    id,
    label,
    active_from,
    active_to,
  }));
}

export function toPublicThresholds(registry: MetricsRegistry): PublicThresholdEntry[] {
  return registry.thresholds.map(({ value, active_from, active_to }) => ({
    value,
    active_from,
    active_to,
  }));
}
