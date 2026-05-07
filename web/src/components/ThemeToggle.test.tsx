import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardProvider } from "../state/DashboardProvider";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("cycles through light → dark → system → light", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    window.localStorage.setItem("langpulse:theme", "light");

    render(
      <DashboardProvider>
        <ThemeToggle />
      </DashboardProvider>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("data-theme-preference", "light");
    await user.click(button);
    expect(button).toHaveAttribute("data-theme-preference", "dark");
    await user.click(button);
    expect(button).toHaveAttribute("data-theme-preference", "system");
    await user.click(button);
    expect(button).toHaveAttribute("data-theme-preference", "light");
  });
});
