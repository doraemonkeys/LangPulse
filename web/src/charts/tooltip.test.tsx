import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ComparisonTooltip } from "./tooltip";
import { RAW_FIELD_SUFFIX, RELATIVE_FIELD_SUFFIX } from "./series";

const labelsById = new Map([
  ["go", "Go"],
  ["rust", "Rust"],
]);

function payloadFor(values: Array<{ id: string; count: number | null; relative: number | null; color?: string }>) {
  const row: Record<string, number | null> = {};
  for (const v of values) {
    row[`${v.id}${RAW_FIELD_SUFFIX}`] = v.count;
    row[`${v.id}${RELATIVE_FIELD_SUFFIX}`] = v.relative;
  }
  return values.map((v) => ({
    dataKey: v.id,
    value: v.count ?? undefined,
    color: v.color ?? "#000",
    payload: row,
  }));
}

describe("ComparisonTooltip", () => {
  it("returns null when inactive or empty", () => {
    const { container: inactive } = render(
      <ComparisonTooltip active={false} payload={[]} label="2026-04-10" labelsById={labelsById} mode="absolute" />,
    );
    expect(inactive.firstChild).toBeNull();

    const { container: empty } = render(
      <ComparisonTooltip active={true} payload={[]} label="2026-04-10" labelsById={labelsById} mode="absolute" />,
    );
    expect(empty.firstChild).toBeNull();
  });

  it("sorts by count in absolute mode and shows count first, percent second", () => {
    const { getByRole, getAllByText } = render(
      <ComparisonTooltip
        active={true}
        payload={payloadFor([
          { id: "go", count: 100, relative: 5 },
          { id: "rust", count: 200, relative: -2 },
        ])}
        label="2026-04-10"
        labelsById={labelsById}
        mode="absolute"
      />,
    );
    expect(getByRole("tooltip")).toBeInTheDocument();
    expect(getAllByText(/Rust|Go/).map((node) => node.textContent)).toEqual(["Rust", "Go"]);
    expect(getByRole("tooltip").textContent).toContain("200");
    expect(getByRole("tooltip").textContent).toMatch(/[+]5\.0%/);
  });

  it("sorts by relative change in relative mode and shows percent first, count second", () => {
    const { getByRole, getAllByText } = render(
      <ComparisonTooltip
        active={true}
        payload={payloadFor([
          { id: "go", count: 100, relative: 5 },
          { id: "rust", count: 200, relative: -2 },
        ])}
        label="2026-04-10"
        labelsById={labelsById}
        mode="relative"
      />,
    );
    expect(getAllByText(/Rust|Go/).map((node) => node.textContent)).toEqual(["Go", "Rust"]);
    expect(getByRole("tooltip").textContent).toMatch(/[+]5\.0%/);
    expect(getByRole("tooltip").textContent).toContain("200");
  });

  it("shows a placeholder instead of zeroing missing values", () => {
    const { getByRole } = render(
      <ComparisonTooltip
        active={true}
        payload={payloadFor([{ id: "go", count: null, relative: null }])}
        label="2026-04-10"
        labelsById={labelsById}
        mode="relative"
      />,
    );
    expect(getByRole("tooltip").textContent).toContain("—");
  });
});
