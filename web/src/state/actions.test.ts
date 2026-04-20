import { describe, expect, it } from "vitest";
import { createInitialState, dashboardReducer, DEFAULT_THRESHOLD } from "./actions";

describe("dashboardReducer", () => {
  const initial = createInitialState("light");

  it("starts with threshold >= 2 and empty pins", () => {
    expect(initial.threshold).toBe(DEFAULT_THRESHOLD);
    expect(initial.pinnedLanguages.size).toBe(0);
    expect(initial.theme).toBe("light");
  });

  it("updates threshold without clearing pins", () => {
    const pinned = dashboardReducer(initial, { type: "toggle_pin", languageId: "go" });
    const next = dashboardReducer(pinned, { type: "set_threshold", threshold: 100 });
    expect(next.threshold).toBe(100);
    expect(next.pinnedLanguages.has("go")).toBe(true);
  });

  it("toggles pins, resets pins, and is idempotent when no pins exist", () => {
    const added = dashboardReducer(initial, { type: "toggle_pin", languageId: "rust" });
    expect(added.pinnedLanguages.has("rust")).toBe(true);
    const removed = dashboardReducer(added, { type: "toggle_pin", languageId: "rust" });
    expect(removed.pinnedLanguages.has("rust")).toBe(false);

    const reset = dashboardReducer(initial, { type: "reset_pins" });
    expect(reset).toBe(initial);

    const afterAddReset = dashboardReducer(added, { type: "reset_pins" });
    expect(afterAddReset.pinnedLanguages.size).toBe(0);
  });

  it("updates range, observed_date, launch_date, and theme", () => {
    const withRange = dashboardReducer(initial, {
      type: "set_range",
      range: { from: "2026-04-01", to: "2026-04-10", preset: "custom" },
    });
    expect(withRange.range.from).toBe("2026-04-01");

    const withObserved = dashboardReducer(withRange, {
      type: "set_observed_date",
      observedDate: "2026-04-10",
    });
    expect(withObserved.observedDate).toBe("2026-04-10");

    const withLaunch = dashboardReducer(withObserved, {
      type: "set_launch_date",
      launchDate: "2026-04-01",
    });
    expect(withLaunch.launchDate).toBe("2026-04-01");

    const dark = dashboardReducer(withLaunch, { type: "set_theme", theme: "dark" });
    expect(dark.theme).toBe("dark");
  });
});
