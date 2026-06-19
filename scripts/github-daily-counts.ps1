<#
.SYNOPSIS
  Single-day GitHub repository creation / push counts via the Search API.

.DESCRIPTION
  LangPulse's published metric is a ROLLING 30-day count (repos with `pushed:>=D-29`).
  A rolling count can't tell you what happened on one specific calendar day. This tool
  queries GitHub Search for SINGLE-DAY windows (`created:DAY` and/or `pushed:DAY`) so a
  real activity event can be told apart from a search-index change:

    - real activity event  -> a SPIKE in created/pushed on that day
    - search-index change  -> rolling count jumps while single-day counts stay FLAT

  Built to diagnose the 2026-05-19 cross-language step-up in LangPulse. Single-day
  created/pushed showed only the normal weekday/weekend rhythm (no spike), so the jump
  came from GitHub's search index (re-index / backfill), not from newly created repos.

.PARAMETER From
  Inclusive start date, UTC, yyyy-MM-dd.

.PARAMETER To
  Inclusive end date, UTC, yyyy-MM-dd.

.PARAMETER Languages
  GitHub language names (the value inside `language:"X"`). Accepts a comma-separated
  string or an array. Omit for an aggregate `is:public` scan only.

.PARAMETER Metric
  created | pushed | both (default: both).

.PARAMETER DelayMs
  Delay between Search API calls. The authenticated Search API allows 30 req/min, so
  the default 2300 ms (~26/min) stays under both the primary and secondary limits.

.EXAMPLE
  pwsh scripts/github-daily-counts.ps1 -From 2026-05-14 -To 2026-05-24

.EXAMPLE
  pwsh scripts/github-daily-counts.ps1 -From 2026-05-15 -To 2026-05-21 -Languages go,python,rust -Metric created

.NOTES
  Requires an authenticated GitHub CLI (`gh auth status`). Counts reflect the index at
  query time; creation dates are immutable, so a genuine creation wave leaves a permanent
  per-day spike here even when queried weeks later.
#>
[CmdletBinding()]
param(
  [string]$From = '2026-05-14',
  [string]$To = '2026-05-24',
  [string[]]$Languages = @(),
  [ValidateSet('created', 'pushed', 'both')][string]$Metric = 'both',
  [int]$DelayMs = 2300
)

$ErrorActionPreference = 'Stop'

gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated. Run: gh auth login' }

# Allow -Languages "go,python" as well as -Languages go,python.
$langs = @($Languages | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Get-SearchCount([string]$query) {
  # Retry with linear backoff: search secondary rate limits surface as transient
  # non-zero exits, and a blank/non-numeric body means the query should be retried.
  for ($try = 0; $try -lt 4; $try++) {
    $body = gh api -X GET search/repositories -f q="$query" -f per_page=1 --jq '.total_count' 2>$null
    if ($LASTEXITCODE -eq 0 -and $body -match '^\d+$') { return [int64]$body }
    Start-Sleep -Seconds (5 * ($try + 1))
  }
  Write-Warning "query failed after retries: $query"
  return $null
}

$d0 = [datetime]::ParseExact($From, 'yyyy-MM-dd', $null)
$d1 = [datetime]::ParseExact($To, 'yyyy-MM-dd', $null)
if ($d1 -lt $d0) { throw 'To must be on or after From.' }

$days = @()
for ($d = $d0; $d -le $d1; $d = $d.AddDays(1)) { $days += $d.ToString('yyyy-MM-dd') }

$metrics = if ($Metric -eq 'both') { @('created', 'pushed') } else { @($Metric) }

# Subjects: the aggregate public scan first, then one row per requested language.
$subjects = @([pscustomobject]@{ Name = 'ALL (is:public)'; Fragment = 'is:public' })
foreach ($l in $langs) {
  $subjects += [pscustomobject]@{ Name = $l; Fragment = ('language:"{0}" is:public' -f $l) }
}

foreach ($m in $metrics) {
  ''
  "=== {0}:DAY — single-day repository count ===" -f $m
  $header = ('{0,-18}' -f 'subject \ date')
  foreach ($d in $days) { $header += ('{0,9}' -f $d.Substring(5)) }
  $header

  foreach ($s in $subjects) {
    $row = ('{0,-18}' -f $s.Name)
    foreach ($d in $days) {
      $count = Get-SearchCount ('{0} {1}:{2}' -f $s.Fragment, $m, $d)
      $row += ('{0,9}' -f $(if ($null -ne $count) { $count } else { '?' }))
      Start-Sleep -Milliseconds $DelayMs
    }
    $row
  }
}
