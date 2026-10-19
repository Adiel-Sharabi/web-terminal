'use strict';
// #377 - which session ASKED for a new one, when the caller did not say.
//
// #374 lets an agent name itself as the parent of a session it opens (`parentId`). A
// script that only sends `spawnedBy` - a display name - leaves nothing to hang the new
// session under. But a local caller is a process on this box, and its ancestry leads
// back to the PTY shell of the session it runs in: curl.exe -> powershell (the script)
// -> the agent's tool shell -> the agent -> the session's shell. That shell's pid is
// what the worker reports as the session's `pid`, so the walk names the session.
//
// Two OS reads, both while the request is still open (the caller is alive until it gets
// its answer): netstat names the process on the CLIENT end of the request's connection,
// and lib/process-tree.js's shared snapshot gives every process's parent. The rest is
// pure. Measured on adiel-home: netstat ~35 ms; a per-process CIM walk instead cost
// ~200 ms PER LEVEL (3 s for a typical chain), which is why the snapshot is reused.
//
// A parent that started AFTER its child is not its parent - Windows reuses pids and a
// child keeps a dead parent's pid - so the walk stops there rather than wander into an
// unrelated tree. Everything fails closed to null (no parent), which is exactly what a
// caller that sends neither field already gets. Windows only; elsewhere null.

const path = require('path');
const { execFile } = require('child_process');
const processTree = require('./process-tree');

const MAX_DEPTH = 16;
const NETSTAT_TIMEOUT_MS = 5000;
// How long a create waits for its trace before answering. The caller has to stay connected
// while netstat looks for it (it exits once answered), but a process query that hangs - one
// took 25s on office-tests (#280) - must not hold a create; a later answer still lands.
const TRACE_WAIT_MS = 1500;

function isLoopback(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// `  TCP    127.0.0.1:57956    127.0.0.1:7681    ESTABLISHED    12345` (or `[::1]:57956`).
// Only the address and port are read, never the state word: Windows translates it.
function endpoint(e) {
  const m = /^(.*):(\d+)$/.exec(String(e || ''));
  return m ? { host: m[1], port: Number(m[2]) } : null;
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]']);

/** The pid owning the client end of a loopback connection clientPort -> serverPort. */
function netstatOwner(stdout, clientPort, serverPort) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'TCP') continue;
    const local = endpoint(f[1]);
    const foreign = endpoint(f[2]);
    if (!local || !foreign || local.port !== clientPort || foreign.port !== serverPort) continue;
    if (!LOOPBACK_HOSTS.has(local.host) || !LOOPBACK_HOSTS.has(foreign.host)) continue;
    // A closed connection keeps its row for a while with pid 0 (TIME_WAIT).
    const pid = Number(f[f.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** [pid] and its ancestors, caller first, from a process-tree snapshot. */
function chainFrom(pid, procs) {
  const byPid = new Map();
  for (const p of procs || []) byPid.set(p.pid, p);
  const out = [];
  let cur = byPid.get(pid);
  let born = null;
  while (cur && out.length < MAX_DEPTH && !out.includes(cur.pid)) {
    if (born != null && cur.startMs != null && cur.startMs > born) break;
    out.push(cur.pid);
    born = cur.startMs;
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/** The first session (by its shell pid) on [chain], caller first; null when none. */
function sessionInChain(chain, sessions) {
  const byPid = new Map();
  for (const s of sessions || []) {
    if (s && s.id && Number.isInteger(s.pid)) byPid.set(s.pid, s.id);
  }
  for (const pid of chain || []) {
    if (byPid.has(pid)) return byPid.get(pid);
  }
  return null;
}

function _netstat() {
  if (process.platform !== 'win32') return Promise.resolve('');
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'NETSTAT.EXE');
  return new Promise((resolve) => {
    // No `-p TCP`: that filter is IPv4-only; the rows read above are TCP either way.
    execFile(exe, ['-ano'], { windowsHide: true, timeout: NETSTAT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout));
  });
}

let _io = { netstat: _netstat, snapshot: (opts) => processTree.snapshot(Date.now(), opts) };

/**
 * The id of the session whose process made the request on [socket], or null. Only a
 * loopback connection can be traced: anything else came from another machine, or
 * through a proxy whose own process is all the connection shows.
 */
async function callerSession(socket, sessions) {
  try {
    if (!socket || !isLoopback(socket.remoteAddress)) return null;
    const owner = netstatOwner(await _io.netstat(), socket.remotePort, socket.localPort);
    if (owner == null) return null;
    // Fresh, not the cached copy: the caller started moments ago. A query already in
    // flight may predate it, so one that lacks the caller is retried once.
    let procs = await _io.snapshot({ maxAgeMs: 0 });
    if (procs && !procs.some((p) => p.pid === owner)) procs = await _io.snapshot({ maxAgeMs: 0 });
    return sessionInChain(chainFrom(owner, procs), sessions);
  } catch {
    return null;
  }
}

function _setIoForTests(io) {
  _io = io ? { ..._io, ...io } : { netstat: _netstat, snapshot: (opts) => processTree.snapshot(Date.now(), opts) };
}

module.exports = { callerSession, sessionInChain, chainFrom, netstatOwner, isLoopback, MAX_DEPTH, TRACE_WAIT_MS, _setIoForTests };
