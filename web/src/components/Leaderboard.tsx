import { useMemo, useState } from "react";
import { LanguagePicker } from "./LanguagePicker";
import { LeaderboardRow } from "./LeaderboardRow";
import { StateBanner } from "./StateBanner";
import type { CompareResponse, PublicLanguage, SnapshotResponse } from "../api/types";
import { getPaletteForIds, type ThemeMode } from "../charts/palette";
import { MAX_PINNED_LANGUAGES } from "../state/actions";

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
  registryLanguages: PublicLanguage[];
  observedDate: string | null;
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
  const {
    snapshot,
    isLoading,
    error,
    sparklineData,
    theme,
    pinnedLanguages,
    onTogglePin,
    onResetPins,
    registryLanguages,
    observedDate,
  } = props;
  const [expanded, setExpanded] = useState(false);

  const sortedLanguages = useMemo(() => {
    if (snapshot === undefined) return [];
    return [...snapshot.languages].sort((a, b) => b.count - a.count);
  }, [snapshot]);

  const topLanguages = sortedLanguages.slice(0, LEADERBOARD_SIZE);
  const tailLanguages = sortedLanguages.slice(LEADERBOARD_SIZE);

  const palette = useMemo(
    () => getPaletteForIds(topLanguages.map((language) => language.id), theme),
    [topLanguages, theme],
  );

  const atCap = pinnedLanguages.size >= MAX_PINNED_LANGUAGES;

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

  if (sortedLanguages.length === 0) {
    return (
      <StateBanner
        tone="info"
        title="No languages at this threshold"
        description="Try lowering the star threshold to see more languages."
      />
    );
  }

  const totalLanguages = sortedLanguages.length;
  const hasTail = tailLanguages.length > 0;

  return (
    <section className="leaderboard" aria-label="Top languages">
      <header className="leaderboard__header">
        <div className="leaderboard__title">
          <h2>Top {topLanguages.length} by repositories</h2>
          <LanguagePicker
            languages={registryLanguages}
            snapshotEntries={snapshot.languages}
            observedDate={observedDate}
            pinnedLanguages={pinnedLanguages}
            maxPinned={MAX_PINNED_LANGUAGES}
            onTogglePin={onTogglePin}
          />
        </div>
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
                disabled={atCap && !pinned}
              />
            </div>
          );
        })}
        {expanded ? (
          <div className="leaderboard__rows leaderboard__rows--more" role="list">
            {tailLanguages.map((entry, index) => {
              const pinned = pinnedLanguages.has(entry.id);
              return (
                <div role="listitem" key={entry.id}>
                  <LeaderboardRow
                    rank={LEADERBOARD_SIZE + index + 1}
                    entry={entry}
                    sparklinePoints={[]}
                    color="var(--ink-muted)"
                    pinned={pinned}
                    onToggle={onTogglePin}
                    showSparkline={false}
                    disabled={atCap && !pinned}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {hasTail ? (
        <button
          type="button"
          className="leaderboard__show-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show all ${totalLanguages} languages`}
        </button>
      ) : null}
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
