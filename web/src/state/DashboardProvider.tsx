import { createContext, useContext, useMemo, useReducer } from "react";
import type { Dispatch, ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import {
  createInitialState,
  dashboardReducer,
  type DashboardAction,
  type DashboardState,
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
  const { theme, setTheme } = useTheme();
  const [state, dispatch] = useReducer(dashboardReducer, theme, createInitialState);

  // Keep the reducer's theme field in sync with the persistent hook. This lets
  // components read `state.theme` (a single source of truth) while the hook
  // owns the localStorage + prefers-color-scheme wiring.
  if (state.theme !== theme) {
    dispatch({ type: "set_theme", theme });
  }

  const value = useMemo<DashboardContextValue>(() => {
    const wrappedDispatch: Dispatch<DashboardAction> = (action) => {
      if (action.type === "set_theme") {
        setTheme(action.theme);
        return;
      }
      dispatch(action);
    };

    return { state, dispatch: wrappedDispatch };
  }, [state, setTheme]);

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (ctx === null) {
    throw new Error("useDashboard must be used within a DashboardProvider.");
  }
  return ctx;
}
