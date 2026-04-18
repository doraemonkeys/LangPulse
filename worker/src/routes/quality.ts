import { QUALITY_CACHE_CONTROL, QUALITY_LATEST_CACHE_CONTROL } from "../constants";
import { HttpError, jsonResponse } from "../http";
import { readLatestPublishedObservedDate, readPublishedQualitySeries } from "../public-quality";
import { validatePublicDateRange } from "../quality-runs";
import type { RequestContext } from "../types";

export async function handleQualityLatest(context: RequestContext): Promise<Response> {
  const observedDate = await readLatestPublishedObservedDate(context);
  return jsonResponse(
    {
      observed_date: observedDate,
    },
    {
      headers: {
        "Cache-Control": QUALITY_LATEST_CACHE_CONTROL,
      },
    },
  );
}

export async function handleQualityRange(
  request: Request,
  context: RequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const languageId = url.searchParams.get("language");
  const fromValue = url.searchParams.get("from");
  const toValue = url.searchParams.get("to");

  if (languageId === null || fromValue === null || toValue === null) {
    throw new HttpError(
      400,
      "missing_query_parameters",
      "language, from, and to are required query parameters.",
    );
  }

  const { from, to, queryFrom } = validatePublicDateRange(
    context.runtime.registry.launch_date,
    fromValue,
    toValue,
  );
  const qualitySeries = await readPublishedQualitySeries(context, languageId, queryFrom, to);

  return jsonResponse(
    {
      language: qualitySeries.language,
      from,
      to,
      series: qualitySeries.series,
    },
    {
      headers: {
        "Cache-Control": QUALITY_CACHE_CONTROL,
      },
    },
  );
}
