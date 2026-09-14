'use strict';
// ONE OWNER FOR THE WORKER SPECS' IPC HARNESS (#262).
//
// `tests/worker-kill.js` said this change was coming and why it was not being made then:
// "each worker spec still owns its copy of the IPC harness. Unifying that is a separate,
// much wider change." This is that change, and it is narrower than "the harness" - see
// WHAT IS DELIBERATELY NOT UNIFIED at the bottom, which is measured rather than guessed.
//
// =============================================================================
// THE DEFECT: 23 FILES EACH BET A DIFFERENT NUMBER, AND NONE OF THEM SAYS WHY
// =============================================================================
//
// MEASURED over `tests/*.spec.js` by extracting each private copy - walking the PARAMETER
// LIST by parens first, then the body by braces - and hashing that body with the timeout
// literal normalised away. (The paren-first order is the whole correction; see below.)
//
//   rpc            - 23 copies, ONE distinct body. Only the number differed.
//   connectClient  - 22 copies, ONE distinct body. Every one of them said 5000.
//
// THE FIRST VERSION OF THAT MEASUREMENT WAS VACUOUS, and it is worth recording because it
// is this repo's favourite defect wearing a new hat. The extractor counted braces from
// `function rpc(` - which closes on the `{}` of `params = {}` IN THE SIGNATURE. So every
// "body" it hashed was the signature prefix and nothing else, and it would have reported
// "one distinct body" no matter how far the 23 copies had actually drifted: a comparison
// that could not fail. It was caught because the same extractor was reused to DELETE those
// definitions and left `, timeoutMs = 5000) {` dangling in all 23 files. The corrected
// version walks the parameter list by parens first, and carries a positive control - a
// one-character change to a body must hash differently - which is the assertion the
// original was missing.
//
// So this was never divergent logic that had to be reconciled; it was one function
// pasted 23 times, carrying five different deadlines:
//
//   3000ms  worker-basic
//   5000ms  13 files (worker-session, worker-agent-ready, api-error-detect, ...)
//   8000ms  cap-sample, worker-blocking-prompt
//   10000ms 6 files (worker-binary-pty, worker-scrollback-chunks, ...)
//   15000ms worker-bracketed-paste
//
// ALMOST NO CALL SITE PASSES AN EXPLICIT TIMEOUT - measured properly this time, by
// parsing every `rpc(` call paren-aware rather than grepping lines: 461 call sites across
// `tests/`, arity histogram {0:1, 1:1, 2:31, 3:426, 4:2}. The two arity-4 sites are
// `worker-scrollback-save-yield.spec.js` (60000, for a deliberate long measurement) and
// `worker-kill.js` (its computed batch budget). Both keep their own value and neither is
// touched by the default.
//
// THE FIRST VERSION OF THIS SENTENCE SAID "NOT ONE - grepped, zero hits", AND THAT WAS
// FALSE. One of the two spans three lines, so a line-oriented grep misses it by
// construction; the other is in THIS CHANGESET. Recorded rather than quietly corrected,
// because it is the same defect as the vacuous extractor above - a measurement whose
// method cannot see the thing it rules out - committed one section after describing it,
// and because the rule at the bottom of this block PRESCRIBES the call-site override
// while the claim above denied any existed. A positive control would have caught it: the
// grep was only ever tested against a single-line call it was already shaped to match.
//
// The point the false sentence was reaching for survives, and is narrower: no call site
// overrides the DEFAULT for an ordinary RPC. So the number was never chosen per RPC; it
// was inherited from whichever file the block was
// pasted into, and the SAME `createSession` call got 3000ms in one spec and 15000ms in
// another. That is the mechanism behind the recorded "flake": because each file bets
// independently, a DIFFERENT spec fails on each loaded run, which is what makes the
// failure look random and get written off (memory: project_suite_fixed_timeout_bets).
//
// =============================================================================
// THE BUDGET RULE, STATED ONCE
// =============================================================================
//
// This is #254's asymmetry, and it is the whole justification for a single generous
// number rather than 23 tuned ones:
//
//   The budget's ONLY job is to bound how long the suite waits on a worker that has
//   genuinely stopped answering. A hung worker never replies, so EVERY finite budget
//   catches it, and the choice changes only how many seconds a real hang takes to
//   surface. Being wrong HIGH therefore costs seconds on a failure that is already
//   fatal. Being wrong LOW costs a FALSE RED that throws away a 13-19 minute run.
//   The two errors are not remotely symmetric.
//
// So the number is not a latency estimate and must not be read as one. It is a ceiling.
//
// 15000ms is the MAXIMUM OF THE 23 DECLARATION DEFAULTS that were already in the tree,
// chosen on that ground alone: **shrinking any spec's budget is the only change here that
// could manufacture a false red**, so the migration takes the largest existing default and
// no spec ends up stricter than it was. Nothing was tuned down.
//
// SAY "DECLARATION DEFAULTS", NOT "BUDGETS IN THE TREE" - the looser phrasing stood here
// and was false, in the one sentence that has to be exact. Larger budgets do exist: the
// 60000 call-site override above, and `killBudgetMs(n)` in `worker-kill.js`, which reaches
// 31200 at n=10. Neither is a default and neither is touched, so the SAFETY claim is
// unaffected - but a safety argument that overstates its own scope invites exactly the
// audit it should survive. Verified exhaustively across the 23: 3000x1, 5000x13, 8000x2,
// 10000x6, 15000x1, all <= 15000, and `connectClient` unchanged at 5000 with every one of
// its 101 call sites arity-1. No spec's effective budget decreased.
//
// MEASURED, and the measurement is the point: a full suite run (1717 tests, 13.3 minutes,
// `WT_RPC_DEBUG=1 WT_RPC_DEBUG_MS=250`) logged **not one RPC at or above 250ms**. So the
// ceiling is at least sixty times the slowest RPC in that run - "at least", because 250ms
// was the THRESHOLD and nothing reached it, so the true slowest is unknown and strictly
// below it. That is a LOWER BOUND, not a measurement of the maximum; it errs in the safe
// direction and the earlier phrasing ("sixty times the slowest thing ever observed")
// claimed a number the run could not produce. Either way the 3000ms this suite was betting
// in `worker-basic` was never about latency.
//
// STATE THE POSITIVE CONTROL, because "zero lines" and "the instrument never ran" look
// identical and this repo has been caught by that before. NOTE the run above predates the
// timeout-logging fix below, so its instrument could not have reported an RPC that hit the
// ceiling - immaterial here only because that run was fully green and nothing timed out,
// which is a fact about the run and not a property of the instrument. Re-run at `WT_RPC_DEBUG_MS=1`,
// `worker-basic` alone logs `[rpc] ping 1ms budget=15000ms` - so the logging path works and
// the zero is a real absence. (That control also found a falsy-zero bug in the threshold
// itself: `parseInt(x, 10) || 500` silently turned a deliberate 0 into 500. Fixed below.)
//
// TWO LIMITS ON THAT MEASUREMENT, both found in review and neither closed by the fix:
//
//   1. `connectClient` IS NOT INSTRUMENTED AT ALL. The debug hook lives in `rpc` only, so
//      the run above says nothing about how long a worker took to accept a connection -
//      a different quantity with its own budget (CONNECT_BUDGET_MS) and no evidence
//      behind it beyond "every one of the 22 copies said 5000".
//   2. A BUDGET LARGER THAN THE ENCLOSING TEST TIMEOUT CAN NEVER FIRE. `playwright.
//      config.js` sets `timeout: 30000` per test. 15000 is comfortably inside it, but two
//      pre-existing budgets are NOT: `killBudgetMs(10)` = 31200ms and the explicit 60000
//      on `__testMeasureSaveBlock`, both in `worker-scrollback-save-yield.spec.js`, whose
//      NUM_SESSIONS is 10 and which sets no `test.setTimeout`. Playwright kills the test
//      at 30s first, so neither budget can ever produce its message - a gate that cannot
//      fire, which is this repo's own "indistinguishable from one that passes". That is
//      #254 arithmetic rather than anything #262 changed, so it is #269, not folded in here.
//
// DO NOT "TUNE" THIS PER FILE AGAIN. If a specific RPC ever genuinely needs a different
// budget, pass it at the CALL SITE with its measurement in a comment beside it - that is
// a local, visible, justified exception. A new per-file default is the defect returning.
//
// =============================================================================
// WHAT IS DELIBERATELY NOT UNIFIED - counted, not glossed
// =============================================================================
//
//   spawnWorker       - 23 copies, SEVENTEEN distinct bodies. It genuinely varies per
//                       spec (env vars, worker flags, stdio), and it varies far more than
//                       it looks: only three pairs/triples share a body at all. Folding
//                       seventeen real behaviours into one signature is a different change
//                       with a different risk, and none of the failures #262 is about
//                       came from it.
//   workerPipePath    - 23 copies, FIVE distinct bodies (19 identical + 4 one-offs).
//   makeTempDataDir   - 22 copies, FIVE distinct bodies (18 identical + 4 one-offs).
//
// Those last two are mostly-identical and could follow later; they are left alone because
// they are not what #262 measured, they carry no deadline, and a wider diff would make
// the one thing this change has to prove - that no spec's budget shrank - harder to read.
//
// AND THREE MORE THAT DO CARRY A DEADLINE, listed because this section claims to count
// rather than gloss and review found it had not counted them:
//
//   rpcOverRawSocket  - `ipc-backpressure.spec.js`, its own `timeoutMs = 5000`. A 24th
//                       near-copy in shape, and CORRECTLY left alone: it drives a RAW
//                       SOCKET with its own FrameDecoder so the slow-consumer test can
//                       attach and detach `data` listeners itself, which the ipc-client
//                       harness cannot do. That file imports this owner for its ordinary
//                       calls and keeps the raw pair beside it - a different mechanism,
//                       not a missed duplicate. (`connectRawSocket`, 8000, likewise.)
//   event waiters     - in `worker-session.spec.js` and `worker-session-id-lookup.spec.js`
//                       (no line numbers: they rot, and this one already moved once)
//                       wait for an EVENT rather than a reply, so they are not round-trip
//                       budgets at all and share none of this module's reasoning.
//
// Leaving each of them is the right call; omitting them from a list headed "counted, not
// glossed" was not. Same defect as the call-site claim corrected above: a completeness
// claim is only worth making if someone checked it.
const ipc = require('../lib/ipc');

