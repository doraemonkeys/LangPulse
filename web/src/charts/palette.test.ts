import { describe, expect, it } from "vitest";
import { getLineColor, getPaletteForIds } from "./palette";

describe("palette", () => {
  it("returns deterministic colors per index and theme", () => {
    expect(getLineColor(0, "light")).toBe("#E69F00");
    expect(getLineColor(0, "dark")).toBe("#E69F00");
    expect(getLineColor(4, "light")).toBe("#0072B2");
    expect(getLineColor(4, "dark")).toBe("#4FA8E0");
  });

  it("wraps around the palette modulo its length", () => {
    const size = 10;
    expect(getLineColor(size, "light")).toBe(getLineColor(0, "light"));
  });

  it("builds an ID->color map preserving input order", () => {
    const map = getPaletteForIds(["go", "rust", "python"], "light");
    expect(Array.from(map.keys())).toEqual(["go", "rust", "python"]);
    expect(map.get("go")).toBe(getLineColor(0, "light"));
  });
});
