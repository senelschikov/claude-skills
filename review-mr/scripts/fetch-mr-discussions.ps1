# Fetch a GitLab MR's metadata and all review discussions through the API (read-only).
# Prints: target/source branch, state, head SHA, description size, then every human thread with
# file:line, resolved state, the commit it was written against, and all notes. Optionally
# saves the raw discussions JSON (-JsonOut) for scripted triage.
#
# Token: $env:GITLAB_TOKEN / $env:GL_TOKEN, else the Windows user-level GITLAB_TOKEN (read now,
# so a session started earlier still finds it). Needs `read_api`. The token is never printed.
#
# Usage: powershell.exe -NoProfile -File fetch-mr-discussions.ps1 -Mr <N> [-Repo <dir>] [-JsonOut <file>]
# Exit:  0 ok · 3 no token · 1 error
param(
  [Parameter(Mandatory = $true)][string]$Mr,
  [string]$Repo = ".",
  [string]$JsonOut = ""
)
$ErrorActionPreference = "Stop"
$Mr = $Mr.TrimStart('!', '#')
if ($Mr -notmatch '^\d+$') { Write-Output "MR must be a number, got: $Mr"; exit 1 }

$origin = (git -C $Repo remote get-url origin).Trim()
if ($origin -match '^https?://([^/]+)/(.+?)(\.git)?$') { $glHost = $Matches[1] -replace '^.*@', ''; $path = $Matches[2] }
elseif ($origin -match '^[^@]+@([^:]+):(.+?)(\.git)?$') { $glHost = $Matches[1]; $path = $Matches[2] }
else { Write-Output "Cannot parse origin: $origin"; exit 1 }
$api = "https://$glHost/api/v4/projects/$([uri]::EscapeDataString($path))/merge_requests/$Mr"

$token = $env:GITLAB_TOKEN
if (-not $token) { $token = $env:GL_TOKEN }
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('GITLAB_TOKEN', 'User') }
if (-not $token) { Write-Output "NO_TOKEN: set GITLAB_TOKEN (scope: read_api) at Windows user level and retry"; exit 3 }
$h = @{ 'PRIVATE-TOKEN' = $token }

try {
  $m = Invoke-RestMethod -Uri $api -Headers $h -TimeoutSec 30
  $all = @(); $page = 1
  do {
    $r = Invoke-WebRequest -Uri "$api/discussions?per_page=100&page=$page" -Headers $h -TimeoutSec 30 -UseBasicParsing
    $all += ($r.Content | ConvertFrom-Json); $next = $r.Headers['X-Next-Page']; $page++
  } while ($next)
} catch { Write-Output "FETCH_FAILED: $($_.Exception.Message)"; exit 1 }

$desc = if ($m.description) { $m.description.Length } else { 0 }
Write-Output "MR: !$($m.iid) $($m.title)"
Write-Output "URL: $($m.web_url)"
Write-Output "STATE: $($m.state) | $($m.source_branch) -> $($m.target_branch) | head $($m.sha) | author $($m.author.username)"
Write-Output "DESCRIPTION: $desc chars$(if ($desc -eq 0) { ' (empty)' })"

$n = 0
foreach ($d in $all) {
  $notes = @($d.notes | Where-Object { -not $_.system })
  if ($notes.Count -eq 0) { continue }
  $n++; $first = $notes[0]; $pos = $first.position
  $where = if ($pos) { "$(if ($pos.new_path) { $pos.new_path } else { $pos.old_path }):$(if ($pos.new_line) { $pos.new_line } else { $pos.old_line })" } else { "(general)" }
  $state = if (-not $first.resolvable) { "-" } elseif ($first.resolved) { "resolved" } else { "open" }
  $sha = if ($pos -and $pos.head_sha) { $pos.head_sha.Substring(0, 9) } else { "" }
  Write-Output ""
  Write-Output "=== THREAD $n [$state] $where  discussion=$($d.id)  commit=$sha"
  foreach ($x in $notes) {
    Write-Output "--- $($x.author.username) @ $($x.created_at.ToString().Substring(0, 16)):"
    Write-Output $x.body.Trim()
  }
}
Write-Output ""
Write-Output "THREADS: $n"
if ($JsonOut) { ($all | ConvertTo-Json -Depth 12) | Out-File -Encoding utf8 $JsonOut; Write-Output "JSON: $JsonOut" }
