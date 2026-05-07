import type { ThemePreference } from "../state/actions";
import { useDashboard } from "../state/DashboardProvider";

// Cycle order chosen so the most common manual override (light↔dark) is one
// click apart, with "system" sitting after dark as the "let the OS decide"
// escape hatch. Going past system loops back to light.
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICON: Record<ThemePreference, string> = {
  light: "☀", // ☀ — current is light
  dark: "☾", // ☾ — current is dark
  system: "◑", // ◑ — current follows the OS
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  light: "light",
  dark: "dark",
  system: "system",
};

export function ThemeToggle() {
  const { state, dispatch } = useDashboard();
  const preference = state.themePreference;
  const next = NEXT_PREFERENCE[preference];
  const label = `Theme: ${PREFERENCE_LABEL[preference]}. Click to switch to ${PREFERENCE_LABEL[next]}.`;

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      data-theme-preference={preference}
      onClick={() => dispatch({ type: "set_theme_preference", preference: next })}
    >
      <span aria-hidden="true">{ICON[preference]}</span>
    </button>
  );
}
