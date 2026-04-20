import { metricsRegistry } from "./config-registry";
import { DEFAULT_RUN_LEASE_DURATION_SECONDS, NO_STORE_CACHE_CONTROL } from "./constants";
import { errorResponse, HttpError, jsonResponse } from "./http";
import { checkDatabaseHealth } from "./public-quality";
import { handleQualityRunsCreate } from "./routes/internal/quality-runs-create";
import { handleQualityRunsFinalize } from "./routes/internal/quality-runs-finalize";
import { handleQualityRunsHeartbeat } from "./routes/internal/quality-runs-heartbeat";
import { handleQualityRunsRowUpsert } from "./routes/internal/quality-runs-row-upsert";
import { handleMetadata } from "./routes/metadata";
import { handleQualityLatest } from "./routes/quality";
import { handleQualityCompare } from "./routes/quality-compare";
import { handleQualitySnapshot } from "./routes/quality-snapshot";
import { parseLeaseDurationSeconds } from "./time";
import type { RequestContext, RuntimeDependencies, WorkerEnv } from "./types";

const INTERNAL_HEARTBEAT_PATH = /^\/internal\/quality-runs\/([^/]+)\/heartbeat$/;
const INTERNAL_ROW_UPSERT_PATH =
  /^\/internal\/quality-runs\/([^/]+)\/rows\/([^/]+)\/([^/]+)$/;
const INTERNAL_FINALIZE_PATH = /^\/internal\/quality-runs\/([^/]+)\/finalize$/;

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_path_segment", "Path parameters must be URL encoded.");
  }
}

function buildRequestContext(env: WorkerEnv, runtime: RuntimeDependencies): RequestContext {
  return {
    env,
    runtime: {
      ...runtime,
      runLeaseDurationSeconds: parseLeaseDurationSeconds(env.RUN_LEASE_DURATION_SECONDS),
    },
  };
}

function assertMethod(request: Request, expected: string, route: string): void {
  if (request.method !== expected) {
    throw new HttpError(405, "method_not_allowed", `Expected ${expected} for ${route}.`);
  }
}

function maybeHandleInternalCreate(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  if (pathname !== "/internal/quality-runs") {
    return null;
  }

  assertMethod(request, "POST", "/internal/quality-runs");
  return handleQualityRunsCreate(request, context);
}

function maybeHandleInternalHeartbeat(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  const heartbeatMatch = pathname.match(INTERNAL_HEARTBEAT_PATH);
  if (heartbeatMatch === null) {
    return null;
  }

  assertMethod(request, "POST", "/internal/quality-runs/{run_id}/heartbeat");
  // Capture groups are guaranteed by INTERNAL_HEARTBEAT_PATH on a non-null match.
  return handleQualityRunsHeartbeat(request, context, decodePathSegment(heartbeatMatch[1]!));
}

function maybeHandleInternalRowUpsert(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  const rowUpsertMatch = pathname.match(INTERNAL_ROW_UPSERT_PATH);
  if (rowUpsertMatch === null) {
    return null;
  }

  assertMethod(request, "PUT", "/internal/quality-runs/{run_id}/rows/{language_id}/{threshold_value}");
  // Capture groups are guaranteed by INTERNAL_ROW_UPSERT_PATH on a non-null match.
  return handleQualityRunsRowUpsert(
    request,
    context,
    decodePathSegment(rowUpsertMatch[1]!),
    decodePathSegment(rowUpsertMatch[2]!),
    decodePathSegment(rowUpsertMatch[3]!),
  );
}

function maybeHandleInternalFinalize(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  const finalizeMatch = pathname.match(INTERNAL_FINALIZE_PATH);
  if (finalizeMatch === null) {
    return null;
  }

  assertMethod(request, "POST", "/internal/quality-runs/{run_id}/finalize");
  // Capture group is guaranteed by INTERNAL_FINALIZE_PATH on a non-null match.
  return handleQualityRunsFinalize(request, context, decodePathSegment(finalizeMatch[1]!));
}

function maybeHandleMetadata(
  pathname: string,
  request: Request,
  context: RequestContext,
): Response | Promise<Response> | null {
  if (pathname !== "/api/metadata") {
    return null;
  }

  assertMethod(request, "GET", "/api/metadata");
  return handleMetadata(context);
}

function maybeHandleQualityLatest(
  pathname: string,
  request: Request,
  context: RequestContext,
): Response | Promise<Response> | null {
  if (pathname !== "/api/quality/latest") {
    return null;
  }

  assertMethod(request, "GET", "/api/quality/latest");
  return handleQualityLatest(context);
}

function maybeHandleQualitySnapshot(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  if (pathname !== "/api/quality/snapshot") {
    return null;
  }

  assertMethod(request, "GET", "/api/quality/snapshot");
  return handleQualitySnapshot(request, context);
}

function maybeHandleQualityCompare(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  if (pathname !== "/api/quality/compare") {
    return null;
  }

  assertMethod(request, "GET", "/api/quality/compare");
  return handleQualityCompare(request, context);
}

async function createHealthResponse(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  // cf-connecting-ip is absent in local/test runs; fall back to a shared bucket
  // so abuse is still bounded there.
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const outcome = await context.env.HEALTH_RATE_LIMITER.limit({ key: clientIp });
  if (!outcome.success) {
    throw new HttpError(429, "rate_limited", "Too many health checks.");
  }

  const ok = await checkDatabaseHealth(context);
  return jsonResponse(
    { ok },
    {
      headers: {
        "Cache-Control": NO_STORE_CACHE_CONTROL,
      },
    },
  );
}

function maybeHandleHealth(
  pathname: string,
  request: Request,
  context: RequestContext,
): Promise<Response> | null {
  if (pathname !== "/api/health") {
    return null;
  }

  assertMethod(request, "GET", "/api/health");
  return createHealthResponse(request, context);
}

export function createWorker(
  overrides: Partial<RuntimeDependencies> = {},
): ExportedHandler<WorkerEnv> {
  const runtime: RuntimeDependencies = {
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    registry: overrides.registry ?? metricsRegistry,
    runLeaseDurationSeconds: overrides.runLeaseDurationSeconds ?? DEFAULT_RUN_LEASE_DURATION_SECONDS,
  };

  return {
    async fetch(request, env): Promise<Response> {
      try {
        const context = buildRequestContext(env, runtime);
        return await routeRequest(request, context);
      } catch (error) {
        if (error instanceof HttpError) {
          return errorResponse(error);
        }

        console.error(error);
        return errorResponse(
          new HttpError(500, "internal_error", "The worker could not process the request."),
        );
      }
    },
  };
}

async function routeRequest(request: Request, context: RequestContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const routedResponse =
    maybeHandleInternalCreate(pathname, request, context) ??
    maybeHandleInternalHeartbeat(pathname, request, context) ??
    maybeHandleInternalRowUpsert(pathname, request, context) ??
    maybeHandleInternalFinalize(pathname, request, context) ??
    maybeHandleMetadata(pathname, request, context) ??
    maybeHandleQualityLatest(pathname, request, context) ??
    maybeHandleQualitySnapshot(pathname, request, context) ??
    maybeHandleQualityCompare(pathname, request, context) ??
    maybeHandleHealth(pathname, request, context);

  if (routedResponse !== null) {
    return await routedResponse;
  }

  throw new HttpError(404, "not_found", "Route does not exist.");
}

const worker = createWorker();

export default worker;
