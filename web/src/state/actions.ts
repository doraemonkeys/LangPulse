import type { RangePreset } from "../utils/dates";

export type ThemeMode = "light" | "dark";

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
}

export type DashboardAction =
  | { type: "set_threshold"; threshold: number }
  | { type: "set_range"; range: DashboardRange }
  | { type: "toggle_pin"; languageId: string }
  | { type: "reset_pins" }
  | { type: "set_observed_date"; observedDate: string | null }
  | { type: "set_launch_date"; launchDate: string }
  | { type: "set_theme"; theme: ThemeMode };

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

  return { ...state, theme: action.theme };
}

export const DEFAULT_THRESHOLD = 2;

export function createInitialState(theme: ThemeMode): DashboardState {
  return {
    threshold: DEFAULT_THRESHOLD,
    range: { from: "", to: "", preset: "90d" },
    pinnedLanguages: new Set<string>(),
    observedDate: null,
    launchDate: null,
    theme,
  };
}
