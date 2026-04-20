const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const FULL_FORMATTER = new Intl.NumberFormat("en-US");

export function formatCompactCount(value: number): string {
  return COMPACT_FORMATTER.format(value);
}

export function formatFullCount(value: number): string {
  return FULL_FORMATTER.format(value);
}

export interface DeltaResult {
  label: string;
  sign: "positive" | "negative" | "zero" | "unknown";
}

const PERCENT_PRECISION = 1;

export function computeDelta(current: number, previous: number | null): DeltaResult {
  if (previous === null) {
    return { label: "\u2014", sign: "unknown" };
  }

  if (previous === 0) {
    if (current === 0) return { label: "0%", sign: "zero" };
    return { label: "\u2191", sign: "positive" };
  }

  const ratio = ((current - previous) / previous) * 100;
  if (ratio === 0) {
    return { label: "0%", sign: "zero" };
  }

  const prefix = ratio > 0 ? "+" : "\u2212";
  const label = `${prefix}${Math.abs(ratio).toFixed(PERCENT_PRECISION)}%`;
  return { label, sign: ratio > 0 ? "positive" : "negative" };
}

export function formatRank(rank: number): string {
  return `#${rank}`;
}

export function formatThresholdLabel(value: number): string {
  return value === 0 ? "All" : `\u2265 ${formatCompactCount(value)}`;
}
