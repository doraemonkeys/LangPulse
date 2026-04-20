import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CompareResponse } from "../api/types";
import { getPaletteForIds, type ThemeMode } from "../charts/palette";
import { ComparisonTooltip } from "../charts/tooltip";
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
}

interface ChartRow {
  date: string;
  [languageId: string]: number | null | string;
}

function pivotSeries(data: CompareResponse): ChartRow[] {
  return data.series.map((point) => {
    const row: ChartRow = { date: point.observed_date };
    for (const language of data.languages) {
      row[language.id] = point.counts[language.id] ?? null;
    }
    return row;
  });
}

export function ComparisonChart(props: ComparisonChartProps) {
  const { data, isLoading, error, theme, pinnedLanguages, onTogglePin } = props;
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
  const rows = useMemo(() => (data === undefined ? [] : pivotSeries(data)), [data]);

  if (error !== null) {
    return (
      <section className="comparison" aria-label="Language comparison chart">
        <StateBanner tone="error" title="Could not load chart" description={error.message} />
      </section>
    );
  }

  if (isLoading || data === undefined) {
    return (
      <section className="comparison" aria-label="Language comparison chart">
        <div className="comparison__skeleton" aria-busy="true">
          Loading chart…
        </div>
      </section>
    );
  }

  if (rows.length === 0 || data.languages.length === 0) {
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

  return (
    <section className="comparison" aria-label="Language comparison chart">
      <div className="comparison__chart">
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={rows} margin={{ top: 16, right: 24, bottom: 12, left: 12 }}>
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
              tickFormatter={(value: number) => formatCompactCount(value)}
              width={56}
            />
            <Tooltip
              content={<ComparisonTooltip labelsById={labelsById} />}
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
      />
    </section>
  );
}
