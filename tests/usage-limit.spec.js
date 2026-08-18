// @ts-check
// Issue #138 — the rule that decides whether a session is blocked on its 5-hour
// usage cap. Pure, so it is unit-tested directly rather than through a worker.
//
// This module is the reason #137 could turn auto-resume ON by default: #69 fired
// on an elapsed timestamp alone, which cannot tell a capped session from one the
// user finished with. Every case below is a session #69 would have typed
// 'continue' into.

const { test, expect } = require('@playwright/test');
const u = require('../lib/usage-limit');

const NOW = 1_700_000_000_000;
const SOON = NOW + 5 * 60 * 1000;   // reset still ahead
const PAST = NOW - 5 * 60 * 1000;   // window already turned over

test.describe('#138 — isCapBlocked', () => {
  test('blocked: the window is spent and its reset is still ahead', () => {
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: SOON, now: NOW })).toBe(true);
  });

  test('NOT blocked at 99% — a nearly-spent window is still a usable one', () => {
    // clampPct ROUNDS, so a real 99.5%+ already arrives as 100. Anything below is
    // genuinely not exhausted, and nudging it would spend quota that was available.
    expect(u.isCapBlocked({ fiveH: 99, fiveHResetAt: SOON, now: NOW })).toBe(false);
    expect(u.isCapBlocked({ fiveH: 0, fiveHResetAt: SOON, now: NOW })).toBe(false);
  });

  // REVIEW FINDING (the serious one). This case previously asserted that a
  // just-passed reset is NOT blocked — which is precisely what made the feature
  // unreachable: the resume fires at reset+60s, so during that minute the
  // derivation said "not blocked", the poll pushed it, and the worker cancelled the
  // timer it was about to fire. For a metrics-only session (every Codex one) the
  // resume could essentially never happen.
  test('STILL blocked in the minute between the reset and the resume', () => {
    const justPassed = NOW - 30 * 1000; // reset 30s ago; resume due in 30s
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: justPassed, now: NOW, delayMs: 60000 })).toBe(true);
  });

  test('still blocked shortly after the resume was due — poll jitter must not disarm it', () => {
    const fired = NOW - 90 * 1000; // resume was due 30s ago
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: fired, now: NOW, delayMs: 60000 })).toBe(true);
  });

  test('NOT blocked once the window is long gone — a stale reading arms nothing', () => {
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: NOW - 3 * 60 * 60 * 1000, now: NOW })).toBe(false);
  });

  test('NOT blocked when the percentage is unknown — refuse to act on silence', () => {
    // #56 rule 3: unknown renders as nothing, never as a number. Here it must also
    // DO nothing: a missed auto-resume costs a manual click, a false one costs quota.
    for (const v of [null, undefined, NaN, 'lots']) {
      expect(u.isCapBlocked({ fiveH: /** @type {any} */ (v), fiveHResetAt: SOON, now: NOW })).toBe(false);
    }
  });

  test('NOT blocked when the reset time is missing or malformed', () => {
    for (const v of [null, undefined, 0, -1, NaN, '3pm']) {
      expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: /** @type {any} */ (v), now: NOW })).toBe(false);
    }
  });
});

test.describe('#137 — usageLimitState (what the session list publishes)', () => {
  test('a capped, enabled session is waiting AND armed, with a resume time', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
    expect(st.armed).toBe(true);
    expect(st.resetAt).toBe(SOON);
    // The badge counts down to when the resume FIRES, not when the window turns
    // over — those are a minute apart and only one of them is when anything happens.
    expect(st.resumeAt).toBe(SOON + 60000);
  });

  test('capped with NO reset time is waiting but NOT armed — no timer can exist', () => {
    // The cap prompt can be observed before any resets_at is read. Reporting armed
    // here would have the badge promise a resume the worker cannot schedule.
    const st = u.usageLimitState({
      metrics: { fiveH: 100 }, observedBlockAt: NOW - 1000,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
    expect(st.armed).toBe(false);
    expect(st.resumeAt).toBeNull();
  });

  test('an observed cap prompt is blocking even with no percentage at all', () => {
    const st = u.usageLimitState({
      metrics: null, observedBlockAt: NOW - 1000,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
  });

  test('an opted-out session still reports waiting — hiding the block would be a lie', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: false, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);   // it IS capped
    expect(st.armed).toBe(false);    // nothing will fire
    expect(st.enabled).toBe(false);
  });

  test('the badge survives to the RESUME moment, not just to the reset', () => {
    // The row said "resumes 14:32" and then reverted to a plain idle row at 14:31,
    // with the action still pending — the badge vanished a minute before the thing
    // it was announcing. waiting now runs to resumeAt.
    const justPassed = NOW - 30 * 1000;
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: justPassed }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);    // still shown
    expect(st.capBlocked).toBe(true); // and still armable
    expect(st.resumeAt).toBe(justPassed + 60000);
  });

  test('once the resume has passed the badge clears but arming keeps its grace', () => {
    const fired = NOW - 90 * 1000; // resume was due 30s ago
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: fired }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(false);   // nothing left to announce
    expect(st.capBlocked).toBe(true); // but the fire must not be cancelled by a race
  });

  test('an ordinary working session publishes nothing to render', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 42, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(false);
    expect(st.armed).toBe(false);
    expect(st.resumeAt).toBeNull();
  });

  test('no metrics at all (a plain shell) is safe, not a crash', () => {
    const st = u.usageLimitState({ metrics: null, enabled: true, delayMs: 60000, now: NOW });
    expect(st.waiting).toBe(false);
    expect(st.resetAt).toBeNull();
  });
});

test.describe('the resume delay is shared, not copied', () => {
  test('server and worker read the same constant', () => {
    // Two copies would mean a sidebar counting down to a moment when nothing happens.
    expect(u.AUTO_RESUME_DELAY_MS).toBe(60000);
    expect(u.autoResumeDelayMs({})).toBe(u.AUTO_RESUME_DELAY_MS);
    expect(u.autoResumeDelayMs({ WT_AUTO_RESUME_FAST: '1' })).toBe(u.AUTO_RESUME_DELAY_FAST_MS);
  });

  test('resumeAtFrom rejects a malformed reset rather than inventing one', () => {
    expect(u.resumeAtFrom(SOON, 60000)).toBe(SOON + 60000);
    expect(u.resumeAtFrom(null, 60000)).toBeNull();
    expect(u.resumeAtFrom(0, 60000)).toBeNull();
  });
});
