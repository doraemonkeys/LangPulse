import { beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  dispatch,
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

  it("returns 404 for the retired single-language /api/quality endpoint", async () => {
    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makePublicRequest("/api/quality?language=go&from=2026-04-01&to=2026-04-05"),
    );
    expect(response.status).toBe(404);
  });

  it("exposes health status", async () => {
    const harness = createHarness();
    const healthResponse = await dispatch(harness.app, makePublicRequest("/api/health"));
    const healthBody = await readJson<{ ok: boolean }>(healthResponse);
    expect(healthResponse.status).toBe(200);
    expect(healthBody.ok).toBe(true);
  });
});
