import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CompareResponse } from "../api/types";
import { getPaletteForIds, type ThemeMode } from "../charts/palette";
import { ComparisonTooltip } from "../charts/tooltip";
import { buildChartViewModel } from "../charts/series";
import type { ChartMode } from "../state/actions";
import { LanguageLegend } from "./LanguageLegend";
import { StateBanner } from "./StateBanner";
import { formatCompactCount } from "../utils/format";
import { formatShortDate } from "../utils/dates";

interface ComparisonChartProps {
  data: CompareResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  theme: ThemeMode;
  pinnedLanguages: ReadonlySet<string>;
  onTogglePin: (languageId: string) => void;
  chartMode: ChartMode;
  onChangeChartMode: (mode: ChartMode) => void;
}

const MODE_OPTIONS: ReadonlyArray<{ value: ChartMode; label: string; description: string }> = [
  { value: "absolute", label: "Absolute", description: "Show real repository counts" },
  { value: "relative", label: "Relative", description: "Show % change from each language's baseline" },
];

function formatRelativeTick(value: number): string {
  if (value === 0) return "0%";
  const sign = value > 0 ? "+" : "−";
  const abs = Math.abs(value);
  const precision = abs < 10 ? 1 : 0;
  return `${sign}${abs.toFixed(precision)}%`;
}

export function ComparisonChart(props: ComparisonChartProps) {
  const {
    data,
    isLoading,
    error,
    theme,
    pinnedLanguages,
    onTogglePin,
    chartMode,
    onChangeChartMode,
  } = props;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const palette = useMemo(
    () => getPaletteForIds(data?.languages.map((language) => language.id) ?? [], theme),
    [data, theme],
  );
  const labelsById = useMemo(() => {
    const map = new Map<string, string>();
    data?.languages.forEach((language) => map.set(language.id, language.label));
    return map;
  }, [data]);
  const viewModel = useMemo(() => {
    if (data === undefined) return null;
    return buildChartViewModel(data, chartMode);
  }, [data, chartMode]);

  if (error !== null) {
    return (
      <section className="comparison" aria-label="Language comparison chart">
        <StateBanner tone="error" title="Could not load chart" description={error.message} />
      </section>
    );
  }

  if (isLoading || data === undefined || viewModel === null) {
    return (
      <section className="comparison" aria-label="Language comparison chart">
        <div className="comparison__skeleton" aria-busy="true">
          Loading chart…
        </div>
      </section>
    );
  }

  if (viewModel.rows.length === 0 || data.languages.length === 0) {
    return (
      <section className="comparison" aria-label="Language comparison chart">
        <StateBanner
          tone="info"
          title="No data in this range"
          description="Pick a wider range or a different threshold to see trends."
        />
      </section>
    );
  }

  const yTickFormatter =
    chartMode === "relative"
      ? formatRelativeTick
      : (value: number) => formatCompactCount(value);

  return (
    <section className="comparison" aria-label="Language comparison chart">
      <div className="comparison__toolbar" role="group" aria-label="Chart display mode">
        {MODE_OPTIONS.map((option) => {
          const active = option.value === chartMode;
          return (
            <button
              key={option.value}
              type="button"
              className={`chip ${active ? "chip--active" : ""}`}
              aria-pressed={active}
              title={option.description}
              onClick={() => onChangeChartMode(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="comparison__chart">
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={viewModel.rows} margin={{ top: 16, right: 24, bottom: 12, left: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-line)" />
            <XAxis
              dataKey="date"
              tickFormatter={formatShortDate}
              stroke="var(--ink-muted)"
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              stroke="var(--ink-muted)"
              tickLine={false}
              axisLine={false}
              tickFormatter={yTickFormatter}
              domain={viewModel.yDomain}
              width={56}
              allowDataOverflow={false}
            />
            {chartMode === "relative" ? (
              <ReferenceLine y={0} stroke="var(--grid-line)" strokeDasharray="2 4" />
            ) : null}
            <Tooltip
              content={<ComparisonTooltip labelsById={labelsById} mode={chartMode} />}
              cursor={{ stroke: "var(--grid-line)" }}
            />
            {data.languages.map((language) => {
              const color = palette.get(language.id) ?? "currentColor";
              const dimmed = hoveredId !== null && hoveredId !== language.id;
              return (
                <Line
                  key={language.id}
                  type="monotone"
                  dataKey={language.id}
                  name={language.label}
                  stroke={color}
                  strokeWidth={hoveredId === language.id ? 3 : 2}
                  strokeOpacity={dimmed ? 0.35 : 1}
                  dot={false}
                  activeDot={{
                    r: 4,
                    onMouseEnter: () => setHoveredId(language.id),
                    onMouseLeave: () => setHoveredId(null),
                  }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <LanguageLegend
        languages={data.languages}
        palette={palette}
        pinnedLanguages={pinnedLanguages}
        onToggle={onTogglePin}
        unavailableByLanguage={
          // Only surface the unavailable indicator in relative mode. Absolute
          // mode renders a missing series exactly as "no line on those days,"
          // which is self-explanatory; relative mode can drop the entire line
          // (zero baseline / fully missing) without an obvious cause.
          chartMode === "relative" ? viewModel.unavailableByLanguage : undefined
        }
      />
    </section>
  );
}
