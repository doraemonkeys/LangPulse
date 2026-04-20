import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThresholdChips } from "./ThresholdChips";
import type { PublicThreshold } from "../api/types";

const THRESHOLDS: PublicThreshold[] = [
  { value: 0, active_from: "2026-04-01", active_to: null },
  { value: 2, active_from: "2026-04-01", active_to: null },
  { value: 10, active_from: "2026-04-01", active_to: null },
  { value: 50, active_from: "2026-04-01", active_to: "2026-04-03" },
];

describe("ThresholdChips", () => {
  it("filters out retired thresholds and marks active chip", () => {
    render(
      <ThresholdChips
        thresholds={THRESHOLDS}
        activeThreshold={2}
        observedDate="2026-04-10"
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { pressed: true })!.textContent).toContain("2");
    expect(screen.queryAllByRole("button", { pressed: false })).toHaveLength(2);
  });

  it("calls onChange when a chip is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ThresholdChips
        thresholds={THRESHOLDS}
        activeThreshold={2}
        observedDate="2026-04-10"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /\u2265 10/ }));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("navigates chips with arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <ThresholdChips
        thresholds={THRESHOLDS}
        activeThreshold={2}
        observedDate="2026-04-10"
        onChange={() => {}}
      />,
    );
    const buttons = screen.getAllByRole("button");
    buttons[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("uses retired flag when observed_date is null", () => {
    render(
      <ThresholdChips
        thresholds={THRESHOLDS}
        activeThreshold={0}
        observedDate={null}
        onChange={() => {}}
      />,
    );
    // Retired threshold (active_to != null) should be filtered out.
    expect(screen.queryAllByRole("button")).toHaveLength(3);
  });
});
