# HOT reload of the LOCAL web-terminal: restart ONLY server.js, leave the worker alive.
#
# The whole point of the three-process split is that pty-worker.js owns every PTY and
# server.js is stateless with respect to them. So when a change touches ONLY server.js
# (or app.html / a lib/ module the WEB side reads), killing server.js is enough: the
# monitor respawns it, it reattaches over IPC, and not one terminal session dies.
#
# USE THIS INSTEAD OF cold-restart.ps1 WHENEVER NOTHING WORKER-SIDE CHANGED. A cold
# restart kills every live PTY on the box; doing that to ship a server-only change costs
# the user every running session for no reason. Check first:
#     git diff --name-only <running-tag>..HEAD | grep -E 'pty-worker|^lib/'
# Anything there (including a lib/agents.js field the worker reads) means COLD, not hot —
# a hot reload would leave the OLD worker running and the fix would look like it failed.
#
# Kill rules, same hard-won ones as cold-restart.ps1:
#   * Match server.js by FULL PATH with -like, never -match: the `\p` in "pty-worker.js"
#     is read as a malformed \p{...} regex Unicode class and throws. (Not matched here,
#     but the filter is written the same way on purpose so the two scripts stay readable
#     as a pair.)
#   * Do NOT touch the monitor — it is the thing that respawns server.js, and killing it
#     turns a hot reload into an outage.
#   * Do NOT touch pty-worker.js — it is the whole reason this script exists.
#   * NEVER `taskkill /F /IM node.exe`.
#
# Launched DETACHED when driven over /api/exec, because that request is served BY the
# server.js being killed and dies mid-response.

param([switch]$CheckOnly)

$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo 'hot-reload.log'

function Note($m) { "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Note '=== hot reload requested (server.js only) ==='

$procs  = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
$server = $procs | Where-Object { $_.CommandLine -like "*$repo\server.js*" }
$worker = $procs | Where-Object { $_.CommandLine -like "*$repo\pty-worker.js*" }

if (-not $server) {
  Note 'no server.js found - nothing to reload'
  Write-Output 'no server.js running'
  exit 1
}

$msg = "server=$(($server | ForEach-Object { $_.ProcessId }) -join ',') worker=$(($worker | ForEach-Object { $_.ProcessId }) -join ',')"
if ($CheckOnly) {
  Note "check-only: $msg"
  Write-Output "would reload server.js only ($msg)"
  exit 0
}

# The worker must SURVIVE. Recording its pid lets the caller prove it did, which is the
# one claim a hot reload has to make.
$workerPidsBefore = ($worker | ForEach-Object { $_.ProcessId }) -join ','
Note "before: $msg"
$server | ForEach-Object { Note "kill server $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

# The monitor notices and respawns it; no relaunch here on purpose.
Start-Sleep -Seconds 6
$deadline = (Get-Date).AddSeconds(40)
$up = $false
while (-not $up -and (Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:7681/api/version' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $up = $true
  } catch {
    # 401 still proves it rebound the port — /api/version is behind auth.
    $code = $_.Exception.Response.StatusCode.value__
    if ($code) { $up = $true } else { Start-Sleep -Seconds 2 }
  }
}

$workerAfter = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$repo\pty-worker.js*" } |
  ForEach-Object { $_.ProcessId }) -join ','

Note "after: listening=$up workerBefore=$workerPidsBefore workerAfter=$workerAfter"
Write-Output "reloaded: listening=$up  worker survived: before=$workerPidsBefore after=$workerAfter"
Note '=== done ==='
