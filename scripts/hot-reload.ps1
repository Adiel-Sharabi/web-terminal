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

# --- #579: refuse a reload nothing would recover from -----------------------------------
# Killing server.js is a reload ONLY because monitor.js respawns it. A server.js whose parent
# is not a running monitor.js (an orphan - the old /api/restart left one on every machine on
# 2026-11-26) has nothing to bring it back: the reload that killed those orphans left five
# peers dark until each was cold-restarted by hand. Refuse, say why, kill nothing.
$unsupervised = @($server | Where-Object {
  $ppid = $_.ParentProcessId
  -not ($procs | Where-Object { $_.ProcessId -eq $ppid -and $_.CommandLine -like '*monitor.js*' })
})
if ($unsupervised.Count -gt 0) {
  $who = ($unsupervised | ForEach-Object { "$($_.ProcessId) (parent $($_.ParentProcessId))" }) -join ', '
  Note "REFUSED - server.js not supervised by monitor.js: $who; nothing killed"
  Write-Output "hot reload REFUSED - server.js $who is not a child of a running monitor.js, so nothing would restart it. Nothing killed. Cold-restart this machine (scripts/cold-restart.ps1) instead."
  exit 3
}

# --- Preflight: can the respawned server.js load its deps? ------------------------------
# A running server serves its modules from memory, so a broken node_modules answers 200
# until the respawn dies on `Cannot find module` (office-tests 2026-08-04). Same gate as
# cold-restart.ps1; only a real verdict blocks. The trimmed /api/exec environment can carry
# PATHEXT=.CPL, which stops PowerShell running node.exe at all - repair it for this process.
if ($env:PATHEXT -notmatch '(?i)\.EXE') { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD;' + $env:PATHEXT }
$nodeExe = ($server | Select-Object -First 1).ExecutablePath
if ($nodeExe -and (Test-Path $nodeExe)) {
  $global:LASTEXITCODE = $null
  $depOut = (& $nodeExe (Join-Path $repo 'scripts\check-deps.js') 2>&1 | Out-String).Trim()
  if ($null -eq $LASTEXITCODE) {
    Note "preflight SKIPPED - could not run check-deps.js: $depOut"
  } elseif ($LASTEXITCODE -ne 0) {
    Note "ABORTED - runtime deps not loadable, nothing killed: $depOut"
    Write-Output 'hot reload ABORTED - runtime deps not loadable, nothing killed:'
    Write-Output $depOut
    exit 1
  } else {
    Note "preflight: $depOut"
  }
} else {
  Note 'preflight SKIPPED - could not read the running node.exe path'
}

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
