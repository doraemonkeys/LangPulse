import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StateBanner } from "./StateBanner";

describe("StateBanner", () => {
  it("renders title, description, and optional action", () => {
    render(
      <StateBanner
        tone="error"
        title="Broken"
        description="Details"
        action={<button type="button">Retry</button>}
      />,
    );

    expect(screen.getByText("Broken")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders without description or action", () => {
    render(<StateBanner tone="info" title="Empty" />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
