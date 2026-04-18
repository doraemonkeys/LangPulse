import { HttpError } from "./http";
import { RUN_STATUSES, type QualityRunRecord } from "./types";

type PreparedStatementOwner = Pick<D1Database, "prepare">;

export async function readRun(
  database: PreparedStatementOwner,
  runId: string,
): Promise<QualityRunRecord | null> {
  return database
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

export async function expireRun(
  database: PreparedStatementOwner,
  runId: string,
  finishedAt: string,
  errorSummary: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE quality_30d_runs
      SET
        status = ?2,
        finished_at = COALESCE(finished_at, ?3),
        error_summary = COALESCE(error_summary, ?4)
      WHERE run_id = ?1 AND status = ?5`,
    )
    .bind(runId, RUN_STATUSES.expired, finishedAt, errorSummary, RUN_STATUSES.running)
    .run();
}

export async function failRun(
  database: PreparedStatementOwner,
  runId: string,
  finishedAt: string,
  errorSummary: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE quality_30d_runs
      SET
        status = ?2,
        finished_at = COALESCE(finished_at, ?3),
        error_summary = ?4
      WHERE run_id = ?1 AND status = ?5`,
    )
    .bind(runId, RUN_STATUSES.failed, finishedAt, errorSummary, RUN_STATUSES.running)
    .run();
}

export function assertKnownRun(run: QualityRunRecord | null, runId: string): asserts run is QualityRunRecord {
  if (run === null) {
    throw new HttpError(404, "run_not_found", "Run does not exist.", { run_id: runId });
  }
}
