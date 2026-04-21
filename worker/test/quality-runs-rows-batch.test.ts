import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BATCH_ROWS } from "../src/quality-runs";
import {
  createHarness,
  dispatch,
  getRow,
  getRun,
  insertRun,
  makeInternalRequest,
  readJson,
  resetDatabase,
  TEST_NOW,
  TEST_OBSERVED_DATE,
} from "./helpers";

interface RowInput {
  language_id: string;
  threshold_value: number;
  count: number;
  collected_at: string;
}

interface QualityRunBody {
  run: {
    run_id: string;
    actual_rows: number;
    status: string;
    expected_rows: number;
  };
}

async function createRunningRun(harness: ReturnType<typeof createHarness>): Promise<string> {
  const response = await dispatch(
    harness.app,
    makeInternalRequest("/internal/quality-runs", "POST", {
      observed_date: TEST_OBSERVED_DATE,
      expected_rows: 4,
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as QualityRunBody;
  return body.run.run_id;
}

async function postBatch(
  harness: ReturnType<typeof createHarness>,
  runId: string,
  rows: RowInput[],
): Promise<Response> {
  return dispatch(
    harness.app,
    makeInternalRequest(`/internal/quality-runs/${runId}/rows:batch`, "POST", { rows }),
  );
}

describe("internal quality runs rows:batch", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("writes every row in a single batch and syncs actual_rows", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const rows: RowInput[] = [
      { language_id: "go", threshold_value: 0, count: 120, collected_at: TEST_NOW },
      { language_id: "go", threshold_value: 10, count: 45, collected_at: TEST_NOW },
      { language_id: "rust", threshold_value: 0, count: 77, collected_at: TEST_NOW },
      { language_id: "rust", threshold_value: 10, count: 31, collected_at: TEST_NOW },
    ];

    const response = await postBatch(harness, runId, rows);
    expect(response.status).toBe(200);

    const body = await readJson<QualityRunBody>(response);
    expect(body.run.actual_rows).toBe(rows.length);
    expect(body.run.status).toBe("running");

    for (const row of rows) {
      const stored = await getRow(runId, row.language_id, row.threshold_value);
      expect(stored).toEqual({ count: row.count, collected_at: row.collected_at });
    }

    const persisted = await getRun(runId);
    expect(persisted?.actual_rows).toBe(rows.length);
  });

  it("treats upserts as idempotent without inflating actual_rows", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    await postBatch(harness, runId, [
      { language_id: "go", threshold_value: 0, count: 12, collected_at: TEST_NOW },
    ]);
    const second = await postBatch(harness, runId, [
      {
        language_id: "go",
        threshold_value: 0,
        count: 18,
        collected_at: "2026-04-07T12:01:00.000Z",
      },
    ]);
    expect(second.status).toBe(200);

    const body = await readJson<QualityRunBody>(second);
    expect(body.run.actual_rows).toBe(1);

    const stored = await getRow(runId, "go", 0);
    expect(stored).toEqual({ count: 18, collected_at: "2026-04-07T12:01:00.000Z" });
  });

  it("rejects writes once the lease has expired and marks the run expired", async () => {
    await insertRun({
      run_id: "expired-batch",
      lease_expires_at: "2026-04-07T11:59:00.000Z",
      last_heartbeat_at: "2026-04-07T11:50:00.000Z",
    });

    const harness = createHarness();
    const response = await postBatch(harness, "expired-batch", [
      { language_id: "go", threshold_value: 0, count: 1, collected_at: TEST_NOW },
    ]);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("run_expired");

    const run = await getRun("expired-batch");
    expect(run?.status).toBe("expired");
  });

  it("rejects unknown languages with the offending language_id in the details", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await postBatch(harness, runId, [
      { language_id: "go", threshold_value: 0, count: 1, collected_at: TEST_NOW },
      { language_id: "fantasy", threshold_value: 0, count: 2, collected_at: TEST_NOW },
    ]);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { language_id: string } };
    };
    expect(body.error.code).toBe("unknown_language");
    expect(body.error.details.language_id).toBe("fantasy");

    // Batch semantics: nothing from the payload persists when validation fails.
    const survivor = await getRow(runId, "go", 0);
    expect(survivor).toBeNull();
  });

  it("rejects unknown thresholds with the offending threshold_value in the details", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await postBatch(harness, runId, [
      { language_id: "go", threshold_value: 999, count: 1, collected_at: TEST_NOW },
    ]);

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { threshold_value: number } };
    };
    expect(body.error.code).toBe("unknown_threshold");
    expect(body.error.details.threshold_value).toBe(999);
  });

  it("rejects languages inactive for observed_date", async () => {
    // Ruby is registered but its active_to precedes the test observed_date.
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await postBatch(harness, runId, [
      { language_id: "ruby", threshold_value: 0, count: 1, collected_at: TEST_NOW },
    ]);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("language_inactive_for_observed_date");
  });

  it("rejects thresholds inactive for observed_date", async () => {
    // Threshold 50 is registered but its active_to precedes the test observed_date.
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await postBatch(harness, runId, [
      { language_id: "go", threshold_value: 50, count: 1, collected_at: TEST_NOW },
    ]);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("threshold_inactive_for_observed_date");
  });

  it("rejects empty rows arrays to prevent contract drift", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await postBatch(harness, runId, []);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_rows");
  });

  it("rejects rows arrays exceeding MAX_BATCH_ROWS with 413", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const oversized: RowInput[] = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, index) => ({
      language_id: "go",
      threshold_value: index,
      count: index,
      collected_at: TEST_NOW,
    }));

    const response = await postBatch(harness, runId, oversized);
    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: { code: string; details: { max_rows: number; received_rows: number } };
    };
    expect(body.error.code).toBe("batch_too_large");
    expect(body.error.details.max_rows).toBe(MAX_BATCH_ROWS);
    expect(body.error.details.received_rows).toBe(MAX_BATCH_ROWS + 1);
  });

  it("requires a JSON array for rows", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await dispatch(
      harness.app,
      makeInternalRequest(`/internal/quality-runs/${runId}/rows:batch`, "POST", {
        rows: "not-an-array",
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_rows");
  });

  it("requires bearer authentication", async () => {
    const harness = createHarness();
    const runId = await createRunningRun(harness);

    const response = await dispatch(
      harness.app,
      new Request(`https://langpulse.test/internal/quality-runs/${runId}/rows:batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{ language_id: "go", threshold_value: 0, count: 1, collected_at: TEST_NOW }],
        }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
