import { DEFAULT_RANGE_PRESET, type RangePreset } from "../utils/dates";

// `ThemeMode` is the *resolved* effective theme used for rendering (chart axes,
// CSS variables). `ThemePreference` is what the user picked — "system" defers
// the decision to the OS via `prefers-color-scheme`. Splitting them keeps the
// rendering layer ignorant of whether the active theme came from a manual
// choice or system follow-along.
export type ThemeMode = "light" | "dark";
export type ThemePreference = "light" | "dark" | "system";

// "absolute" preserves raw counts so the chart answers "who's bigger"; "relative"
// rebases each language to its own first valid sample so small-but-meaningful
// fluctuations are not flattened by a larger language's scale. The mode is
// user-visible chart semantics, so it lives in dashboard state rather than as
// component-local state.
export type ChartMode = "absolute" | "relative";

export interface DashboardRange {
  from: string;
  to: string;
  preset: RangePreset;
}

export interface DashboardState {
  threshold: number;
  range: DashboardRange;
  pinnedLanguages: ReadonlySet<string>;
  observedDate: string | null;
  launchDate: string | null;
  themePreference: ThemePreference;
  theme: ThemeMode;
  chartMode: ChartMode;
}

export type DashboardAction =
  | { type: "set_threshold"; threshold: number }
  | { type: "set_range"; range: DashboardRange }
  | { type: "toggle_pin"; languageId: string }
  // Explicit batch set — used when an interaction (e.g. remove-with-replacement
  // from the chart legend) computes the new pinned set in one shot. Toggling
  // would race with the implicit "no pins ⇒ top-10" fallback.
  | { type: "set_pinned"; languageIds: ReadonlyArray<string> }
  | { type: "reset_pins" }
  | { type: "set_observed_date"; observedDate: string | null }
  | { type: "set_launch_date"; launchDate: string }
  // User intent: change the preference. Intercepted by the provider — the
  // resolved theme is owned by `useTheme`, so this never reaches the reducer.
  | { type: "set_theme_preference"; preference: ThemePreference }
  // Internal sync: the provider mirrors hook state into the reducer with this.
  | { type: "sync_theme"; preference: ThemePreference; theme: ThemeMode }
  | { type: "set_chart_mode"; mode: ChartMode };

function togglePin(pinnedLanguages: ReadonlySet<string>, languageId: string): Set<string> {
  const next = new Set(pinnedLanguages);
  if (next.has(languageId)) {
    next.delete(languageId);
  } else {
    next.add(languageId);
  }
  return next;
}

function setsHaveSameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function syncTheme(state: DashboardState, preference: ThemePreference, theme: ThemeMode): DashboardState {
  if (state.themePreference === preference && state.theme === theme) return state;
  return { ...state, themePreference: preference, theme };
}

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "set_threshold":
      return { ...state, threshold: action.threshold };
    case "set_range":
      return { ...state, range: action.range };
    case "toggle_pin":
      return { ...state, pinnedLanguages: togglePin(state.pinnedLanguages, action.languageId) };
    case "set_pinned": {
      const next = new Set<string>(action.languageIds.slice(0, MAX_PINNED_LANGUAGES));
      return setsHaveSameMembers(next, state.pinnedLanguages)
        ? state
        : { ...state, pinnedLanguages: next };
    }
    case "reset_pins":
      return state.pinnedLanguages.size === 0 ? state : { ...state, pinnedLanguages: new Set<string>() };
    case "set_observed_date":
      return { ...state, observedDate: action.observedDate };
    case "set_launch_date":
      return { ...state, launchDate: action.launchDate };
    case "sync_theme":
      return syncTheme(state, action.preference, action.theme);
    // Provider-intercepted command — reaching the reducer would mean the
    // provider didn't wrap dispatch. Treat as a no-op rather than corrupt state.
    case "set_theme_preference":
      return state;
    case "set_chart_mode":
      return state.chartMode === action.mode ? state : { ...state, chartMode: action.mode };
  }
}

export const DEFAULT_THRESHOLD = 2;

// Mirrors the worker's MAX_COMPARE_LANGUAGES cap in worker/src/constants.ts so
// UI-gated pinning never produces a compare request the server will reject.
export const MAX_PINNED_LANGUAGES = 20;

export const DEFAULT_CHART_MODE: ChartMode = "relative";

export interface InitialThemeState {
  preference: ThemePreference;
  theme: ThemeMode;
}

export function createInitialState(initialTheme: InitialThemeState): DashboardState {
  return {
    threshold: DEFAULT_THRESHOLD,
    range: { from: "", to: "", preset: DEFAULT_RANGE_PRESET },
    pinnedLanguages: new Set<string>(),
    observedDate: null,
    launchDate: null,
    themePreference: initialTheme.preference,
    theme: initialTheme.theme,
    chartMode: DEFAULT_CHART_MODE,
  };
}
