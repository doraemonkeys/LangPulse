import { beforeEach, describe, expect, it } from "vitest";
import {
  findLanguageById,
  findThresholdByValue,
  getActiveLanguages,
  getActiveThresholds,
  isEntryActiveOnDate,
  loadMetricsRegistry,
  metricsRegistry,
  toPublicLanguages,
  toPublicThresholds,
} from "../src/config-registry";
import { assertKnownRun, expireRun, failRun, readRun } from "../src/database";
import { requireServiceAuth } from "../src/auth";
import { HttpError, readJsonObject } from "../src/http";
import { createWorker } from "../src/index";
import {
  checkDatabaseHealth,
  readLatestPublishedObservedDate,
} from "../src/public-quality";
import { finalizeQualityRun, heartbeatQualityRun, upsertQualityRunRow, validatePublicDateRange, createQualityRun } from "../src/quality-runs";
import {
  assertPublicRange,
  assertUtcDate,
  assertUtcTimestamp,
  extendLease,
  parseLeaseDurationSeconds,
} from "../src/time";
import type { MetricsRegistry, RequestContext, WorkerEnv } from "../src/types";
import {
  createHarness,
  dispatch,
  insertPublication,
  insertRun,
  makePublicRequest,
  resetDatabase,
  testEnv,
  TEST_BASE_URL,
  TEST_NOW,
  TEST_OBSERVED_DATE,
} from "./helpers";

function createContext(overrides: Partial<RequestContext["runtime"]> = {}): RequestContext {
  return {
    env: testEnv,
    runtime: {
      registry: overrides.registry ?? metricsRegistry,
      now: overrides.now ?? (() => new Date(TEST_NOW)),
      randomUUID: overrides.randomUUID ?? (() => "coverage-run"),
      runLeaseDurationSeconds: overrides.runLeaseDurationSeconds ?? 300,
    },
  };
}

function buildRegistry(overrides: Partial<MetricsRegistry> = {}): MetricsRegistry {
  return {
    ...metricsRegistry,
    ...overrides,
    languages: overrides.languages ?? structuredClone(metricsRegistry.languages),
    thresholds: overrides.thresholds ?? structuredClone(metricsRegistry.thresholds),
  };
}

