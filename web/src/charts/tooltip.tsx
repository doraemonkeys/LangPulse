import type { TooltipProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { formatFullCount } from "../utils/format";
import { formatShortDate } from "../utils/dates";

type CompareTooltipProps = TooltipProps<ValueType, NameType> & {
  labelsById: Map<string, string>;
};

export function ComparisonTooltip({ active, payload, label, labelsById }: CompareTooltipProps) {
  if (active !== true || payload === undefined || payload.length === 0) return null;

  const sorted = [...payload]
    .filter((entry) => typeof entry.value === "number")
    .sort((a, b) => (b.value as number) - (a.value as number));

  const observedDate = typeof label === "string" ? label : "";

  return (
    <div className="chart-tooltip" role="tooltip">
      <p className="chart-tooltip__date">{observedDate === "" ? "" : formatShortDate(observedDate)}</p>
      <ul className="chart-tooltip__list">
        {sorted.map((entry) => {
          const id = String(entry.dataKey ?? "");
          const language = labelsById.get(id) ?? id;
          return (
            <li key={id} className="chart-tooltip__item">
              <span className="chart-tooltip__swatch" style={{ backgroundColor: entry.color }} />
              <span className="chart-tooltip__label">{language}</span>
              <span className="chart-tooltip__value">
                {formatFullCount(entry.value as number)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
