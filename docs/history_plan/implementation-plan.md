# LangPulse Implementation Plan

**Overall Status:** Completed. Implementation and validation are done.

## Product Contract

LangPulse ships one dataset only.

1. **Launch-Forward Quality Snapshot**
   - Metric: `quality_30d_snapshot`
   - Definition: for UTC date `D`, language `L`, and threshold `T`, count public repositories whose primary language matches `L`, whose current stars are `>= T`, and whose latest push date is on or after `D-29`, as observed by GitHub Search at `observed_at` on UTC date `D`
   - Source: GitHub Search API
   - Snapshot semantics: `observed_date` is the target UTC date and `observed_at` is the actual UTC instant when the collector observed GitHub Search
   - Guarantee: starts at `launch_date` only
   - No historical reconstruction

Global rules:

- Timezone: `UTC`
- Window size: `30` days
- Public repository qualifier: `is:public fork:true` and this intentionally includes public forks
- Threshold `0` omits the `stars` qualifier
- `latest` always means latest published snapshot
- Public read APIs never expose unpublished, failed, or expired attempts
- Successful publication is immutable for an `observed_date`
- Missing `observed_date` values are valid product outcomes; public APIs return sparse time series
- Automatic and manual retries are allowed only while `current_utc_date = observed_date` and no publication exists yet
- Collection may run at any UTC time during `observed_date`; `observed_at` preserves the actual instant
- Configuration is append-only: existing language IDs and threshold values are never repurposed or deleted from the registry
- `language.id` is the stable public identifier and never changes
- `label` is presentation-only and may change
- `github_query_fragment` is a collector-only GitHub query fragment and is immutable for a given `language.id`; any semantic change requires a new `language.id`
- `active_from` and `active_to` control collection eligibility only; they never hide previously published history
- Retired languages and thresholds remain publicly queryable for historical dates

Example config shape:

```json
{
  "timezone": "UTC",
  "window_days": 30,
  "launch_date": "2026-04-01",
  "languages": [
    {
      "id": "go",
      "label": "Go",
      "github_query_fragment": "language:\"go\"",
      "active_from": "2026-04-01",
      "active_to": null
    }
  ],
  "thresholds": [
    { "value": 0, "active_from": "2026-04-01", "active_to": null },
    { "value": 10, "active_from": "2026-04-01", "active_to": null }
  ]
}
```

Notes:

- Retiring a language or threshold means setting `active_to`; do not remove the entry from the file
- Renaming UI text means updating `label` only
- Changing GitHub query semantics means creating a new `language.id`

---

## Phase 1: Shared Config and Schema

**Files**

- `config/metrics.json` ✅ Done
- `migrations/0001_init.sql` ✅ Done
- `collector/go.mod` ✅ Done
- `worker/package.json`
- `worker/tsconfig.json`
- `worker/wrangler.toml`
- `web/package.json` ✅ Done
- `web/tsconfig.json` ✅ Done
- `web/vite.config.ts` ✅ Done
- `.gitignore` ✅ Done

**Schema**

```sql
CREATE TABLE quality_30d_runs (
    run_id             TEXT NOT NULL PRIMARY KEY,
    observed_date      TEXT NOT NULL,     -- target UTC YYYY-MM-DD
    attempt_no         INTEGER NOT NULL,  -- monotonic within observed_date
    observed_at        TEXT NOT NULL,     -- ISO 8601 UTC snapshot instant
    status             TEXT NOT NULL,     -- running | failed | expired | complete
    lease_expires_at   TEXT NOT NULL,     -- ISO 8601 UTC lease deadline
    last_heartbeat_at  TEXT NOT NULL,     -- ISO 8601 UTC
    expected_rows      INTEGER NOT NULL,
    actual_rows        INTEGER NOT NULL DEFAULT 0,
    error_summary      TEXT,
    started_at         TEXT NOT NULL,     -- ISO 8601 UTC
    finished_at        TEXT,
    UNIQUE (observed_date, attempt_no)
);

CREATE TABLE quality_30d_run_rows (
    run_id            TEXT NOT NULL,
    language_id       TEXT NOT NULL,
    threshold_value   INTEGER NOT NULL,
    count             INTEGER NOT NULL,
    collected_at      TEXT NOT NULL,     -- ISO 8601 UTC
    PRIMARY KEY (run_id, language_id, threshold_value),
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
);

CREATE TABLE quality_30d_publications (
    observed_date     TEXT NOT NULL PRIMARY KEY,
    run_id            TEXT NOT NULL UNIQUE,
    published_at      TEXT NOT NULL,     -- ISO 8601 UTC
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
);

CREATE UNIQUE INDEX idx_quality_running_date
    ON quality_30d_runs(observed_date)
    WHERE status = 'running';

CREATE INDEX idx_quality_runs_date_status
    ON quality_30d_runs(observed_date, status);

CREATE INDEX idx_quality_rows_run_language_threshold
    ON quality_30d_run_rows(run_id, language_id, threshold_value);
```

