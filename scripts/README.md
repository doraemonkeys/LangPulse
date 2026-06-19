# scripts/

Ad-hoc diagnostic tools for LangPulse data anomalies. These are operator tools, not part
of the collector/worker/web build or CI.

## Why these exist

LangPulse publishes one metric: a **rolling 30-day count** of public repos with
`pushed:>=D-29` per language. A rolling count tells you the *level*, never what happened on
a single day. When every language stepped up on 2026-05-19, these scripts were used to tell
apart the only two things that can move that metric:

- a **real activity event** (new/active repos on that day) → shows up as a single-day spike
  in `created:`/`pushed:` and in the raw event stream;
- a **GitHub search-index / counting change** (re-index, backfill) → the rolling count jumps
  while single-day activity stays flat.

For May 19 the single-day signals were flat → the jump was on GitHub's search/index side.

## Prerequisites

- `github-daily-counts.ps1`: an authenticated GitHub CLI (`gh auth status`).
- `gharchive-activity.ps1`: `curl` and `python` on `PATH`, plus write access to `$env:TEMP`.

## Tools

### `github-daily-counts.ps1`

Single-day `created:` / `pushed:` repo counts via the GitHub Search API, with an aggregate
`is:public` row plus one row per requested language.

```powershell
# Aggregate scan across a date range
pwsh scripts/github-daily-counts.ps1 -From 2026-05-14 -To 2026-05-24

# Per-language, creations only
pwsh scripts/github-daily-counts.ps1 -From 2026-05-15 -To 2026-05-21 -Languages go,python,rust -Metric created
```

Note: counts reflect the index *at query time*. Creation dates are immutable, so a genuine
creation wave still leaves a permanent per-day spike here even when queried weeks later.

### `gharchive-activity.ps1`

Raw activity volume per day from [GHArchive](https://www.gharchive.org/) (the public event
firehose) — **independent of GitHub Search**, so it answers "was there a real activity event
on date X?" Downloads a spread of hourly files, counts events, then deletes them.

```powershell
pwsh scripts/gharchive-activity.ps1 -Dates 2026-05-14,2026-05-18,2026-05-19,2026-05-20
```

Schema caveat (2026): the public firehose no longer emits repository-creation events (every
`CreateEvent` is `ref_type=branch`). Per-day **new-repo** counts must come from
`github-daily-counts.ps1` (`created:DAY`), not from here.

## Rate limits

The Search API allows 30 req/min when authenticated; `github-daily-counts.ps1` paces itself
(`-DelayMs`, default 2300 ms). A wide range × many languages × `both` metrics can take a few
minutes.
