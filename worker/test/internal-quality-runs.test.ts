import { beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  dispatch,
  getRun,
  insertRun,
  makeInternalRequest,
  readJson,
  resetDatabase,
  TEST_BASE_URL,
  TEST_NOW,
  TEST_OBSERVED_DATE,
} from "./helpers";

function expectRunEnvelope(body: { run: Record<string, unknown> } & Record<string, unknown>): void {
  expect(Object.keys(body)).toEqual(["run"]);
  expect(body).not.toHaveProperty("run_id");
  expect(body).not.toHaveProperty("attempt_no");
  expect(body).not.toHaveProperty("status");
  expect(body).not.toHaveProperty("lease_expires_at");
  expect(body).not.toHaveProperty("actual_rows");
  expect(body).not.toHaveProperty("error_summary");
}

function expectFinalizedRunEnvelope(
  body: { run: Record<string, unknown>; published_at: string | null } & Record<string, unknown>,
): void {
  expect(Object.keys(body).sort()).toEqual(["published_at", "run"]);
  expect(body).not.toHaveProperty("run_id");
  expect(body).not.toHaveProperty("attempt_no");
  expect(body).not.toHaveProperty("status");
  expect(body).not.toHaveProperty("error_summary");
}

describe("internal quality run routes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("requires service authentication for ingest routes", async () => {
    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      new Request(`${TEST_BASE_URL}/internal/quality-runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          observed_date: TEST_OBSERVED_DATE,
          expected_rows: 4,
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("expires stale runs before assigning the next attempt number", async () => {
    await insertRun({
      run_id: "stale-run",
      lease_expires_at: "2026-04-07T11:55:00.000Z",
      last_heartbeat_at: "2026-04-07T11:50:00.000Z",
    });

    const harness = createHarness();
    const response = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    const body = await readJson<
      { run: { run_id: string; attempt_no: number } } & Record<string, unknown>
    >(response);

    expect(response.status).toBe(201);
    expectRunEnvelope(body);
    expect(body.run.run_id).toBe("run-1");
    expect(body.run.attempt_no).toBe(2);

    const staleRun = await getRun("stale-run");
    expect(staleRun?.status).toBe("expired");
  });

  it("renews leases through heartbeat while the run is still valid", async () => {
    const harness = createHarness();
    const createResponse = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    const createdRun = await readJson<{ run: { run_id: string } } & Record<string, unknown>>(
      createResponse,
    );
    expectRunEnvelope(createdRun);

    harness.setNow("2026-04-07T12:03:00.000Z");
    const heartbeatResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/heartbeat`,
        "POST",
      ),
    );
    const heartbeatBody = await readJson<
      { run: { lease_expires_at: string } } & Record<string, unknown>
    >(heartbeatResponse);

    expect(heartbeatResponse.status).toBe(200);
    expectRunEnvelope(heartbeatBody);
    expect(heartbeatBody.run.lease_expires_at).toBe("2026-04-07T12:08:00.000Z");
  });

  it("keeps finalization idempotent and blocks new attempts after publication", async () => {
    const harness = createHarness();
    const createResponse = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    const createdRun = await readJson<{ run: { run_id: string } } & Record<string, unknown>>(
      createResponse,
    );
    expectRunEnvelope(createdRun);

    const batchResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/rows:batch`,
        "POST",
        {
          rows: [
            { language_id: "go", threshold_value: 0, count: 100, collected_at: TEST_NOW },
            { language_id: "go", threshold_value: 10, count: 80, collected_at: TEST_NOW },
            { language_id: "rust", threshold_value: 0, count: 70, collected_at: TEST_NOW },
            { language_id: "rust", threshold_value: 10, count: 60, collected_at: TEST_NOW },
          ],
        },
      ),
    );
    expect(batchResponse.status).toBe(200);

    const finalizeResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/finalize`,
        "POST",
        { status: "complete" },
      ),
    );
    const repeatedFinalizeResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/finalize`,
        "POST",
        { status: "complete" },
      ),
    );

    expect(finalizeResponse.status).toBe(200);
    expect(repeatedFinalizeResponse.status).toBe(200);

    const finalizeBody = await readJson<
      { published_at: string; run: { status: string } } & Record<string, unknown>
    >(finalizeResponse);
    const repeatedFinalizeBody = await readJson<
      { published_at: string; run: { status: string } } & Record<string, unknown>
    >(repeatedFinalizeResponse);
    expectFinalizedRunEnvelope(finalizeBody);
    expectFinalizedRunEnvelope(repeatedFinalizeBody);
    expect(finalizeBody.run.status).toBe("complete");
    expect(repeatedFinalizeBody.published_at).toBe(finalizeBody.published_at);

    const createAfterPublication = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    expect(createAfterPublication.status).toBe(409);
  });

  it("marks incomplete runs failed during successful-finalize attempts", async () => {
    const harness = createHarness();
    const createResponse = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    const createdRun = await readJson<{ run: { run_id: string } } & Record<string, unknown>>(
      createResponse,
    );
    expectRunEnvelope(createdRun);

    const rowResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/rows:batch`,
        "POST",
        {
          rows: [
            { language_id: "go", threshold_value: 0, count: 20, collected_at: TEST_NOW },
          ],
        },
      ),
    );
    expect(rowResponse.status).toBe(200);

    const finalizeResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/finalize`,
        "POST",
        { status: "complete" },
      ),
    );
    expect(finalizeResponse.status).toBe(409);

    const storedRun = await getRun(createdRun.run.run_id);
    expect(storedRun?.status).toBe("failed");
    expect(storedRun?.actual_rows).toBe(1);
  });

  it("allows explicit failed finalization with a diagnostic summary", async () => {
    const harness = createHarness();
    const createResponse = await dispatch(
      harness.app,
      makeInternalRequest("/internal/quality-runs", "POST", {
        observed_date: TEST_OBSERVED_DATE,
        expected_rows: 4,
      }),
    );
    const createdRun = await readJson<{ run: { run_id: string } } & Record<string, unknown>>(
      createResponse,
    );
    expectRunEnvelope(createdRun);

    const finalizeResponse = await dispatch(
      harness.app,
      makeInternalRequest(
        `/internal/quality-runs/${createdRun.run.run_id}/finalize`,
        "POST",
        {
          status: "failed",
          error_summary: "GitHub Search returned incomplete_results=true.",
        },
      ),
    );
    expect(finalizeResponse.status).toBe(200);

    const finalizeBody = await readJson<
      { run: { status: string; error_summary: string }; published_at: null } & Record<string, unknown>
    >(finalizeResponse);
    expectFinalizedRunEnvelope(finalizeBody);
    expect(finalizeBody.run.status).toBe("failed");
    expect(finalizeBody.run.error_summary).toContain("incomplete_results");
    expect(finalizeBody.published_at).toBeNull();
  });
});
