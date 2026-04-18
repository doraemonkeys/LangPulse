import { requireServiceAuth } from "../../auth";
import { readJsonObject } from "../../http";
import { upsertQualityRunRow } from "../../quality-runs";
import type { RequestContext } from "../../types";
import { qualityRunResponse } from "./quality-run-responses";

export async function handleQualityRunsRowUpsert(
  request: Request,
  context: RequestContext,
  runId: string,
  languageId: string,
  thresholdValue: string,
): Promise<Response> {
  requireServiceAuth(request, context.env);
  const payload = await readJsonObject(request);
  const run = await upsertQualityRunRow(context, runId, languageId, thresholdValue, payload);
  return qualityRunResponse(run);
}
