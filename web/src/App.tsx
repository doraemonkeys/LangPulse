import { useEffect, useMemo } from "react";
import { AppHeader } from "./components/AppHeader";
import { ComparisonChart } from "./components/ComparisonChart";
import { DateRangePicker } from "./components/DateRangePicker";
import { Leaderboard, LEADERBOARD_SIZE } from "./components/Leaderboard";
import { SnapshotDatePicker } from "./components/SnapshotDatePicker";
import { StateBanner } from "./components/StateBanner";
import { ThresholdChips } from "./components/ThresholdChips";
import { useCompare } from "./hooks/useCompare";
import { useLatest } from "./hooks/useLatest";
import { useMetadata } from "./hooks/useMetadata";
import { useSnapshot } from "./hooks/useSnapshot";
import { MAX_PINNED_LANGUAGES, type DashboardRange } from "./state/actions";
import { useDashboard } from "./state/DashboardProvider";
import {
  addDaysUtc,
  compareDates,
  computePresetRange,
  SPARKLINE_RANGE_DAYS,
} from "./utils/dates";

function useDashboardBootstrap(launchDate: string | undefined, latestObservedDate: string | null): void {
  const { state, dispatch } = useDashboard();

  useEffect(() => {
    if (launchDate !== undefined && state.launchDate !== launchDate) {
      dispatch({ type: "set_launch_date", launchDate });
    }
  }, [launchDate, state.launchDate, dispatch]);

  useEffect(() => {
    // Seed once when the first /latest response arrives. Re-fetches that
    // surface a newer date must NOT clobber a user-selected snapshot — that's
    // what the explicit "Latest" affordance in SnapshotDatePicker is for.
    if (state.observedDate === null && latestObservedDate !== null) {
      dispatch({ type: "set_observed_date", observedDate: latestObservedDate });
    }
  }, [latestObservedDate, state.observedDate, dispatch]);

  useEffect(() => {
    if (launchDate === undefined) return;
    // Defer until /latest resolves; otherwise we'd stamp a placeholder range
    // and the `from !== ""` gate below would then lock it in forever.
    if (latestObservedDate === null) return;
    if (state.range.from !== "" && state.range.to !== "") return;
    dispatch({
      type: "set_range",
      range: computePresetRange("90d", launchDate, latestObservedDate),
    });
  }, [launchDate, latestObservedDate, state.range.from, state.range.to, dispatch]);
}

// Snapshot date drives the chart's right edge so the trend line always ends
// at the day the leaderboard is showing. For non-custom presets we recompute
// `from` off the preset; for custom ranges we keep `from` (clamped) and just
// snap `to` to the new snapshot date.
function reanchorRange(
  range: DashboardRange,
  launchDate: string,
  newAnchor: string,
): DashboardRange {
  if (range.preset !== "custom") {
    return { ...computePresetRange(range.preset, launchDate, newAnchor), preset: range.preset };
  }
  const from = compareDates(range.from, newAnchor) > 0 ? newAnchor : range.from;
  return { from, to: newAnchor, preset: "custom" };
}

