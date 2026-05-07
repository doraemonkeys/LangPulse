import { createContext, useContext, useMemo, useReducer } from "react";
import type { Dispatch, ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import {
  createInitialState,
  dashboardReducer,
  type DashboardAction,
  type DashboardState,
  type InitialThemeState,
} from "./actions";

interface DashboardContextValue {
  state: DashboardState;
  dispatch: Dispatch<DashboardAction>;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

interface DashboardProviderProps {
  children: ReactNode;
}

export function DashboardProvider({ children }: DashboardProviderProps) {
  const { preference, theme, setPreference } = useTheme();
  const [state, dispatch] = useReducer(
    dashboardReducer,
    { preference, theme } satisfies InitialThemeState,
    createInitialState,
  );

  // Mirror the hook's preference + resolved theme into the reducer so consumers
  // can read a single source of truth (`state.theme`, `state.themePreference`).
  // The hook owns persistence (localStorage) and the OS listener; this sync
  // keeps the reducer's view consistent across re-renders.
  if (state.themePreference !== preference || state.theme !== theme) {
    dispatch({ type: "sync_theme", preference, theme });
  }

  const value = useMemo<DashboardContextValue>(() => {
    const wrappedDispatch: Dispatch<DashboardAction> = (action) => {
      if (action.type === "set_theme_preference") {
        // Route preference changes through the hook so localStorage and the
        // matchMedia subscription stay authoritative; the sync above will
        // propagate the result back into reducer state.
        setPreference(action.preference);
        return;
      }
      dispatch(action);
    };

    return { state, dispatch: wrappedDispatch };
  }, [state, setPreference]);

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (ctx === null) {
    throw new Error("useDashboard must be used within a DashboardProvider.");
  }
  return ctx;
}
