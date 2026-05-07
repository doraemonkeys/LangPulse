import { useCallback, useEffect, useState } from "react";
import type { ThemeMode, ThemePreference } from "../state/actions";

const STORAGE_KEY = "langpulse:theme";
const THEME_ATTRIBUTE = "data-theme";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

function readSystemTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.(SYSTEM_QUERY).matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference): ThemeMode {
  return preference === "system" ? readSystemTheme() : preference;
}

function readInitialPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  // No stored preference: defer to the OS so first-time visitors match the
  // surrounding system chrome instead of forcing a hard-coded default.
  return "system";
}

export function useTheme(): {
  preference: ThemePreference;
  theme: ThemeMode;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readInitialPreference);
  const [theme, setThemeState] = useState<ThemeMode>(() => resolveTheme(readInitialPreference()));

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  // Live-follow the OS only while the preference is "system". When the user
  // pins to light/dark explicitly, we deliberately stop listening so a
  // background OS change doesn't override their choice.
  useEffect(() => {
    if (typeof window === "undefined" || preference !== "system") return;
    const mql = window.matchMedia?.(SYSTEM_QUERY);
    if (!mql) return;
    const handleChange = (event: MediaQueryListEvent) => {
      setThemeState(event.matches ? "dark" : "light");
    };
    mql.addEventListener?.("change", handleChange);
    return () => mql.removeEventListener?.("change", handleChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    // Resolve synchronously alongside the preference change so consumers see
    // a single coherent transition rather than a two-step re-render.
    setThemeState(resolveTheme(next));
  }, []);

  return { preference, theme, setPreference };
}
