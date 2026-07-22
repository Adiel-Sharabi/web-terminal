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

module.exports = { descendantsOf, newestDescendantNamed, snapshot, SNAPSHOT_TTL_MS, _resetForTests };
