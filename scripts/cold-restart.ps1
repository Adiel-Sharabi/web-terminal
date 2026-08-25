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

#   * PREFLIGHT the runtime deps and ABORT if they cannot load. A wedged worker still owns
#     live PTYs; a monitor that gave up owns nothing. See scripts/check-deps.js for the
#     2026-07-30 outage this prevents. -CheckOnly runs just that check and kills nothing,
#     so a peer's tree can be audited over /api/exec without disturbing it.

param([switch]$CheckOnly)

$ErrorActionPreference = 'SilentlyContinue'
# Derived from this script's own location, so the same file works on every machine in the
# cluster — no per-host path to keep in sync.
$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $repo 'cold-restart.log'

function Note($m) { "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Note '=== cold restart requested (worker changed) ==='

# --- Preflight: are the runtime deps actually loadable? -------------------------------
# Must come before the first Stop-Process. Restarting a box whose node_modules is broken
# replaces a serving-from-memory server with a worker that cannot start at all.
#
# node is NOT resolved from PATH alone. The documented way to cold-restart a peer is over
# its /api/exec, whose shell runs with a trimmed environment (config `passAllEnv` defaults
# to false) — measured on Office and XPS, where `Get-Command node` finds nothing and the
# preflight silently skipped itself in exactly the case it exists for. So fall back to the
# interpreter ALREADY RUNNING this server (the most authoritative answer available: it is
# the one the worker will be relaunched with) and then to the default install location.

# That same trimmed environment arrives with PATHEXT set to just ".CPL" — measured on
# Office over /api/exec. Without .EXE in it PowerShell refuses to run node.exe as a
# program at all ("Cannot run a document in the middle of a pipeline"), which made this
# preflight ABORT a restart on a peer whose tree was perfectly healthy. Repair it for this
# process only; it also lets the PATH lookup below work at all.
if ($env:PATHEXT -notmatch '(?i)\.EXE') { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD;' + $env:PATHEXT }

function Resolve-NodeExe {
  $onPath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($onPath) { return $onPath }

  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$repo\server.js*" -or $_.CommandLine -like "*$repo\pty-worker.js*" } |
    Select-Object -First 1
  if ($running -and $running.ExecutablePath -and (Test-Path $running.ExecutablePath)) {
    return $running.ExecutablePath
  }

  foreach ($p in @((Join-Path "$env:ProgramFiles" 'nodejs\node.exe'), 'C:\Program Files\nodejs\node.exe')) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

$nodeExe = Resolve-NodeExe

# --- Machine-local agent config, applied by the deploy path ----------------------------
# scripts/install-codex-notify.js writes the three [tui] keys that turn on Codex's OSC 9
# status channel. It used to be a MANUAL per-machine step and the predictable happened
# (#82): the feature shipped in 1.45.0 and sat inert on every box, because an unconfigured
# machine is SILENT rather than noisy — notification_condition defaults to "unfocused" and
# a PTY has no focus state, so nothing is emitted and nothing surfaces the gap.
#
# A cold restart is already REQUIRED for this config to take effect (it is worker-side), so
# it is the one operation that cannot legitimately be skipped — which makes it the right
# owner. The installer is idempotent (no change => no write, no backup) and re-stamps
# `notify`'s absolute path, so a repo that moved self-heals on the next deploy.
#
# NON-FATAL by construction: a machine with no codex exits 1, and that must never block a
# restart of the terminal server. Config drift is a warning, not an outage.
function Invoke-CodexNotifyConfig([switch]$Check) {
  if (-not $nodeExe) { return 'skipped (no node found)' }
  $js = Join-Path $repo 'scripts\install-codex-notify.js'
  if (-not (Test-Path $js)) { return 'skipped (installer not present)' }
  try {
    if ($Check) { $out = (& $nodeExe $js --check 2>&1 | Out-String).Trim() }
    else        { $out = (& $nodeExe $js       2>&1 | Out-String).Trim() }
  } catch {
    return "skipped (could not run: $($_.Exception.Message))"
  }
  if (-not $out) { $out = '(no output)' }
  return ($out -replace '\s*\r?\n\s*', ' | ')
}

# scripts/install-hooks.js owns the Claude Code hook set in ~/.claude/settings.json.
# Same lesson as the Codex block above, one layer up: the set had NO owner in this repo
# (both siblings referenced a "fix-hooks.js" that was never a file), so every machine ran
# whatever eight events had once been pasted in by hand and nobody noticed SessionStart
# was missing - which left a started-or-resumed session reporting no conversation id at
# all, and a chat lens returning 404 next to a live terminal.
#
# Unlike the Codex config this needs no restart (hooks are read per agent launch); it
# rides the deploy path purely so it is APPLIED rather than remembered. Idempotent, and
# it only ever touches web-terminal's own entry, so user hooks are safe.
#
# NON-FATAL: a machine without Claude Code exits 1, which must never block a restart.
function Invoke-ClaudeHooksConfig([switch]$Check) {
  if (-not $nodeExe) { return 'skipped (no node found)' }
  $js = Join-Path $repo 'scripts\install-hooks.js'
  if (-not (Test-Path $js)) { return 'skipped (installer not present)' }
  try {
    if ($Check) { $out = (& $nodeExe $js --check 2>&1 | Out-String).Trim() }
    else        { $out = (& $nodeExe $js       2>&1 | Out-String).Trim() }
  } catch {
    return "skipped (could not run: $($_.Exception.Message))"
  }
  if (-not $out) { $out = '(no output)' }
  return ($out -replace '\s*\r?\n\s*', ' | ')
}

# scripts/install-statusline.js writes the two things the ctx/token badges need: the
# push block in ~/.claude/claude-status.sh, and the settings.json `statusLine` entry
# that makes Claude Code actually RUN it. Same reasoning as the Codex config above and
# the same failure mode (#82): an unconfigured machine is SILENT, not noisy - no line
# in the terminal and no badge in the sidebar looks exactly like a feature that was
# never built, so it goes unreported until someone compares two boxes side by side.
# That is how a machine was found in that state long after the feature shipped.
#
# UNLIKE the Codex config, this one must run AFTER the relaunch: the installer refuses
# to point a machine at the raw-payload pusher until a server confirms it can read one
# (an older server stores a raw payload as four blank numbers, emptying every badge on
# the box), and during a restart there is no server to ask. Running it before the kill
# would ask the OUTGOING build - the pre-pull one - which is the wrong question.
#
# NON-FATAL, like its sibling: the relaunch has already happened by this point, so
# nothing here can cost an outage. Config drift is a warning.
function Invoke-StatusLineConfig([switch]$Check) {
  if (-not $nodeExe) { return 'skipped (no node found)' }
  $js = Join-Path $repo 'scripts\install-statusline.js'
  if (-not (Test-Path $js)) { return 'skipped (installer not present)' }
  # No try/catch here: $ErrorActionPreference is SilentlyContinue at the top of
  # this file and a native exe does not throw anyway, so that catch never fired -
  # and a genuine REFUSAL (a foreign statusLine, an unparseable settings.json, a
  # missing pusher) then read in the deploy log exactly like a success. This one
  # line is the only signal anyone gets, so the exit code has to reach it. Checked
  # via $LASTEXITCODE, the same way check-deps.js is below; $? is no good here
  # because 2>&1 on a native exe wraps stderr in ErrorRecords and clears it even
  # on a clean exit.
  $global:LASTEXITCODE = $null
  if ($Check) { $out = (& $nodeExe $js --check 2>&1 | Out-String).Trim() }
  else        { $out = (& $nodeExe $js       2>&1 | Out-String).Trim() }
  $code = $LASTEXITCODE
  if (-not $out) { $out = '(no output)' }
  if ($code -ne 0) { $out = "FAILED (exit $code): $out" }
  return ($out -replace '\s*\r?\n\s*', ' | ')
}

if ($nodeExe) {
  $global:LASTEXITCODE = $null
  $depOut = (& $nodeExe (Join-Path $repo 'scripts\check-deps.js') 2>&1 | Out-String).Trim()

  if ($null -eq $LASTEXITCODE) {
    # The check could not be RUN at all — an environment problem, not a broken tree. Only a
    # real verdict may block a restart, so this reports rather than aborts. (Without this,
    # a launch failure left LASTEXITCODE unset and `-ne 0` aborted with an EMPTY message,
    # which is exactly how a healthy peer was told its deps were unloadable.)
    $depOut = "skipped (could not run check-deps.js) $depOut".Trim()
    Note "preflight SKIPPED - could not run the check: $depOut"
  } elseif ($LASTEXITCODE -ne 0) {
    Note "ABORTED - runtime deps not loadable, nothing killed: $depOut"
    Write-Output "cold restart ABORTED - runtime deps not loadable, nothing killed:"
    Write-Output $depOut
    exit 1
  } else {
    Note "preflight: $depOut"
  }
} else {
  # Nothing running and no node anywhere we know to look: there is nothing to kill, so the
  # relaunch is the only part that matters and blocking it would be worse than proceeding.
  $depOut = 'skipped (no node found)'
  Note 'preflight SKIPPED - no node found on PATH, in the running server, or in Program Files'
}

if ($CheckOnly) {
  # Report config drift too — auditing a peer over /api/exec is the cheapest moment to
  # notice that its Codex status channel is unconfigured, and --check changes nothing.
  $cfgCheck = Invoke-CodexNotifyConfig -Check
  $hookCheck = Invoke-ClaudeHooksConfig -Check
  # The peer is LIVE during an audit, so the status-line installer can complete its
  # server-version probe here - the one moment --check gives a real verdict.
  $slCheck = Invoke-StatusLineConfig -Check
  Note "check-only: nothing killed; codex notify config: $cfgCheck; claude hooks: $hookCheck; status line: $slCheck"
  Write-Output "preflight OK: $depOut"
  Write-Output "codex notify config: $cfgCheck"
  Write-Output "claude hooks: $hookCheck"
  Write-Output "status line: $slCheck"
  exit 0
}

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

# --- Repair: relink node_modules\.bin, ONLY while the worker is stopped ----------------
# This window is the whole point: the bins live inside node_modules, and the worker holds
# node-pty's OpenConsole.exe open, which is what makes an npm write fail half-done.
#
# Why it can be missing at all: the 2026-07-30 deletion took .bin with the packages, and
# the recovery `npm install` did NOT put it back — its reify aborted on the EPERM from that
# locked binary. The damage is quiet but nasty: without .bin, `npx playwright test` runs a
# DIFFERENT physical copy of playwright out of the npx cache, the specs register on the
# local one, and every run reports "No tests found" — a gate that looks like it ran and ran
# nothing.
#
# `rebuild` is chosen deliberately over `ci`/`install`: it RELINKS bins from the packages
# already on disk — no delete, no download — so a failure here cannot leave the box without
# node_modules, which is the very outage this script now guards against. --ignore-scripts
# keeps it away from node-pty's native build. Verified in an isolated tree before shipping:
# deleting .bin and running this restores all 21 entries.
$binDir = Join-Path $repo 'node_modules\.bin'
if ($nodeExe -and -not (Test-Path $binDir)) {
  $npmCli = Join-Path (Split-Path $nodeExe -Parent) 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path $npmCli) {
    Note 'node_modules\.bin missing - relinking (worker stopped, locks released)'
    Push-Location $repo
    $rebuildOut = (& $nodeExe $npmCli rebuild --ignore-scripts --no-audit --no-fund 2>&1 | Out-String).Trim()
    Pop-Location
    Note "bin relink: exit=$LASTEXITCODE  present=$(Test-Path $binDir)  $rebuildOut"
  } else {
    Note "bin relink SKIPPED - npm-cli.js not found at $npmCli"
  }
}

# Apply the machine-local agent config before the relaunch, so a box that was never
# hand-patched comes back configured instead of silently inert (see the function above).
Note "codex notify config: $(Invoke-CodexNotifyConfig)"
Note "claude hooks: $(Invoke-ClaudeHooksConfig)"

# GUI-subsystem launcher: wscript runs node hidden, so no console window flashes.
Note 'relaunching via start-server.vbs'
Start-Process -FilePath 'wscript.exe' -ArgumentList (Join-Path $repo 'start-server.vbs') -WorkingDirectory $repo

# Readiness, not identity: /api/version is behind auth, so an unauthenticated probe gets a
# 401 — which still proves the server is LISTENING again, and is the answer we want here. Any
# HTTP status means it rebound the port; only a connection error means it did not come back.
# (Treating that 401 as a failure is what made a healthy restart log "version probe failed".)
Start-Sleep -Seconds 6
$deadline = (Get-Date).AddSeconds(30)
$up = $false
while (-not $up -and (Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:7681/api/version' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $up = $true
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code) { $up = $true; Note "back up: listening (HTTP $code)" }
    else { Start-Sleep -Seconds 2 }
  }
}
if (-not $up) { Note 'DID NOT COME BACK — no HTTP response on 7681' }

# The status-line config is applied HERE, after the readiness probe above, rather than
# beside the Codex config before the relaunch — the installer refuses to act until a
# server confirms it can read a raw payload, and before the relaunch there is none to
# ask (asking the OUTGOING build would answer for the pre-pull version). Reuses that
# probe's verdict rather than waiting again: $up is exactly the precondition.
if ($up) {
  Note "status line config: $(Invoke-StatusLineConfig)"
} else {
  Note 'status line config SKIPPED - server did not come back, nothing to probe'
}
Note '=== done ==='
