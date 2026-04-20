import { beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  dispatch,
  makePublicRequest,
  readJson,
  resetDatabase,
  seedPublishedRun,
} from "./helpers";

interface CompareBody {
  threshold: number;
  from: string;
  to: string;
  languages: Array<{ id: string; label: string }>;
  series: Array<{ observed_date: string; counts: Record<string, number> }>;
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe("GET /api/quality/compare", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns multi-language sparse series at the selected threshold", async () => {
    await seedPublishedRun({
      run_id: "run-2026-04-02",
      observed_date: "2026-04-02",
      observed_at: "2026-04-02T02:00:00.000Z",
      published_at: "2026-04-02T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 2, count: 10, collected_at: "2026-04-02T02:00:00.000Z" },
        { language_id: "go", threshold_value: 10, count: 5, collected_at: "2026-04-02T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 2, count: 7, collected_at: "2026-04-02T02:00:00.000Z" },
      ],
    });
    await seedPublishedRun({
      run_id: "run-2026-04-04",
      observed_date: "2026-04-04",
      observed_at: "2026-04-04T02:00:00.000Z",
      published_at: "2026-04-04T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 2, count: 12, collected_at: "2026-04-04T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 2, count: 9, collected_at: "2026-04-04T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go,rust&threshold=2&from=2026-04-01&to=2026-04-05",
      ),
    );
    const body = await readJson<CompareBody>(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(body.threshold).toBe(2);
    expect(body.from).toBe("2026-04-01");
    expect(body.to).toBe("2026-04-05");
    expect(body.languages).toEqual([
      { id: "go", label: "Go" },
      { id: "rust", label: "Rust" },
    ]);
    expect(body.series.map((point) => point.observed_date)).toEqual([
      "2026-04-02",
      "2026-04-04",
    ]);
    expect(body.series[0]!.counts).toEqual({ go: 10, rust: 7 });
    expect(body.series[1]!.counts).toEqual({ go: 12, rust: 9 });
  });

  it("deduplicates language ids and excludes dates without rows for any requested language", async () => {
    await seedPublishedRun({
      run_id: "run-one-lang",
      observed_date: "2026-04-05",
      observed_at: "2026-04-05T02:00:00.000Z",
      published_at: "2026-04-05T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 2, count: 3, collected_at: "2026-04-05T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go,go,rust&threshold=2&from=2026-04-01&to=2026-04-05",
      ),
    );
    const body = await readJson<CompareBody>(response);

    expect(response.status).toBe(200);
    expect(body.languages.map((language) => language.id)).toEqual(["go", "rust"]);
    expect(body.series).toEqual([
      { observed_date: "2026-04-05", counts: { go: 3 } },
    ]);
  });

  it("rejects missing params, empty languages, too many languages, unknown language, unknown threshold, invalid range", async () => {
    const harness = createHarness();

    const missing = await dispatch(harness.app, makePublicRequest("/api/quality/compare"));
    expect(missing.status).toBe(400);
    expect((await readJson<ErrorBody>(missing)).error.code).toBe("missing_query_parameters");

    const emptyLanguages = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=,&threshold=2&from=2026-04-01&to=2026-04-05",
      ),
    );
    expect(emptyLanguages.status).toBe(400);
    expect((await readJson<ErrorBody>(emptyLanguages)).error.code).toBe("invalid_languages");

    const tooMany = Array.from({ length: 21 }, (_, index) => `lang${index}`).join(",");
    const tooManyResponse = await dispatch(
      harness.app,
      makePublicRequest(
        `/api/quality/compare?languages=${tooMany}&threshold=2&from=2026-04-01&to=2026-04-05`,
      ),
    );
    expect(tooManyResponse.status).toBe(400);
    expect((await readJson<ErrorBody>(tooManyResponse)).error.code).toBe("too_many_languages");

    const unknownLanguage = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go,made-up&threshold=2&from=2026-04-01&to=2026-04-05",
      ),
    );
    expect(unknownLanguage.status).toBe(400);
    expect((await readJson<ErrorBody>(unknownLanguage)).error.code).toBe("unknown_language");

    const unknownThreshold = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go&threshold=7&from=2026-04-01&to=2026-04-05",
      ),
    );
    expect(unknownThreshold.status).toBe(400);
    expect((await readJson<ErrorBody>(unknownThreshold)).error.code).toBe("unknown_threshold");

    const invalidRange = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go&threshold=2&from=2026-04-10&to=2026-04-05",
      ),
    );
    expect(invalidRange.status).toBe(400);
    expect((await readJson<ErrorBody>(invalidRange)).error.code).toBe("invalid_date_range");
  });

  it("clamps from to launch_date when the requested range starts before it", async () => {
    await seedPublishedRun({
      run_id: "run-early",
      observed_date: "2026-04-01",
      observed_at: "2026-04-01T02:00:00.000Z",
      published_at: "2026-04-01T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 10, count: 2, collected_at: "2026-04-01T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest(
        "/api/quality/compare?languages=go&threshold=10&from=2025-12-01&to=2026-04-05",
      ),
    );
    const body = await readJson<CompareBody>(response);

    expect(response.status).toBe(200);
    expect(body.from).toBe("2025-12-01");
    expect(body.series.map((point) => point.observed_date)).toEqual(["2026-04-01"]);
  });
});
