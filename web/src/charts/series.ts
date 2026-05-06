import type { CompareResponse } from "../api/types";
import type { ChartMode } from "../state/actions";

// Padding used to inflate min/max when building a focused absolute Y domain.
// 5% gives 1%-2% fluctuations enough vertical room without making the line
// brush against the axis. Kept as a named constant so chart axis tuning lives
// in one place.
export const FOCUSED_DOMAIN_PADDING_RATIO = 0.05;

// Threshold for declaring "all displayed languages are at a similar magnitude"
// in absolute mode. When min(values)/max(values) is at or above this ratio the
// domain focuses on the active band so 1%-2% fluctuations stay readable. When
// magnitudes diverge below this ratio we fall back to a zero-anchored domain
// because focusing would crush the smallest series against the axis. Tuned by
// hand: 0.5 keeps "Go vs Java" focused (similar) while pushing
// "Python vs Brainfuck" to zero-anchored (mixed).
export const SIMILAR_MAGNITUDE_RATIO = 0.5;

// Padding used around the min/max of relative-mode percentages so the highest
// and lowest values are not clipped onto the gridlines. Expressed in percentage
// points (i.e. 5 means 5%) because relative values are already percentages.
export const RELATIVE_DOMAIN_PADDING_PCT = 5;

// Minimum half-height of the relative-mode Y domain. Used when every relative
// value collapses to 0% (only baselines visible, or all values equal) so the
// axis still renders a visible band instead of a degenerate line.
export const MIN_VISIBLE_DOMAIN_PCT = 1;

// Suffix conventions for the per-row sidecar fields the tooltip reads. The Line
// component's dataKey points at the displayed value (raw count or relative),
// but tooltips need both metrics simultaneously, so each row carries both.
export const RAW_FIELD_SUFFIX = "__count";
export const RELATIVE_FIELD_SUFFIX = "__relative";

export type UnavailableReason = "no_baseline" | "zero_baseline" | "no_data";

export interface ChartRow {
  date: string;
  // Displayed value per language id, plus sidecar `${id}__count` and
  // `${id}__relative` fields for tooltip rendering. Recharts allows arbitrary
  // numeric/null/string fields on rows, hence the broad index signature.
  [key: string]: number | null | string;
}

export interface ChartViewModel {
  rows: ChartRow[];
  yDomain: [number, number];
  unavailableByLanguage: Map<string, UnavailableReason>;
  baselineByLanguage: Map<string, number | null>;
}

interface BaselineInfo {
  baselineDate: string | null;
  baselineCount: number | null;
  reason: UnavailableReason | null;
}

function findBaseline(data: CompareResponse, languageId: string): BaselineInfo {
  let sawAnyValue = false;
  let sawZeroOnly = true;
  for (const point of data.series) {
    const value = point.counts[languageId];
    if (value === undefined || value === null) continue;
    sawAnyValue = true;
    if (value !== 0) sawZeroOnly = false;
    if (value > 0) {
      return { baselineDate: point.observed_date, baselineCount: value, reason: null };
    }
  }
  if (!sawAnyValue) {
    return { baselineDate: null, baselineCount: null, reason: "no_data" };
  }
  if (sawZeroOnly) {
    return { baselineDate: null, baselineCount: null, reason: "zero_baseline" };
  }
  return { baselineDate: null, baselineCount: null, reason: "no_baseline" };
}

function rawAt(point: CompareResponse["series"][number], id: string): number | null {
  const value = point.counts[id];
  return value === undefined ? null : value;
}

function relativeAt(
  point: CompareResponse["series"][number],
  id: string,
  baseline: BaselineInfo,
): number | null {
  if (baseline.baselineDate === null || baseline.baselineCount === null) return null;
  if (point.observed_date < baseline.baselineDate) return null;
  const value = point.counts[id];
  if (value === undefined || value === null) return null;
  return (value / baseline.baselineCount - 1) * 100;
}

function paddedDomain(min: number, max: number, padding: number): [number, number] {
  if (max - min < padding * 2) {
    // Span is degenerate — expand around the midpoint by `padding` so the line
    // sits inside a visible band instead of on the axis.
    const center = (min + max) / 2;
    return [center - padding, center + padding];
  }
  return [min - padding, max + padding];
}

function computeAbsoluteDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Focus on the active band when languages share a similar magnitude (or only
  // one series is visible). The choice is driven by the data, not by the
  // language count: Go + Java sit comfortably in the same band and benefit
  // from a focused axis, while Python + Brainfuck cannot share one without
  // visually erasing Brainfuck. Zero-anchored fallback below preserves the
  // honest "who is bigger" signal whenever magnitudes diverge.
  const magnitudesAreSimilar = max === 0 || min / max >= SIMILAR_MAGNITUDE_RATIO;
  if (magnitudesAreSimilar) {
    const span = max - min;
    const padding = Math.max(span * FOCUSED_DOMAIN_PADDING_RATIO, 1);
    // Clamp lower bound to 0 so we never imply negative repository counts.
    const lower = Math.max(0, min - padding);
    return [lower, max + padding];
  }

  const padding = Math.max(max * FOCUSED_DOMAIN_PADDING_RATIO, 1);
  return [0, max + padding];
}

function computeRelativeDomain(values: number[]): [number, number] {
  if (values.length === 0) {
    return [-MIN_VISIBLE_DOMAIN_PCT, MIN_VISIBLE_DOMAIN_PCT];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const [lower, upper] = paddedDomain(min, max, RELATIVE_DOMAIN_PADDING_PCT);
  // Guarantee 0% (the baseline reference line) always sits inside the domain
  // so the user can see whether each line is above or below its own baseline.
  return [Math.min(lower, -MIN_VISIBLE_DOMAIN_PCT), Math.max(upper, MIN_VISIBLE_DOMAIN_PCT)];
}

export function buildChartViewModel(data: CompareResponse, mode: ChartMode): ChartViewModel {
  const baselineByLanguage = new Map<string, number | null>();
  const unavailableByLanguage = new Map<string, UnavailableReason>();
  const baselines = new Map<string, BaselineInfo>();
  for (const language of data.languages) {
    const baseline = findBaseline(data, language.id);
    baselines.set(language.id, baseline);
    baselineByLanguage.set(language.id, baseline.baselineCount);
    if (baseline.reason !== null) {
      unavailableByLanguage.set(language.id, baseline.reason);
    }
  }

  const rows: ChartRow[] = [];
  const displayedValues: number[] = [];
  for (const point of data.series) {
    const row: ChartRow = { date: point.observed_date };
    for (const language of data.languages) {
      const baseline = baselines.get(language.id) ?? {
        baselineDate: null,
        baselineCount: null,
        reason: "no_data" as const,
      };
      const raw = rawAt(point, language.id);
      const relative = relativeAt(point, language.id, baseline);
      row[`${language.id}${RAW_FIELD_SUFFIX}`] = raw;
      row[`${language.id}${RELATIVE_FIELD_SUFFIX}`] = relative;
      const displayed = mode === "relative" ? relative : raw;
      row[language.id] = displayed;
      if (displayed !== null) displayedValues.push(displayed);
    }
    rows.push(row);
  }

  const yDomain =
    mode === "relative"
      ? computeRelativeDomain(displayedValues)
      : computeAbsoluteDomain(displayedValues);

  return { rows, yDomain, unavailableByLanguage, baselineByLanguage };
}
