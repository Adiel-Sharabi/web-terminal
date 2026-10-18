'use strict';

/// Where the background-agent listing's child process actually gets started (#366).
///
/// Two transports with ONE contract - `exec(req) -> Promise<{ ok: true, stdout } | { ok: false, reason }>`,
/// where `req` is `{ bin, argv, env, cwd, timeoutMs }`. The promise ALWAYS settles and never
/// rejects; `reason` is a short code, never any of the child's output.
///
///  * createInlineExec - spawns in the calling thread. This is what runs INSIDE the worker
///    thread (lib/background-listing-worker.js), and what the tests drive directly.
///  * createThreadedExec - the one server.js uses: the same thing, hosted in a single
///    long-lived `worker_threads` Worker, so the spawn is not made on the server's main loop.
///
/// WHY NOT JUST SPAWN ON THE MAIN THREAD. On Windows Node's `spawn` / `execFile` runs
/// CreateProcess SYNCHRONOUSLY, so the time until `execFile` returns is an event-loop freeze,
/// and an AV that hooks process creation can make that seconds long (measured on adiel-home
/// under ESET: up to 8.3 s for cmd.exe, 13.9 s for PowerShell). `claude.exe` is ~290 MB, which
/// is exactly what an on-access scanner likes to look at. A watchdog armed after `execFile`
/// returns cannot bound that, so the spawn is moved off the loop that serves every request.
/// Each worker thread has a libuv loop of its own: a CreateProcess that blocks there blocks
/// only that thread. The measurement that decided this is in the #366 commit message.
///
/// TWO WATCHDOGS, because they guard different things:
///  * inside the thread (inline exec): the child ran too long -> kill its whole TREE;
///  * on the main thread (threaded exec): the THREAD itself is stuck - e.g. blocked in
///    CreateProcess, where its own timers cannot fire - so give up on it after
///    `timeoutMs + graceMs`, answer "unavailable", and terminate it. The main-thread timer
///    is the only one that still runs in that case.
const path = require('path');
const { Worker } = require('worker_threads');

/// stdout ceiling. A listing of live agents is a few KB; this only bounds a runaway.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/// How long past `timeoutMs` the main thread waits on the worker before abandoning it.
const WORKER_GRACE_MS = 3000;

const DEFAULT_WORKER_PATH = path.join(__dirname, 'background-listing-worker.js');

/// @param {object} o
/// @param {Function} o.execFile            child_process.execFile-compatible
/// @param {(pid:number)=>void} o.killTree  best-effort tree kill
/// @param {Function} [o.setTimer]          setTimeout-compatible; injectable so a test can fire
///                                         the watchdog at a moment of its choosing instead of
///                                         betting on how fast a stub process boots
function createInlineExec(o) {
  const setTimer = o.setTimer || setTimeout;
  return function exec(req) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };

      let child = null;
      try {
        child = o.execFile(req.bin, req.argv, {
          cwd: req.cwd,
          env: req.env,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: MAX_STDOUT_BYTES,
        }, (err, stdout) => {
          if (err) return done({ ok: false, reason: `exec:${err.code != null ? err.code : 'error'}` });
          done({ ok: true, stdout: String(stdout == null ? '' : stdout) });
        });
      } catch {
        return done({ ok: false, reason: 'spawn-threw' });
      }

      // An execFile that called back before returning has already settled: arming a
      // watchdog now would only leave a timer that fires into a finished request.
      if (settled) return;

      // Our own watchdog rather than execFile's `timeout`, which signals only the direct
      // child. Unref'd: a pending watchdog must never be what keeps the process alive.
      timer = setTimer(() => {
        try { if (child && child.pid) o.killTree(child.pid); } catch { /* best effort */ }
        done({ ok: false, reason: 'timeout' });
      }, req.timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  };
}

/// @param {object} [o]
/// @param {string} [o.workerPath]  the thread's entry script
/// @param {Function} [o.WorkerCtor] worker_threads.Worker-compatible (tests)
/// @param {number} [o.graceMs]
/// @returns {{ exec: Function, dispose: () => void, running: () => boolean }}
function createThreadedExec(o = {}) {
  const workerPath = o.workerPath || DEFAULT_WORKER_PATH;
  const WorkerCtor = o.WorkerCtor || Worker;
  const graceMs = o.graceMs != null ? o.graceMs : WORKER_GRACE_MS;

  let worker = null;                 // the live thread, created on first use
  let seq = 0;
  const pending = new Map();         // id -> { worker, settle }

  /// A thread that is gone, or being abandoned: forget it and fail what was waiting on it.
  function drop(w, reason) {
    if (worker === w) worker = null;
    for (const [id, p] of [...pending]) {
      if (p.worker === w) { pending.delete(id); p.settle({ ok: false, reason }); }
    }
  }

  function start() {
    const w = new WorkerCtor(workerPath);
    // Never let the thread be what keeps the server process alive. It dies with the
    // process (a hot reload TerminateProcess()es server.js and takes its threads along),
    // which is why this is a thread and not a forked helper that would be orphaned.
    if (typeof w.unref === 'function') w.unref();
    w.on('message', (m) => {
      const p = m && pending.get(m.id);
      if (!p || p.worker !== w) return;
      pending.delete(m.id);
      p.settle(m.result && typeof m.result === 'object' ? m.result : { ok: false, reason: 'worker-bad-reply' });
    });
    w.on('error', () => drop(w, 'worker-error'));
    w.on('exit', () => drop(w, 'worker-exit'));
    return w;
  }

  function terminate(w) {
    try { const r = w.terminate(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* gone */ }
  }

  function exec(req) {
    return new Promise((resolve) => {
      let w;
      try {
        if (!worker) worker = start();
        w = worker;
      } catch {
        worker = null;
        return resolve({ ok: false, reason: 'worker-start' });
      }

      const id = ++seq;
      let timer = null;
      const settle = (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      pending.set(id, { worker: w, settle });

      // The thread is stuck (or dead without saying so): abandon it, the next call starts a
      // fresh one. Whatever child it had started is left to finish on its own; a
      // `claude agents --json` that has begun runs for a fraction of a second.
      timer = setTimeout(() => {
        if (!pending.has(id)) return;
        drop(w, 'worker-timeout');
        terminate(w);
      }, Math.max(0, Number(req.timeoutMs) || 0) + graceMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        w.postMessage({ id, req });
      } catch {
        pending.delete(id);
        settle({ ok: false, reason: 'worker-post' });
        drop(w, 'worker-post');
        terminate(w);
      }
    });
  }

  /// Stop the thread (server shutdown). Anything still waiting is answered "unavailable".
  function dispose() {
    const w = worker;
    if (!w) return;
    drop(w, 'disposed');
    terminate(w);
  }

  return { exec, dispose, running: () => worker !== null };
}

module.exports = {
  createInlineExec, createThreadedExec, MAX_STDOUT_BYTES, WORKER_GRACE_MS, DEFAULT_WORKER_PATH,
};
