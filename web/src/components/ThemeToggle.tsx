import { useDashboard } from "../state/DashboardProvider";

export function ThemeToggle() {
  const { state, dispatch } = useDashboard();
  const nextTheme = state.theme === "light" ? "dark" : "light";
  const label = state.theme === "light" ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      aria-pressed={state.theme === "dark"}
      onClick={() => dispatch({ type: "set_theme", theme: nextTheme })}
    >
      <span aria-hidden="true">{state.theme === "light" ? "\u263E" : "\u2600"}</span>
    </button>
  );
}
