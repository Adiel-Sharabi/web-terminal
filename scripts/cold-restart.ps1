# COLD restart of the LOCAL web-terminal (monitor + worker + server), then relaunch.
#
# A cold restart is required whenever pty-worker.js (or a lib/agents.js field it reads)
# changes — a hot server.js-only reload leaves the OLD worker running with the OLD
# behaviour, and the fix looks like it did not work.
#
# This script is launched DETACHED on purpose: it kills the very process tree that spawned
# it (every PTY on this box dies with the worker, including the terminal that started this),
# so it must not be a child of anything it is about to kill.
#
# Kill rules, learned the hard way:
#   * Match server.js / pty-worker.js by FULL PATH with -like, never -match: the `\p` in
#     "pty-worker.js" is read as a malformed \p{...} regex Unicode class and throws.
#   * monitor.js has no path in its CommandLine, so it cannot be matched by name. Find it as
#     the PARENT of the matched server/worker instead.
#   * NEVER `taskkill /F /IM node.exe` — that blanket-kills MCP servers, PM2, and every other
#     unrelated node process on the machine.

$ErrorActionPreference = 'SilentlyContinue'
# Derived from this script's own location, so the same file works on every machine in the
# cluster — no per-host path to keep in sync.
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo 'cold-restart.log'

function Note($m) { "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Note '=== cold restart requested (worker changed) ==='

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"

$targets = $procs | Where-Object {
  $_.CommandLine -like "*$repo\server.js*" -or $_.CommandLine -like "*$repo\pty-worker.js*"
}

# The monitor supervises them and would just respawn what we kill, so it goes first —
# identified by being the PARENT of a server/worker we matched, since its own CommandLine
# carries no path.
$monitorIds = $targets | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique
$monitors = $procs | Where-Object { $monitorIds -contains $_.ProcessId }

foreach ($m in $monitors) { Note "kill monitor  $($m.ProcessId)" }
foreach ($t in $targets)  { Note "kill target   $($t.ProcessId)  $($t.CommandLine)" }

$monitors | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 400
$targets  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Let the port and the named pipe actually release before rebinding them.
Start-Sleep -Seconds 3

# GUI-subsystem launcher: wscript runs node hidden, so no console window flashes.
Note 'relaunching via start-server.vbs'
Start-Process -FilePath 'wscript.exe' -ArgumentList (Join-Path $repo 'start-server.vbs') -WorkingDirectory $repo

Start-Sleep -Seconds 6
try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:7681/api/version' -TimeoutSec 5
  Note "back up: version $($v.version)"
} catch {
  Note "version probe failed: $($_.Exception.Message)"
}
Note '=== done ==='