Rationale:

- Run attempts, row payloads, and publications are different concepts
- `attempt_no` makes retries ordered and auditable
- `lease_expires_at` and `last_heartbeat_at` prevent a crashed collector from blocking the day forever
- `language.id` is the stable public identifier, `label` is presentation-only, and `github_query_fragment` stays collector-only
- `active_to` stops future collection without rewriting history

---

## Phase 2: Daily Quality Snapshot Collector ✅ Done

**Goal**

Collect `quality_30d_snapshot` once per UTC day from `launch_date` forward.

**Files**

- `collector/cmd/collect-quality/main.go` ✅ Done
- `collector/github/client.go` ✅ Done
- `collector/ingest/client.go` ✅ Done
- `collector/quality/query.go` ✅ Done
- `collector/quality/run.go` ✅ Done

**Query shape**

```text
{github_query_fragment} is:public fork:true pushed:>={from} stars:>={threshold}
```

- `from = observed_date - 29 days`
- For threshold `0`, omit `stars:>={threshold}`
- Use `url.QueryEscape`
- Do not add an upper-bound `pushed` qualifier; the snapshot is anchored by `observed_at` on `observed_date`

**Behavior**

- Require authenticated GitHub API access
- Load the append-only config registry from `config/metrics.json`
- Resolve the active language set for `observed_date` from `languages[].active_from` and `languages[].active_to`
- Resolve the active threshold set for `observed_date` from `thresholds[].active_from` and `thresholds[].active_to`
- Compute `expected_rows` from the active language-threshold Cartesian product
- Create one run via the internal ingest API before issuing queries; the ingest API assigns `attempt_no`, `observed_at`, and `lease_expires_at`
- Renew the run lease with heartbeats while the collector is still working
- Write each query result through the internal ingest API with an idempotent row upsert keyed by `(run_id, language_id, threshold_value)`
- Treat `incomplete_results = true` as a failed query for publication purposes
- Retry `403`, `429`, and `5xx` with reset-aware bounded backoff, but never past the UTC day boundary
- Finalize the run through the internal ingest API
- Mark the run `complete` only when all expected rows are present, the lease is still valid, and no publication exists for `observed_date`
- Finalization and publication happen in one transaction
- If the lease expires before heartbeat or finalization, the run becomes `expired` and the collector must stop using it

**Rules**

- No backfill job
- No old-date reconstruction
- Collector target date must be the current UTC date
- Automatic retries stop at a bounded limit or when the UTC day closes
- Operators may manually retry the current UTC date until the day closes or a publication exists
- Once a publication exists for `observed_date`, new attempts for that date are rejected
- Failed and expired runs remain stored for diagnostics only
- Collector never writes D1 directly

---

## Phase 3: Cloudflare Worker API ✅ Done

**Files**

- `worker/src/types.ts`
- `worker/src/routes/internal/quality-runs-create.ts`
- `worker/src/routes/internal/quality-runs-heartbeat.ts`
- `worker/src/routes/internal/quality-runs-row-upsert.ts`
- `worker/src/routes/internal/quality-runs-finalize.ts`
- `worker/src/routes/metadata.ts`
- `worker/src/routes/quality.ts`
- `worker/src/index.ts`

**Endpoints**

| Endpoint | Purpose |
|---|---|
| `POST /internal/quality-runs` | authenticated ingest endpoint for run creation and lease acquisition |
| `POST /internal/quality-runs/{run_id}/heartbeat` | extend the lease for a running attempt |
| `PUT /internal/quality-runs/{run_id}/rows/{language_id}/{threshold_value}` | idempotent row write for one language-threshold result |
| `POST /internal/quality-runs/{run_id}/finalize` | atomically complete and publish a successful attempt, or fail/expire it |
| `GET /api/metadata` | timezone, window size, launch date, and all publicly queryable languages and thresholds, including retired entries |
| `GET /api/quality?language=go&from=...&to=...` | published quality snapshots only, returning every published threshold row for the language in the requested range |
| `GET /api/quality/latest` | latest published snapshot date |
| `GET /api/health` | D1 connectivity |

