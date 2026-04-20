import { useRef } from "react";
import clsx from "clsx";
import type { PublicThreshold } from "../api/types";
import { isActiveOn } from "../utils/dates";
import { formatThresholdLabel } from "../utils/format";

interface ThresholdChipsProps {
  thresholds: PublicThreshold[];
  activeThreshold: number;
  observedDate: string | null;
  onChange: (threshold: number) => void;
}

export function ThresholdChips({
  thresholds,
  activeThreshold,
  observedDate,
  onChange,
}: ThresholdChipsProps) {
  const visibleThresholds = thresholds.filter((threshold) => isActiveOn(threshold, observedDate));
  const containerRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>("button[data-chip]");
    if (!buttons || buttons.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const currentIndex = Array.from(buttons).findIndex((button) => button === active);
    if (currentIndex === -1) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  return (
    <div
      ref={containerRef}
      className="threshold-chips"
      role="group"
      aria-label="Star threshold"
      onKeyDown={handleKeyDown}
    >
      <span className="threshold-chips__label">Stars</span>
      {visibleThresholds.map((threshold) => {
        const selected = threshold.value === activeThreshold;
        return (
          <button
            key={threshold.value}
            type="button"
            data-chip
            className={clsx("chip", selected && "chip--active")}
            aria-pressed={selected}
            onClick={() => onChange(threshold.value)}
          >
            {formatThresholdLabel(threshold.value)}
          </button>
        );
      })}
    </div>
  );
}
