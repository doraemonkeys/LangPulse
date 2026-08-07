import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { ApiError } from "./api/client";
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

interface RenderAppOptions {
  extraSnapshotByKey?: Record<string, SnapshotResponse>;
  snapshotErrorByKey?: Record<string, Error>;
}

function renderApp(opts: RenderAppOptions = {}) {
  const compareByKey: Record<string, CompareResponse> = {};
  // Sparkline calls land on a 60-day range ending on the observed date.
  for (const t of [0, 2, 10]) {
    compareByKey[compareKey(["go", "python", "rust"], t, "2026-02-10", "2026-04-10")] = buildCompare(
      ["go", "python", "rust"],
      t,
      "2026-02-10",
      "2026-04-10",
    );
    // Chart calls default to the 60d range, clamped at the product launch date.
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

  const recorder = createFakeApi({
    metadata: SAMPLE_METADATA,
    latest: { observed_date: "2026-04-10" },
    snapshotByKey: {
      "2026-04-10|2": buildSnapshot(2),
      "2026-04-10|10": buildSnapshot(10),
      ...(opts.extraSnapshotByKey ?? {}),
    },
    snapshotErrorByKey: opts.snapshotErrorByKey,
    compareByKey,
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <QualityApiProvider value={recorder.api}>
        <DashboardProvider>
          <App />
        </DashboardProvider>
      </QualityApiProvider>
    </QueryClientProvider>,
  );
  return { ...utils, recorder };
}

describe("App", () => {
  it("defaults the trend chart to 60d without offering a Max range", async () => {
    renderApp();

    const defaultRange = await screen.findByRole("button", { name: "60d" });
    expect(defaultRange).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /max/i })).not.toBeInTheDocument();
  });

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

  it("X-ing the only pinned language in the chart legend reverts to default top-10", async () => {
    const user = userEvent.setup();
    renderApp();

    const goRow = await screen.findByRole("button", { name: /Go, 1,202 repositories/ });
    await user.click(goRow);
    await waitFor(() => expect(goRow).toHaveAttribute("aria-pressed", "true"));

    const removeGo = await screen.findByRole("button", { name: /Remove go from chart/i });
    await user.click(removeGo);

    await waitFor(() => expect(goRow).toHaveAttribute("aria-pressed", "false"));
    expect(screen.queryByRole("button", { name: /Reset to top 10/ })).toBeNull();
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

  it("snaps the chart `to` to the snapshot date when the user steps backward", async () => {
    const user = userEvent.setup();
    const { recorder } = renderApp({
      extraSnapshotByKey: { "2026-04-09|2": { ...buildSnapshot(2), observed_date: "2026-04-09" } },
    });
    await screen.findByText("Python");

    await user.click(screen.getByRole("button", { name: "Previous day" }));

    await waitFor(() => {
      expect(recorder.snapshotCalls.some((call) => call.date === "2026-04-09")).toBe(true);
    });
    await waitFor(() => {
      expect(
        recorder.compareCalls.some((call) => call.to === "2026-04-09" && call.from === "2026-04-01"),
      ).toBe(true);
    });
  });

  it("does not change the snapshot when the user only edits the chart To input", async () => {
    const { recorder } = renderApp();
    await screen.findByText("Python");
    const initialSnapshotCount = recorder.snapshotCalls.length;

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-04-08" } });

    await waitFor(() => {
      expect(
        recorder.compareCalls.some((call) => call.to === "2026-04-08"),
      ).toBe(true);
    });
    // No new snapshot fetch was triggered — leaderboard date is unchanged.
    expect(recorder.snapshotCalls.length).toBe(initialSnapshotCount);
  });

  it("renders the Jump-to-latest banner when the snapshot date returns 404", async () => {
    const user = userEvent.setup();
    renderApp({
      extraSnapshotByKey: { "2026-04-09|2": { ...buildSnapshot(2), observed_date: "2026-04-09" } },
      snapshotErrorByKey: {
        "2026-04-09|2": new ApiError(404, "No published snapshot exists for this date.", "snapshot_not_found"),
      },
    });
    await screen.findByText("Python");

    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await screen.findByText("No snapshot for this date");

    await user.click(screen.getByRole("button", { name: /Jump to latest/ }));
    await waitFor(() => expect(screen.queryByText("No snapshot for this date")).not.toBeInTheDocument());
    expect(screen.getByText("Python")).toBeInTheDocument();
  });
});