**Rules**

- Enforce strict UTC date validation
- Max date range: `365` days
- Internal ingest endpoints require service authentication
- Run creation transactionally expires a stale `running` attempt for the same `observed_date` before assigning the next `attempt_no`
- Heartbeat is valid only for a `running` attempt whose lease has not expired yet
- Row writes are idempotent upserts and reject unknown languages, unknown thresholds, and writes against non-running attempts
- Finalization is idempotent and checks expected row count, lease validity, and publication absence before inserting into `quality_30d_publications`
- A run that reaches lease expiry before successful finalization becomes `expired`
- Read paths join `quality_30d_publications`, `quality_30d_runs`, and `quality_30d_run_rows`
- `/api/metadata` returns all public-queryable dimensions, not only currently active ones
- Read paths never clip away published history because of current `active_to`
- Return sparse series; do not fabricate zero rows for missing dates
- Each `observed_date` response slice must come from exactly one published `run_id`
- Response payloads include `observed_at` and `published_at`
- Cache-Control on `/api/quality/latest`: `public, max-age=60, stale-while-revalidate=300`
- Cache-Control on `/api/quality`: `public, max-age=300, stale-while-revalidate=3600`

---

## Phase 4: Frontend ✅ Done

**Files**

- `web/index.html` ✅ Done
- `web/src/main.ts` ✅ Done
- `web/src/api.ts` ✅ Done
- `web/src/charts/quality-chart.ts` ✅ Done
- `web/src/style.css` ✅ Done

**Layout**

- One primary chart: `Repositories pushed in the last 30 days`
- Language selector uses `language.id` and displays `language.label`
- Language selector includes retired languages that still have published history
- Threshold series are cumulative and labeled `>= N stars`
- Explicit note: `available from launch date only`, `snapshots are observed during the UTC day`, and `missing dates are possible`
- Tooltip or subtitle shows `observed_at`
- Default range: last `90` days when available
- Loading, error, and empty states are required

Rationale:

- The product has one dataset, so the UI should present one honest story
- Stable language IDs decouple UI state from GitHub query syntax
- Historical visibility must survive dimension retirement

---

## Phase 5: CI/CD ✅ Done

**Files**

- `.github/workflows/collect-quality.yml` ✅ Done
- `.github/workflows/deploy.yml` ✅ Done
- `.github/workflows/validate.yml` ✅ Done

**collect-quality.yml**

1. Build collector
2. Run daily quality snapshot for the current UTC date
3. Fail the workflow if no publication is produced within the automated retry budget
4. Keep failed and expired attempt details visible in logs and alerts

**deploy.yml**

1. Apply migrations
2. Deploy Worker
3. Reset the smoke date and verify stale-attempt expiry, successful publication, and post-publication rejection in the smoke Worker environment
4. Build the frontend bundle into Worker static assets and deploy the Worker

**validate.yml**

1. Run collector tests with coverage and fail below the repository minimum
2. Enforce the Worker `90%` coverage contract in CI
3. Enforce the Web `90%` coverage contract in CI

Rationale:

- Schema must exist before Worker reads published data
- Collection and deployment remain operationally separate
- Coverage is a merge gate, not a best-effort local convention

---

## Verification

1. Go unit tests cover query building, active range resolution, current-day retry guards, and config invariants for `language.id`, `label`, and `github_query_fragment`
2. Worker tests cover ingest authentication, stale-run expiry, attempt numbering, heartbeat lease renewal, idempotent row writes, finalization idempotency, publication immutability, historical visibility after retirement, sparse responses, and published-only reads
3. Frontend tests cover label display, retired-language discoverability, `observed_at` display, and empty/error states
4. `make ci` and the frontend test commands must satisfy the repository coverage bar before merge
5. Smoke tests must verify `/api/quality/latest`, one published `/api/quality` query, stale-attempt expiry followed by a successful retry, and rejection of a new attempt after publication

---

## Non-Goals

- No historical dataset
- No reconstruction of missed past dates
- No successful rerun after a publication exists
- No public API access to unpublished, failed, or expired attempts
- No fixed end-of-day snapshot time
- No bucketized star-tier chart
