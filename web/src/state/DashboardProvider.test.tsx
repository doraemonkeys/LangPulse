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

  it("persists the theme via the theme toggle path", async () => {
    const user = userEvent.setup();
    function ThemeProbe() {
      const { state, dispatch } = useDashboard();
      return (
        <button
          type="button"
          onClick={() => dispatch({ type: "set_theme", theme: state.theme === "light" ? "dark" : "light" })}
        >
          theme:{state.theme}
        </button>
      );
    }

    const { getByRole } = render(
      <DashboardProvider>
        <ThemeProbe />
      </DashboardProvider>,
    );
    const button = getByRole("button");
    expect(button.textContent).toContain("light");
    await user.click(button);
    expect(button.textContent).toContain("dark");
  });

  it("throws when used outside a provider", () => {
    expect(() => renderHook(() => useDashboard())).toThrow();
  });
});