describe("supporting logic coverage", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("validates registry invariants", () => {
    expect(() => loadMetricsRegistry(null)).toThrow(/must be an object/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        timezone: "Asia/Shanghai",
      }),
    ).toThrow(/timezone must stay fixed/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        window_days: 14,
      }),
    ).toThrow(/window_days must stay fixed/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: "nope",
        thresholds: [],
      }),
    ).toThrow(/must be arrays/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [
          metricsRegistry.languages[0],
          { ...metricsRegistry.languages[0] },
        ],
      }),
    ).toThrow(/Duplicate id/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        thresholds: [
          metricsRegistry.thresholds[0],
          { ...metricsRegistry.thresholds[0] },
        ],
      }),
    ).toThrow(/Duplicate value/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [],
        thresholds: [],
      }),
    ).toThrow(/requires at least one language and one threshold/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [
          {
            ...metricsRegistry.languages[0],
            id: " go ",
          },
        ],
      }),
    ).toThrow(/must not contain leading or trailing whitespace/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [
          {
            ...metricsRegistry.languages[0],
            id: "Go!",
          },
        ],
      }),
    ).toThrow(/stable slug/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [
          {
            ...metricsRegistry.languages[0],
            active_from: "2026-03-31",
          },
        ],
      }),
    ).toThrow(/active_from must be on or after launch_date/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        thresholds: [
          {
            ...metricsRegistry.thresholds[0],
            active_from: "2026-03-31",
          },
        ],
      }),
    ).toThrow(/active_from must be on or after launch_date/i);

    expect(() =>
      loadMetricsRegistry({
        ...metricsRegistry,
        languages: [
          {
            ...metricsRegistry.languages[0],
            active_from: "2026-04-07",
            active_to: "2026-04-01",
          },
        ],
      }),
    ).toThrow(/active_to must be on or after active_from/i);

  });

  it("preserves retired dimensions publicly", () => {
    expect(getActiveLanguages(metricsRegistry, "2026-04-07").map((entry) => entry.id)).toEqual([
      "go",
      "rust",
    ]);
    expect(getActiveThresholds(metricsRegistry, "2026-04-07").map((entry) => entry.value)).toEqual([
      0,
      10,
    ]);
    expect(getActiveLanguages(metricsRegistry, "2026-04-08").map((entry) => entry.id)).toEqual([
      "go",
      "rust",
      "python",
      "javascript",
      "typescript",
      "java",
      "csharp",
      "cpp",
      "php",
      "kotlin",
      "swift",
      "solidity",
      "move",
      "shell",
      "powershell",
      "dart",
      "vue",
      "visual-basic-dotnet",
      "r",
      "pascal",
      "matlab",
      "fortran",
      "ada",
      "cobol",
      "common-lisp",
      "zig",
      "vbscript",
      "lua",
      "erlang",
      "scala",
    ]);
    expect(getActiveThresholds(metricsRegistry, "2026-04-08").map((entry) => entry.value)).toEqual([
      0,
      2,
      10,
      100,
      1000,
    ]);
    expect(isEntryActiveOnDate("2026-04-02", "2026-04-01", "2026-04-03")).toBe(true);
    expect(isEntryActiveOnDate("2026-04-07", "2026-04-01", "2026-04-03")).toBe(false);
    expect(findLanguageById(metricsRegistry, "go")?.label).toBe("Go");
    expect(findLanguageById(metricsRegistry, "missing")).toBeUndefined();
    expect(findThresholdByValue(metricsRegistry, 10)?.value).toBe(10);
    expect(findThresholdByValue(metricsRegistry, 999)).toBeUndefined();
    expect(toPublicLanguages(metricsRegistry).every((entry) => !("github_query_fragment" in entry))).toBe(
      true,
    );
    expect(toPublicThresholds(metricsRegistry).map((entry) => entry.value)).toContain(50);
    expect(toPublicThresholds(metricsRegistry).map((entry) => entry.value)).toContain(1000);
  });

  it("validates UTC helpers and public date ranges", () => {
    expect(assertUtcDate("2026-04-07", "observed_date")).toBe("2026-04-07");
    expect(() => assertUtcDate("2026-04-31", "observed_date")).toThrow(/real UTC date/i);
    expect(assertUtcTimestamp("2026-04-07T12:00:00Z", "collected_at")).toBe(
      "2026-04-07T12:00:00.000Z",
    );
    expect(() => assertUtcTimestamp("2026-04-07T12:00:00", "collected_at")).toThrow(
      /ISO 8601 UTC timestamp/i,
    );
    expect(() => assertPublicRange("2026-04-08", "2026-04-07")).toThrow(/on or before/i);
    expect(() => assertPublicRange("2026-01-01", "2027-01-01")).toThrow(/cannot exceed 365/i);
    expect(parseLeaseDurationSeconds(undefined)).toBe(300);
    expect(() => parseLeaseDurationSeconds("0")).toThrow(/positive integer/i);
    expect(extendLease(new Date(TEST_NOW), 300)).toBe("2026-04-07T12:05:00.000Z");
    expect(validatePublicDateRange("2026-04-01", "2026-03-25", "2026-04-07")).toEqual({
      from: "2026-03-25",
      to: "2026-04-07",
      queryFrom: "2026-04-01",
    });
    expect(() => validatePublicDateRange("2026-04-01", "bad", "2026-04-07")).toThrow(
      /UTC date/i,
    );
  });

  it("updates diagnostic run states through database helpers", async () => {
    await insertRun({ run_id: "expire-me" });
    await expireRun(testEnv.DB, "expire-me", "2026-04-07T12:10:00.000Z", "expired for coverage");
    const expiredRun = await readRun(testEnv.DB, "expire-me");
    expect(expiredRun?.status).toBe("expired");

    await insertRun({ run_id: "fail-me", attempt_no: 2 });
    await failRun(testEnv.DB, "fail-me", "2026-04-07T12:10:00.000Z", "failed for coverage");
    const failedRun = await readRun(testEnv.DB, "fail-me");
    expect(failedRun?.status).toBe("failed");

    expect(() => assertKnownRun(null, "missing-run")).toThrowError(HttpError);
  });

  it("rejects misconfigured auth, invalid json bodies, and unsupported routes", async () => {
    expect(() =>
      requireServiceAuth(new Request(`${TEST_BASE_URL}/internal/quality-runs`), {
        ...testEnv,
        INTERNAL_API_TOKEN: "",
      } as WorkerEnv),
    ).toThrow(/INTERNAL_API_TOKEN must be configured/i);

    // Same-length, single-byte mismatch exercises the XOR path end-to-end:
    // short-circuit compares would leak the mismatch index via response timing.
    expect(() =>
      requireServiceAuth(
        new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
          headers: { authorization: "Bearer test-internal-tokeN" },
        }),
        testEnv,
      ),
    ).toThrow(/Service authentication is required/i);

    expect(() =>
      requireServiceAuth(
        new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
          headers: { authorization: "Bearer wrong-length-token" },
        }),
        testEnv,
      ),
    ).toThrow(/Service authentication is required/i);

    expect(() =>
      requireServiceAuth(new Request(`${TEST_BASE_URL}/internal/quality-runs`), testEnv),
    ).toThrow(/Service authentication is required/i);

    await expect(
      readJsonObject(
        new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_json" });

    await expect(
      readJsonObject(
        new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([]),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_json" });

    const harness = createHarness();
    const wrongMethod = await dispatch(harness.app, makePublicRequest("/internal/quality-runs"));
    expect(wrongMethod.status).toBe(405);

    const missingCompareParameters = await dispatch(
      harness.app,
      makePublicRequest("/api/quality/compare?languages=go&threshold=2"),
    );
    expect(missingCompareParameters.status).toBe(400);

    const invalidPathSegment = await dispatch(
      harness.app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs/%E0%A4%A/heartbeat`, { method: "POST" }),
    );
    expect(invalidPathSegment.status).toBe(400);

    const unknownRoute = await dispatch(harness.app, makePublicRequest("/api/unknown"));
    expect(unknownRoute.status).toBe(404);

    const invalidJsonResponse = await dispatch(
      harness.app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-internal-token",
          "content-type": "application/json",
        },
        body: "{broken",
      }),
    );
    expect(invalidJsonResponse.status).toBe(400);
  });

  it("enforces current-day and registry cardinality constraints during run creation", async () => {
    const baseContext = createContext();

    await expect(
      createQualityRun(baseContext, {
        observed_date: "2026-03-31",
        expected_rows: 4,
      }),
    ).rejects.toMatchObject({ code: "observed_date_before_launch" });

    await expect(
      createQualityRun(baseContext, {
        observed_date: "2026-04-06",
        expected_rows: 4,
      }),
    ).rejects.toMatchObject({ code: "observed_date_not_current_utc_date" });

    await expect(
      createQualityRun(baseContext, {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 99,
      }),
    ).rejects.toMatchObject({ code: "expected_rows_mismatch" });

    const inactiveRegistry = buildRegistry({
      languages: [
        {
          ...metricsRegistry.languages[0]!,
          active_from: "2026-04-08",
        },
      ],
      thresholds: [
        {
          ...metricsRegistry.thresholds[0]!,
          active_from: "2026-04-08",
        },
      ],
    });

    await expect(
      createQualityRun(createContext({ registry: inactiveRegistry }), {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 1,
      }),
    ).rejects.toMatchObject({ code: "no_active_dimensions" });
  });

  it("rejects expired heartbeats and invalid row dimensions", async () => {
    await insertRun({
      run_id: "expired-run",
      lease_expires_at: "2026-04-07T11:59:00.000Z",
      last_heartbeat_at: "2026-04-07T11:50:00.000Z",
    });

    await expect(heartbeatQualityRun(createContext(), "expired-run")).rejects.toMatchObject({
      code: "run_expired",
    });
    expect((await readRun(testEnv.DB, "expired-run"))?.status).toBe("expired");

    await insertRun({ run_id: "row-run", attempt_no: 2 });
    await expect(
      upsertQualityRunRow(createContext(), "row-run", "unknown", "0", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "unknown_language" });

    await expect(
      upsertQualityRunRow(createContext(), "row-run", "go", "999", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "unknown_threshold" });

    await expect(
      upsertQualityRunRow(createContext(), "row-run", "ruby", "0", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "language_inactive_for_observed_date" });

    await expect(
      upsertQualityRunRow(createContext(), "row-run", "go", "50", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "threshold_inactive_for_observed_date" });
  });

  it("covers finalize conflict and terminal-state branches", async () => {
    await insertRun({
      run_id: "published-run",
      status: "complete",
      finished_at: "2026-04-07T12:01:00.000Z",
    });
    await insertPublication(TEST_OBSERVED_DATE, "published-run", "2026-04-07T12:01:00.000Z");

    await expect(
      finalizeQualityRun(createContext(), "published-run", { status: "failed" }),
    ).rejects.toMatchObject({ code: "run_already_complete" });

    await insertRun({
      run_id: "failed-run",
      attempt_no: 2,
      status: "failed",
      finished_at: "2026-04-07T12:01:00.000Z",
      error_summary: "failed already",
    });
    await expect(
      finalizeQualityRun(createContext(), "failed-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "run_already_failed" });

    await insertRun({
      run_id: "conflict-run",
      observed_date: TEST_OBSERVED_DATE,
      attempt_no: 3,
    });
    await expect(
      finalizeQualityRun(createContext(), "conflict-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "publication_exists" });
    expect((await readRun(testEnv.DB, "conflict-run"))?.status).toBe("failed");

    await insertRun({
      run_id: "expired-finalize-run",
      attempt_no: 4,
      lease_expires_at: "2026-04-07T11:59:00.000Z",
      last_heartbeat_at: "2026-04-07T11:50:00.000Z",
    });
    await expect(
      finalizeQualityRun(createContext(), "expired-finalize-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "run_expired" });
    expect((await readRun(testEnv.DB, "expired-finalize-run"))?.status).toBe("expired");
  });
});

describe("worker runtime branch coverage", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("handles method dispatch through the worker entrypoint for additional branches", async () => {
    const app = createWorker({
      now: () => new Date(TEST_NOW),
      randomUUID: () => "worker-run",
      registry: metricsRegistry,
      runLeaseDurationSeconds: 300,
    });

    const metadataWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/api/metadata`, { method: "POST" }),
    );
    expect(metadataWrongMethod.status).toBe(405);

    const latestWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/api/quality/latest`, { method: "POST" }),
    );
    expect(latestWrongMethod.status).toBe(405);

    const snapshotWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/api/quality/snapshot?date=2026-04-02&threshold=2`, {
        method: "POST",
      }),
    );
    expect(snapshotWrongMethod.status).toBe(405);

    const compareWrongMethod = await dispatch(
      app,
      new Request(
        `${TEST_BASE_URL}/api/quality/compare?languages=go&threshold=2&from=2026-04-01&to=2026-04-02`,
        { method: "POST" },
      ),
    );
    expect(compareWrongMethod.status).toBe(405);

    const healthWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/api/health`, { method: "POST" }),
    );
    expect(healthWrongMethod.status).toBe(405);

    const finalizeWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs/run-1/finalize`, { method: "GET" }),
    );
    expect(finalizeWrongMethod.status).toBe(405);

    const heartbeatWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs/run-1/heartbeat`, { method: "GET" }),
    );
    expect(heartbeatWrongMethod.status).toBe(405);

    const rowWrongMethod = await dispatch(
      app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs/run-1/rows/go/0`, { method: "POST" }),
    );
    expect(rowWrongMethod.status).toBe(405);

    const brokenEnvResponse = await app.fetch!(
      new Request(`${TEST_BASE_URL}/api/health`) as Request<
        unknown,
        IncomingRequestCfProperties<unknown>
      >,
      {
        ...testEnv,
        RUN_LEASE_DURATION_SECONDS: "not-a-number",
      } as WorkerEnv,
      {} as ExecutionContext,
    );
    expect(brokenEnvResponse.status).toBe(500);

    const rateLimitedResponse = await app.fetch!(
      new Request(`${TEST_BASE_URL}/api/health`) as Request<
        unknown,
        IncomingRequestCfProperties<unknown>
      >,
      {
        ...testEnv,
        HEALTH_RATE_LIMITER: {
          limit: async () => ({ success: false }),
        } as RateLimit,
      } as WorkerEnv,
      {} as ExecutionContext,
    );
    expect(rateLimitedResponse.status).toBe(429);
    const rateLimitedBody = (await rateLimitedResponse.json()) as {
      error: { code: string };
    };
    expect(rateLimitedBody.error.code).toBe("rate_limited");
  });

  it("covers defensive read-model branches with stub databases", async () => {
    const unhealthyContext = {
      ...createContext(),
      env: {
        DB: {
          prepare() {
            return {
              first: async () => ({ ok: 0 }),
            };
          },
        },
      } as unknown as WorkerEnv,
    } satisfies RequestContext;

    await expect(checkDatabaseHealth(unhealthyContext)).resolves.toBe(false);

    const noLatestContext = {
      ...createContext(),
      env: {
        DB: {
          prepare() {
            return {
              first: async () => null,
            };
          },
        },
      } as unknown as WorkerEnv,
    } satisfies RequestContext;

    await expect(readLatestPublishedObservedDate(noLatestContext)).resolves.toBeNull();
  });

  it("covers additional lifecycle validation branches and defensive fallbacks", async () => {
    await expect(
      createQualityRun(createContext(), {
        observed_date: "bad-date",
        expected_rows: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_observed_date" });

    await expect(
      createQualityRun(createContext(), {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_expected_rows" });

    await insertRun({
      run_id: "completed-heartbeat",
      status: "complete",
      finished_at: "2026-04-07T12:01:00.000Z",
    });
    await expect(heartbeatQualityRun(createContext(), "completed-heartbeat")).rejects.toMatchObject({
      code: "run_not_running",
    });

    await insertRun({
      run_id: "failed-row-write",
      attempt_no: 2,
      status: "failed",
      finished_at: "2026-04-07T12:01:00.000Z",
      error_summary: "already failed",
    });
    await expect(
      upsertQualityRunRow(createContext(), "failed-row-write", "go", "0", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "run_not_running" });

    await expect(
      upsertQualityRunRow(createContext(), "failed-row-write", "go", "not-a-number", {
        count: 1,
        collected_at: TEST_NOW,
      }),
    ).rejects.toMatchObject({ code: "invalid_threshold_value" });

    await expect(
      upsertQualityRunRow(createContext(), "failed-row-write", "go", "0", {
        count: 1,
        collected_at: "not-a-timestamp",
      }),
    ).rejects.toMatchObject({ code: "invalid_collected_at" });

    await expect(
      finalizeQualityRun(createContext(), "failed-run", { status: "unexpected" }),
    ).rejects.toMatchObject({ code: "invalid_finalize_status" });

    await expect(
      finalizeQualityRun(createContext(), "failed-run", { status: "failed" }),
    ).rejects.toMatchObject({ code: "run_not_found" });

    await insertRun({
      run_id: "expired-state-run",
      attempt_no: 3,
      status: "expired",
      finished_at: "2026-04-07T12:01:00.000Z",
      error_summary: "expired already",
    });
    await expect(
      finalizeQualityRun(createContext(), "expired-state-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "run_expired" });

    const createFallbackContext = {
      env: {
        DB: {
          batch: async () => [],
          prepare(sql: string) {
            return {
              bind() {
                if (sql.includes("FROM quality_30d_publications")) {
                  return {
                    first: async () => null,
                  };
                }
                return {
                  first: async () => null,
                };
              },
            };
          },
        },
      } as unknown as WorkerEnv,
      runtime: createContext().runtime,
    } satisfies RequestContext;

    await expect(
      createQualityRun(createFallbackContext, {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    ).rejects.toMatchObject({ code: "run_creation_failed" });

    const finalizeFallbackContext = {
      env: {
        DB: {
          batch: async () => [],
          prepare(sql: string) {
            return {
              bind() {
                if (sql.includes("COUNT(*) AS actual_rows")) {
                  return { first: async () => ({ actual_rows: 1 }) };
                }
                if (sql.includes("WHERE run_id = ?1") && sql.includes("FROM quality_30d_runs")) {
                  return {
                    first: async () => ({
                      run_id: "fallback-run",
                      observed_date: TEST_OBSERVED_DATE,
                      attempt_no: 1,
                      observed_at: TEST_NOW,
                      status: "running",
                      lease_expires_at: "2026-04-07T12:05:00.000Z",
                      last_heartbeat_at: TEST_NOW,
                      expected_rows: 1,
                      actual_rows: 1,
                      error_summary: null,
                      started_at: TEST_NOW,
                      finished_at: null,
                    }),
                    run: async () => ({ success: true }),
                  };
                }
                if (sql.includes("FROM quality_30d_publications")) {
                  return {
                    first: async () => null,
                  };
                }
                return {
                  run: async () => ({ success: true }),
                  first: async () => null,
                };
              },
            };
          },
        },
      } as unknown as WorkerEnv,
      runtime: createContext({
        randomUUID: () => "fallback-run",
      }).runtime,
    } satisfies RequestContext;

    await expect(
      finalizeQualityRun(finalizeFallbackContext, "fallback-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "run_finalize_failed" });
  });
});
