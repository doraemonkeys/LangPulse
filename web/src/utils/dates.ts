export const TREND_RANGE_PRESETS = [
  { preset: "60d", days: 60 },
  { preset: "90d", days: 90 },
  { preset: "180d", days: 180 },
  { preset: "360d", days: 360 },
] as const;

export type TrendRangePreset = (typeof TREND_RANGE_PRESETS)[number]["preset"];
export type RangePreset = TrendRangePreset | "custom";

export const DEFAULT_RANGE_PRESET: TrendRangePreset = "90d";
export const DEFAULT_RANGE_DAYS = presetToDays(DEFAULT_RANGE_PRESET);
export const SPARKLINE_RANGE_DAYS = 60;

export function addDaysUtc(date: string, delta: number): string {
  const utcDate = new Date(`${date}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + delta);
  return utcDate.toISOString().slice(0, 10);
}

export function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function clampDate(candidate: string, launchDate: string): string {
  return compareDates(candidate, launchDate) < 0 ? launchDate : candidate;
}

// Precondition: callers must only compute a range once a snapshot has been
// observed. A null latestObservedDate means "no data yet" — there is no
// meaningful window to derive, so the UI must defer initialization rather
// than synthesize a placeholder range that collapses to a single day.
export function computeDefaultRange(
  launchDate: string,
  latestObservedDate: string,
  windowDays = DEFAULT_RANGE_DAYS,
): { from: string; to: string } {
  const candidateFrom = addDaysUtc(latestObservedDate, -(windowDays - 1));
  return {
    from: clampDate(candidateFrom, launchDate),
    to: latestObservedDate,
  };
}

export function computePresetRange(
  preset: RangePreset,
  launchDate: string,
  latestObservedDate: string,
): { from: string; to: string; preset: RangePreset } {
  if (preset === "custom") {
    return { ...computeDefaultRange(launchDate, latestObservedDate), preset };
  }

  const days = presetToDays(preset);
  return { ...computeDefaultRange(launchDate, latestObservedDate, days), preset };
}

export function presetToDays(preset: TrendRangePreset): number {
  const configuration = TREND_RANGE_PRESETS.find((candidate) => candidate.preset === preset);
  if (configuration === undefined) {
    throw new Error(`Unsupported trend range preset: ${preset}`);
  }
  return configuration.days;
}

export function formatShortDate(date: string): string {
  // "2026-04-19" -> "Apr 19"; keeps axis ticks readable without importing date-fns.
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const month = parsed.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = parsed.getUTCDate();
  return `${month} ${day}`;
}

export interface ActivationWindow {
  active_from: string;
  active_to: string | null;
}

export function isActiveOn(window: ActivationWindow, observedDate: string | null): boolean {
  if (observedDate === null) return window.active_to === null;
  if (window.active_from > observedDate) return false;
  return window.active_to === null || window.active_to >= observedDate;
}
