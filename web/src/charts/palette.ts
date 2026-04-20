export type ThemeMode = "light" | "dark";

// Okabe-Ito colorblind-safe palette plus two warm extensions, tuned to hold
// contrast against both the parchment and the dark slate backgrounds.
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

export function getPaletteForIds(ids: string[], theme: ThemeMode): Map<string, string> {
  const result = new Map<string, string>();
  ids.forEach((id, index) => {
    result.set(id, getLineColor(index, theme));
  });
  return result;
}
