import {
  findLanguageById,
  findThresholdByValue,
  getExpectedRowCount,
  isEntryActiveOnDate,
} from "./config-registry";
import { assertKnownRun, expireRun, failRun, readRun } from "./database";
import { HttpError } from "./http";
import { assertPublicRange, assertUtcDate, assertUtcTimestamp, extendLease, getCurrentUtcDate } from "./time";
import {
  RUN_STATUSES,
  type FinalizeQualityRunRequest,
  type QualityRunRecord,
  type RequestContext,
} from "./types";

const REPLACED_ATTEMPT_EXPIRY_SUMMARY =
  "Lease expired before a replacement attempt acquired the date.";
const HEARTBEAT_EXPIRY_SUMMARY = "Lease expired before the collector renewed the run.";
const FINALIZATION_EXPIRY_SUMMARY = "Lease expired before the collector finalized the run.";
const COMPLETION_FAILURE_SUMMARY = "Collector finalized the run as failed.";
const PUBLICATION_EXISTS_SUMMARY = "A publication already exists for observed_date.";

function asBadRequest(code: string, operation: () => string): string {
  try {
    return operation();
  } catch (error) {
    throw new HttpError(400, code, error instanceof Error ? error.message : "Invalid request.");
  }
}

function asPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new HttpError(400, `invalid_${fieldName}`, `${fieldName} must be a positive integer.`);
  }

  return value as number;
}

function asOptionalErrorSummary(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(
      400,
      "invalid_error_summary",
      "error_summary must be a non-empty string when provided.",
    );
  }

  return value.trim();
}

function isLeaseExpired(run: QualityRunRecord, nowIso: string): boolean {
  return run.lease_expires_at <= nowIso;
}

async function readPublicationByObservedDate(
  database: Pick<D1Database, "prepare">,
  observedDate: string,
): Promise<{ observed_date: string; run_id: string; published_at: string } | null> {
  return database
    .prepare(
      `SELECT observed_date, run_id, published_at
      FROM quality_30d_publications
      WHERE observed_date = ?1`,
    )
    .bind(observedDate)
    .first<{ observed_date: string; run_id: string; published_at: string }>();
}

async function readPublicationByRunId(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<{ observed_date: string; run_id: string; published_at: string } | null> {
  return database
    .prepare(
      `SELECT observed_date, run_id, published_at
      FROM quality_30d_publications
      WHERE run_id = ?1`,
    )
    .bind(runId)
    .first<{ observed_date: string; run_id: string; published_at: string }>();
}

async function readRunningAttemptForObservedDate(
  database: Pick<D1Database, "prepare">,
  observedDate: string,
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
      WHERE observed_date = ?1 AND status = ?2
      ORDER BY attempt_no DESC
      LIMIT 1`,
    )
    .bind(observedDate, RUN_STATUSES.running)
    .first<QualityRunRecord>();
}

async function readActualRowCount(
  database: Pick<D1Database, "prepare">,
  runId: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS actual_rows
      FROM quality_30d_run_rows
      WHERE run_id = ?1`,
    )
    .bind(runId)
    .first<{ actual_rows: number }>();

  return row?.actual_rows ?? 0;
}

async function syncActualRowCount(
  database: Pick<D1Database, "prepare">,
  runId: string,
  nowIso: string,
): Promise<number> {
  const actualRows = await readActualRowCount(database, runId);
  await database
    .prepare(
      `UPDATE quality_30d_runs
      SET actual_rows = ?2
      WHERE run_id = ?1
        AND status = ?3
        AND lease_expires_at > ?4`,
    )
    .bind(runId, actualRows, RUN_STATUSES.running, nowIso)
    .run();

  return actualRows;
}

