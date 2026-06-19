<#
.SYNOPSIS
  Raw GitHub activity volume per day from GHArchive (independent of GitHub Search).

.DESCRIPTION
  GHArchive (https://www.gharchive.org/) is the public GitHub event firehose. Because it
  is an event log — NOT the search index — it is the independent cross-check for "was
  there a real-world activity event on date X?" If LangPulse's search-derived counts jump
  but GHArchive event volume is flat, the jump is a search/index artifact, not real activity.

  Used to corroborate the 2026-05-19 LangPulse step-up: raw event volume, pushes, and
  distinct active repos on May 19 were ordinary weekday levels → no activity surge.

  Schema note (2026): the public firehose no longer emits repository-creation events; every
  CreateEvent has ref_type=branch. So per-day NEW-repo counts must come from the Search API
  (`created:DAY`, see github-daily-counts.ps1), not from here.

.PARAMETER Dates
  UTC dates to sample, yyyy-MM-dd. Accepts a comma-separated string or an array.

.PARAMETER Hours
  Hours (0-23, UN-padded — GHArchive filenames are e.g. `2026-05-19-7.json.gz`) to sample
  per day. Default 0,4,8,12,16,20 — a 6-point spread that smooths single-hour noise while
  keeping the download light (~6 x ~15 MB per day).

.EXAMPLE
  pwsh scripts/gharchive-activity.ps1 -Dates 2026-05-14,2026-05-18,2026-05-19,2026-05-20

.NOTES
  Requires curl, python, and write access to $env:TEMP. Downloads are deleted after counting.
#>
[CmdletBinding()]
param(
  [string[]]$Dates = @('2026-05-18', '2026-05-19', '2026-05-20'),
  [int[]]$Hours = @(0, 4, 8, 12, 16, 20)
)

$ErrorActionPreference = 'Stop'

$dates = @($Dates | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$dir = Join-Path $env:TEMP ('gharchive_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir | Out-Null

# Counter: total events, pushes, branch-creates, deletes, distinct active repos, unreadable files.
$py = Join-Path $dir 'count.py'
@'
import sys, gzip, json
total=push=createbr=delete=0
repos=set(); bad=0
for path in sys.argv[1:]:
    try:
        with gzip.open(path,"rb") as f:
            for line in f:
                total+=1
                try: o=json.loads(line)
                except Exception: continue
                t=o.get("type")
                if t=="PushEvent": push+=1
                elif t=="CreateEvent" and o.get("payload",{}).get("ref_type")=="branch": createbr+=1
                elif t=="DeleteEvent": delete+=1
                r=o.get("repo",{}).get("id")
                if r is not None: repos.add(r)
    except Exception:
        bad+=1
print(f"{total}\t{push}\t{createbr}\t{delete}\t{len(repos)}\t{bad}")
'@ | Set-Content -Path $py -Encoding UTF8

try {
  "day ({0}h sample)  dow    totalEvents      pushEv   newBranch   deleteEv   distinctRepos  badFiles" -f $Hours.Count
  foreach ($d in $dates) {
    $files = @()
    foreach ($h in $Hours) {
      $tmp = Join-Path $dir "$d-$h.json.gz"
      curl.exe -s -o $tmp "https://data.gharchive.org/$d-$h.json.gz"
      $files += $tmp
    }
    $parts = (python $py @files) -split "`t"
    $dow = ([datetime]::ParseExact($d, 'yyyy-MM-dd', $null)).DayOfWeek.ToString().Substring(0, 3)
    '{0}   {1}   {2,11}  {3,11}  {4,9}  {5,9}  {6,13}  {7,7}' -f $d, $dow, $parts[0], $parts[1], $parts[2], $parts[3], $parts[4], $parts[5]
  }
}
finally {
  try { [System.IO.Directory]::Delete($dir, $true) } catch { }
}
