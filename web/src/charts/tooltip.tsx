import type { TooltipProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { formatFullCount } from "../utils/format";
import { formatShortDate } from "../utils/dates";
import type { ChartMode } from "../state/actions";
import { RAW_FIELD_SUFFIX, RELATIVE_FIELD_SUFFIX } from "./series";

type CompareTooltipProps = TooltipProps<ValueType, NameType> & {
  labelsById: Map<string, string>;
  mode: ChartMode;
};

const UNAVAILABLE_PLACEHOLDER = "—";

interface TooltipEntry {
  id: string;
  label: string;
  color: string | undefined;
  count: number | null;
  relative: number | null;
}

function formatRelative(value: number | null): string {
  if (value === null) return UNAVAILABLE_PLACEHOLDER;
  if (value === 0) return "0%";
  const prefix = value > 0 ? "+" : "−";
  return `${prefix}${Math.abs(value).toFixed(1)}%`;
}

function formatCount(value: number | null): string {
  if (value === null) return UNAVAILABLE_PLACEHOLDER;
  return formatFullCount(value);
}

function readSidecar(
  payloadRow: Record<string, unknown> | undefined,
  id: string,
  suffix: string,
): number | null {
  if (payloadRow === undefined) return null;
  const value = payloadRow[`${id}${suffix}`];
  return typeof value === "number" ? value : null;
}

export function ComparisonTooltip({
  active,
  payload,
  label,
  labelsById,
  mode,
}: CompareTooltipProps) {
  if (active !== true || payload === undefined || payload.length === 0) return null;

  const entries: TooltipEntry[] = payload.map((entry) => {
    const id = String(entry.dataKey ?? "");
    const row = entry.payload as Record<string, unknown> | undefined;
    return {
      id,
      label: labelsById.get(id) ?? id,
      color: entry.color,
      count: readSidecar(row, id, RAW_FIELD_SUFFIX),
      relative: readSidecar(row, id, RELATIVE_FIELD_SUFFIX),
    };
  });

  // Sorting follows the active mode so the entry the user is reading the chart
  // for sits at the top — count rank in absolute mode, % change rank in
  // relative mode. Missing values fall to the bottom regardless of mode.
  entries.sort((a, b) => {
    const av = mode === "relative" ? a.relative : a.count;
    const bv = mode === "relative" ? b.relative : b.count;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });

  const observedDate = typeof label === "string" ? label : "";

  return (
    <div className="chart-tooltip" role="tooltip">
      <p className="chart-tooltip__date">{observedDate === "" ? "" : formatShortDate(observedDate)}</p>
      <ul className="chart-tooltip__list">
        {entries.map((entry) => {
          const primary = mode === "relative" ? formatRelative(entry.relative) : formatCount(entry.count);
          const secondary = mode === "relative" ? formatCount(entry.count) : formatRelative(entry.relative);
          return (
            <li key={entry.id} className="chart-tooltip__item">
              <span className="chart-tooltip__swatch" style={{ backgroundColor: entry.color }} />
              <span className="chart-tooltip__label">{entry.label}</span>
              <span className="chart-tooltip__value">{primary}</span>
              <span className="chart-tooltip__secondary">{secondary}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
