import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders a sparkline region with the given label", () => {
    const { getByRole } = render(
      <Sparkline
        points={[
          { date: "2026-04-01", value: 10 },
          { date: "2026-04-02", value: null },
          { date: "2026-04-03", value: 12 },
        ]}
        color="#123456"
        ariaLabel="Go 60-day trend"
      />,
    );
    expect(getByRole("img")).toHaveAttribute("aria-label", "Go 60-day trend");
  });
});
