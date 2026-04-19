import { beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  dispatch,
  insertRun,
  makePublicRequest,
  readJson,
  resetDatabase,
  seedPublishedRun,
} from "./helpers";

describe("public quality routes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns metadata for all publicly queryable languages and thresholds", async () => {
    const harness = createHarness();
    const response = await dispatch(harness.app, makePublicRequest("/api/metadata"));
    const body = await readJson<{
      languages: Array<Record<string, unknown>>;
      thresholds: Array<Record<string, unknown>>;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.languages.map((language) => language.id)).toContain("python");
    expect(body.languages.map((language) => language.id)).toContain("ruby");
    expect(body.thresholds.map((threshold) => threshold.value)).toContain(1000);
    expect(body.thresholds.map((threshold) => threshold.value)).toContain(50);
    expect(body.languages[0]).not.toHaveProperty("github_query_fragment");
  });

  it("returns the latest published snapshot date with the required cache policy", async () => {
    await seedPublishedRun({
      run_id: "run-early",
      observed_date: "2026-04-02",
      observed_at: "2026-04-02T01:00:00.000Z",
      published_at: "2026-04-02T01:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 0, count: 12, collected_at: "2026-04-02T01:00:00.000Z" },
      ],
    });
    await seedPublishedRun({
      run_id: "run-late",
      observed_date: "2026-04-05",
      observed_at: "2026-04-05T01:00:00.000Z",
      published_at: "2026-04-05T01:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 0, count: 22, collected_at: "2026-04-05T01:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(harness.app, makePublicRequest("/api/quality/latest"));
    const body = await readJson<{ observed_date: string | null }>(response);

    expect(response.status).toBe(200);
    expect(body.observed_date).toBe("2026-04-05");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  it("returns sparse published series and excludes unpublished failed attempts", async () => {
    await seedPublishedRun({
      run_id: "run-2026-04-02",
      observed_date: "2026-04-02",
      observed_at: "2026-04-02T02:00:00.000Z",
      published_at: "2026-04-02T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 0, count: 15, collected_at: "2026-04-02T02:00:00.000Z" },
        { language_id: "go", threshold_value: 10, count: 9, collected_at: "2026-04-02T02:00:00.000Z" },
      ],
    });
    await insertRun({
      run_id: "failed-run",
      observed_date: "2026-04-03",
      status: "failed",
      expected_rows: 2,
      actual_rows: 1,
      finished_at: "2026-04-03T02:05:00.000Z",
      error_summary: "GitHub Search returned incomplete_results=true.",
    });
    await seedPublishedRun({
      run_id: "run-2026-04-04",
      observed_date: "2026-04-04",
      observed_at: "2026-04-04T02:00:00.000Z",
      published_at: "2026-04-04T02:05:00.000Z",
      rows: [
        { language_id: "go", threshold_value: 0, count: 20, collected_at: "2026-04-04T02:00:00.000Z" },
        { language_id: "go", threshold_value: 10, count: 11, collected_at: "2026-04-04T02:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality?language=go&from=2026-04-02&to=2026-04-04"),
    );
    const body = await readJson<{
      series: Array<{ observed_date: string; observed_at: string; published_at: string }>;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.series.map((point) => point.observed_date)).toEqual([
      "2026-04-02",
      "2026-04-04",
    ]);
    expect(body.series[0]!.observed_at).toBe("2026-04-02T02:00:00.000Z");
    expect(body.series[1]!.published_at).toBe("2026-04-04T02:05:00.000Z");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });

  it("keeps retired languages and thresholds visible for historical publications", async () => {
    await seedPublishedRun({
      run_id: "ruby-history",
      observed_date: "2026-04-02",
      observed_at: "2026-04-02T03:00:00.000Z",
      published_at: "2026-04-02T03:05:00.000Z",
      rows: [
        { language_id: "ruby", threshold_value: 0, count: 30, collected_at: "2026-04-02T03:00:00.000Z" },
        { language_id: "ruby", threshold_value: 10, count: 20, collected_at: "2026-04-02T03:00:00.000Z" },
        { language_id: "ruby", threshold_value: 50, count: 8, collected_at: "2026-04-02T03:00:00.000Z" },
      ],
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality?language=ruby&from=2026-04-01&to=2026-04-05"),
    );
    const body = await readJson<{
      series: Array<{
        observed_date: string;
        thresholds: Array<{ threshold_value: number; count: number }>;
      }>;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.series).toHaveLength(1);
    expect(body.series[0]!.observed_date).toBe("2026-04-02");
    expect(body.series[0]!.thresholds).toEqual([
      { threshold_value: 0, count: 30 },
      { threshold_value: 10, count: 20 },
      { threshold_value: 50, count: 8 },
    ]);
  });

  it("validates read ranges and exposes health status", async () => {
    const harness = createHarness();

    const invalidRangeResponse = await dispatch(
      harness.app,
      makePublicRequest("/api/quality?language=go&from=2026-01-01&to=2027-01-01"),
    );
    expect(invalidRangeResponse.status).toBe(400);

    const healthResponse = await dispatch(harness.app, makePublicRequest("/api/health"));
    const healthBody = await readJson<{ ok: boolean }>(healthResponse);
    expect(healthResponse.status).toBe(200);
    expect(healthBody.ok).toBe(true);
  });
});
