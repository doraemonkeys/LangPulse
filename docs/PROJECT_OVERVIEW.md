# Project Overview

## What This Repo Does

LangPulse ships one dataset only: `quality_30d_snapshot`.

It collects one UTC-day snapshot of public GitHub repositories and publishes that data through a single Cloudflare Worker that serves both the public API and the frontend shell.

Core rule set:

- UTC only
- one dataset only
- no historical backfill
- successful publication for an `observed_date` is immutable
- public APIs expose published data only
- config is append-only

## High-Level Flow

1. `collector/` reads `config/metrics.json`
2. it queries GitHub Search in parallel for each active (language, threshold) pair under a shared rate limiter
3. it writes the full result set to the Worker's internal ingest endpoint in one atomic batch
4. `worker/` stores runs, rows, publications, and the deployed frontend assets
5. `web/` is built into static assets and reads published data from same-origin Worker public endpoints
6. GitHub Actions validates, deploys, and runs the daily collection workflow

## Top-Level Structure

```text
collector/           Go collector
worker/              Cloudflare Worker app
web/                 React frontend
config/              metric dimensions and activation windows
migrations/          D1 schema
.github/             validation, deploy, and collection workflows
docs/plan/           implementation plan
docs/history_plan/   archived plan history
docs/clarifications/ design decisions
go.mod               root workspace anchor for Go tooling
go.work              Go workspace
```

## Key Entry Points

### Collector

- `collector/cmd/collect-quality/main.go`
  Executable, env / flag parsing, dependency wiring
- `collector/github/client.go`
  GitHub Search client with shared rate limiter
- `collector/ingest/client.go`
  Internal ingest API client (batch row upsert)
- `collector/quality/config.go`
  Registry loading and active-dimension resolution
- `collector/quality/query.go`
  GitHub query construction
- `collector/quality/run.go`
  Run orchestration and errgroup-based search fan-out
- `collector/quality/run_lease.go`
  Background lease heartbeat controller and detached failure finalization

### Worker

`worker/src/index.ts` is a pure router. It delegates to handlers under `routes/`, which call domain modules for core logic.

- `worker/src/index.ts`
  HTTP router for public and internal endpoints
- `worker/src/quality-runs.ts`
  Run lifecycle core: create, heartbeat, row-batch upsert, finalize, publication
- `worker/src/public-quality.ts`
  Public read queries: latest, snapshot, compare, health
- `worker/src/config-registry.ts`
  `config/metrics.json` loader, activation filter, public projection
- `worker/src/database.ts`
  Low-level run read / expire / fail helpers
- `worker/src/auth.ts`, `http.ts`, `time.ts`, `constants.ts`, `types.ts`
  Bearer auth, error/JSON helpers, UTC parsing, tunables and table names, shared types
- `worker/src/routes/metadata.ts`
  `GET /api/metadata`
- `worker/src/routes/quality.ts`
  `GET /api/quality/latest`
- `worker/src/routes/quality-snapshot.ts`
  `GET /api/quality/snapshot`
- `worker/src/routes/quality-compare.ts`
  `GET /api/quality/compare`
- `worker/src/routes/internal/*`
  `POST /internal/quality-runs`, `/heartbeat`, `/rows:batch`, `/finalize`

### Web

React 19 + `@tanstack/react-query`, dashboard state in a reducer.

- `web/src/main.tsx`
  Page bootstrap; wires `QueryClientProvider`, `QualityApiProvider`, `DashboardProvider`
- `web/src/App.tsx`
  Top-level layout and bootstrap effects (launch date, observed date, default range)
- `web/src/api/client.ts`, `api/types.ts`, `api/queryClient.ts`
  Public API client, response types, react-query defaults
- `web/src/state/DashboardProvider.tsx`, `state/actions.ts`
  Reducer state: threshold, range, pinned languages, observed date, theme
- `web/src/hooks/{useMetadata,useLatest,useSnapshot,useCompare,useTheme,useQualityApi}.ts`
  `useQuery` wrappers per endpoint, theme persistence, API context
- `web/src/components/*`
  AppHeader, ComparisonChart, Sparkline, Leaderboard, LeaderboardRow, LanguagePicker, LanguageLegend, ThresholdChips, DateRangePicker, StateBanner, ThemeToggle
- `web/src/charts/palette.ts`, `charts/tooltip.tsx`
  Color palette, shared recharts tooltip
- `web/src/theme/{reset,tokens,app}.css`
  Global reset, design tokens, component styles
- `web/src/utils/{dates,format}.ts`
  UTC date math, number formatting

### Data / Infra

- `config/metrics.json`
  Languages, thresholds, activation windows
- `migrations/0001_init.sql`
  D1 schema for runs, rows, publications
- `worker/wrangler.toml`
  Local Worker defaults; CI renders env-specific deploy config from this template

## Where To Start For Common Changes

### Change metric semantics

Start with:

- `config/metrics.json`
- `collector/quality/*`
- `worker/src/config-registry.ts`
- `worker/src/public-quality.ts`

### Change ingest lifecycle or retry rules

Start with:

- `collector/quality/run.go`, `run_lease.go`
- `collector/ingest/client.go`
- `worker/src/quality-runs.ts`
- `worker/src/routes/internal/*`

### Change public API payloads

Start with:

- `worker/src/index.ts`
- `worker/src/routes/{metadata,quality,quality-snapshot,quality-compare}.ts`
- `worker/src/public-quality.ts`
- `web/src/api/{client,types}.ts`
- related tests under `worker/test/` and `web/src/**/*.test.{ts,tsx}`

### Change chart / UI behavior

Start with:

- `web/src/App.tsx`
- `web/src/state/*`, `web/src/hooks/*`
- `web/src/components/*`
- `web/src/theme/*`

### Change CI / deploy behavior

Start with:

- `.github/workflows/{validate,deploy,collect-quality}.yml`
- `.github/scripts/render-wrangler-config.mjs`
- `.github/scripts/smoke-quality-api.mjs`
- `.github/scripts/run-*.mjs` (workflow command shims)

## Important Invariants

- `language.id` is stable and public; do not repurpose it
- `label` is presentation-only
- changing `github_query_fragment` semantics requires a new `language.id`
- `active_to` stops future collection only; it does not hide published history
- threshold `0` means no stars qualifier in GitHub Search
- `latest` means latest published snapshot, not latest attempted run
- a day may have failed or missing collection; public series stay sparse
- run creation only accepts the current UTC date; historical backfill is rejected server-side
- row upsert is a single atomic batch (≤ 500 rows) per run, guarded by the lease

## Test / Validation Commands

Repo root:

```powershell
make ci
```
