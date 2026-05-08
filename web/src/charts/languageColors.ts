import type { ThemeMode } from "./palette";

// Source: github-linguist `lib/linguist/languages.yml`. Bound by language ID so
// the same language always renders in the same hue across snapshots, charts,
// and sessions — matching the color users already associate with each language
// on github.com.
//
// Per-theme overrides are applied only where the linguist color falls below
// ~2.5:1 contrast against the active background (parchment #f4efe6 / dark slate
// #141a22). Anything brighter than that keeps its canonical color.
interface LanguageColorEntry {
  base: string;
  light?: string;
  dark?: string;
}

const LANGUAGE_COLORS: Record<string, LanguageColorEntry> = {
  go: { base: "#00ADD8" },
  rust: { base: "#DEA584" },
  python: { base: "#3572A5" },
  // Pale yellow disappears on parchment; deepen to amber.
  javascript: { base: "#F1E05A", light: "#C9A227" },
  typescript: { base: "#3178C6" },
  java: { base: "#B07219" },
  csharp: { base: "#178600" },
  cpp: { base: "#F34B7D" },
  c: { base: "#555555" },
  // Linguist navy is unreadable on dark slate; lift to PHP's community blue.
  php: { base: "#4F5D95", dark: "#8993BE" },
  kotlin: { base: "#A97BFF" },
  swift: { base: "#F05138" },
  solidity: { base: "#AA6746" },
  shell: { base: "#89E051" },
  // Linguist's #012456 is essentially invisible on dark slate.
  powershell: { base: "#012456", dark: "#5391FE" },
  dart: { base: "#00B4AB" },
  vue: { base: "#41B883" },
  "visual-basic-dotnet": { base: "#945DB7" },
  r: { base: "#198CE7" },
  matlab: { base: "#E16737" },
  fortran: { base: "#4D41B1" },
  // Bright neon green disappears on parchment.
  ada: { base: "#02F88C", light: "#1C9F5E" },
  "common-lisp": { base: "#3FB68B" },
  zig: { base: "#EC915C" },
  vbscript: { base: "#15DCDC" },
  // Pure navy on dark slate has ~1.4:1 contrast.
  lua: { base: "#000080", dark: "#5577FF" },
  erlang: { base: "#B83998" },
  scala: { base: "#C22D40" },
  // Dark maroon on dark slate; brighten to community red.
  ruby: { base: "#701516", dark: "#CC342D" },
  "objective-c": { base: "#438EFF" },
  julia: { base: "#A270BA" },
  // Muddy purple on dark slate; lift to a paler tint.
  haskell: { base: "#5E5086", dark: "#9085C2" },
  perl: { base: "#0298C3" },
  nix: { base: "#7E7EFF" },
  // Languages without a github-linguist color (move, pascal, cobol) are
  // intentionally omitted — they fall through to the Okabe-Ito fallback.
};

export function getLanguageColor(languageId: string, theme: ThemeMode): string | null {
  const entry = LANGUAGE_COLORS[languageId];
  if (entry === undefined) return null;
  if (theme === "dark" && entry.dark !== undefined) return entry.dark;
  if (theme === "light" && entry.light !== undefined) return entry.light;
  return entry.base;
}
