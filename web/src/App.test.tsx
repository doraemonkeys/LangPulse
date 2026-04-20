import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { QualityApiProvider } from "./hooks/useQualityApi";
import { DashboardProvider } from "./state/DashboardProvider";
import { createFakeApi, SAMPLE_METADATA } from "./test-utils/fakeApi";
import type { CompareResponse, SnapshotResponse } from "./api/types";

function buildSnapshot(threshold: number): SnapshotResponse {
  return {
    observed_date: "2026-04-10",
    threshold,
    previous_date: "2026-04-09",
    languages: [
      { id: "go", label: "Go", count: 1200 + threshold, previous_count: 1100 },
      { id: "rust", label: "Rust", count: 900 + threshold, previous_count: 850 },
      { id: "python", label: "Python", count: 2100 + threshold, previous_count: 2000 },
    ],
  };
}

function buildCompare(languages: string[], threshold: number, from: string, to: string): CompareResponse {
  return {
    threshold,
    from,
    to,
    languages: languages.map((id) => ({ id, label: id })),
    series: [
      {
        observed_date: "2026-04-05",
        counts: Object.fromEntries(languages.map((id) => [id, 100 + threshold])),
      },
      {
        observed_date: "2026-04-10",
        counts: Object.fromEntries(languages.map((id) => [id, 120 + threshold])),
      },
    ],
  };
}

function compareKey(ids: string[], threshold: number, from: string, to: string): string {
  return `${[...ids].sort().join(",")}|${threshold}|${from}|${to}`;
}

function renderApp() {
  const compareByKey: Record<string, CompareResponse> = {};
  // Sparkline calls land on a 60-day range ending on the observed date.
  for (const t of [0, 2, 10]) {
    compareByKey[compareKey(["go", "python", "rust"], t, "2026-02-10", "2026-04-10")] = buildCompare(
      ["go", "python", "rust"],
      t,
      "2026-02-10",
      "2026-04-10",
    );
    // Chart calls default to 90d range.
    compareByKey[compareKey(["go", "python", "rust"], t, "2026-04-01", "2026-04-10")] = buildCompare(
      ["go", "python", "rust"],
      t,
      "2026-04-01",
      "2026-04-10",
    );
    // Pinned single-language chart request.
    compareByKey[compareKey(["go"], t, "2026-04-01", "2026-04-10")] = buildCompare(
      ["go"],
      t,
      "2026-04-01",
      "2026-04-10",
    );
  }

  const { api } = createFakeApi({
    metadata: SAMPLE_METADATA,
    latest: { observed_date: "2026-04-10" },
    snapshotByKey: {
      "2026-04-10|2": buildSnapshot(2),
      "2026-04-10|10": buildSnapshot(10),
    },
    compareByKey,
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QualityApiProvider value={api}>
        <DashboardProvider>
          <App />
        </DashboardProvider>
      </QualityApiProvider>
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("shows the default top-10 leaderboard and lets the user switch thresholds", async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() => expect(screen.getByText("Python")).toBeInTheDocument());
    expect(screen.getByText("2026-04-10")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /\u2265 10/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /\u2265 10/ })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("pins a language into the comparison chart when a row is clicked", async () => {
    const user = userEvent.setup();
    renderApp();

    const goRow = await screen.findByRole("button", { name: /Go, 1,202 repositories/ });
    await user.click(goRow);
    expect(goRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Reset to top 10/ })).toBeInTheDocument();
  });

  it("pins a language selected from the language picker via typeahead + Enter", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Rust");

    const combobox = screen.getByRole("combobox");
    await user.click(combobox);
    await user.type(combobox, "rust");
    await user.keyboard("{Enter}");

    const rustRow = screen.getByRole("button", { name: /Rust, 902 repositories/ });
    expect(rustRow).toHaveAttribute("aria-pressed", "true");
  });
});
