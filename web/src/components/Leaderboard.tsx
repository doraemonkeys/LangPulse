import { useMemo } from "react";
import { LeaderboardRow } from "./LeaderboardRow";
import { StateBanner } from "./StateBanner";
import type { CompareResponse, SnapshotResponse } from "../api/types";
import { getPaletteForIds, type ThemeMode } from "../charts/palette";

export const LEADERBOARD_SIZE = 10;

interface LeaderboardProps {
  snapshot: SnapshotResponse | undefined;
  isLoading: boolean;
  error: Error | null;
  sparklineData: CompareResponse | undefined;
  theme: ThemeMode;
  pinnedLanguages: ReadonlySet<string>;
  onTogglePin: (languageId: string) => void;
  onResetPins: () => void;
}

interface SparklinePoint {
  date: string;
  value: number | null;
}

function buildSparklineSeries(
  compare: CompareResponse | undefined,
  languageId: string,
): SparklinePoint[] {
  if (compare === undefined) return [];
  return compare.series.map((point) => ({
    date: point.observed_date,
    value: point.counts[languageId] ?? null,
  }));
}

export function Leaderboard(props: LeaderboardProps) {
  const { snapshot, isLoading, error, sparklineData, theme, pinnedLanguages, onTogglePin, onResetPins } = props;

  const topLanguages = useMemo(() => {
    if (snapshot === undefined) return [];
    return [...snapshot.languages].sort((a, b) => b.count - a.count).slice(0, LEADERBOARD_SIZE);
  }, [snapshot]);

  const palette = useMemo(
    () => getPaletteForIds(topLanguages.map((language) => language.id), theme),
    [topLanguages, theme],
  );

  if (error !== null) {
    return (
      <StateBanner
        tone="error"
        title="Could not load leaderboard"
        description={error.message}
      />
    );
  }

  if (isLoading || snapshot === undefined) {
    return <LeaderboardSkeleton />;
  }

  if (topLanguages.length === 0) {
    return (
      <StateBanner
        tone="info"
        title="No languages at this threshold"
        description="Try lowering the star threshold to see more languages."
      />
    );
  }

  return (
    <section className="leaderboard" aria-label="Top languages">
      <header className="leaderboard__header">
        <h2>Top {topLanguages.length} by repositories</h2>
        {pinnedLanguages.size > 0 ? (
          <button type="button" className="ghost-button" onClick={onResetPins}>
            Reset to top {LEADERBOARD_SIZE}
          </button>
        ) : null}
      </header>
      <div className="leaderboard__rows" role="list">
        {topLanguages.map((entry, index) => {
          const pinned = pinnedLanguages.has(entry.id);
          const color = palette.get(entry.id) ?? "currentColor";
          return (
            <div role="listitem" key={entry.id}>
              <LeaderboardRow
                rank={index + 1}
                entry={entry}
                sparklinePoints={buildSparklineSeries(sparklineData, entry.id)}
                color={color}
                pinned={pinned}
                onToggle={onTogglePin}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LeaderboardSkeleton() {
  return (
    <div className="leaderboard" aria-busy="true" aria-live="polite">
      <header className="leaderboard__header">
        <h2>Top languages</h2>
      </header>
      <div className="leaderboard__rows">
        {Array.from({ length: LEADERBOARD_SIZE }, (_, index) => (
          <div key={index} className="leaderboard-row leaderboard-row--skeleton" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
