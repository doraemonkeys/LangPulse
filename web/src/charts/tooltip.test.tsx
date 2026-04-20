import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ComparisonTooltip } from "./tooltip";

describe("ComparisonTooltip", () => {
  const labelsById = new Map([
    ["go", "Go"],
    ["rust", "Rust"],
  ]);

  it("returns null when inactive or empty", () => {
    const { container: inactive } = render(
      <ComparisonTooltip active={false} payload={[]} label="2026-04-10" labelsById={labelsById} />,
    );
    expect(inactive.firstChild).toBeNull();

    const { container: empty } = render(
      <ComparisonTooltip active={true} payload={[]} label="2026-04-10" labelsById={labelsById} />,
    );
    expect(empty.firstChild).toBeNull();
  });

  it("sorts entries by value descending and shows the date", () => {
    const { getByRole, getAllByText } = render(
      <ComparisonTooltip
        active={true}
        payload={[
          { dataKey: "go", value: 100, color: "#E69F00" },
          { dataKey: "rust", value: 200, color: "#56B4E9" },
        ]}
        label="2026-04-10"
        labelsById={labelsById}
      />,
    );
    expect(getByRole("tooltip")).toBeInTheDocument();
    expect(getAllByText(/Rust|Go/).map((node) => node.textContent)).toEqual(["Rust", "Go"]);
  });
});
