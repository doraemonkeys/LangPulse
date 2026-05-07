import { describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardProvider, useDashboard } from "./DashboardProvider";

function wrapper({ children }: { children: React.ReactNode }) {
  return <DashboardProvider>{children}</DashboardProvider>;
}

describe("DashboardProvider", () => {
  it("exposes the reducer state and dispatch to consumers", () => {
    const { result } = renderHook(() => useDashboard(), { wrapper });
    expect(result.current.state.threshold).toBe(2);

    act(() => {
      result.current.dispatch({ type: "set_threshold", threshold: 100 });
    });
    expect(result.current.state.threshold).toBe(100);
  });

  it("routes preference changes through the hook and mirrors them into reducer state", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("langpulse:theme", "light");
    const user = userEvent.setup();
    function ThemeProbe() {
      const { state, dispatch } = useDashboard();
      const next = state.themePreference === "light" ? "dark" : "light";
      return (
        <button
          type="button"
          onClick={() => dispatch({ type: "set_theme_preference", preference: next })}
        >
          pref:{state.themePreference} theme:{state.theme}
        </button>
      );
    }

    const { getByRole } = render(
      <DashboardProvider>
        <ThemeProbe />
      </DashboardProvider>,
    );
    const button = getByRole("button");
    expect(button.textContent).toContain("pref:light");
    expect(button.textContent).toContain("theme:light");
    await user.click(button);
    expect(button.textContent).toContain("pref:dark");
    expect(button.textContent).toContain("theme:dark");
    expect(window.localStorage.getItem("langpulse:theme")).toBe("dark");
  });

  it("throws when used outside a provider", () => {
    expect(() => renderHook(() => useDashboard())).toThrow();
  });
});
