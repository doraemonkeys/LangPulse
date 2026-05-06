import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const noopProps = {
  isLoading: false,
  error: null,
  theme: "light" as const,
  pinnedLanguages: new Set<string>(),
  onTogglePin: () => {},
  chartMode: "absolute" as const,
  onChangeChartMode: () => {},
};

describe("ComparisonChart", () => {
  it("renders the chart region with the legend and the mode toggle", () => {
    render(<ComparisonChart {...noopProps} data={data} />);
    expect(screen.getByRole("region", { name: /Language comparison chart/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Go/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Absolute/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Relative/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("invokes the mode change handler when the user clicks Relative", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<ComparisonChart {...noopProps} data={data} onChangeChartMode={handler} />);
    await user.click(screen.getByRole("button", { name: /Relative/ }));
    expect(handler).toHaveBeenCalledWith("relative");
  });

  it("reflects the active mode in the toggle's aria-pressed state", () => {
    render(<ComparisonChart {...noopProps} data={data} chartMode="relative" />);
    expect(screen.getByRole("button", { name: /Relative/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Absolute/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a loading skeleton when data is undefined", () => {
    render(<ComparisonChart {...noopProps} data={undefined} isLoading={true} />);
    expect(screen.getByText(/Loading chart/)).toBeInTheDocument();
  });

  it("shows an empty banner when no series rows exist", () => {
    render(<ComparisonChart {...noopProps} data={{ ...data, series: [], languages: [] }} />);
    expect(screen.getByText(/No data in this range/)).toBeInTheDocument();
  });

  it("shows an error banner when the query errored", () => {
    render(<ComparisonChart {...noopProps} data={undefined} error={new Error("boom")} />);
    expect(screen.getByText(/Could not load chart/)).toBeInTheDocument();
  });

  it("flags legend chips as unavailable in relative mode when a language has no baseline", () => {
    const zeroBaseline: CompareResponse = {
      threshold: 2,
      from: "2026-04-01",
      to: "2026-04-02",
      languages: [
        { id: "go", label: "Go" },
        { id: "nascent", label: "Nascent" },
      ],
      series: [
        { observed_date: "2026-04-01", counts: { go: 100, nascent: 0 } },
        { observed_date: "2026-04-02", counts: { go: 110, nascent: 0 } },
      ],
    };
    render(<ComparisonChart {...noopProps} data={zeroBaseline} chartMode="relative" />);
    expect(screen.getByRole("button", { name: /Nascent.*Baseline is zero/ })).toHaveClass(
      "legend-chip--unavailable",
    );
  });

  it("does not flag legend chips as unavailable in absolute mode", () => {
    const zeroBaseline: CompareResponse = {
      threshold: 2,
      from: "2026-04-01",
      to: "2026-04-02",
      languages: [
        { id: "go", label: "Go" },
        { id: "nascent", label: "Nascent" },
      ],
      series: [
        { observed_date: "2026-04-01", counts: { go: 100, nascent: 0 } },
        { observed_date: "2026-04-02", counts: { go: 110, nascent: 0 } },
      ],
    };
    render(<ComparisonChart {...noopProps} data={zeroBaseline} chartMode="absolute" />);
    expect(screen.getByRole("button", { name: /^Nascent/ })).not.toHaveClass(
      "legend-chip--unavailable",
    );
  });
});
