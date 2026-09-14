'use strict';
// ONE OWNER FOR "TEAR DOWN THIS SPEC'S SESSIONS" (#253, #254).
//
// #253 - `killSession` under a spec's default `rpc()` budget was a false red at the tail
// of a full-suite run (13 minutes, 1600 tests in) while the SAME spec passed in 701ms run
// alone. Root cause is load, not logic.
//
// #254 - the same shape sat in two more specs, and BOTH were worse in one specific way:
// their loop was `try { await rpc(...) } catch {}`, so a timeout was swallowed and the
// test stayed green. There is no assertion in a teardown, so nothing ever reported that
// the cleanup had not happened - a genuinely wedged `killSession` would leave the spec
// green and the sessions alive, and the next spec in the run would inherit them. That is
// the shape of a cross-spec failure nobody can trace back to its cause. It is also this
// repo's own recorded trap arriving from the teardown side: *a positive assertion behind
// a timer is flaky, a NEGATIVE one is VACUOUS* - and a swallowed one is not even an
// assertion.
//
// SO THE DECISION ON THE `try/catch` IS: REPORT, NEVER SWALLOW. The outer `finally` in
// every caller stops the worker and removes the temp data dir regardless, so the process
// and the disk are cleaned up either way; what the catch was hiding is the only thing the
// call can tell you, which is that the worker stopped answering.
//
// =============================================================================
// THE BUDGET MUST SCALE WITH THE BATCH - and #253's fix, which this file inherited,
// silently made it STRICTER. Found by the fix for #254 going red at test 1653 of 1700.
// =============================================================================
//
// `pty-worker.js`'s `killSession` (~:2570) is `async` in signature and FULLY SYNCHRONOUS
// inside: clear four timers, `cancelSubmitWatch`, `cancelAutoResume`, a fire-and-forget
// `session.term.kill()`, `sessions.delete`, `deleteScrollback`, then a synchronous
// `saveSessionConfigs()` (a `writeFileSync`). There is no yield point anywhere in it. So
// N concurrent `killSession` RPCs are executed STRICTLY SERIALLY on the worker's single
// JS thread - concurrency removes N round-trips, and cannot parallelise one microsecond
// of the handlers themselves.
//
// #253's own comment says the handler is synchronous. What it did not follow through is
// what that does to the DEADLINE, and the arithmetic inverts:
//
//   | dispatch                      | the batch fails when                        |
//   |-------------------------------|---------------------------------------------|
//   | sequential, own window each   | ONE kill exceeds the window (5000ms)        |
//   | concurrent, one shared window | the SUM of all N exceeds the window (8700ms)|
//
// Under the old sequential form every kill's timer started when the previous one
// RESOLVED, so five kills tolerated up to ~25s of total work. Under one shared 8700ms
// window all five timers start at t=0 and the fifth must finish within 8700ms of an
// instant at which it had not begun. **Concurrent dispatch is still right** - it is what
// removes the per-call round-trip and gives the batch a single, comprehensible deadline -
// but a CONSTANT window is wrong for it, because what has to fit inside that window is N
// serialized handlers.
//
// STATE THE PREDICATE THE NUMBERS COME FROM, because this repo's recurring test defect is
// a fixed-timeout bet (memory: project_suite_fixed_timeout_bets) and another round number
// chosen by feel would be the third one. The budget's ONLY job is to bound how long the
// suite waits on a worker that has genuinely stopped answering. A hung worker never
// replies, so EVERY finite budget catches it and the choice changes only how many seconds
// a real hang takes to surface. Being wrong high therefore costs seconds on a failure
// that is already fatal; being wrong low costs a FALSE RED that throws away a 13-minute
// run. The two errors are not remotely symmetric, so this is sized generously on purpose.
//
// The per-kill term is anchored to #191's ~870ms (CLAUDE.md, "A ConPTY `term.kill()` is
// ALREADY graceful"), which is the only real Windows ConPTY-teardown figure this repo has
// measured. STATE WHAT IT ACTUALLY MEASURES: it is how long THE AGENT takes to exit AFTER
// the kill, and this RPC never waits on that - these are plain shells with no agent at
// all. It is a RELATED quantity used for headroom, not a fitted bound.
const { rpc } = require('./worker-ipc');   // #262 - the harness this file's header promised

