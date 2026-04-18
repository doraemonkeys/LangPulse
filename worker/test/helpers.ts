import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "../src/index";
import type { QualityRunRecord, RunStatus, WorkerEnv } from "../src/types";
import { TEST_SCHEMA_STATEMENTS } from "./schema";

export const TEST_INTERNAL_TOKEN = "test-internal-token";
export const TEST_BASE_URL = "https://langpulse.test";
export const TEST_OBSERVED_DATE = "2026-04-07";
export const TEST_NOW = "2026-04-07T12:00:00.000Z";

export interface TestHarness {
  app: ExportedHandler<WorkerEnv>;
  setNow: (isoTimestamp: string) => void;
}

export interface SeedRunInput {
  run_id: string;
  observed_date: string;
  attempt_no: number;
  observed_at: string;
  status: RunStatus;
  lease_expires_at: string;
  last_heartbeat_at: string;
  expected_rows: number;
  actual_rows: number;
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export const testEnv = env as unknown as WorkerEnv;

export async function resetDatabase(): Promise<void> {
  await testEnv.DB.batch(TEST_SCHEMA_STATEMENTS.map((statement) => testEnv.DB.prepare(statement)));
}

export function createHarness(): TestHarness {
  let currentNow = TEST_NOW;
  let nextRunNumber = 1;

  return {
    app: createWorker({
      now: () => new Date(currentNow),
      randomUUID: () => `run-${nextRunNumber++}`,
      runLeaseDurationSeconds: 300,
    }),
    setNow: (isoTimestamp: string) => {
      currentNow = isoTimestamp;
    },
  };
}

export async function dispatch(
  app: ExportedHandler<WorkerEnv>,
  request: Request,
): Promise<Response> {
  const executionContext = createExecutionContext();
  const response = await app.fetch!(
    request as Request<unknown, IncomingRequestCfProperties<unknown>>,
    testEnv,
    executionContext,
  );
  await waitOnExecutionContext(executionContext);
  return response;
}

export function makeInternalRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Request {
  const headers = new Headers({
    authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
  });

  let requestBody: string | undefined;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    requestBody = JSON.stringify(body);
  }

  return new Request(`${TEST_BASE_URL}${path}`, {
    method,
    headers,
    body: requestBody,
  });
}

export function makePublicRequest(path: string): Request {
  return new Request(`${TEST_BASE_URL}${path}`);
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function insertRun(overrides: Partial<SeedRunInput> & Pick<SeedRunInput, "run_id">): Promise<void> {
  const run: SeedRunInput = {
    run_id: overrides.run_id,
    observed_date: overrides.observed_date ?? TEST_OBSERVED_DATE,
    attempt_no: overrides.attempt_no ?? 1,
    observed_at: overrides.observed_at ?? TEST_NOW,
    status: overrides.status ?? "running",
    lease_expires_at: overrides.lease_expires_at ?? "2026-04-07T12:05:00.000Z",
    last_heartbeat_at: overrides.last_heartbeat_at ?? TEST_NOW,
    expected_rows: overrides.expected_rows ?? 4,
    actual_rows: overrides.actual_rows ?? 0,
    error_summary: overrides.error_summary ?? null,
    started_at: overrides.started_at ?? TEST_NOW,
    finished_at: overrides.finished_at ?? null,
  };

  await testEnv.DB
    .prepare(
      `INSERT INTO quality_30d_runs (
        run_id,
        observed_date,
        attempt_no,
        observed_at,
        status,
        lease_expires_at,
        last_heartbeat_at,
        expected_rows,
        actual_rows,
        error_summary,
        started_at,
        finished_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      run.run_id,
      run.observed_date,
      run.attempt_no,
      run.observed_at,
      run.status,
      run.lease_expires_at,
      run.last_heartbeat_at,
      run.expected_rows,
      run.actual_rows,
      run.error_summary,
      run.started_at,
      run.finished_at,
    )
    .run();
}

export async function insertRow(
  runId: string,
  languageId: string,
  thresholdValue: number,
  count: number,
  collectedAt: string,
): Promise<void> {
  await testEnv.DB
    .prepare(
      `INSERT INTO quality_30d_run_rows (
        run_id,
        language_id,
        threshold_value,
        count,
        collected_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(runId, languageId, thresholdValue, count, collectedAt)
    .run();
}

export async function insertPublication(
  observedDate: string,
  runId: string,
  publishedAt: string,
): Promise<void> {
  await testEnv.DB
    .prepare(
      `INSERT INTO quality_30d_publications (
        observed_date,
        run_id,
        published_at
      ) VALUES (?1, ?2, ?3)`,
    )
    .bind(observedDate, runId, publishedAt)
    .run();
}

export async function getRun(runId: string): Promise<QualityRunRecord | null> {
  return testEnv.DB
    .prepare(
      `SELECT
        run_id,
        observed_date,
        attempt_no,
        observed_at,
        status,
        lease_expires_at,
        last_heartbeat_at,
        expected_rows,
        actual_rows,
        error_summary,
        started_at,
        finished_at
      FROM quality_30d_runs
      WHERE run_id = ?1`,
    )
    .bind(runId)
    .first<QualityRunRecord>();
}

export async function getRow(
  runId: string,
  languageId: string,
  thresholdValue: number,
): Promise<{ count: number; collected_at: string } | null> {
  return testEnv.DB
    .prepare(
      `SELECT count, collected_at
      FROM quality_30d_run_rows
      WHERE run_id = ?1 AND language_id = ?2 AND threshold_value = ?3`,
    )
    .bind(runId, languageId, thresholdValue)
    .first<{ count: number; collected_at: string }>();
}

export async function seedPublishedRun(options: {
  run_id: string;
  observed_date: string;
  observed_at: string;
  published_at: string;
  rows: Array<{
    language_id: string;
    threshold_value: number;
    count: number;
    collected_at: string;
  }>;
}): Promise<void> {
  await insertRun({
    run_id: options.run_id,
    observed_date: options.observed_date,
    attempt_no: 1,
    observed_at: options.observed_at,
    status: "complete",
    lease_expires_at: options.published_at,
    last_heartbeat_at: options.published_at,
    expected_rows: options.rows.length,
    actual_rows: options.rows.length,
    started_at: options.observed_at,
    finished_at: options.published_at,
  });

  for (const row of options.rows) {
    await insertRow(
      options.run_id,
      row.language_id,
      row.threshold_value,
      row.count,
      row.collected_at,
    );
  }

  await insertPublication(options.observed_date, options.run_id, options.published_at);
}
