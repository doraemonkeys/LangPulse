import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { useMetadata } from "./useMetadata";
import { useLatest } from "./useLatest";
import { useSnapshot } from "./useSnapshot";
import { useCompare } from "./useCompare";
import { QualityApiProvider } from "./useQualityApi";
import { createFakeApi, SAMPLE_METADATA } from "../test-utils/fakeApi";
import type { SnapshotResponse } from "../api/types";

const snapshot: SnapshotResponse = {
  observed_date: "2026-04-10",
  threshold: 2,
  previous_date: "2026-04-09",
  languages: [{ id: "go", label: "Go", count: 10, previous_count: 8 }],
};

function buildWrapper(api: ReturnType<typeof createFakeApi>["api"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <QualityApiProvider value={api}>{children}</QualityApiProvider>
      </QueryClientProvider>
    );
  };
}

describe("query hooks", () => {
  it("fetches metadata and latest observed date", async () => {
    const { api } = createFakeApi({
      metadata: SAMPLE_METADATA,
      latest: { observed_date: "2026-04-10" },
    });
    const wrapper = buildWrapper(api);

    const metadataHook = renderHook(() => useMetadata(), { wrapper });
    const latestHook = renderHook(() => useLatest(), { wrapper });

    await waitFor(() => expect(metadataHook.result.current.data).toBeDefined());
    await waitFor(() => expect(latestHook.result.current.data?.observed_date).toBe("2026-04-10"));
  });

  it("is disabled until a snapshot date is provided", async () => {
    const { api } = createFakeApi({
      snapshotByKey: { "2026-04-10|2": snapshot },
    });
    const wrapper = buildWrapper(api);

    const disabled = renderHook(() => useSnapshot({ date: null, threshold: 2 }), { wrapper });
    expect(disabled.result.current.fetchStatus).toBe("idle");

    const enabled = renderHook(() => useSnapshot({ date: "2026-04-10", threshold: 2 }), { wrapper });
    await waitFor(() => expect(enabled.result.current.data).toBeDefined());
  });

  it("is disabled until compare has at least one language and a full range", async () => {
    const { api, compareCalls } = createFakeApi({});
    const wrapper = buildWrapper(api);

    const disabled = renderHook(
      () => useCompare({ languages: [], threshold: 2, from: "", to: "" }),
      { wrapper },
    );
    expect(disabled.result.current.fetchStatus).toBe("idle");

    const enabled = renderHook(
      () =>
        useCompare({ languages: ["go"], threshold: 2, from: "2026-04-01", to: "2026-04-10" }),
      { wrapper },
    );
    await waitFor(() => expect(enabled.result.current.data).toBeDefined());
    expect(compareCalls).toHaveLength(1);
  });
});
