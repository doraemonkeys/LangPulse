import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast";

describe("relativeLuminance", () => {
  it("returns 0 for pure black and 1 for pure white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("matches WCAG reference value for 50% gray", () => {
    // sRGB #777777 luminance is ~0.1845 per WCAG 2.1 worked examples.
    expect(relativeLuminance("#777777")).toBeCloseTo(0.1845, 3);
  });

  it("rejects malformed hex strings", () => {
    expect(() => relativeLuminance("777777")).toThrow();
    expect(() => relativeLuminance("#FFF")).toThrow();
  });
});

describe("contrastRatio", () => {
  it("yields 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("is symmetric in its operands", () => {
    expect(contrastRatio("#3572A5", "#f4efe6")).toBeCloseTo(
      contrastRatio("#f4efe6", "#3572A5"),
      5,
    );
  });

  it("returns 1:1 for identical colors", () => {
    expect(contrastRatio("#AABBCC", "#AABBCC")).toBeCloseTo(1, 5);
  });
});
