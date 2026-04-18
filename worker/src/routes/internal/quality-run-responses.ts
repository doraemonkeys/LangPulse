import { jsonResponse } from "../../http";
import type { QualityRunRecord } from "../../types";

export interface QualityRunEnvelope {
  run: QualityRunRecord;
}

export interface FinalizedQualityRunEnvelope extends QualityRunEnvelope {
  published_at: string | null;
}

export function qualityRunResponse(run: QualityRunRecord, init: ResponseInit = {}): Response {
  return jsonResponse({ run } satisfies QualityRunEnvelope, init);
}

export function finalizedQualityRunResponse(
  result: FinalizedQualityRunEnvelope,
  init: ResponseInit = {},
): Response {
  return jsonResponse(result satisfies FinalizedQualityRunEnvelope, init);
}
