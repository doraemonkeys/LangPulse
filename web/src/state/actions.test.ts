import { describe, expect, it } from "vitest";
import { createInitialState, dashboardReducer, DEFAULT_THRESHOLD } from "./actions";

describe("dashboardReducer", () => {
  const initial = createInitialState({ preference: "light", theme: "light" });

  it("starts with the default threshold, 90-day range, and empty pins", () => {
    expect(initial.threshold).toBe(DEFAULT_THRESHOLD);
    expect(initial.range.preset).toBe("90d");
    expect(initial.pinnedLanguages.size).toBe(0);
    expect(initial.theme).toBe("light");
    expect(initial.themePreference).toBe("light");
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

  it("starts in relative chart mode and toggles chart mode without losing other state", () => {
    expect(initial.chartMode).toBe("relative");
    const pinned = dashboardReducer(initial, { type: "toggle_pin", languageId: "go" });
    const absolute = dashboardReducer(pinned, { type: "set_chart_mode", mode: "absolute" });
    expect(absolute.chartMode).toBe("absolute");
    expect(absolute.pinnedLanguages.has("go")).toBe(true);

    const sameMode = dashboardReducer(absolute, { type: "set_chart_mode", mode: "absolute" });
    expect(sameMode).toBe(absolute);
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

    const dark = dashboardReducer(withLaunch, {
      type: "sync_theme",
      preference: "dark",
      theme: "dark",
    });
    expect(dark.theme).toBe("dark");
    expect(dark.themePreference).toBe("dark");

    const system = dashboardReducer(dark, {
      type: "sync_theme",
      preference: "system",
      theme: "light",
    });
    expect(system.themePreference).toBe("system");
    expect(system.theme).toBe("light");
  });

  it("treats set_theme_preference as a no-op (provider intercepts it)", () => {
    const next = dashboardReducer(initial, {
      type: "set_theme_preference",
      preference: "dark",
    });
    expect(next).toBe(initial);
  });

  it("set_pinned replaces the pin set, dedupes, and caps at MAX_PINNED_LANGUAGES", () => {
    const explicit = dashboardReducer(initial, {
      type: "set_pinned",
      languageIds: ["go", "rust", "go", "python"],
    });
    expect(explicit.pinnedLanguages.size).toBe(3);
    expect(explicit.pinnedLanguages.has("go")).toBe(true);
    expect(explicit.pinnedLanguages.has("rust")).toBe(true);
    expect(explicit.pinnedLanguages.has("python")).toBe(true);

    // Identity short-circuit: dispatching the same set should return the same state ref.
    const sameAgain = dashboardReducer(explicit, {
      type: "set_pinned",
      languageIds: ["python", "rust", "go"],
    });
    expect(sameAgain).toBe(explicit);

    const overflow = Array.from({ length: 25 }, (_, idx) => `lang-${idx}`);
    const capped = dashboardReducer(initial, { type: "set_pinned", languageIds: overflow });
    expect(capped.pinnedLanguages.size).toBe(20);
    expect(capped.pinnedLanguages.has("lang-0")).toBe(true);
    expect(capped.pinnedLanguages.has("lang-19")).toBe(true);
    expect(capped.pinnedLanguages.has("lang-20")).toBe(false);
  });
});
