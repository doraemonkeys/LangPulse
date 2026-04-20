import { findThresholdByValue } from "../config-registry";
import { QUALITY_CACHE_CONTROL } from "../constants";
import { HttpError, jsonResponse } from "../http";
import { readPublishedQualitySnapshot } from "../public-quality";
import { assertUtcDate, compareUtcDates } from "../time";
import type { RequestContext } from "../types";

const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

function parseDateParam(value: string): string {
  try {
    return assertUtcDate(value, "date");
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_date",
      error instanceof Error ? error.message : "Invalid date.",
    );
  }
}

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

export async function handleQualitySnapshot(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const dateValue = url.searchParams.get("date");
  const thresholdValue = url.searchParams.get("threshold");

  if (dateValue === null || thresholdValue === null) {
    throw new HttpError(
      400,
      "missing_query_parameters",
      "date and threshold are required query parameters.",
    );
  }

  const date = parseDateParam(dateValue);
  const threshold = parseThresholdParam(thresholdValue);

  if (findThresholdByValue(context.runtime.registry, threshold) === undefined) {
    throw new HttpError(400, "unknown_threshold", "threshold is not a known threshold.value.", {
      threshold,
    });
  }

  if (compareUtcDates(date, context.runtime.registry.launch_date) < 0) {
    throw new HttpError(400, "date_before_launch", "date must be on or after launch_date.", {
      date,
      launch_date: context.runtime.registry.launch_date,
    });
  }

  const snapshot = await readPublishedQualitySnapshot(context, date, threshold);
  if (snapshot === null) {
    throw new HttpError(404, "snapshot_not_found", "No published snapshot exists for this date.", {
      date,
    });
  }

  return jsonResponse(snapshot, {
    headers: {
      "Cache-Control": QUALITY_CACHE_CONTROL,
    },
  });
}
