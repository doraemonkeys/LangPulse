# LangPulse

LangPulse publishes one thing: a daily UTC-day snapshot of how many public GitHub repositories in each programming language have been active recently, broken down by star-count threshold.

## What the number actually measures

For every published UTC date `D`, every active language `L`, and every active star threshold `T`, LangPulse stores a single integer: the total count returned by a GitHub repository-search query equivalent to

```
language:"<L>" is:public pushed:>=D-29 stars:>=T
```

Concretely:

- The window is always 30 days, inclusive of the observed date (`D-29 .. D`).
- `pushed:>=` reflects any push activity on any branch. It is a proxy for "this repo has seen human touch recently," not a direct quality signal.
- `threshold = 0` drops the `stars:` qualifier entirely, so it counts *every* recently-pushed public repo in that language.
- `language:"..."` uses GitHub's own Linguist classification, not file extensions.
- `github_query_fragment` in `config/metrics.json` is the source of truth for each language's query spelling. Two spellings of the same language would need two different `language.id`s — the ID is a contract.

So one row in the dataset answers: *on date `D`, how many public repos classified as language `L` had at least `T` stars and were pushed to within the last 30 days?*

## Architecture at a glance

```
┌──────────────┐      HTTP + Bearer      ┌────────────────────┐
│  collector/  │ ───────────────────────▶│   worker/  (CF)    │
│  Go, daily   │   /internal/quality-*   │  D1: runs, rows,   │
│  via Actions │                         │       publications │
└──────┬───────┘                         └─────────┬──────────┘
       │ GitHub Search API                         │ same-origin
       ▼                                           ▼
┌──────────────┐                         ┌────────────────────┐
│  GitHub      │                         │    web/  (React)   │
│              │                         │  static assets     │
└──────────────┘                         └────────────────────┘
```

A single Cloudflare Worker serves both the public API and the static frontend. The collector runs daily at `00:15 UTC` via GitHub Actions, queries GitHub Search in parallel under a shared rate limiter, and hands the entire result set to the Worker's internal ingest endpoint in one atomic batch.


## Repository layout

```
collector/                  Go collector
  cmd/collect-quality/      executable entry point
  github/                   Search client with shared rate limiter
  ingest/                   internal ingest API client (batch upsert)
  quality/                  run orchestration, lease, query construction
worker/                     Cloudflare Worker (src/index.ts is a pure router)
  src/routes/               public route handlers
  src/routes/internal/      run lifecycle: create, heartbeat, rows:batch, finalize
  src/quality-runs.ts       run lifecycle core (lease, upsert, publish)
  src/public-quality.ts     public read queries
  src/config-registry.ts    metrics.json loader and activation filter
web/                        React 19 + @tanstack/react-query dashboard
config/metrics.json         languages, thresholds, activation windows
migrations/0001_init.sql    D1 schema: runs, run_rows, publications
docs/                       PROJECT_OVERVIEW, DEPLOY, clarifications, history_plan
.github/                    validate, deploy, collect-quality workflows + scripts
```

For a file-level entry-point map and "where to start for common changes," see [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md).

## Public API

All endpoints are same-origin on the deployed Worker. Responses are JSON; dates are UTC `YYYY-MM-DD`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Pings D1. Rate-limited per client IP. |
| `GET` | `/api/metadata` | Registry projection: active languages, thresholds, `launch_date`, `window_days`. |
| `GET` | `/api/quality/latest` | `{ observed_date }` of the most recently published snapshot, or `null`. |
| `GET` | `/api/quality/snapshot?date=YYYY-MM-DD&threshold=N` | Ranked language counts for the given date + threshold, plus the previous *published* date's counts so the frontend can render deltas. |
| `GET` | `/api/quality/compare?languages=a,b,c&threshold=N&from=...&to=...` | Time-series counts for a small set of languages over a date window. |

Internal endpoints under `/internal/quality-runs/*` are Bearer-auth only and used exclusively by the collector. Their payload contracts live in `worker/src/quality-runs.ts` and the corresponding route handlers.

## Data model

Three tables in Cloudflare D1 (full schema in `migrations/0001_init.sql`):

- **`quality_30d_runs`** — every attempt, with `status ∈ {running, failed, expired, complete}`, lease bookkeeping, and `(observed_date, attempt_no)` unique. A partial unique index ensures at most one `running` row per date.
- **`quality_30d_run_rows`** — one integer per `(run_id, language_id, threshold_value)`.
- **`quality_30d_publications`** — the immutable pointer from `observed_date` to the winning `run_id`. Public reads always join through this table, so failed or expired attempts are invisible externally but remain for auditability.

## Local development

Requires Go, Node 22+, and [sloc-guard](https://crates.io/crates/sloc-guard) (`cargo install sloc-guard`).

```
make setup       # install Node deps for worker + web
make ci          # full validation: Go tests (90% coverage floor), worker/web check/coverage/build/lint, scripts tests, sloc-guard
make verify      # same as ci but without the setup step
```

Targeted subsets:

```
make collector-test
make worker-check worker-coverage
make web-check web-coverage
```

## Deployment

Production runs on a single Cloudflare Worker with a D1 binding. D1 databases are **not** created by the deploy workflow — they must exist first and their IDs must be wired into GitHub Variables. The end-to-end first-time checklist (Cloudflare setup, GitHub Variables/Secrets, first deploy, first collection, verification URLs) lives in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Further reading

- [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) — file-level entry points and "where to start for common changes."
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — full first-time deployment and operations checklist.
- [`docs/clarifications/`](docs/clarifications/) — recorded design decisions (CORS stance, hosting/config contract, sloc-guard validation rationale).
- [`docs/history_plan/`](docs/history_plan/) — archived implementation plans, including the collector throughput refactor.
