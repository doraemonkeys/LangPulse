import { describe, expect, it } from "vitest";
import { getLanguageColor } from "./languageColors";
import { getLineColor, getPaletteForIds } from "./palette";

describe("palette", () => {
  it("returns deterministic Okabe-Ito colors per index and theme", () => {
    expect(getLineColor(0, "light")).toBe("#E69F00");
    expect(getLineColor(0, "dark")).toBe("#E69F00");
    expect(getLineColor(4, "light")).toBe("#0072B2");
    expect(getLineColor(4, "dark")).toBe("#4FA8E0");
  });

  it("wraps around the fallback palette modulo its length", () => {
    const size = 10;
    expect(getLineColor(size, "light")).toBe(getLineColor(0, "light"));
  });

  it("binds known languages to their github-linguist color", () => {
    const map = getPaletteForIds(["go", "rust", "python"], "light");
    expect(map.get("go")).toBe("#00ADD8");
    expect(map.get("rust")).toBe("#DEA584");
    expect(map.get("python")).toBe("#3572A5");
  });

  it("applies theme overrides for low-contrast linguist colors", () => {
    expect(getPaletteForIds(["javascript"], "light").get("javascript")).toBe("#C9A227");
    expect(getPaletteForIds(["javascript"], "dark").get("javascript")).toBe("#F1E05A");
    expect(getPaletteForIds(["powershell"], "dark").get("powershell")).toBe("#5391FE");
    expect(getPaletteForIds(["powershell"], "light").get("powershell")).toBe("#012456");
  });

  it("falls back to Okabe-Ito for languages without a linguist color", () => {
    const map = getPaletteForIds(["move", "pascal", "cobol"], "light");
    expect(map.get("move")).toBe(getLineColor(0, "light"));
    expect(map.get("pascal")).toBe(getLineColor(1, "light"));
    expect(map.get("cobol")).toBe(getLineColor(2, "light"));
  });

  it("uses a separate fallback counter so known languages don't shift unknowns", () => {
    // Known languages (go, rust) take their linguist colors and do NOT advance
    // the fallback index, so the only unknown ("move") still lands on slot 0.
    const map = getPaletteForIds(["go", "move", "rust"], "light");
    expect(map.get("go")).toBe("#00ADD8");
    expect(map.get("rust")).toBe("#DEA584");
    expect(map.get("move")).toBe(getLineColor(0, "light"));
  });

  it("preserves input order in the resulting map", () => {
    const map = getPaletteForIds(["python", "go", "rust"], "light");
    expect(Array.from(map.keys())).toEqual(["python", "go", "rust"]);
  });

  it("returns null from getLanguageColor for unknown IDs", () => {
    expect(getLanguageColor("not-a-language", "light")).toBeNull();
    expect(getLanguageColor("move", "dark")).toBeNull();
  });
});
