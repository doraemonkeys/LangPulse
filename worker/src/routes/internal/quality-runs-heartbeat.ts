import { requireServiceAuth } from "../../auth";
import { heartbeatQualityRun } from "../../quality-runs";
import type { RequestContext } from "../../types";
import { qualityRunResponse } from "./quality-run-responses";

export async function handleQualityRunsHeartbeat(
  request: Request,
  context: RequestContext,
  runId: string,
): Promise<Response> {
  requireServiceAuth(request, context.env);
  const run = await heartbeatQualityRun(context, runId);
  return qualityRunResponse(run);
}
