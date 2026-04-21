import clsx from "clsx";
import type { DashboardRange } from "../state/actions";
import {
  clampDate,
  compareDates,
  computePresetRange,
  type RangePreset,
} from "../utils/dates";

interface DateRangePickerProps {
  range: DashboardRange;
  launchDate: string;
  latestObservedDate: string;
  onChange: (range: DashboardRange) => void;
}

const PRESETS: Array<{ preset: Exclude<RangePreset, "custom">; label: string }> = [
  { preset: "30d", label: "30d" },
  { preset: "90d", label: "90d" },
  { preset: "180d", label: "180d" },
  { preset: "max", label: "Max" },
];

export function DateRangePicker({
  range,
  launchDate,
  latestObservedDate,
  onChange,
}: DateRangePickerProps) {
  function handlePreset(preset: Exclude<RangePreset, "custom">): void {
    onChange(computePresetRange(preset, launchDate, latestObservedDate));
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
        {PRESETS.map((item) => (
          <button
            key={item.preset}
            type="button"
            className={clsx("chip", range.preset === item.preset && "chip--active")}
            aria-pressed={range.preset === item.preset}
            onClick={() => handlePreset(item.preset)}
          >
            {item.label}
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
