import { findThresholdByValue } from "../config-registry";
import { MAX_COMPARE_LANGUAGES, QUALITY_CACHE_CONTROL } from "../constants";
import { HttpError, jsonResponse } from "../http";
import { readPublishedQualityCompare } from "../public-quality";
import { validatePublicDateRange } from "../quality-runs";
import type { RequestContext } from "../types";

const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

function parseThresholdParam(value: string): number {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    throw new HttpError(
      400,
      "invalid_threshold",
      "threshold must be a non-negative integer.",
    );
  }

  return Number.parseInt(value, 10);
}

function parseLanguagesParam(value: string): string[] {
  const languageIds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (languageIds.length === 0) {
    throw new HttpError(
      400,
      "invalid_languages",
      "languages must contain at least one language id.",
    );
  }

  if (languageIds.length > MAX_COMPARE_LANGUAGES) {
    throw new HttpError(
      400,
      "too_many_languages",
      `languages must not exceed ${MAX_COMPARE_LANGUAGES} entries.`,
      { limit: MAX_COMPARE_LANGUAGES, received: languageIds.length },
    );
  }

  // Deduplicate while preserving order so callers never receive duplicate series keys.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const languageId of languageIds) {
    if (!seen.has(languageId)) {
      seen.add(languageId);
      unique.push(languageId);
    }
  }

  return unique;
}

export async function handleQualityCompare(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const languagesValue = url.searchParams.get("languages");
  const thresholdValue = url.searchParams.get("threshold");
  const fromValue = url.searchParams.get("from");
  const toValue = url.searchParams.get("to");

  if (
    languagesValue === null ||
    thresholdValue === null ||
    fromValue === null ||
    toValue === null
  ) {
    throw new HttpError(
      400,
      "missing_query_parameters",
      "languages, threshold, from, and to are required query parameters.",
    );
  }

  const languageIds = parseLanguagesParam(languagesValue);
  const threshold = parseThresholdParam(thresholdValue);

  if (findThresholdByValue(context.runtime.registry, threshold) === undefined) {
    throw new HttpError(400, "unknown_threshold", "threshold is not a known threshold.value.", {
      threshold,
    });
  }

  const { from, to, queryFrom } = validatePublicDateRange(
    context.runtime.registry.launch_date,
    fromValue,
    toValue,
  );

  const compare = await readPublishedQualityCompare(
    context,
    languageIds,
    threshold,
    queryFrom,
    to,
  );

  return jsonResponse(
    {
      threshold: compare.threshold,
      from,
      to,
      languages: compare.languages,
      series: compare.series,
    },
    {
      headers: {
        "Cache-Control": QUALITY_CACHE_CONTROL,
      },
    },
  );
}
