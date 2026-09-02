import type { ThemeMode } from "./palette";

// Source: github-linguist `lib/linguist/languages.yml`. Bound by language ID so
// the same language always renders in the same hue across snapshots, charts,
// and sessions — matching the color users already associate with each language
// on github.com.
//
// Per-theme overrides are applied wherever the linguist color falls below
// 1.6:1 contrast against the active background (parchment #f4efe6 / dark slate
// #141a22 — see web/src/theme/tokens.css). Identity wins above that threshold;
// readability wins below it. The policy is enforced by a contrast assertion
// test in palette.test.ts that iterates every entry — adding a new language or
// changing a hex without meeting 1.6:1 will fail CI.
interface LanguageColorEntry {
  base: string;
  light?: string;
  dark?: string;
}

const LANGUAGE_COLORS: Record<string, LanguageColorEntry> = {
  go: { base: "#00ADD8" },
  rust: { base: "#DEA584" },
  python: { base: "#3572A5" },
  // Pale yellow is unreadable on parchment; deepen to amber.
  javascript: { base: "#F1E05A", light: "#C9A227" },
  typescript: { base: "#3178C6" },
  java: { base: "#B07219" },
  csharp: { base: "#7355dd" },
  cpp: { base: "#F34B7D" },
  c: { base: "#555555" },
  php: { base: "#4F5D95" },
  kotlin: { base: "#A97BFF" },
  swift: { base: "#F05138" },
  solidity: { base: "#AA6746" },
  // Lime green disappears on parchment (~1.43:1); deepen to forest green.
  shell: { base: "#89E051", light: "#4E8C2C" },
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
  // Bright cyan disappears on parchment (~1.50:1); deepen to teal.
  vbscript: { base: "#15DCDC", light: "#0E9494" },
  // Pure navy on dark slate has ~1.4:1 contrast.
  lua: { base: "#000080", dark: "#5577FF" },
  erlang: { base: "#B83998" },
  scala: { base: "#C22D40" },
  // Dark maroon on dark slate; brighten to community red.
  ruby: { base: "#701516", dark: "#CC342D" },
  "objective-c": { base: "#438EFF" },
  julia: { base: "#A270BA" },
  haskell: { base: "#5E5086" },
  perl: { base: "#0298C3" },
  nix: { base: "#7E7EFF" },
  // Languages without a github-linguist color (move, pascal, cobol) are
  // intentionally omitted — they fall through to the Okabe-Ito fallback.
};

export const KNOWN_LANGUAGE_IDS: readonly string[] = Object.freeze(
  Object.keys(LANGUAGE_COLORS),
);

export function getLanguageColor(languageId: string, theme: ThemeMode): string | null {
  const entry = LANGUAGE_COLORS[languageId];
  if (entry === undefined) return null;
  if (theme === "dark" && entry.dark !== undefined) return entry.dark;
  if (theme === "light" && entry.light !== undefined) return entry.light;
  return entry.base;
}