/** The shared ceiling. See THE BUDGET RULE above before changing it. */
const RPC_BUDGET_MS = 15000;

/** How long to wait for a freshly spawned worker to accept a connection. Every one of the
 *  22 private copies said 5000 and none of them ever overrode it, so this is the existing
 *  value promoted, not a new bet. It bounds a different thing from RPC_BUDGET_MS: the
 *  worker coming UP, rather than answering once it has. */
const CONNECT_BUDGET_MS = 5000;

/**
 * Connect to a worker's pipe, resolving once the handshake completes.
 * Byte-identical to the copy all 22 specs carried.
 */
async function connectClient(pipePath, timeoutMs = CONNECT_BUDGET_MS) {
  const client = ipc.createClient(pipePath, { retry: true, retryDelayMs: 100 });
  await Promise.race([
    client.connected(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('worker never ready')), timeoutMs)),
  ]);
  return client;
}

/**
 * One JSON RPC round-trip to the worker.
 *
 * Two things differ from the 23 copies this replaces, and both are about what you can
 * learn from a failure rather than about behaviour:
 *
 *   1. The timeout message names the BUDGET and the ELAPSED time. The old message was
 *      bare - `RPC killSession timed out` - which cannot tell "the deadline was too
 *      tight" from "the worker is wedged", and that ambiguity is most of why #253, #254
 *      and #262 each had to re-derive the same answer. Production's own shape already
 *      reads `RPC listSessions timed out after 30000ms`.
 *   2. `WT_RPC_DEBUG=1` logs any call slower than WT_RPC_DEBUG_MS (default 500ms), so
 *      the ceiling above can be re-checked against a real loaded run instead of argued
 *      about. Off by default, and off it costs one `Date.now()` per call - NOT literally
 *      nothing, which is what this said until review; the timestamp is taken
 *      unconditionally because the logging decision happens after the call completes.
 *
 *      A TIMEOUT IS ALWAYS LOGGED, whatever the threshold. The first version routed
 *      logging through `settle()` alone, and the timeout path rejects WITHOUT going
 *      through it - so the instrument was blind to the slowest calls that can occur,
 *      which are the only ones it exists to find. An instrument whose blind spot is its
 *      own subject reports a reassuring zero for the same reason a broken one does.
 */
