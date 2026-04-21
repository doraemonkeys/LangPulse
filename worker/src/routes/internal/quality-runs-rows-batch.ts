import { requireServiceAuth } from "../../auth";
import { readJsonObject } from "../../http";
import { upsertQualityRunRows } from "../../quality-runs";
import type { RequestContext } from "../../types";
import { qualityRunResponse } from "./quality-run-responses";

export async function handleQualityRunsRowsBatch(
  request: Request,
  context: RequestContext,
  runId: string,
): Promise<Response> {
  requireServiceAuth(request, context.env);
  const payload = await readJsonObject(request);
  const run = await upsertQualityRunRows(context, runId, payload);
  return qualityRunResponse(run);
}
