import { findLanguageById, isEntryActiveOnDate } from "./config-registry";
import { HttpError } from "./http";
import type {
  CompareLanguageEntry,
  CompareSeriesPoint,
  QualityCompareResponse,
  QualitySnapshotResponse,
  RequestContext,
  SnapshotLanguageCount,
} from "./types";

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

interface SnapshotRow {
  observed_date: string;
  language_id: string;
  count: number;
}

async function readPreviousObservedDate(
  context: RequestContext,
  observedDate: string,
): Promise<string | null> {
  const row = await context.env.DB
    .prepare(
      `SELECT MAX(observed_date) AS observed_date
      FROM quality_30d_publications
      WHERE observed_date < ?1`,
    )
    .bind(observedDate)
    .first<{ observed_date: string | null }>();

  return row?.observed_date ?? null;
}

async function readPublicationExists(
  context: RequestContext,
  observedDate: string,
): Promise<boolean> {
  const row = await context.env.DB
    .prepare(
      `SELECT 1 AS present
      FROM quality_30d_publications
      WHERE observed_date = ?1`,
    )
    .bind(observedDate)
    .first<{ present: number }>();

  return row !== null;
}

export async function readPublishedQualitySnapshot(
  context: RequestContext,
  observedDate: string,
  thresholdValue: number,
): Promise<QualitySnapshotResponse | null> {
  if (!(await readPublicationExists(context, observedDate))) {
    return null;
  }

  const previousDate = await readPreviousObservedDate(context, observedDate);
  const dates = previousDate === null ? [observedDate] : [observedDate, previousDate];
  const placeholders = dates.map((_, index) => `?${index + 2}`).join(", ");

  const queryResult = await context.env.DB
    .prepare(
      `SELECT publications.observed_date, rows.language_id, rows.count
      FROM quality_30d_publications AS publications
      INNER JOIN quality_30d_run_rows AS rows
        ON rows.run_id = publications.run_id
      WHERE rows.threshold_value = ?1
        AND publications.observed_date IN (${placeholders})`,
    )
    .bind(thresholdValue, ...dates)
    .all<SnapshotRow>();

  const currentCounts = new Map<string, number>();
  const previousCounts = new Map<string, number>();
  for (const row of queryResult.results ?? []) {
    if (row.observed_date === observedDate) {
      currentCounts.set(row.language_id, row.count);
    } else if (previousDate !== null && row.observed_date === previousDate) {
      previousCounts.set(row.language_id, row.count);
    }
  }

  const languages: SnapshotLanguageCount[] = [];
  for (const language of context.runtime.registry.languages) {
    if (!isEntryActiveOnDate(observedDate, language.active_from, language.active_to)) {
      continue;
    }

    const count = currentCounts.get(language.id);
    if (count === undefined) {
      continue;
    }

    const previousCount =
      previousDate === null ? null : (previousCounts.get(language.id) ?? null);

    languages.push({
      id: language.id,
      label: language.label,
      count,
      previous_count: previousCount,
    });
  }

  return {
    observed_date: observedDate,
    threshold: thresholdValue,
    previous_date: previousDate,
    languages,
  };
}

interface CompareRow {
  observed_date: string;
  language_id: string;
  count: number;
}

export async function readPublishedQualityCompare(
  context: RequestContext,
  languageIds: string[],
  thresholdValue: number,
  from: string,
  to: string,
): Promise<QualityCompareResponse> {
  const resolvedLanguages: CompareLanguageEntry[] = [];
  for (const languageId of languageIds) {
    const language = findLanguageById(context.runtime.registry, languageId);
    if (language === undefined) {
      throw new HttpError(400, "unknown_language", "language must be a known language.id.", {
        language: languageId,
      });
    }

    resolvedLanguages.push({ id: language.id, label: language.label });
  }

  const languagePlaceholders = languageIds.map((_, index) => `?${index + 2}`).join(", ");
  const fromIndex = languageIds.length + 2;
  const toIndex = languageIds.length + 3;

  const queryResult = await context.env.DB
    .prepare(
      `SELECT publications.observed_date, rows.language_id, rows.count
      FROM quality_30d_publications AS publications
      INNER JOIN quality_30d_run_rows AS rows
        ON rows.run_id = publications.run_id
      WHERE rows.threshold_value = ?1
        AND rows.language_id IN (${languagePlaceholders})
        AND publications.observed_date >= ?${fromIndex}
        AND publications.observed_date <= ?${toIndex}
      ORDER BY publications.observed_date ASC`,
    )
    .bind(thresholdValue, ...languageIds, from, to)
    .all<CompareRow>();

  const pointsByDate = new Map<string, CompareSeriesPoint>();
  for (const row of queryResult.results ?? []) {
    let point = pointsByDate.get(row.observed_date);
    if (point === undefined) {
      point = { observed_date: row.observed_date, counts: {} };
      pointsByDate.set(row.observed_date, point);
    }

    point.counts[row.language_id] = row.count;
  }

  const series = Array.from(pointsByDate.values()).sort((a, b) =>
    a.observed_date.localeCompare(b.observed_date),
  );

  return {
    threshold: thresholdValue,
    from,
    to,
    languages: resolvedLanguages,
    series,
  };
}

export async function checkDatabaseHealth(context: RequestContext): Promise<boolean> {
  const result = await context.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return result?.ok === 1;
}
