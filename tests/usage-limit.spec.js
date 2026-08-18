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

  test('NOT blocked when the reset has already passed — the reading is stale, not live', () => {
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: PAST, now: NOW })).toBe(false);
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

  test('an opted-out session still reports waiting — hiding the block would be a lie', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: false, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);   // it IS capped
    expect(st.armed).toBe(false);    // nothing will fire
    expect(st.enabled).toBe(false);
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
