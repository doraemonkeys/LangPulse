import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateRangePicker } from "./DateRangePicker";

const launchDate = "2026-04-01";
const latestObservedDate = "2026-04-20";
const initialRange = { from: "2026-04-10", to: "2026-04-20", preset: "60d" as const };

describe("DateRangePicker", () => {
  it("shows only the supported presets and highlights the active one", () => {
    render(
      <DateRangePicker
        range={initialRange}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate={latestObservedDate}
        onChange={() => {}}
      />,
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "30d",
      "60d",
      "90d",
      "180d",
    ]);
    expect(screen.getByRole("button", { name: "60d" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /max/i })).not.toBeInTheDocument();
  });

  it("emits a new range when a preset is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        range={initialRange}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate={latestObservedDate}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "30d" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: "30d" }));
  });

  it("anchors preset ranges on anchorDate, not on latestObservedDate", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        range={initialRange}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate="2026-04-15"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "30d" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ to: "2026-04-15", preset: "30d" }),
    );
  });

  it("clamps custom From before launch and keeps To on or after From", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DateRangePicker
        range={initialRange}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate={latestObservedDate}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-12-01" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2026-04-01", to: "2026-04-20", preset: "custom" });

    onChange.mockClear();
    rerender(
      <DateRangePicker
        range={{ from: "2026-04-18", to: "2026-04-20", preset: "custom" }}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate={latestObservedDate}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-04-25" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2026-04-25", to: "2026-04-25", preset: "custom" });
  });

  it("caps custom To at the latest observed date and never before From", () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker
        range={initialRange}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        anchorDate={latestObservedDate}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-05-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-04-10", to: "2026-04-20", preset: "custom" });

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-04-05" } });
    expect(onChange).toHaveBeenLastCalledWith({ from: "2026-04-10", to: "2026-04-10", preset: "custom" });
  });
});
