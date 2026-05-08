import { getLanguageColor } from "./languageColors";

export type ThemeMode = "light" | "dark";

// Okabe-Ito colorblind-safe palette plus two warm extensions, tuned to hold
// contrast against both the parchment and the dark slate backgrounds. Used as
// a deterministic fallback for languages that lack a github-linguist color.
const BASE_PALETTE = [
  "#E69F00",
  "#56B4E9",
  "#009E73",
  "#D55E00",
  "#0072B2",
  "#CC79A7",
  "#F0E442",
  "#66A61E",
  "#8E6C8A",
  "#A6761D",
] as const;

const DARK_OVERRIDES: Record<number, string> = {
  // "#0072B2" is muddy on the dark-slate panel; brighten to a cooler blue.
  4: "#4FA8E0",
  // "#F0E442" is near-fluorescent on dark; mute to parchment yellow.
  6: "#D9C75C",
};

export function getLineColor(index: number, theme: ThemeMode): string {
  const position = index % BASE_PALETTE.length;
  if (theme === "dark" && DARK_OVERRIDES[position] !== undefined) {
    return DARK_OVERRIDES[position];
  }

  return BASE_PALETTE[position];
}

// Resolves color per language ID. Known languages get their github-linguist
// hue (with theme-aware overrides for low-contrast cases); unknown IDs fall
// back to the Okabe-Ito wheel indexed by their position in the input list, so
// neighboring unknowns still get distinct colors.
export function getPaletteForIds(ids: string[], theme: ThemeMode): Map<string, string> {
  const result = new Map<string, string>();
  let fallbackIndex = 0;
  ids.forEach((id) => {
    const linguistColor = getLanguageColor(id, theme);
    if (linguistColor !== null) {
      result.set(id, linguistColor);
    } else {
      result.set(id, getLineColor(fallbackIndex, theme));
      fallbackIndex += 1;
    }
  });
  return result;
}