function validateCreatePayload(
  context: RequestContext,
  payload: Record<string, unknown>,
): { observedDate: string; expectedRows: number } {
  const observedDate = asBadRequest("invalid_observed_date", () =>
    assertUtcDate(payload.observed_date, "observed_date"),
  );
  const expectedRows = asPositiveInteger(payload.expected_rows, "expected_rows");

  if (observedDate < context.runtime.registry.launch_date) {
    throw new HttpError(
      409,
      "observed_date_before_launch",
      "Runs can only be created on or after launch_date.",
      { observed_date: observedDate, launch_date: context.runtime.registry.launch_date },
    );
  }

  const currentUtcDate = getCurrentUtcDate(context.runtime.now());
  if (observedDate !== currentUtcDate) {
    throw new HttpError(
      409,
      "observed_date_not_current_utc_date",
      "Runs can only be created for the current UTC date.",
      { observed_date: observedDate, current_utc_date: currentUtcDate },
    );
  }

  const expectedFromRegistry = getExpectedRowCount(context.runtime.registry, observedDate);
  if (expectedFromRegistry === 0) {
    throw new HttpError(
      409,
      "no_active_dimensions",
      "The registry has no active language-threshold combinations for observed_date.",
      { observed_date: observedDate },
    );
  }

  if (expectedRows !== expectedFromRegistry) {
    throw new HttpError(
      409,
      "expected_rows_mismatch",
      "expected_rows must match the active language-threshold product for observed_date.",
      {
        observed_date: observedDate,
        expected_rows: expectedRows,
        registry_expected_rows: expectedFromRegistry,
      },
    );
  }

  return { observedDate, expectedRows };
}

// D1 limits a single prepared statement to 100 bind parameters. The batch handler
// emits one INSERT per row (7 binds: 5 business columns plus the two-parameter
// lease guard in `WHERE EXISTS` — runId repeated for status/nowIso) plus a
// trailing actual_rows sync, so the absolute ceiling is driven by row count,
// not per-row bind width.
export const MAX_BATCH_ROWS = 500;

function validateFinalizePayload(payload: Record<string, unknown>): FinalizeQualityRunRequest {
  if (payload.status !== RUN_STATUSES.complete && payload.status !== RUN_STATUSES.failed) {
    throw new HttpError(
      400,
      "invalid_finalize_status",
      "status must be either complete or failed.",
    );
  }

  return {
    status: payload.status,
    error_summary: asOptionalErrorSummary(payload.error_summary),
  };
}

