// @ts-check
// #254 - THE TEARDOWN BUDGET MUST GROW WITH THE BATCH, and a constant is the regression.
//
// `pty-worker.js`'s `killSession` (~:2570) is `async` in signature and FULLY SYNCHRONOUS
// inside - four `clearTimeout`s, `cancelSubmitWatch`, `cancelAutoResume`, a
// fire-and-forget `term.kill()`, `sessions.delete`, `deleteScrollback`, and a synchronous
// `saveSessionConfigs()`. No yield point anywhere. So N concurrent `killSession` RPCs run
// STRICTLY SERIALLY on the worker's single JS thread: concurrent dispatch removes N
// round-trips and cannot parallelise one microsecond of the handlers.
//
// That inverts what the deadline means, and #253's fix - which moved these kills from a
// sequential loop to one `Promise.all` under ONE constant window - tightened it without
// saying so:
//
//   sequential, own window each  -> fails when ONE kill exceeds the window
//   concurrent, one shared window -> fails when the SUM of all N exceeds the window
//
// MEASURED: the fix for #254 went red at test 1653 of 1700 in a full-suite run, in the
// very spec #253 had "fixed", with `RPC killSession timed out` on a 5-session batch under
// the 8700ms constant. The same batch takes 18ms on a quiet box.
//
// WHY THIS TEST IS NOT ITSELF A TIMING BET: it asserts the SHAPE of the rule, never a
// duration, and runs no worker. Nothing here can go red for load. What it catches is the
// one edit that brings the bug back - collapsing the budget to a constant - which every
// behavioural test in the repo would stay green through, because a constant is only wrong
// at the tail of a long run on a loaded box.
const { test, expect } = require('@playwright/test');
const { KILL_BASE_MS, KILL_PER_SESSION_MS, killBudgetMs } = require('./worker-kill');

test.describe('#254: the kill budget scales with the batch', () => {
  test('one kill gets the base window, and every extra kill adds its own', () => {
    expect(killBudgetMs(1)).toBe(KILL_BASE_MS);
    expect(killBudgetMs(2)).toBe(KILL_BASE_MS + KILL_PER_SESSION_MS);
    expect(killBudgetMs(5)).toBe(KILL_BASE_MS + 4 * KILL_PER_SESSION_MS);
    expect(killBudgetMs(10)).toBe(KILL_BASE_MS + 9 * KILL_PER_SESSION_MS);
  });

  test('it STRICTLY grows - a constant window is the regression', () => {
    // THE LOAD-BEARING ASSERTION. `killBudgetMs = () => 8700` satisfies every "is it at
    // least N ms" check anyone would write; only growth distinguishes it.
    for (let n = 1; n < 12; n++) {
      expect(killBudgetMs(n + 1),
        `the window for ${n + 1} serialized kills must exceed the window for ${n}`)
        .toBeGreaterThan(killBudgetMs(n));
    }
    expect(KILL_PER_SESSION_MS, 'a per-session term of 0 IS a constant window')
      .toBeGreaterThan(0);
  });

  test('an empty or single batch never asks for less than the base', () => {
    // `Math.max(0, n - 1)` - a 0-length batch is legal (callers pass `ids` straight
    // through) and must not produce a negative window.
    expect(killBudgetMs(0)).toBe(KILL_BASE_MS);
    expect(killBudgetMs(1)).toBeGreaterThanOrEqual(KILL_BASE_MS);
  });
});
