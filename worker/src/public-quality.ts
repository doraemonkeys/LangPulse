import { findLanguageById } from "./config-registry";
import { HttpError } from "./http";
import type { QualitySeriesPoint, RequestContext } from "./types";

interface QualitySeriesRow {
  observed_date: string;
  run_id: string;
  observed_at: string;
  published_at: string;
  threshold_value: number;
  count: number;
}

export async function readLatestPublishedObservedDate(
  context: RequestContext,
): Promise<string | null> {
  const row = await context.env.DB
    .prepare(
      `SELECT observed_date
      FROM quality_30d_publications
      ORDER BY observed_date DESC
      LIMIT 1`,
    )
    .first<{ observed_date: string }>();

  return row?.observed_date ?? null;
}

export async function readPublishedQualitySeries(
  context: RequestContext,
  languageId: string,
  from: string,
  to: string,
): Promise<{ language: { id: string; label: string }; series: QualitySeriesPoint[] }> {
  const language = findLanguageById(context.runtime.registry, languageId);
  if (language === undefined) {
    throw new HttpError(400, "unknown_language", "language must be a known language.id.", {
      language: languageId,
    });
  }

  const queryResult = await context.env.DB
    .prepare(
      `SELECT
        publications.observed_date,
        publications.run_id,
        runs.observed_at,
        publications.published_at,
        rows.threshold_value,
        rows.count
      FROM quality_30d_publications AS publications
      INNER JOIN quality_30d_runs AS runs
        ON runs.run_id = publications.run_id
      INNER JOIN quality_30d_run_rows AS rows
        ON rows.run_id = publications.run_id
      WHERE rows.language_id = ?1
        AND publications.observed_date >= ?2
        AND publications.observed_date <= ?3
      ORDER BY publications.observed_date ASC, rows.threshold_value ASC`,
    )
    .bind(languageId, from, to)
    .all<QualitySeriesRow>();

  const groupedSeries: QualitySeriesPoint[] = [];
  let currentPoint: QualitySeriesPoint | null = null;
  let currentRunId: string | null = null;

  for (const row of queryResult.results ?? []) {
    if (currentPoint === null || currentPoint.observed_date !== row.observed_date) {
      currentPoint = {
        observed_date: row.observed_date,
        observed_at: row.observed_at,
        published_at: row.published_at,
        thresholds: [],
      };
      groupedSeries.push(currentPoint);
      currentRunId = row.run_id;
    } else if (currentRunId !== row.run_id) {
      throw new HttpError(
        500,
        "published_slice_run_mismatch",
        "Each published observed_date must resolve to exactly one run_id.",
        { observed_date: row.observed_date },
      );
    }

    currentPoint.thresholds.push({
      threshold_value: row.threshold_value,
      count: row.count,
    });
  }

  return {
    language: {
      id: language.id,
      label: language.label,
    },
    series: groupedSeries,
  };
}

export async function checkDatabaseHealth(context: RequestContext): Promise<boolean> {
  const result = await context.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return result?.ok === 1;
}
