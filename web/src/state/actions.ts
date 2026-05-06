import type { RangePreset } from "../utils/dates";

export type ThemeMode = "light" | "dark";

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
  theme: ThemeMode;
  chartMode: ChartMode;
}

export type DashboardAction =
  | { type: "set_threshold"; threshold: number }
  | { type: "set_range"; range: DashboardRange }
  | { type: "toggle_pin"; languageId: string }
  | { type: "reset_pins" }
  | { type: "set_observed_date"; observedDate: string | null }
  | { type: "set_launch_date"; launchDate: string }
  | { type: "set_theme"; theme: ThemeMode }
  | { type: "set_chart_mode"; mode: ChartMode };

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  if (action.type === "set_threshold") {
    return { ...state, threshold: action.threshold };
  }

  if (action.type === "set_range") {
    return { ...state, range: action.range };
  }

  if (action.type === "toggle_pin") {
    const next = new Set(state.pinnedLanguages);
    if (next.has(action.languageId)) {
      next.delete(action.languageId);
    } else {
      next.add(action.languageId);
    }
    return { ...state, pinnedLanguages: next };
  }

  if (action.type === "reset_pins") {
    if (state.pinnedLanguages.size === 0) return state;
    return { ...state, pinnedLanguages: new Set<string>() };
  }

  if (action.type === "set_observed_date") {
    return { ...state, observedDate: action.observedDate };
  }

  if (action.type === "set_launch_date") {
    return { ...state, launchDate: action.launchDate };
  }

  if (action.type === "set_theme") {
    return { ...state, theme: action.theme };
  }

  if (state.chartMode === action.mode) return state;
  return { ...state, chartMode: action.mode };
}

export const DEFAULT_THRESHOLD = 2;

// Mirrors the worker's MAX_COMPARE_LANGUAGES cap in worker/src/constants.ts so
// UI-gated pinning never produces a compare request the server will reject.
export const MAX_PINNED_LANGUAGES = 20;

export const DEFAULT_CHART_MODE: ChartMode = "absolute";

export function createInitialState(theme: ThemeMode): DashboardState {
  return {
    threshold: DEFAULT_THRESHOLD,
    range: { from: "", to: "", preset: "90d" },
    pinnedLanguages: new Set<string>(),
    observedDate: null,
    launchDate: null,
    theme,
    chartMode: DEFAULT_CHART_MODE,
  };
}
