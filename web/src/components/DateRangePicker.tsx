import clsx from "clsx";
import type { DashboardRange } from "../state/actions";
import {
  clampDate,
  compareDates,
  computePresetRange,
  TREND_RANGE_PRESETS,
  type TrendRangePreset,
} from "../utils/dates";

interface DateRangePickerProps {
  range: DashboardRange;
  launchDate: string;
  latestObservedDate: string;
  anchorDate: string;
  onChange: (range: DashboardRange) => void;
}

export function DateRangePicker({
  range,
  launchDate,
  latestObservedDate,
  anchorDate,
  onChange,
}: DateRangePickerProps) {
  function handlePreset(preset: TrendRangePreset): void {
    // Anchor presets on the snapshot date so trends always end at what the
    // leaderboard is showing. latestObservedDate is only used as the upper
    // bound on the date inputs below.
    onChange(computePresetRange(preset, launchDate, anchorDate));
  }

  function handleFromChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const from = clampDate(event.target.value, launchDate);
    const to = compareDates(from, range.to) > 0 ? from : range.to;
    onChange({ from, to, preset: "custom" });
  }

  function handleToChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const candidate =
      compareDates(event.target.value, latestObservedDate) > 0
        ? latestObservedDate
        : event.target.value;
    const to = compareDates(candidate, range.from) < 0 ? range.from : candidate;
    onChange({ from: range.from, to, preset: "custom" });
  }

  return (
    <div className="date-range" role="group" aria-label="Date range">
      <div className="date-range__presets">
        {TREND_RANGE_PRESETS.map(({ preset }) => (
          <button
            key={preset}
            type="button"
            className={clsx("chip", range.preset === preset && "chip--active")}
            aria-pressed={range.preset === preset}
            onClick={() => handlePreset(preset)}
          >
            {preset}
          </button>
        ))}
      </div>
      <label className="date-range__field">
        <span>From</span>
        <input
          type="date"
          value={range.from}
          min={launchDate}
          max={latestObservedDate}
          onChange={handleFromChange}
        />
      </label>
      <label className="date-range__field">
        <span>To</span>
        <input
          type="date"
          value={range.to}
          min={launchDate}
          max={latestObservedDate}
          onChange={handleToChange}
        />
      </label>
    </div>
  );
}
