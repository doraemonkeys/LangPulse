import clsx from "clsx";
import { Sparkline } from "./Sparkline";
import type { SnapshotLanguageCount } from "../api/types";
import { computeDelta, formatFullCount, formatRank } from "../utils/format";

interface SparklinePoint {
  date: string;
  value: number | null;
}

interface LeaderboardRowProps {
  rank: number;
  entry: SnapshotLanguageCount;
  sparklinePoints: SparklinePoint[];
  color: string;
  pinned: boolean;
  onToggle: (languageId: string) => void;
}

function handleKeyToggle(
  event: React.KeyboardEvent<HTMLDivElement>,
  languageId: string,
  onToggle: (id: string) => void,
): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onToggle(languageId);
  }
}

export function LeaderboardRow({
  rank,
  entry,
  sparklinePoints,
  color,
  pinned,
  onToggle,
}: LeaderboardRowProps) {
  const delta = computeDelta(entry.count, entry.previous_count);
  const countText = formatFullCount(entry.count);
  const ariaLabel = `${formatRank(rank)}. ${entry.label}, ${countText} repositories, delta ${delta.label}. Press Enter to toggle on chart.`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={pinned}
      aria-label={ariaLabel}
      className={clsx("leaderboard-row", pinned && "leaderboard-row--pinned")}
      onClick={() => onToggle(entry.id)}
      onKeyDown={(event) => handleKeyToggle(event, entry.id, onToggle)}
    >
      <span className="leaderboard-row__rank">{formatRank(rank)}</span>
      <span
        className="leaderboard-row__swatch"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="leaderboard-row__label">{entry.label}</span>
      <span className="leaderboard-row__count">{countText}</span>
      <span className={clsx("leaderboard-row__delta", `leaderboard-row__delta--${delta.sign}`)}>
        {delta.label}
      </span>
      <span className="leaderboard-row__sparkline">
        <Sparkline
          points={sparklinePoints}
          color={color}
          ariaLabel={`${entry.label} 60-day trend`}
        />
      </span>
    </div>
  );
}