export async function createQualityRun(
  context: RequestContext,
  payload: Record<string, unknown>,
): Promise<QualityRunRecord> {
  const { observedDate, expectedRows } = validateCreatePayload(context, payload);
  const now = context.runtime.now();
  const nowIso = now.toISOString();
  const leaseExpiresAt = extendLease(now, context.runtime.runLeaseDurationSeconds);
  const runId = context.runtime.randomUUID();
  const database = context.env.DB;

  await database.batch([
    database
      .prepare(
        `UPDATE quality_30d_runs
        SET
          status = ?2,
          finished_at = COALESCE(finished_at, ?3),
          error_summary = COALESCE(error_summary, ?4)
        WHERE observed_date = ?1
          AND status = ?5
          AND lease_expires_at <= ?6`,
      )
      .bind(
        observedDate,
        RUN_STATUSES.expired,
        nowIso,
        REPLACED_ATTEMPT_EXPIRY_SUMMARY,
        RUN_STATUSES.running,
        nowIso,
      ),
    database
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
        )
        SELECT
          ?1,
          ?2,
          COALESCE((SELECT MAX(attempt_no) + 1 FROM quality_30d_runs WHERE observed_date = ?2), 1),
          ?3,
          ?4,
          ?5,
          ?3,
          ?6,
          0,
          NULL,
          ?3,
          NULL
        WHERE NOT EXISTS (
          SELECT 1
          FROM quality_30d_publications
          WHERE observed_date = ?2
        )
          AND NOT EXISTS (
            SELECT 1
            FROM quality_30d_runs
            WHERE observed_date = ?2 AND status = ?4
          )`,
      )
      .bind(
        runId,
        observedDate,
        nowIso,
        RUN_STATUSES.running,
        leaseExpiresAt,
        expectedRows,
      ),
  ]);

  const createdRun = await readRun(database, runId);
  if (createdRun !== null) {
    return createdRun;
  }

  const existingPublication = await readPublicationByObservedDate(database, observedDate);
  if (existingPublication !== null) {
    throw new HttpError(
      409,
      "publication_exists",
      "A publication already exists for observed_date.",
      { observed_date: observedDate, run_id: existingPublication.run_id },
    );
  }

  const runningAttempt = await readRunningAttemptForObservedDate(database, observedDate);
  if (runningAttempt !== null) {
    throw new HttpError(
      409,
      "run_in_progress",
      "A running attempt already holds the lease for observed_date.",
      { observed_date: observedDate, run_id: runningAttempt.run_id },
    );
  }

  throw new HttpError(500, "run_creation_failed", "The run could not be created.");
}

export async function heartbeatQualityRun(
  context: RequestContext,
  runId: string,
): Promise<QualityRunRecord> {
  const now = context.runtime.now();
  const nowIso = now.toISOString();
  const leaseExpiresAt = extendLease(now, context.runtime.runLeaseDurationSeconds);
  const database = context.env.DB;

  await database
    .prepare(
      `UPDATE quality_30d_runs
      SET
        lease_expires_at = ?2,
        last_heartbeat_at = ?3
      WHERE run_id = ?1
        AND status = ?4
        AND lease_expires_at > ?5`,
    )
    .bind(runId, leaseExpiresAt, nowIso, RUN_STATUSES.running, nowIso)
    .run();

  const updatedRun = await readRun(database, runId);
  assertKnownRun(updatedRun, runId);

  if (
    updatedRun.status === RUN_STATUSES.running &&
    updatedRun.lease_expires_at === leaseExpiresAt &&
    updatedRun.last_heartbeat_at === nowIso
  ) {
    return updatedRun;
  }

  if (updatedRun.status !== RUN_STATUSES.running) {
    throw new HttpError(409, "run_not_running", "Only running attempts can receive heartbeats.", {
      run_id: runId,
      status: updatedRun.status,
    });
  }

  if (isLeaseExpired(updatedRun, nowIso)) {
    await expireRun(database, runId, nowIso, HEARTBEAT_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before the heartbeat arrived.",
      { run_id: runId },
    );
  }

  return updatedRun;
}

interface ValidatedRowUpsert {
  languageId: string;
  thresholdValue: number;
  count: number;
  collectedAt: string;
}

// Each row is validated against the payload contract in isolation so the batch
// can be rejected up-front with the offending language_id/threshold_value — the
// D1 batch below has no per-row diagnostics.
function validateRowUpsertEntry(entry: unknown, index: number): ValidatedRowUpsert {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new HttpError(
      400,
      "invalid_row",
      `rows[${index}] must be a JSON object.`,
      { index },
    );
  }

  const raw = entry as Record<string, unknown>;
  const languageId = raw.language_id;
  if (typeof languageId !== "string" || languageId.trim() === "") {
    throw new HttpError(
      400,
      "invalid_language_id",
      `rows[${index}].language_id must be a non-empty string.`,
      { index },
    );
  }

  const thresholdValue = raw.threshold_value;
  if (!Number.isInteger(thresholdValue) || (thresholdValue as number) < 0) {
    throw new HttpError(
      400,
      "invalid_threshold_value",
      `rows[${index}].threshold_value must be a non-negative integer.`,
      { index, language_id: languageId },
    );
  }

  const count = raw.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new HttpError(
      400,
      "invalid_count",
      `rows[${index}].count must be a non-negative integer.`,
      { index, language_id: languageId, threshold_value: thresholdValue },
    );
  }

  let collectedAt: string;
  try {
    collectedAt = assertUtcTimestamp(raw.collected_at, `rows[${index}].collected_at`);
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_collected_at",
      error instanceof Error ? error.message : "Invalid collected_at.",
      { index, language_id: languageId, threshold_value: thresholdValue },
    );
  }

  return {
    languageId,
    thresholdValue: thresholdValue as number,
    count: count as number,
    collectedAt,
  };
}

export async function upsertQualityRunRows(
  context: RequestContext,
  runId: string,
  payload: Record<string, unknown>,
): Promise<QualityRunRecord> {
  const rawRows = payload.rows;
  if (!Array.isArray(rawRows)) {
    throw new HttpError(400, "invalid_rows", "rows must be a JSON array.");
  }

  if (rawRows.length === 0) {
    throw new HttpError(400, "empty_rows", "rows must not be empty.");
  }

  if (rawRows.length > MAX_BATCH_ROWS) {
    throw new HttpError(
      413,
      "batch_too_large",
      `rows must contain at most ${MAX_BATCH_ROWS} entries.`,
      { max_rows: MAX_BATCH_ROWS, received_rows: rawRows.length },
    );
  }

  const rows = rawRows.map((entry, index) => validateRowUpsertEntry(entry, index));
  const nowIso = context.runtime.now().toISOString();
  const database = context.env.DB;

  const existingRun = await readRun(database, runId);
  assertKnownRun(existingRun, runId);

  if (existingRun.status !== RUN_STATUSES.running) {
    throw new HttpError(409, "run_not_running", "Rows can only be written to running attempts.", {
      run_id: runId,
      status: existingRun.status,
    });
  }

  if (isLeaseExpired(existingRun, nowIso)) {
    await expireRun(database, runId, nowIso, HEARTBEAT_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before the row batch completed.",
      { run_id: runId },
    );
  }

  // Registry validation happens against the observed_date of the existing run.
  // Per-row failures abort the whole batch (batch semantics: no partial writes),
  // so the offending dimension is surfaced in the HttpError details.
  for (const row of rows) {
    const language = findLanguageById(context.runtime.registry, row.languageId);
    if (language === undefined) {
      throw new HttpError(400, "unknown_language", "language_id is not present in the registry.", {
        language_id: row.languageId,
      });
    }

    const threshold = findThresholdByValue(context.runtime.registry, row.thresholdValue);
    if (threshold === undefined) {
      throw new HttpError(
        400,
        "unknown_threshold",
        "threshold_value is not present in the registry.",
        { threshold_value: row.thresholdValue },
      );
    }

    if (!isEntryActiveOnDate(existingRun.observed_date, language.active_from, language.active_to)) {
      throw new HttpError(
        409,
        "language_inactive_for_observed_date",
        "language_id is not active for the run's observed_date.",
        { language_id: row.languageId, observed_date: existingRun.observed_date },
      );
    }

    if (!isEntryActiveOnDate(existingRun.observed_date, threshold.active_from, threshold.active_to)) {
      throw new HttpError(
        409,
        "threshold_inactive_for_observed_date",
        "threshold_value is not active for the run's observed_date.",
        { threshold_value: row.thresholdValue, observed_date: existingRun.observed_date },
      );
    }
  }

  // D1 caps a single prepared statement at 100 bind parameters, so the batch is
  // built as N separate INSERTs (7 binds each: 5 business columns plus 2 for
  // the `WHERE EXISTS` lease guard — status + nowIso) rather than one
  // multi-VALUES statement. database.batch([...]) still wraps the whole
  // sequence in a single transaction, preserving all-or-nothing semantics.
  const statements = rows.map((row) =>
    database
      .prepare(
        `INSERT INTO quality_30d_run_rows (
          run_id,
          language_id,
          threshold_value,
          count,
          collected_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1
          FROM quality_30d_runs
          WHERE run_id = ?1
            AND status = ?6
            AND lease_expires_at > ?7
        )
        ON CONFLICT(run_id, language_id, threshold_value)
        DO UPDATE SET
          count = excluded.count,
          collected_at = excluded.collected_at`,
      )
      .bind(
        runId,
        row.languageId,
        row.thresholdValue,
        row.count,
        row.collectedAt,
        RUN_STATUSES.running,
        nowIso,
      ),
  );

  statements.push(
    database
      .prepare(
        `UPDATE quality_30d_runs
        SET actual_rows = (
          SELECT COUNT(*)
          FROM quality_30d_run_rows
          WHERE run_id = ?1
        )
        WHERE run_id = ?1
          AND status = ?2
          AND lease_expires_at > ?3`,
      )
      .bind(runId, RUN_STATUSES.running, nowIso),
  );

  await database.batch(statements);

  const updatedRun = await readRun(database, runId);
  assertKnownRun(updatedRun, runId);

  if (updatedRun.status !== RUN_STATUSES.running) {
    throw new HttpError(409, "run_not_running", "Rows can only be written to running attempts.", {
      run_id: runId,
      status: updatedRun.status,
    });
  }

  if (isLeaseExpired(updatedRun, nowIso)) {
    await expireRun(database, runId, nowIso, HEARTBEAT_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before the row batch completed.",
      { run_id: runId },
    );
  }

  return updatedRun;
}

export async function finalizeQualityRun(
  context: RequestContext,
  runId: string,
  payload: Record<string, unknown>,
): Promise<{ run: QualityRunRecord; published_at: string | null }> {
  const finalizeRequest = validateFinalizePayload(payload);
  const nowIso = context.runtime.now().toISOString();
  const database = context.env.DB;

  const existingRun = await readRun(database, runId);
  assertKnownRun(existingRun, runId);

  if (existingRun.status === RUN_STATUSES.complete) {
    const publication = await readPublicationByRunId(database, runId);
    if (finalizeRequest.status !== RUN_STATUSES.complete || publication === null) {
      throw new HttpError(
        409,
        "run_already_complete",
        "The run is already complete and cannot change status.",
        { run_id: runId },
      );
    }

    return { run: existingRun, published_at: publication.published_at };
  }

  if (existingRun.status === RUN_STATUSES.failed) {
    if (finalizeRequest.status !== RUN_STATUSES.failed) {
      throw new HttpError(
        409,
        "run_already_failed",
        "The run is already failed and cannot change status.",
        { run_id: runId },
      );
    }

    return { run: existingRun, published_at: null };
  }

  if (existingRun.status === RUN_STATUSES.expired) {
    throw new HttpError(409, "run_expired", "The run lease has already expired.", {
      run_id: runId,
    });
  }

  if (isLeaseExpired(existingRun, nowIso)) {
    await expireRun(database, runId, nowIso, FINALIZATION_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before finalization completed.",
      { run_id: runId },
    );
  }

  const existingPublication = await readPublicationByObservedDate(database, existingRun.observed_date);
  if (existingPublication !== null) {
    await failRun(database, runId, nowIso, PUBLICATION_EXISTS_SUMMARY);
    throw new HttpError(
      409,
      "publication_exists",
      "A publication already exists for observed_date.",
      { observed_date: existingRun.observed_date, run_id: existingPublication.run_id },
    );
  }

  if (finalizeRequest.status === RUN_STATUSES.failed) {
    const errorSummary = finalizeRequest.error_summary ?? COMPLETION_FAILURE_SUMMARY;
    await database
      .prepare(
        `UPDATE quality_30d_runs
        SET
          status = ?2,
          finished_at = ?3,
          error_summary = ?4
        WHERE run_id = ?1 AND status = ?5`,
      )
      .bind(runId, RUN_STATUSES.failed, nowIso, errorSummary, RUN_STATUSES.running)
      .run();

    const failedRun = await readRun(database, runId);
    assertKnownRun(failedRun, runId);
    return { run: failedRun, published_at: null };
  }

  const actualRows = await syncActualRowCount(database, runId, nowIso);
  const refreshedRun = await readRun(database, runId);
  assertKnownRun(refreshedRun, runId);

  // Mirror the initial terminal-state handling above: between the first lease
  // check and the row-count sync, a concurrent finalizer may have completed or
  // failed the run, or an expireRun may have flipped status to "expired". Each
  // terminal state must be surfaced with its own semantics — collapsing them
  // into run_expired would misclassify a successful concurrent complete and
  // break finalize idempotency.
  if (refreshedRun.status === RUN_STATUSES.complete) {
    const publication = await readPublicationByRunId(database, runId);
    if (publication !== null) {
      return { run: refreshedRun, published_at: publication.published_at };
    }
  }

  if (refreshedRun.status === RUN_STATUSES.failed) {
    return { run: refreshedRun, published_at: null };
  }

  if (refreshedRun.status === RUN_STATUSES.expired) {
    throw new HttpError(409, "run_expired", "The run lease has already expired.", {
      run_id: runId,
    });
  }

  // Refresh the clock so the lease guard and the batch below compare against
  // the actual wall-clock: readActualRowCount may have taken real time, and
  // the captured nowIso from request entry could be stale enough to let the
  // batch publish after the logical lease deadline.
  const postSyncNowIso = context.runtime.now().toISOString();

  if (isLeaseExpired(refreshedRun, postSyncNowIso)) {
    await expireRun(database, runId, postSyncNowIso, FINALIZATION_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before finalization completed.",
      { run_id: runId },
    );
  }

  if (actualRows !== refreshedRun.expected_rows) {
    await database
      .prepare(
        `UPDATE quality_30d_runs
        SET
          status = ?2,
          actual_rows = ?3,
          finished_at = ?4,
          error_summary = ?5
        WHERE run_id = ?1 AND status = ?6`,
      )
      .bind(
        runId,
        RUN_STATUSES.failed,
        actualRows,
        postSyncNowIso,
        `Expected ${refreshedRun.expected_rows} rows but found ${actualRows}.`,
        RUN_STATUSES.running,
      )
      .run();

    throw new HttpError(
      409,
      "row_count_mismatch",
      "The run cannot be published until every expected row is present.",
      {
        run_id: runId,
        expected_rows: refreshedRun.expected_rows,
        actual_rows: actualRows,
      },
    );
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO quality_30d_publications (
          observed_date,
          run_id,
          published_at
        )
        SELECT observed_date, run_id, ?2
        FROM quality_30d_runs
        WHERE run_id = ?1
          AND status = ?3
          AND actual_rows = expected_rows
          AND lease_expires_at > ?2
          AND NOT EXISTS (
            SELECT 1
            FROM quality_30d_publications
            WHERE observed_date = quality_30d_runs.observed_date
          )`,
      )
      .bind(runId, postSyncNowIso, RUN_STATUSES.running),
    database
      .prepare(
        `UPDATE quality_30d_runs
        SET
          status = ?2,
          finished_at = ?3,
          error_summary = NULL
        WHERE run_id = ?1
          AND EXISTS (
            SELECT 1
            FROM quality_30d_publications
            WHERE run_id = ?1
          )`,
      )
      .bind(runId, RUN_STATUSES.complete, postSyncNowIso),
  ]);

  const publication = await readPublicationByRunId(database, runId);
  const completedRun = await readRun(database, runId);
  assertKnownRun(completedRun, runId);

  if (publication !== null && completedRun.status === RUN_STATUSES.complete) {
    return { run: completedRun, published_at: publication.published_at };
  }

  const publicationAfterAttempt = await readPublicationByObservedDate(
    database,
    completedRun.observed_date,
  );
  if (publicationAfterAttempt !== null && publicationAfterAttempt.run_id !== runId) {
    await failRun(database, runId, postSyncNowIso, PUBLICATION_EXISTS_SUMMARY);
    throw new HttpError(
      409,
      "publication_exists",
      "A publication already exists for observed_date.",
      { observed_date: completedRun.observed_date, run_id: publicationAfterAttempt.run_id },
    );
  }

  if (completedRun.status === RUN_STATUSES.running && isLeaseExpired(completedRun, postSyncNowIso)) {
    await expireRun(database, runId, postSyncNowIso, FINALIZATION_EXPIRY_SUMMARY);
    throw new HttpError(
      409,
      "run_expired",
      "The run lease expired before finalization completed.",
      { run_id: runId },
    );
  }

  throw new HttpError(500, "run_finalize_failed", "The run could not be finalized.");
}

export function validatePublicDateRange(
  launchDate: string,
  fromValue: string,
  toValue: string,
): { from: string; to: string; queryFrom: string } {
  const from = asBadRequest("invalid_from", () => assertUtcDate(fromValue, "from"));
  const to = asBadRequest("invalid_to", () => assertUtcDate(toValue, "to"));

  try {
    assertPublicRange(from, to);
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_date_range",
      error instanceof Error ? error.message : "Invalid date range.",
    );
  }

  return {
    from,
    to,
    queryFrom: from < launchDate ? launchDate : from,
  };
}
