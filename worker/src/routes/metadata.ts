import { toPublicLanguages, toPublicThresholds } from "../config-registry";
import { QUALITY_METRIC } from "../constants";
import { jsonResponse } from "../http";
import type { RequestContext } from "../types";

export function handleMetadata(context: RequestContext): Response {
  return jsonResponse({
    metric: QUALITY_METRIC,
    timezone: context.runtime.registry.timezone,
    window_days: context.runtime.registry.window_days,
    launch_date: context.runtime.registry.launch_date,
    languages: toPublicLanguages(context.runtime.registry),
    thresholds: toPublicThresholds(context.runtime.registry),
  });
}
