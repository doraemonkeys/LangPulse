import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapshotDatePicker } from "./SnapshotDatePicker";

const launchDate = "2026-04-01";
const latestObservedDate = "2026-04-20";

function setup(value: string, onChange = vi.fn()) {
  render(
    <SnapshotDatePicker
      value={value}
      launchDate={launchDate}
      latestObservedDate={latestObservedDate}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("SnapshotDatePicker", () => {
  it("exposes min/max bounds on the date input", () => {
    setup("2026-04-10");
    const input = screen.getByLabelText("Snapshot date input") as HTMLInputElement;
    expect(input.min).toBe(launchDate);
    expect(input.max).toBe(latestObservedDate);
    expect(input.value).toBe("2026-04-10");
  });

  it("steps backward and forward by one UTC day", async () => {
    const user = userEvent.setup();
    const { onChange } = setup("2026-04-10");

    await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-04-09");

    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-04-11");
  });

  it("disables Previous at the launch date and Next at the latest date", () => {
    const { rerender } = render(
      <SnapshotDatePicker
        value={launchDate}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous day" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next day" })).not.toBeDisabled();

    rerender(
      <SnapshotDatePicker
        value={latestObservedDate}
        launchDate={launchDate}
        latestObservedDate={latestObservedDate}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous day" })).not.toBeDisabled();
  });

  it("clamps out-of-range typed input to the launch/latest bounds", () => {
    const { onChange } = setup("2026-04-10");
    const input = screen.getByLabelText("Snapshot date input");

    fireEvent.change(input, { target: { value: "2025-12-01" } });
    expect(onChange).toHaveBeenLastCalledWith(launchDate);

    fireEvent.change(input, { target: { value: "2026-12-01" } });
    expect(onChange).toHaveBeenLastCalledWith(latestObservedDate);
  });

  it("Latest button jumps to latestObservedDate and is pressed when already there", async () => {
    const user = userEvent.setup();
    const { onChange } = setup("2026-04-10");
    const latestButton = screen.getByRole("button", { name: "Latest" });
    expect(latestButton).toHaveAttribute("aria-pressed", "false");

    await user.click(latestButton);
    expect(onChange).toHaveBeenLastCalledWith(latestObservedDate);
  });

  it("ignores empty input change events (browser quirk during typing)", () => {
    const { onChange } = setup("2026-04-10");
    fireEvent.change(screen.getByLabelText("Snapshot date input"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
