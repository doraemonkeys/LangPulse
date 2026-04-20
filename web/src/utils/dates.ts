export type RangePreset = "30d" | "90d" | "180d" | "max" | "custom";

export const DEFAULT_RANGE_DAYS = 90;
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

export function computeDefaultRange(
  launchDate: string,
  latestObservedDate: string | null,
  windowDays = DEFAULT_RANGE_DAYS,
): { from: string; to: string } {
  if (latestObservedDate === null) {
    return { from: launchDate, to: launchDate };
  }

  const candidateFrom = addDaysUtc(latestObservedDate, -(windowDays - 1));
  return {
    from: clampDate(candidateFrom, launchDate),
    to: latestObservedDate,
  };
}

export function computePresetRange(
  preset: RangePreset,
  launchDate: string,
  latestObservedDate: string | null,
): { from: string; to: string; preset: RangePreset } {
  if (latestObservedDate === null) {
    return { from: launchDate, to: launchDate, preset };
  }

  if (preset === "max") {
    return { from: launchDate, to: latestObservedDate, preset };
  }

  if (preset === "custom") {
    return { ...computeDefaultRange(launchDate, latestObservedDate), preset };
  }

  const days = presetToDays(preset);
  return { ...computeDefaultRange(launchDate, latestObservedDate, days), preset };
}

export function presetToDays(preset: Exclude<RangePreset, "max" | "custom">): number {
  if (preset === "30d") return 30;
  if (preset === "90d") return 90;
  return 180;
}

export function formatShortDate(date: string): string {
  // "2026-04-19" -> "Apr 19"; keeps axis ticks readable without importing date-fns.
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const month = parsed.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = parsed.getUTCDate();
  return `${month} ${day}`;
}
