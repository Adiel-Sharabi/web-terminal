'use strict';

/// Runs an agent CLI's background-agent listing (#366) at most once per TTL window, however
/// many clients ask, and turns every way it can go wrong into "unavailable".
///
/// The rules for what the output may become live in lib/background-listing.js (pure). What
/// is here is the part with a clock and a child process in it, built as a factory over
/// injected `execFile` / `resolve` / `now` so the single-flight, cache and failure paths are
/// exercised in tests against a REAL child process (a stub that prints, fails or hangs)
/// without the suite ever launching the real CLI.
///
/// What it guarantees:
///  * SPAWNS ONLY ON DEMAND - nothing runs at load, and nothing runs while a fresh answer is
///    held. A dashboard polling every few seconds costs one spawn per `ttlMs`.
///  * SINGLE-FLIGHT - a call that arrives while one is running joins it. Two tabs, one spawn.
///  * FAILURE IS AN ANSWER, AND IS CACHED TOO. A missing binary, a non-zero exit, output that
///    is not a JSON array and a hang past `timeoutMs` all resolve to `{ available: false }`,
///    held for the same window as a success: a CLI that hangs for 10 s must not be spawned
///    again by every poll for the whole of that outage.
///  * NEVER REJECTS, NEVER THROWS, NEVER LOGS OUTPUT. The output names every project's
///    sessions on the machine; `onFailure` receives a short reason code and nothing else.
///  * KILLS WHAT IT STARTED. A timeout takes the whole process tree down (`killTree`), not
///    only the direct child - the same hazard lib/git-safe.js exists for.
const { parseBackgroundListing, scrubEnv } = require('./background-listing');

/// stdout ceiling. A listing of live agents is a few KB; this only bounds a runaway.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

const UNAVAILABLE = Object.freeze({ available: false });

/// @param {object} o
/// @param {{argv: string[], timeoutMs: number, ttlMs: number, scrubEnv?: object}} o.cfg
///        the registry's `backgroundListing` entry
/// @param {() => (string|null)} o.resolve  the executable to run, or null for none
/// @param {Function} o.execFile            child_process.execFile-compatible
/// @param {(pid:number)=>void} o.killTree  best-effort tree kill
/// @param {() => number} [o.now]
/// @param {() => object} [o.env]           the environment to derive the child's from
/// @param {string} [o.cwd]                 where the child runs
/// @param {(reason:string)=>void} [o.onFailure]
function createBackgroundListing(o) {
  const cfg = o.cfg;
  const now = o.now || Date.now;
  const envOf = o.env || (() => process.env);
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : () => {};

  let inflight = null;   // Promise of the run in progress
  let held = null;       // { ts, value } - the last settled answer

  function fail(reason) {
    try { onFailure(reason); } catch { /* a logger must not break an answer */ }
    return UNAVAILABLE;
  }

  function run() {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let child = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };

      let bin;
      try { bin = o.resolve(); } catch { bin = null; }
      if (!bin) return done(fail('no-binary'));

      try {
        child = o.execFile(bin, cfg.argv, {
          cwd: o.cwd,
          env: scrubEnv(envOf(), cfg.scrubEnv),
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: MAX_STDOUT_BYTES,
        }, (err, stdout) => {
          if (err) return done(fail(`exec:${err.code != null ? err.code : 'error'}`));
          const rows = parseBackgroundListing(stdout);
          if (!rows) return done(fail('bad-output'));
          done({ available: true, agents: rows });
        });
      } catch {
        return done(fail('spawn-threw'));
      }

      // Our own watchdog rather than execFile's `timeout`, which signals only the direct
      // child. Unref'd: a pending watchdog must never be what keeps the server alive.
      timer = setTimeout(() => {
        try { if (child && child.pid) o.killTree(child.pid); } catch { /* best effort */ }
        done(fail('timeout'));
      }, cfg.timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  /// Resolves to `{ available: true, agents: [...] }` or `{ available: false }`. Never rejects.
  function get() {
    if (inflight) return inflight;
    if (held && now() - held.ts < cfg.ttlMs) return Promise.resolve(held.value);
    const p = run().then((value) => {
      held = { ts: now(), value };
      return value;
    }).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  /// Forget the held answer (the next `get` spawns). For tests; nothing in production needs it.
  function reset() { held = null; }

  return { get, reset };
}

module.exports = { createBackgroundListing, UNAVAILABLE, MAX_STDOUT_BYTES };
