import { QUALITY_LATEST_CACHE_CONTROL } from "../constants";
import { jsonResponse } from "../http";
import { readLatestPublishedObservedDate } from "../public-quality";
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
