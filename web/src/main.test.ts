import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type MetadataResponse, type QualityApi, type QualityResponse } from "./api";
import { computeDefaultRange, createDashboard, partitionLanguages } from "./main";

function makeMetadata(): MetadataResponse {
  return {
    metric: "quality_30d_snapshot",
    timezone: "UTC",
    window_days: 30,
    launch_date: "2026-04-01",
    languages: [
      {
        id: "go",
        label: "Go",
        active_from: "2026-04-01",
        active_to: null,
      },
      {
        id: "ruby",
        label: "Ruby",
        active_from: "2026-04-01",
        active_to: "2026-04-03",
      },
    ],
    thresholds: [
      {
        value: 0,
        active_from: "2026-04-01",
        active_to: null,
      },
      {
        value: 10,
        active_from: "2026-04-01",
        active_to: null,
      },
    ],
  };
}

function makeQuality(series: QualityResponse["series"]): QualityResponse {
  return {
    language: {
      id: "go",
      label: "Go",
    },
    from: "2026-04-01",
    to: "2026-04-07",
    series,
  };
}

function createApiStub(overrides: Partial<QualityApi> = {}): QualityApi {
  return {
    getMetadata: vi.fn().mockResolvedValue(makeMetadata()),
    getLatest: vi.fn().mockResolvedValue({ observed_date: "2026-04-07" }),
    getQuality: vi.fn().mockResolvedValue(
      makeQuality([
        {
          observed_date: "2026-04-05",
          observed_at: "2026-04-05T02:00:00.000Z",
          published_at: "2026-04-05T02:05:00.000Z",
          thresholds: [
            { threshold_value: 0, count: 24 },
            { threshold_value: 10, count: 12 },
          ],
        },
      ]),
    ),
    ...overrides,
  };
}

describe("dashboard helpers", () => {
  it("uses the last 90 days when available without going before launch", () => {
    expect(computeDefaultRange("2026-04-01", "2026-07-15")).toEqual({
      from: "2026-04-17",
      to: "2026-07-15",
    });
    expect(computeDefaultRange("2026-04-01", "2026-04-07")).toEqual({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(computeDefaultRange("2026-04-01", null)).toEqual({
      from: "2026-04-01",
      to: "2026-04-01",
    });
  });

  it("keeps retired languages discoverable in a separate group", () => {
    const groups = partitionLanguages(makeMetadata().languages);

    expect(groups.active.map((language) => language.id)).toEqual(["go"]);
    expect(groups.retired.map((language) => language.id)).toEqual(["ruby"]);
  });
});

describe("createDashboard", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders retired-language discoverability and the latest observed_at in the summary", async () => {
    const api = createApiStub();
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    const options = Array.from(root.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toContain("Go (go)");
    expect(options).toContain("Ruby (ruby, retired 2026-04-03)");
    expect(root.textContent).toContain("observed at 2026-04-05T02:00:00.000Z");
    expect((root.querySelector("input[name='from']") as HTMLInputElement).value).toBe("2026-04-01");
    expect((root.querySelector("input[name='to']") as HTMLInputElement).value).toBe("2026-04-07");
  });

  it("renders an empty state when the selected range has no published snapshots", async () => {
    const api = createApiStub({
      getQuality: vi.fn().mockResolvedValue(makeQuality([])),
    });
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    expect(root.textContent).toContain("No published snapshots match this range yet.");
    expect(root.querySelector(".app-shell")?.classList.contains("app-shell--empty")).toBe(true);
  });

  it("renders an error state when loading the series fails", async () => {
    const api = createApiStub({
      getQuality: vi.fn().mockRejectedValue(new Error("network unreachable")),
    });
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    expect(root.textContent).toContain("network unreachable");
    expect(root.querySelector(".app-shell")?.classList.contains("app-shell--error")).toBe(true);
  });

  it("renders an error state when the filters are invalid", async () => {
    const api = createApiStub();
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    const fromInput = root.querySelector<HTMLInputElement>("input[name='from']");
    const toInput = root.querySelector<HTMLInputElement>("input[name='to']");
    const form = root.querySelector<HTMLFormElement>("form.controls");
    if (fromInput === null || toInput === null || form === null) {
      throw new Error("Missing form fields.");
    }

    fromInput.value = "2026-04-07";
    toInput.value = "2026-04-01";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(root.textContent).toContain("From must be on or before To.");
  });

  it("renders an error when the filters are incomplete", async () => {
    const api = createApiStub();
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    const fromInput = root.querySelector<HTMLInputElement>("input[name='from']");
    const toInput = root.querySelector<HTMLInputElement>("input[name='to']");
    const form = root.querySelector<HTMLFormElement>("form.controls");
    if (fromInput === null || toInput === null || form === null) {
      throw new Error("Missing form fields.");
    }

    fromInput.value = "";
    toInput.value = "";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(root.textContent).toContain("Choose a complete UTC date range.");
  });

  it("renders a metadata error from the public API", async () => {
    const api = createApiStub({
      getMetadata: vi.fn().mockRejectedValue(
        new ApiError(503, "metadata service unavailable", "service_unavailable"),
      ),
    });
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    expect(root.textContent).toContain("metadata service unavailable");
    expect(root.querySelector(".app-shell")?.classList.contains("app-shell--error")).toBe(true);
  });

  it("renders the fallback error message for unexpected failures", async () => {
    const api = createApiStub({
      getQuality: vi.fn().mockRejectedValue("bad gateway"),
    });
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    expect(root.textContent).toContain("An unexpected error occurred.");
  });

  it("renders a configuration empty state when no languages are exposed", async () => {
    const api = createApiStub({
      getMetadata: vi.fn().mockResolvedValue({
        ...makeMetadata(),
        languages: [],
      }),
    });
    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    await dashboard.init();

    expect(root.textContent).toContain("No public languages are configured.");
    expect(root.querySelectorAll("option")).toHaveLength(0);
  });

  it("shows a metadata loading message before the initial requests resolve", async () => {
    let resolveMetadata: ((value: MetadataResponse) => void) | undefined;
    let resolveLatest: ((value: { observed_date: string | null }) => void) | undefined;
    const api = createApiStub({
      getMetadata: vi.fn().mockImplementation(
        () =>
          new Promise<MetadataResponse>((resolve) => {
            resolveMetadata = resolve;
          }),
      ),
      getLatest: vi.fn().mockImplementation(
        () =>
          new Promise<{ observed_date: string | null }>((resolve) => {
            resolveLatest = resolve;
          }),
      ),
    });

    const root = document.querySelector<HTMLElement>("#app");
    if (root === null) {
      throw new Error("Missing root node.");
    }

    const dashboard = createDashboard(root, api);
    const initPromise = dashboard.init();

    expect(root.textContent).toContain("Loading dataset metadata");
    resolveMetadata?.(makeMetadata());
    resolveLatest?.({ observed_date: "2026-04-07" });
    await initPromise;
  });
});
