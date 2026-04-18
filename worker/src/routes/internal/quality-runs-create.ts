import { requireServiceAuth } from "../../auth";
import { readJsonObject } from "../../http";
import { createQualityRun } from "../../quality-runs";
import type { RequestContext } from "../../types";
import { qualityRunResponse } from "./quality-run-responses";

export async function handleQualityRunsCreate(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  requireServiceAuth(request, context.env);
  const payload = await readJsonObject(request);
  const run = await createQualityRun(context, payload);
  return qualityRunResponse(run, { status: 201 });
}
