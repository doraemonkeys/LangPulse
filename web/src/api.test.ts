import { afterEach, describe, expect, it, vi } from "vitest";

import { createQualityApi } from "./api";

describe("createQualityApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes the base URL and fetches the public endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ launch_date: "2026-04-01", languages: [], thresholds: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ observed_date: "2026-04-07" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            language: { id: "go", label: "Go" },
            from: "2026-04-01",
            to: "2026-04-07",
            series: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);
    const api = createQualityApi("https://langpulse.example/");

    await api.getMetadata();
    await api.getLatest();
    await api.getQuality({ language: "go", from: "2026-04-01", to: "2026-04-07" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://langpulse.example/api/metadata");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://langpulse.example/api/quality/latest");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://langpulse.example/api/quality?language=go&from=2026-04-01&to=2026-04-07",
      { signal: undefined },
    );
  });

  it("forwards AbortSignal to the underlying fetch so stale getQuality calls can be cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          language: { id: "go", label: "Go" },
          from: "2026-04-01",
          to: "2026-04-07",
          series: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);
    const api = createQualityApi();
    const controller = new AbortController();

    await api.getQuality({
      language: "go",
      from: "2026-04-01",
      to: "2026-04-07",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality?language=go&from=2026-04-01&to=2026-04-07",
      { signal: controller.signal },
    );
  });

  it("surfaces API error payloads as ApiError instances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "unknown_language",
              message: "language must be a known language.id.",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const api = createQualityApi();

    await expect(api.getMetadata()).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        code: "unknown_language",
        message: "language must be a known language.id.",
      }),
    );
  });

  it("falls back to the status when the response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("upstream gateway failure", { status: 502 })),
    );

    const api = createQualityApi();

    await expect(api.getLatest()).rejects.toEqual(
      expect.objectContaining({
        status: 502,
        message: "Request failed with status 502.",
      }),
    );
  });
});
