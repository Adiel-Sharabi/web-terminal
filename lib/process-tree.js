'use strict';
// Which agent process is running INSIDE a session's PTY.
//
// A session's PTY is a shell (`bash.exe`); the agent is a descendant of it, often not a
// direct child. Answering "which codex is this session's" therefore means walking the
// tree from the PTY's pid. That single fact is what lets two Codex sessions in ONE
// folder be told apart — see lib/codex-match.js for what it is used for.
//
// The walk is pure and takes an injected snapshot, so it is unit-testable without
// spawning anything. Only `snapshot()` touches the OS.
const { execFile } = require('child_process');

// One WMI query serves EVERY session, so it is cached rather than run per session. The
// window is long enough that a session-list poll costs nothing and short enough that an
// agent started moments ago is picked up quickly.
const SNAPSHOT_TTL_MS = 15000;

let _cache = { at: 0, procs: null, inflight: null };

/**
 * Every descendant pid of `rootPid`, including nested ones (PTY -> shell -> codex).
 * Cycle-safe: a malformed parent chain (a pid that is its own ancestor) must not hang
 * the session list.
 */
function descendantsOf(procs, rootPid) {
  const byParent = new Map();
  for (const p of procs || []) {
    const arr = byParent.get(p.ppid) || [];
    arr.push(p);
    byParent.set(p.ppid, arr);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * The most recently started descendant whose image name matches `exeName`.
 *
 * Newest wins because a session that ran the agent, quit and ran it again is on its
 * SECOND conversation — the older process is history, and matching it would resurrect a
 * finished transcript.
 */
function newestDescendantNamed(procs, rootPid, exeName) {
  const want = String(exeName || '').toLowerCase();
  let best = null;
  for (const p of descendantsOf(procs, rootPid)) {
    if (String(p.name || '').toLowerCase() !== want) continue;
    if (!best || (p.startMs || 0) > (best.startMs || 0)) best = p;
  }
  return best;
}

/// Program names that ARE an agent, and names that mean "a command is running".
/// A shell BELOW the agent is a tool call; whatever it spawns (msbuild, dotnet,
/// npm) hangs below that shell, so counting the shell counts the whole command
/// without maintaining a list of build tools.
const AGENT_NAMES = new Set(['claude.exe', 'codex.exe', 'claude', 'codex']);
const SHELL_NAMES = new Set([
  'powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'sh.exe', 'zsh.exe',
]);

/**
 * Shell commands currently RUNNING inside the session rooted at `rootPid`.
 *
 * Why this exists: a session's status tracks the AGENT'S TURN, and the
 * transcript-derived badge only sees `run_in_background` launches. An ordinary
 * tool call — or anything that outlives the turn — is invisible to both.
 * Measured on Office: "sanity 147" reported `status=idle, backgroundTasks=[]`
 * while a real `powershell.exe -NoProfile -NonInteractive` was alive under its
 * agent (it exited minutes later). Only the process tree can see that.
 *
 * The discriminator comes from real trees, not guesswork:
 *
 *   bash.exe -> bash.exe -> claude.exe        the PTY chain + the agent
 *                             node/memory/python   MCP servers, in EVERY session
 *                             powershell.exe       <- a command  *** work ***
 *
 * So work = a SHELL descended from the AGENT. That subtracts the login chain
 * above the agent and the MCP servers beside it, with no allowlist to maintain.
 * Two sessions sampled with nothing running had no shell under their agent at
 * all, which is what makes this trustworthy rather than merely plausible.
 *
 * Returns `[{ pid, name }]`, outermost shell only — a shell that spawned another
 * shell is one command. Empty when the session has no agent: a plain shell
 * session has no "beside the agent" baseline, so the same rule would report the
 * user's own interactive shell as work.
 */
function runningShellsUnder(procs, rootPid) {
  if (!Array.isArray(procs) || !Number.isFinite(rootPid)) return [];
  const lower = (n) => String(n || '').toLowerCase();

  // Reuse descendantsOf's cycle-safety rather than re-walking by hand: collect
  // the agents under the PTY, then the shells under each agent.
  const all = descendantsOf(procs, rootPid);
  const agents = all.filter((p) => AGENT_NAMES.has(lower(p.name)));
  if (!agents.length) return [];

  const agentPids = new Set(agents.map((p) => p.pid));
  const out = [];
  const claimed = new Set();
  for (const agent of agents) {
    for (const p of descendantsOf(procs, agent.pid)) {
      if (!SHELL_NAMES.has(lower(p.name))) continue;
      if (agentPids.has(p.pid)) continue;
      // Outermost only: skip a shell that is itself under an already-claimed one.
      if (descendantsOf(procs, p.pid).some((c) => claimed.has(c.pid))) continue;
      if (claimed.has(p.pid)) continue;
      claimed.add(p.pid);
      out.push({ pid: p.pid, name: p.name });
    }
  }
  // Drop any shell that is a descendant of another reported shell (one command).
  return out.filter((s) => !out.some((other) =>
    other.pid !== s.pid && descendantsOf(procs, other.pid).some((d) => d.pid === s.pid)));
}

// --- OS access -------------------------------------------------------------------

// Windows only, and deliberately soft: every caller treats a null snapshot as "cannot
// tell", which falls back to the previous newest-in-cwd behaviour rather than erroring.
function _queryWindows() {
  return new Promise((resolve) => {
    // CSV out of WMIC-style CIM: ProcessId, ParentProcessId, Name, CreationDate.
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { " +
      "$_.ProcessId.ToString() + '|' + $_.ParentProcessId + '|' + $_.Name + '|' + " +
      "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const procs = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const parts = line.split('|');
          if (parts.length < 4) continue;
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          const startMs = parseInt(parts[3], 10);
          if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
          procs.push({ pid, ppid, name: parts[2], startMs: Number.isFinite(startMs) ? startMs : null });
        }
        resolve(procs.length ? procs : null);
      });
  });
}

/**
 * A cached process snapshot, or null when it cannot be taken (non-Windows, or the query
 * failed). Concurrent callers share one in-flight query — the session list resolves
 * every session in parallel, and without this each would spawn its own PowerShell.
 */
async function snapshot(now = Date.now()) {
  if (_cache.procs && now - _cache.at < SNAPSHOT_TTL_MS) return _cache.procs;
  if (_cache.inflight) return _cache.inflight;
  if (process.platform !== 'win32') return null;
  _cache.inflight = _queryWindows().then((procs) => {
    _cache = { at: Date.now(), procs, inflight: null };
    return procs;
  }).catch(() => { _cache.inflight = null; return null; });
  return _cache.inflight;
}

function _resetForTests() { _cache = { at: 0, procs: null, inflight: null }; }

module.exports = {
  descendantsOf, newestDescendantNamed, runningShellsUnder,
  snapshot, SNAPSHOT_TTL_MS, _resetForTests,
};
