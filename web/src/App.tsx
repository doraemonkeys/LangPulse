import { useEffect, useMemo } from "react";
import { AppHeader } from "./components/AppHeader";
import { ComparisonChart } from "./components/ComparisonChart";
import { DateRangePicker } from "./components/DateRangePicker";
import { Leaderboard, LEADERBOARD_SIZE } from "./components/Leaderboard";
import { StateBanner } from "./components/StateBanner";
import { ThresholdChips } from "./components/ThresholdChips";
import { useCompare } from "./hooks/useCompare";
import { useLatest } from "./hooks/useLatest";
import { useMetadata } from "./hooks/useMetadata";
import { useSnapshot } from "./hooks/useSnapshot";
import { useDashboard } from "./state/DashboardProvider";
import { addDaysUtc, computePresetRange, SPARKLINE_RANGE_DAYS } from "./utils/dates";

function useDashboardBootstrap(launchDate: string | undefined, latestObservedDate: string | null): void {
  const { state, dispatch } = useDashboard();

  useEffect(() => {
    if (launchDate !== undefined && state.launchDate !== launchDate) {
      dispatch({ type: "set_launch_date", launchDate });
    }
  }, [launchDate, state.launchDate, dispatch]);

  useEffect(() => {
    if (state.observedDate !== latestObservedDate) {
      dispatch({ type: "set_observed_date", observedDate: latestObservedDate });
    }
  }, [latestObservedDate, state.observedDate, dispatch]);

  useEffect(() => {
    if (launchDate === undefined) return;
    if (state.range.from !== "" && state.range.to !== "") return;
    dispatch({
      type: "set_range",
      range: computePresetRange("90d", launchDate, latestObservedDate),
    });
  }, [launchDate, latestObservedDate, state.range.from, state.range.to, dispatch]);
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

  const topTenIds = useMemo(() => {
    if (snapshotQuery.data === undefined) return [];
    return [...snapshotQuery.data.languages]
      .sort((a, b) => b.count - a.count)
      .slice(0, LEADERBOARD_SIZE)
      .map((language) => language.id);
  }, [snapshotQuery.data]);

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

  const pinnedIds = useMemo(() => Array.from(state.pinnedLanguages), [state.pinnedLanguages]);
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
          observedDate={latestObservedDate}
          onChange={(threshold) => dispatch({ type: "set_threshold", threshold })}
        />
        {launchDate !== undefined ? (
          <DateRangePicker
            range={state.range}
            launchDate={launchDate}
            latestObservedDate={latestObservedDate}
            onChange={(range) => dispatch({ type: "set_range", range })}
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
      />

      <ComparisonChart
        data={chartQuery.data}
        isLoading={chartQuery.isLoading}
        error={chartQuery.error as Error | null}
        theme={state.theme}
        pinnedLanguages={state.pinnedLanguages}
        onTogglePin={(languageId) => dispatch({ type: "toggle_pin", languageId })}
      />
    </div>
  );
}
