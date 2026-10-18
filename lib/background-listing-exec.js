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
/// TWO DEADLINES, and only ONE of them ever kills anything:
///  * inside the thread (inline exec): the CHILD ran too long -> kill its whole TREE. The
///    budget is the ABSOLUTE deadline the main thread sent with the request (its send time
///    plus `timeoutMs`), not a fresh `timeoutMs` from when `execFile` returned or from when
///    the thread got round to the message. So time inside a blocked CreateProcess counts
///    against the child: if the spawn ate the budget the child is killed the moment it
///    exists, and a request whose deadline passed while it sat in a stuck thread's queue is
///    answered "expired" WITHOUT being spawned - the main thread stopped waiting for it long
///    ago, and starting claude.exe for nobody on recovery is pure waste.
///  * on the main thread (threaded exec): stop WAITING for the thread after
///    `timeoutMs + graceMs` and answer "unavailable". That is all it does. It must not
///    terminate the thread: the thread's own deadline is the only thing that tree-kills the
///    child, and a terminated thread takes that timer with it, orphaning a claude.exe on
///    every window. A late reply is simply ignored. The thread is replaced only when it
///    reports that it died ('error' / 'exit'), and stopped only by dispose().
///
/// KNOWN LIMITATION, not fixed. On Windows libuv starts the child with CreateProcessW and
/// inherited handles, so a child created by ANOTHER thread of this process at the same
/// moment (the main loop's git / PowerShell spawns) can inherit the write end of this
/// child's stdout pipe. The pipe then does not reach EOF until that other child exits, and
/// the listing can time out spuriously. The result is one `{available:false}` held for a TTL
/// window - a missing strip for a while, never wrong data.
const path = require('path');
const { Worker } = require('worker_threads');

/// stdout ceiling. A listing of live agents is a few KB; this only bounds a runaway.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/// How long past `timeoutMs` the main thread waits on the worker before it stops waiting.
const WORKER_GRACE_MS = 3000;

const DEFAULT_WORKER_PATH = path.join(__dirname, 'background-listing-worker.js');

/// @param {object} o
/// @param {Function} o.execFile            child_process.execFile-compatible
/// @param {(pid:number)=>void} o.killTree  best-effort tree kill
/// @param {Function} [o.setTimer]          setTimeout-compatible; injectable so a test can fire
///                                         the watchdog at a moment of its choosing instead of
///                                         betting on how fast a stub process boots
/// @param {() => number} [o.now]           ms clock; injectable for the same reason
/// @returns {(req: object, deadline?: number) => Promise<object>} `deadline` is the absolute
///          ms-epoch instant the child must be dead by (default: now + `req.timeoutMs`)
function createInlineExec(o) {
  const setTimer = o.setTimer || setTimeout;
  const now = o.now || Date.now;
  return function exec(req, deadline) {
    const due = Number.isFinite(deadline) ? deadline : now() + (Number(req.timeoutMs) || 0);
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
      // child. Its budget is what is LEFT until the sender's deadline - zero when the spawn
      // alone used it up, which kills the child on the next turn of the loop. Unref'd: a
      // pending watchdog must never be what keeps the process alive.
      const remaining = Math.max(0, due - now());
      timer = setTimer(() => {
        try { if (child && child.pid) o.killTree(child.pid); } catch { /* best effort */ }
        done({ ok: false, reason: 'timeout' });
      }, remaining);
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

  /// A thread that is gone (or being disposed): forget it and fail what was waiting on it.
  function drop(w, reason) {
    if (worker === w) worker = null;
    for (const [id, p] of [...pending]) {
      if (p.worker === w) { pending.delete(id); p.settle({ ok: false, reason }); }
    }
  }

  function start() {
    const w = new WorkerCtor(workerPath);
    // Never let the thread be what keeps the server process alive. (Keeping the process
    // alive is not the same as not delaying its exit: Node joins its worker threads when it
    // exits, and a thread blocked inside a native CreateProcessW cannot be interrupted, so a
    // shutdown that lands during a blocked spawn waits that spawn out.)
    if (typeof w.unref === 'function') w.unref();
    w.on('message', (m) => {
      const p = m && pending.get(m.id);
      // No pending entry: the main thread already gave up on this request (its deadline
      // passed) or the thread was replaced. A late reply changes nothing.
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
      const timeoutMs = Math.max(0, Number(req.timeoutMs) || 0);
      // Absolute, and stamped on THIS side: the thread cannot know how long the message sat
      // in its queue behind a blocked spawn, but it can compare this with its own clock
      // (threads of one process share it).
      const deadline = Date.now() + timeoutMs;
      let timer = null;
      const settle = (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      pending.set(id, { worker: w, settle });

      // Stop WAITING; do not touch the thread. If it is blocked in CreateProcess it will
      // come back, see the request's deadline has passed and kill its own child; if it is
      // busy with an earlier request this one simply queues behind it (the thread is serial
      // when blocked). The single-flight and failure cache upstream keep that queue short.
      timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        resolve({ ok: false, reason: 'worker-timeout' });
      }, timeoutMs + graceMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        w.postMessage({ id, req, deadline });
      } catch {
        // The message could not be sent (e.g. not cloneable): that says nothing about the
        // thread, so it is left running.
        pending.delete(id);
        settle({ ok: false, reason: 'worker-post' });
      }
    });
  }

  /// Stop the thread (server shutdown). Anything still waiting is answered "unavailable".
  /// The ONLY place a live thread is terminated. A thread inside a native CreateProcessW
  /// cannot be interrupted, so this returns at once but the thread may outlive the call.
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
