import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardProvider } from "../state/DashboardProvider";
import { AppHeader } from "./AppHeader";

describe("AppHeader", () => {
  it("renders the observed date pill and window-day copy", () => {
    render(
      <DashboardProvider>
        <AppHeader observedDate="2026-04-10" windowDays={30} />
      </DashboardProvider>,
    );
    expect(screen.getByText("2026-04-10")).toBeInTheDocument();
    expect(screen.getByText(/30 days/)).toBeInTheDocument();
  });

  it("falls back to em-dash when observed_date is null", () => {
    render(
      <DashboardProvider>
        <AppHeader observedDate={null} windowDays={30} />
      </DashboardProvider>,
    );
    expect(screen.getByLabelText("Latest observed UTC date").textContent).toContain("\u2014");
  });

  it("exposes a GitHub repository link that opens safely in a new tab", () => {
    render(
      <DashboardProvider>
        <AppHeader observedDate="2026-04-10" windowDays={30} />
      </DashboardProvider>,
    );
    const link = screen.getByRole("link", { name: /github/i });
    expect(link).toHaveAttribute("href", "https://github.com/doraemonkeys/LangPulse");
    expect(link).toHaveAttribute("target", "_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });
});
