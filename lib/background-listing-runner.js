'use strict';

/// Runs an agent CLI's background-agent listing (#366) at most once per TTL window, however
/// many clients ask, and turns every way it can go wrong into "unavailable".
///
/// The rules for what the output may become live in lib/background-listing.js (pure). WHERE
/// the child process is started lives in lib/background-listing-exec.js - in production a
/// worker thread, so a slow CreateProcess never freezes the server's main loop. What is here
/// is the part with a clock in it: the single-flight and the cache, built as a factory over
/// an injected `exec` so each is tested without a process (a deferred promise stands in for
/// a slow child), and the process paths are tested separately against a real stub.
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
///    sessions on the machine; `onFailure` receives a short reason code and nothing else,
///    and only when the reason CHANGES - an outage that lasts an hour is one line, not 120.
const { parseBackgroundListing, scrubEnv } = require('./background-listing');

const UNAVAILABLE = Object.freeze({ available: false });

/// @param {object} o
/// @param {{argv: string[], timeoutMs: number, ttlMs: number, scrubEnv?: object}} o.cfg
///        the registry's `backgroundListing` entry
/// @param {() => (string|null)} o.resolve  the executable to run, or null for none
/// @param {(req: object) => Promise<{ok: boolean, stdout?: string, reason?: string}>} o.exec
///        starts the child (lib/background-listing-exec.js); must always settle
/// @param {() => number} [o.now]
/// @param {() => object} [o.env]           the environment to derive the child's from
/// @param {string} [o.cwd]                 where the child runs
/// @param {(reason:string)=>void} [o.onFailure] called when the failure reason changes
function createBackgroundListing(o) {
  const cfg = o.cfg;
  const now = o.now || Date.now;
  const envOf = o.env || (() => process.env);
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : () => {};

  let inflight = null;      // Promise of the run in progress
  let held = null;          // { ts, value } - the last settled answer
  let lastReason = null;    // the failure reason last REPORTED; null while healthy

  function fail(reason) {
    if (reason !== lastReason) {
      lastReason = reason;
      try { onFailure(reason); } catch { /* a logger must not break an answer */ }
    }
    return UNAVAILABLE;
  }

  async function run() {
    let bin;
    try { bin = o.resolve(); } catch { bin = null; }
    if (!bin) return fail('no-binary');

    let res;
    try {
      res = await o.exec({
        bin,
        argv: cfg.argv,
        env: scrubEnv(envOf(), cfg.scrubEnv),
        cwd: o.cwd,
        timeoutMs: cfg.timeoutMs,
      });
    } catch {
      return fail('exec-threw');
    }
    if (!res || !res.ok) return fail(String((res && res.reason) || 'exec-failed'));

    const rows = parseBackgroundListing(res.stdout);
    if (!rows) return fail('bad-output');
    lastReason = null;
    return { available: true, agents: rows };
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

module.exports = { createBackgroundListing, UNAVAILABLE };
