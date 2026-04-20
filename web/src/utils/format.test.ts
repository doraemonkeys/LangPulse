import { describe, expect, it } from "vitest";
import {
  computeDelta,
  formatCompactCount,
  formatFullCount,
  formatRank,
  formatThresholdLabel,
} from "./format";

describe("format utils", () => {
  it("formats compact and full counts", () => {
    expect(formatCompactCount(1_200)).toBe("1.2K");
    expect(formatCompactCount(3_200_000)).toBe("3.2M");
    expect(formatFullCount(1_234_567)).toBe("1,234,567");
  });

  it("computes delta with sign and handles null + zero previous", () => {
    expect(computeDelta(110, 100)).toEqual({ label: "+10.0%", sign: "positive" });
    expect(computeDelta(80, 100)).toEqual({ label: "\u221220.0%", sign: "negative" });
    expect(computeDelta(100, 100)).toEqual({ label: "0%", sign: "zero" });
    expect(computeDelta(5, null).sign).toBe("unknown");
    expect(computeDelta(0, 0)).toEqual({ label: "0%", sign: "zero" });
    expect(computeDelta(5, 0).sign).toBe("positive");
  });

  it("formats rank and threshold labels", () => {
    expect(formatRank(3)).toBe("#3");
    expect(formatThresholdLabel(0)).toBe("All");
    expect(formatThresholdLabel(1000)).toContain("\u2265");
  });
});
