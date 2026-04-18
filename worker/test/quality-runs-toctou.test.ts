import { describe, expect, it } from "vitest";
import { metricsRegistry } from "../src/config-registry";
import { finalizeQualityRun } from "../src/quality-runs";
import type { RequestContext, WorkerEnv } from "../src/types";
import { TEST_NOW, TEST_OBSERVED_DATE } from "./helpers";

interface PostSyncState {
  status: "running" | "complete" | "failed" | "expired";
  errorSummary: string | null;
  publication: { run_id: string; observed_date: string; published_at: string } | null;
  expectedRows?: number;
  actualRows?: number;
}

// Simulates concurrent DB mutations between the initial readRun (status=running,
// lease valid) and the post-syncActualRowCount readRun. Each terminal state must
// be surfaced with its own semantics; collapsing them all into run_expired would
// misclassify a successful concurrent complete and break finalize idempotency.
function makeContext(postSync: PostSyncState): RequestContext {
  let runReadCount = 0;
  const expectedRows = postSync.expectedRows ?? 3;
  const actualRows = postSync.actualRows ?? 0;

  return {
    env: {
      DB: {
        batch: async () => [],
        prepare(sql: string) {
          return {
            bind() {
              if (sql.includes("COUNT(*) AS actual_rows")) {
                return { first: async () => ({ actual_rows: actualRows }) };
              }
              if (sql.includes("WHERE run_id = ?1") && sql.includes("FROM quality_30d_runs")) {
                runReadCount += 1;
                const firstRead = runReadCount === 1;
                return {
                  first: async () => ({
                    run_id: "toctou-run",
                    observed_date: TEST_OBSERVED_DATE,
                    attempt_no: 1,
                    observed_at: TEST_NOW,
                    status: firstRead ? "running" : postSync.status,
                    lease_expires_at: "2026-04-07T12:05:00.000Z",
                    last_heartbeat_at: TEST_NOW,
                    expected_rows: expectedRows,
                    actual_rows: firstRead ? 0 : actualRows,
                    error_summary: firstRead ? null : postSync.errorSummary,
                    started_at: TEST_NOW,
                    finished_at: firstRead ? null : TEST_NOW,
                  }),
                  run: async () => ({ success: true }),
                };
              }
              if (sql.includes("FROM quality_30d_publications") && sql.includes("run_id = ?1")) {
                return { first: async () => postSync.publication };
              }
              if (sql.includes("FROM quality_30d_publications")) {
                return { first: async () => null };
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
    runtime: {
      registry: metricsRegistry,
      now: () => new Date(TEST_NOW),
      randomUUID: () => "toctou-run",
      runLeaseDurationSeconds: 300,
    },
  } satisfies RequestContext;
}

describe("finalizeQualityRun post-sync terminal transitions", () => {
  it("reports run_expired when a concurrent expireRun flips status between the lease check and the row-count sync", async () => {
    const context = makeContext({
      status: "expired",
      errorSummary: "concurrent expire",
      publication: null,
    });

    await expect(
      finalizeQualityRun(context, "toctou-run", { status: "complete" }),
    ).rejects.toMatchObject({ code: "run_expired" });
  });

  it("returns the existing publication idempotently when a concurrent finalize completes the run first", async () => {
    const publishedAt = "2026-04-07T12:03:30.000Z";
    const context = makeContext({
      status: "complete",
      errorSummary: null,
      publication: {
        run_id: "toctou-run",
        observed_date: TEST_OBSERVED_DATE,
        published_at: publishedAt,
      },
      expectedRows: 3,
      actualRows: 3,
    });

    const result = await finalizeQualityRun(context, "toctou-run", { status: "complete" });

    expect(result.published_at).toBe(publishedAt);
    expect(result.run.status).toBe("complete");
  });

  it("returns the failed run without error when a concurrent finalize marks it failed first", async () => {
    const context = makeContext({
      status: "failed",
      errorSummary: "concurrent failure",
      publication: null,
    });

    const result = await finalizeQualityRun(context, "toctou-run", { status: "complete" });

    expect(result.published_at).toBeNull();
    expect(result.run.status).toBe("failed");
  });
});
