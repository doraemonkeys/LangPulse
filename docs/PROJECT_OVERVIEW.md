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
2. it queries GitHub Search for each active language / threshold pair
3. it writes results to Worker internal ingest endpoints
4. `worker/` stores runs, rows, publications, and the deployed frontend assets
5. `web/` is built into static assets and reads published data from same-origin Worker public endpoints
6. GitHub Actions validates, deploys, and runs the daily collection workflow

## Top-Level Structure

```text
collector/    Go collector
worker/       Cloudflare Worker app
web/          frontend app
config/       metric dimensions and activation windows
migrations/   D1 schema
.github/      validation, deploy, and collection workflows
docs/history_plan/ implementation plan and product contract
go.mod        root workspace anchor for Go tooling
go.work       Go workspace
```

## Key Entry Points

### Collector

- `collector/cmd/collect-quality/main.go`
  Main executable, env parsing, orchestration
- `collector/github/client.go`
  GitHub Search client
- `collector/ingest/client.go`
  Internal ingest API client
- `collector/quality/config.go`
  Registry loading and active-dimension resolution
- `collector/quality/query.go`
  GitHub query construction
- `collector/quality/run.go`
  Run lifecycle, retry, heartbeat, finalize flow

### Worker

- `worker/src/index.ts`
  HTTP router for internal and public endpoints
- `worker/src/quality-runs.ts`
  Core run lifecycle and publication logic
- `worker/src/public-quality.ts`
  Public read paths and health checks
- `worker/src/routes/internal/*`
  Internal ingest endpoints
- `worker/src/routes/metadata.ts`
  Public metadata endpoint
- `worker/src/routes/quality.ts`
  Public quality and latest endpoints

### Web

- `web/src/main.ts`
  Page bootstrap, state, fetch flow, rendering
- `web/src/api.ts`
  Public API client
- `web/src/charts/quality-chart.ts`
  Chart rendering
- `web/src/style.css`
  App styling

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
- `worker/src/public-quality.ts`

### Change ingest lifecycle or retry rules

Start with:

- `collector/quality/run.go`
- `collector/ingest/client.go`
- `worker/src/quality-runs.ts`
- `worker/src/routes/internal/*`

### Change public API payloads

Start with:

- `worker/src/index.ts`
- `worker/src/routes/metadata.ts`
- `worker/src/routes/quality.ts`
- `web/src/api.ts`
- related tests under `worker/test/` and `web/src/*.test.ts`

### Change chart / UI behavior

Start with:

- `web/src/main.ts`
- `web/src/charts/quality-chart.ts`
- `web/src/style.css`

### Change CI / deploy behavior

Start with:

- `.github/workflows/validate.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/collect-quality.yml`
- `.github/scripts/render-wrangler-config.mjs`
- `.github/scripts/smoke-quality-api.mjs`

## Important Invariants

- `language.id` is stable and public; do not repurpose it
- `label` is presentation-only
- changing `github_query_fragment` semantics requires a new `language.id`
- `active_to` stops future collection only; it does not hide published history
- threshold `0` means no stars qualifier in GitHub Search
- `latest` means latest published snapshot, not latest attempted run
- a day may have failed or missing collection; public series stay sparse

## Test / Validation Commands

Repo root:

```bash
make ci
```

