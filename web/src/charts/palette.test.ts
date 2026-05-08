import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { getLanguageColor, KNOWN_LANGUAGE_IDS } from "./languageColors";
import { getLineColor, getPaletteForIds } from "./palette";

// Mirror of --bg in web/src/theme/tokens.css. If the theme tokens move, this
// must move with them — the contrast policy is meaningless against the wrong
// background.
const LIGHT_BG = "#f4efe6";
const DARK_BG = "#141a22";
const MIN_CONTRAST = 1.6;

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
    // Use dark theme so rust's base linguist color (no dark override) is
    // returned directly — light theme would surface the contrast override.
    const map = getPaletteForIds(["go", "rust", "python"], "dark");
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
    const map = getPaletteForIds(["go", "move", "rust"], "dark");
    expect(map.get("go")).toBe("#00ADD8");
    expect(map.get("rust")).toBe("#DEA584");
    expect(map.get("move")).toBe(getLineColor(0, "dark"));
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

describe("language color contrast policy", () => {
  // Iterates the entire registry so adding a new language with a low-contrast
  // linguist color trips CI immediately, instead of silently regressing the
  // chart on one of the two themes.
  it(`every known language meets ≥${MIN_CONTRAST}:1 against both backgrounds`, () => {
    const violations: string[] = [];
    for (const id of KNOWN_LANGUAGE_IDS) {
      for (const [theme, bg] of [
        ["light", LIGHT_BG],
        ["dark", DARK_BG],
      ] as const) {
        const color = getLanguageColor(id, theme);
        if (color === null) {
          violations.push(`${id}/${theme}: missing color`);
          continue;
        }
        const ratio = contrastRatio(color, bg);
        if (ratio < MIN_CONTRAST) {
          violations.push(
            `${id}/${theme}: ${color} on ${bg} → ${ratio.toFixed(2)}:1 (< ${MIN_CONTRAST.toFixed(1)})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
