import { describe, expect, it } from "vitest";
import {
  addDaysUtc,
  clampDate,
  compareDates,
  computeDefaultRange,
  computePresetRange,
  DEFAULT_RANGE_PRESET,
  formatShortDate,
  presetToDays,
  TREND_RANGE_PRESETS,
} from "./dates";

describe("date utils", () => {
  it("adds and subtracts UTC days", () => {
    expect(addDaysUtc("2026-04-10", 1)).toBe("2026-04-11");
    expect(addDaysUtc("2026-04-01", -1)).toBe("2026-03-31");
  });

  it("compares and clamps dates to the launch floor", () => {
    expect(compareDates("2026-04-10", "2026-04-12")).toBeLessThan(0);
    expect(clampDate("2025-12-01", "2026-04-01")).toBe("2026-04-01");
    expect(clampDate("2026-04-15", "2026-04-01")).toBe("2026-04-15");
  });

  it("caps the default range at the launch date", () => {
    const result = computeDefaultRange("2026-04-01", "2026-04-03", 90);
    expect(result.from).toBe("2026-04-01");
    expect(result.to).toBe("2026-04-03");
  });

  it("defines the supported trend ranges with a 60-day default", () => {
    expect(TREND_RANGE_PRESETS.map(({ preset }) => preset)).toEqual([
      "30d",
      "60d",
      "90d",
      "180d",
    ]);
    expect(DEFAULT_RANGE_PRESET).toBe("60d");
    expect(presetToDays("30d")).toBe(30);
    expect(presetToDays("60d")).toBe(60);
    expect(presetToDays("90d")).toBe(90);
    expect(presetToDays("180d")).toBe(180);

    const sixty = computePresetRange(DEFAULT_RANGE_PRESET, "2026-01-01", "2026-04-20");
    expect(sixty).toEqual({ from: "2026-02-20", to: "2026-04-20", preset: "60d" });

    const thirty = computePresetRange("30d", "2026-04-01", "2026-04-20");
    expect(thirty.preset).toBe("30d");
    expect(thirty.to).toBe("2026-04-20");

    const custom = computePresetRange("custom", "2026-04-01", "2026-04-20");
    expect(custom.preset).toBe("custom");
  });

  it("formats short date strings", () => {
    expect(formatShortDate("2026-04-09")).toBe("Apr 9");
    expect(formatShortDate("2026-12-01")).toBe("Dec 1");
  });
});
