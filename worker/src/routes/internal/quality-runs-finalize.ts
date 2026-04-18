import { requireServiceAuth } from "../../auth";
import { readJsonObject } from "../../http";
import { finalizeQualityRun } from "../../quality-runs";
import type { RequestContext } from "../../types";
import { finalizedQualityRunResponse } from "./quality-run-responses";

export async function handleQualityRunsFinalize(
  request: Request,
  context: RequestContext,
  runId: string,
): Promise<Response> {
  requireServiceAuth(request, context.env);
  const payload = await readJsonObject(request);
  const result = await finalizeQualityRun(context, runId, payload);
  return finalizedQualityRunResponse(result);
}
