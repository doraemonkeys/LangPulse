import clsx from "clsx";
import { addDaysUtc, clampDate, compareDates } from "../utils/dates";

interface SnapshotDatePickerProps {
  value: string;
  launchDate: string;
  latestObservedDate: string;
  onChange: (date: string) => void;
}

function clampToBounds(candidate: string, launchDate: string, latestObservedDate: string): string {
  const lower = clampDate(candidate, launchDate);
  return compareDates(lower, latestObservedDate) > 0 ? latestObservedDate : lower;
}

export function SnapshotDatePicker({
  value,
  launchDate,
  latestObservedDate,
  onChange,
}: SnapshotDatePickerProps) {
  const atStart = compareDates(value, launchDate) <= 0;
  const atEnd = compareDates(value, latestObservedDate) >= 0;

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
    if (event.target.value === "") return;
    onChange(clampToBounds(event.target.value, launchDate, latestObservedDate));
  }

  function step(delta: number): void {
    onChange(clampToBounds(addDaysUtc(value, delta), launchDate, latestObservedDate));
  }

  return (
    <div className="snapshot-date" role="group" aria-label="Snapshot date">
      <span className="snapshot-date__label">Snapshot</span>
      <button
        type="button"
        className="chip snapshot-date__step"
        aria-label="Previous day"
        onClick={() => step(-1)}
        disabled={atStart}
      >
        {"←"}
      </button>
      <input
        type="date"
        className="snapshot-date__input"
        aria-label="Snapshot date input"
        value={value}
        min={launchDate}
        max={latestObservedDate}
        onChange={handleInputChange}
      />
      <button
        type="button"
        className="chip snapshot-date__step"
        aria-label="Next day"
        onClick={() => step(1)}
        disabled={atEnd}
      >
        {"→"}
      </button>
      <button
        type="button"
        className={clsx("chip", atEnd && "chip--active")}
        aria-pressed={atEnd}
        onClick={() => onChange(latestObservedDate)}
      >
        Latest
      </button>
    </div>
  );
}
