import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createQualityApi } from "./client";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(response: Partial<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("createQualityApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("calls metadata, latest, snapshot, and compare with correct URLs", async () => {
    const spy = mockFetch({ json: async () => ({ any: true }) });
    const api = createQualityApi("https://example.com/");

    await api.getMetadata();
    await api.getLatest();
    await api.getSnapshot({ date: "2026-04-10", threshold: 2 });
    await api.getCompare({
      languages: ["go", "rust"],
      threshold: 10,
      from: "2026-04-01",
      to: "2026-04-10",
    });

    expect(spy).toHaveBeenNthCalledWith(1, "https://example.com/api/metadata", { signal: undefined });
    expect(spy).toHaveBeenNthCalledWith(2, "https://example.com/api/quality/latest", { signal: undefined });
    expect(spy.mock.calls[2]![0]).toBe(
      "https://example.com/api/quality/snapshot?date=2026-04-10&threshold=2",
    );
    expect(spy.mock.calls[3]![0]).toBe(
      "https://example.com/api/quality/compare?languages=go%2Crust&threshold=10&from=2026-04-01&to=2026-04-10",
    );
  });

  it("throws ApiError with decoded payload on non-ok response", async () => {
    mockFetch({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "invalid_threshold", message: "bad threshold" } }),
    });
    const api = createQualityApi();

    await expect(api.getMetadata()).rejects.toMatchObject({
      status: 400,
      code: "invalid_threshold",
      message: "bad threshold",
    });
  });

  it("falls back to generic error when body is unreadable", async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const api = createQualityApi();

    const promise = api.getLatest();
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it("propagates AbortSignal to fetch", async () => {
    const spy = mockFetch({ json: async () => ({}) });
    const api = createQualityApi();
    const controller = new AbortController();

    await api.getSnapshot({ date: "2026-04-10", threshold: 2, signal: controller.signal });

    expect(spy).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
  });
});
