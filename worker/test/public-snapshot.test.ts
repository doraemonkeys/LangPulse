import { beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  dispatch,
  makePublicRequest,
  readJson,
  resetDatabase,
  seedPublishedRun,
} from "./helpers";

interface SnapshotLanguage {
  id: string;
  label: string;
  count: number;
  previous_count: number | null;
}

interface SnapshotBody {
  observed_date: string;
  threshold: number;
  previous_date: string | null;
  languages: SnapshotLanguage[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe("GET /api/quality/snapshot", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns the current snapshot plus previous-day counts at the requested threshold", async () => {
    await seedPublishedRun({
      run_id: "run-2026-04-09",
      observed_date: "2026-04-09",
      observed_at: "2026-04-09T02:00:00.000Z",
      published_at: "2026-04-09T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 2, count: 100, collected_at: "2026-04-09T02:00:00.000Z" },
        { language_id: "go", threshold_value: 10, count: 40, collected_at: "2026-04-09T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 2, count: 80, collected_at: "2026-04-09T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 10, count: 30, collected_at: "2026-04-09T02:00:00.000Z" },
      ],
    });
    await seedPublishedRun({
      run_id: "run-2026-04-10",
      observed_date: "2026-04-10",
      observed_at: "2026-04-10T02:00:00.000Z",
      published_at: "2026-04-10T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 2, count: 110, collected_at: "2026-04-10T02:00:00.000Z" },
        { language_id: "go", threshold_value: 10, count: 42, collected_at: "2026-04-10T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 2, count: 79, collected_at: "2026-04-10T02:00:00.000Z" },
        { language_id: "rust", threshold_value: 10, count: 31, collected_at: "2026-04-10T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-10&threshold=2"),
    );
    const body = await readJson<SnapshotBody>(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(body.observed_date).toBe("2026-04-10");
    expect(body.threshold).toBe(2);
    expect(body.previous_date).toBe("2026-04-09");

    const byId = new Map(body.languages.map((language) => [language.id, language]));
    expect(byId.get("go")).toEqual({ id: "go", label: "Go", count: 110, previous_count: 100 });
    expect(byId.get("rust")).toEqual({ id: "rust", label: "Rust", count: 79, previous_count: 80 });
    expect(body.languages.every((language) => language.count >= 0)).toBe(true);
    expect(body.languages.some((language) => language.id === "ruby")).toBe(false);
  });

  it("returns previous_date null and previous_count null when no prior publication exists", async () => {
    await seedPublishedRun({
      run_id: "run-first-day",
      observed_date: "2026-04-01",
      observed_at: "2026-04-01T02:00:00.000Z",
      published_at: "2026-04-01T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 10, count: 5, collected_at: "2026-04-01T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-01&threshold=10"),
    );
    const body = await readJson<SnapshotBody>(response);

    expect(response.status).toBe(200);
    expect(body.previous_date).toBeNull();
    expect(body.languages).toHaveLength(1);
    expect(body.languages[0]!.previous_count).toBeNull();
  });

  it("skips languages that are inactive on the observed_date", async () => {
    await seedPublishedRun({
      run_id: "run-retired",
      observed_date: "2026-04-09",
      observed_at: "2026-04-09T02:00:00.000Z",
      published_at: "2026-04-09T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 0, count: 1, collected_at: "2026-04-09T02:00:00.000Z" },
        { language_id: "ruby", threshold_value: 0, count: 9, collected_at: "2026-04-09T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-09&threshold=0"),
    );
    const body = await readJson<SnapshotBody>(response);

    expect(response.status).toBe(200);
    expect(body.languages.some((language) => language.id === "ruby")).toBe(false);
    expect(body.languages.some((language) => language.id === "go")).toBe(true);
  });

  it("returns 404 when the requested date has no published snapshot", async () => {
    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-15&threshold=2"),
    );
    const body = await readJson<ErrorBody>(response);

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("snapshot_not_found");
  });

  it("rejects unknown thresholds, missing params, and dates before launch", async () => {
    const harness = createHarness();

    const missing = await dispatch(harness.app, makePublicRequest("/api/quality/snapshot"));
    expect(missing.status).toBe(400);
    expect((await readJson<ErrorBody>(missing)).error.code).toBe("missing_query_parameters");

    const invalidDate = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=bad&threshold=2"),
    );
    expect(invalidDate.status).toBe(400);
    expect((await readJson<ErrorBody>(invalidDate)).error.code).toBe("invalid_date");

    const invalidThreshold = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-09&threshold=-5"),
    );
    expect(invalidThreshold.status).toBe(400);
    expect((await readJson<ErrorBody>(invalidThreshold)).error.code).toBe("invalid_threshold");

    const unknownThreshold = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2026-04-09&threshold=7"),
    );
    expect(unknownThreshold.status).toBe(400);
    expect((await readJson<ErrorBody>(unknownThreshold)).error.code).toBe("unknown_threshold");

    const beforeLaunch = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/snapshot?date=2025-01-01&threshold=2"),
    );
    expect(beforeLaunch.status).toBe(400);
    expect((await readJson<ErrorBody>(beforeLaunch)).error.code).toBe("date_before_launch");
  });
});
