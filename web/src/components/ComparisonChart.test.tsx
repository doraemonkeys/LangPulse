import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparisonChart } from "./ComparisonChart";
import type { CompareResponse } from "../api/types";

const data: CompareResponse = {
  threshold: 2,
  from: "2026-04-01",
  to: "2026-04-03",
  languages: [
    { id: "go", label: "Go" },
    { id: "rust", label: "Rust" },
  ],
  series: [
    { observed_date: "2026-04-01", counts: { go: 100, rust: 80 } },
    { observed_date: "2026-04-02", counts: { go: 110 } },
    { observed_date: "2026-04-03", counts: { go: 120, rust: 90 } },
  ],
};

describe("ComparisonChart", () => {
  it("renders the chart region with the legend", () => {
    render(
      <ComparisonChart
        data={data}
        isLoading={false}
        error={null}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
      />,
    );
    expect(screen.getByRole("region", { name: /Language comparison chart/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Go/ })).toBeInTheDocument();
  });

  it("shows a loading skeleton when data is undefined", () => {
    render(
      <ComparisonChart
        data={undefined}
        isLoading={true}
        error={null}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
      />,
    );
    expect(screen.getByText(/Loading chart/)).toBeInTheDocument();
  });

  it("shows an empty banner when no series rows exist", () => {
    render(
      <ComparisonChart
        data={{ ...data, series: [], languages: [] }}
        isLoading={false}
        error={null}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
      />,
    );
    expect(screen.getByText(/No data in this range/)).toBeInTheDocument();
  });

  it("shows an error banner when the query errored", () => {
    render(
      <ComparisonChart
        data={undefined}
        isLoading={false}
        error={new Error("boom")}
        theme="light"
        pinnedLanguages={new Set()}
        onTogglePin={() => {}}
      />,
    );
    expect(screen.getByText(/Could not load chart/)).toBeInTheDocument();
  });
});