export function App() {
  const metadataQuery = useMetadata();
  const latestQuery = useLatest();
  const { state, dispatch } = useDashboard();

  const launchDate = metadataQuery.data?.launch_date;
  const latestObservedDate = latestQuery.data?.observed_date ?? null;
  useDashboardBootstrap(launchDate, latestObservedDate);

  const snapshotQuery = useSnapshot({
    date: state.observedDate,
    threshold: state.threshold,
  });

  const rankedIds = useMemo(() => {
    if (snapshotQuery.data === undefined) return [];
    return [...snapshotQuery.data.languages]
      .sort((a, b) => b.count - a.count)
      .map((language) => language.id);
  }, [snapshotQuery.data]);
  const topTenIds = useMemo(() => rankedIds.slice(0, LEADERBOARD_SIZE), [rankedIds]);

  const sparklineFrom = useMemo(
    () => (state.observedDate === null ? "" : addDaysUtc(state.observedDate, -(SPARKLINE_RANGE_DAYS - 1))),
    [state.observedDate],
  );
  const sparklineTo = state.observedDate ?? "";

  const sparklineQuery = useCompare({
    languages: topTenIds,
    threshold: state.threshold,
    from: sparklineFrom,
    to: sparklineTo,
  });

  // Defensive cap: worker rejects > MAX_COMPARE_LANGUAGES. UI already gates pins
  // at MAX_PINNED_LANGUAGES, but slicing here makes out-of-band state (e.g. a
  // preload from URL, a test) degrade gracefully instead of 400'ing the server.
  const pinnedIds = useMemo(
    () => Array.from(state.pinnedLanguages).slice(0, MAX_PINNED_LANGUAGES),
    [state.pinnedLanguages],
  );
  const chartLanguages = pinnedIds.length > 0 ? pinnedIds : topTenIds;

  const chartQuery = useCompare({
    languages: chartLanguages,
    threshold: state.threshold,
    from: state.range.from,
    to: state.range.to,
  });

  if (latestObservedDate === null && latestQuery.isSuccess) {
    return (
      <div className="app-shell">
        <AppHeader observedDate={null} windowDays={metadataQuery.data?.window_days ?? 30} />
        <StateBanner
          tone="info"
          title="No published snapshots yet"
          description="Come back after the first daily collection publishes."
        />
      </div>
    );
  }

  // Removing a language from the chart legend has two meanings depending on
  // mode:
  //   - Default top-10 view (no explicit pins): user wants to "swap out" a
  //     line, so we backfill from the next-best ranked language and solidify
  //     the new set as explicit pins.
  //   - Explicit pin mode (user-curated set): user wants to drop a line they
  //     previously selected. Just remove it; if the set empties out, reset
  //     back to the default top-10 view rather than auto-picking a stranger.
  function handleRemoveChartLanguage(languageId: string): void {
    if (rankedIds.length === 0) return;
    const currentSet = chartLanguages;
    if (!currentSet.includes(languageId)) return;
    const remaining = currentSet.filter((id) => id !== languageId);

    if (pinnedIds.length === 0) {
      const replacement = rankedIds.find(
        (id) => id !== languageId && !remaining.includes(id),
      );
      const next = replacement === undefined ? remaining : [...remaining, replacement];
      dispatch({ type: "set_pinned", languageIds: next });
      return;
    }

    if (remaining.length === 0) {
      dispatch({ type: "reset_pins" });
      return;
    }
    dispatch({ type: "set_pinned", languageIds: remaining });
  }

  function handleSnapshotChange(date: string): void {
    dispatch({ type: "set_observed_date", observedDate: date });
    if (launchDate !== undefined) {
      dispatch({ type: "set_range", range: reanchorRange(state.range, launchDate, date) });
    }
  }

  function handleJumpToLatest(): void {
    if (latestObservedDate !== null) handleSnapshotChange(latestObservedDate);
  }

  return (
    <div className="app-shell">
      <AppHeader
        observedDate={latestObservedDate}
        windowDays={metadataQuery.data?.window_days ?? 30}
      />

      <section className="controls-card" aria-label="Dashboard filters">
        <ThresholdChips
          thresholds={metadataQuery.data?.thresholds ?? []}
          activeThreshold={state.threshold}
          observedDate={state.observedDate}
          onChange={(threshold) => dispatch({ type: "set_threshold", threshold })}
        />
        {launchDate !== undefined && latestObservedDate !== null && state.observedDate !== null ? (
          <SnapshotDatePicker
            value={state.observedDate}
            launchDate={launchDate}
            latestObservedDate={latestObservedDate}
            onChange={handleSnapshotChange}
          />
        ) : null}
      </section>

      <Leaderboard
        snapshot={snapshotQuery.data}
        isLoading={snapshotQuery.isLoading}
        error={snapshotQuery.error as Error | null}
        sparklineData={sparklineQuery.data}
        theme={state.theme}
        pinnedLanguages={state.pinnedLanguages}
        onTogglePin={(languageId) => dispatch({ type: "toggle_pin", languageId })}
        onResetPins={() => dispatch({ type: "reset_pins" })}
        registryLanguages={metadataQuery.data?.languages ?? []}
        observedDate={state.observedDate}
        latestObservedDate={latestObservedDate}
        onJumpToLatest={handleJumpToLatest}
      />

      <section className="chart-card" aria-label="Trend comparison">
        {launchDate !== undefined && latestObservedDate !== null && state.observedDate !== null ? (
          <DateRangePicker
            range={state.range}
            launchDate={launchDate}
            latestObservedDate={latestObservedDate}
            anchorDate={state.observedDate}
            onChange={(range) => dispatch({ type: "set_range", range })}
          />
        ) : null}
        <ComparisonChart
          data={chartQuery.data}
          isLoading={chartQuery.isLoading}
          error={chartQuery.error as Error | null}
          theme={state.theme}
          pinnedLanguages={state.pinnedLanguages}
          onTogglePin={(languageId) => dispatch({ type: "toggle_pin", languageId })}
          onRemoveLanguage={handleRemoveChartLanguage}
          chartMode={state.chartMode}
          onChangeChartMode={(mode) => dispatch({ type: "set_chart_mode", mode })}
        />
      </section>
    </div>
  );
}