const KILL_BASE_MS = 8700;        // 10x #191's ~870ms - the window the batch gets for free
const KILL_PER_SESSION_MS = 2500; // ...plus this for every session after the first

/** The shared window a batch of `n` serialized kills gets. */
function killBudgetMs(n) {
  return KILL_BASE_MS + Math.max(0, n - 1) * KILL_PER_SESSION_MS;
}

// WHAT IS DELIBERATELY NOT CONVERTED, counted rather than glossed. Eleven more
// `try { await rpc(client, 'killSession', ...) } catch {}` sites remain, in
// `ipc-backpressure.spec.js` (1), `worker-binary-pty.spec.js` (5) and
// `worker-scrollback-chunks.spec.js` (5). Every one of them is a SINGLE kill, so none has
// the compounding shape above where N serialized handlers share one deadline. They share
// only the swallow.
//
// STATE THE PREDICATE, because the obvious one is wrong. It is NOT "no `for` appears above
// the call" - three of the eleven do have one (`worker-binary-pty.spec.js:253`,
// `worker-scrollback-chunks.spec.js:187` and `:235`). Those loops are CLOSED before the
// kill: they build or assert chunks, and the kill is a single statement after the brace.
// The property that matters is that no loop is still OPEN at the call site, which is why
// it was checked by reading each of the eleven rather than by grepping for `for`.
//
// Converting them is mechanical and this module is ready for it; it is left out because it
// would turn eleven passing tests into eleven failing for a reason nobody has measured,
// which is the opposite of what #254 asks for.

/**
 * Kill every session in ONE concurrent batch: one round-trip in flight for all of them,
 * under a single window sized for N serialized handlers.
 *
 * `rpc` IS NOW IMPORTED, not passed in. This used to read "passed in rather than imported
 * because each worker spec still owns its copy of the IPC harness. Unifying that is a
 * separate, much wider change" - #262 IS that change, and `tests/worker-ipc.js` is the one
 * owner it promised. What MUST NOT be duplicated is still this rule - the budget and the
 * dispatch - which is what drifts.
 *
 * `allSettled`, not `all`: `all` rejects on the FIRST failure and abandons the rest, so
 * the error names one id and cannot say whether the worker answered anybody. The whole
 * point of un-swallowing this is that the report is worth reading.
 *
 * @param {any} client
 * @param {string[]} ids
 * @param {{worker?:any, label?:string}} [opts] optional `worker` (from `spawnWorker`) so a
 *   failure can say whether the process is still alive and what it printed - the one
 *   question "RPC killSession timed out" cannot answer on its own.
 */
async function killAllSessions(client, ids, opts = {}) {
  const budget = killBudgetMs(ids.length);
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    ids.map((id) => rpc(client, 'killSession', { id }, budget)),
  );
  const elapsed = Date.now() - t0;

  // Opt-in timing, for sizing the constants above against a REAL full-suite tail rather
  // than against a quiet single-spec run - which is where #253 and this both showed up.
  if (process.env.WT_KILL_DEBUG) {
    console.log(`[kill-batch] n=${ids.length} elapsed=${elapsed}ms budget=${budget}ms`
      + `${opts.label ? ' ' + opts.label : ''}`);
  }

  const failed = settled.filter((r) => r.status === 'rejected');
  if (failed.length) {
    const w = opts.worker;
    let why = '';
    if (w && w.proc) {
      const dead = w.proc.exitCode !== null || w.proc.signalCode !== null;
      why = ` worker ${dead ? `EXITED (code=${w.proc.exitCode} signal=${w.proc.signalCode})` : 'still running'}`;
      const err = typeof w.getStderr === 'function' ? (w.getStderr() || '').trim() : '';
      if (err) why += `; stderr tail: ${err.slice(-400)}`;
    }
    throw new Error(
      `killSession batch failed: ${failed.length}/${ids.length} after ${elapsed}ms `
      + `(budget ${budget}ms for ${ids.length} serialized kills).${why} `
      + `First: ${failed[0].reason && failed[0].reason.message}`,
    );
  }
  return settled.map((r) => r.value);
}

module.exports = { KILL_BASE_MS, KILL_PER_SESSION_MS, killBudgetMs, killAllSessions };