function rpc(client, method, params = {}, timeoutMs = RPC_BUDGET_MS) {
  const id = Math.floor(Math.random() * 1e9);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settle(reject, new Error(`RPC ${method} timed out after ${timeoutMs}ms`), true),
      timeoutMs,
    );
    function settle(fn, arg, timedOut) {
      clearTimeout(timer);
      client.off('frame', onFrame);
      if (process.env.WT_RPC_DEBUG) {
        const ms = Date.now() - t0;
        // `parseInt(x, 10) || 500` would turn a deliberate WT_RPC_DEBUG_MS=0 into 500 -
        // the classic falsy-zero bug, and a debugging aid that silently ignores the value
        // you gave it is worse than none. Caught by running the positive control: at
        // threshold 0 nothing logged, which is also what a broken instrument looks like.
        const raw = parseInt(process.env.WT_RPC_DEBUG_MS, 10);
        const floor = Number.isFinite(raw) ? raw : 500;
        if (timedOut || ms >= floor) {
          console.log(`[rpc] ${method} ${ms}ms budget=${timeoutMs}ms`
            + (timedOut ? ' TIMED OUT' : ''));
        }
      }
      fn(arg);
    }
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;
      if (msg.error) settle(reject, new Error(msg.error));
      else settle(resolve, msg.result);
    }
    client.on('frame', onFrame);
    client.send(ipc.encodeJson({ id, method, params }));
  });
}

module.exports = { RPC_BUDGET_MS, CONNECT_BUDGET_MS, connectClient, rpc };
