// The rule behind `[slow-sessions]` — lib/slow-log.js.
//
// `GET /api/sessions` went to 17-28s on a cluster peer on 2026-09-22 and no log
// anywhere said which of its four phases was responsible, which is what made the
// hunt cost a day. These specs exist so the instrument that closes that gap
// cannot quietly stop working: EVERY failure mode of a throttled threshold log
// reads, from the outside, exactly like "nothing was slow".
//
// Each negative here is pinned against ONE named mutation, and each was
// confirmed red by applying that mutation alone. Two earlier drafts of these
// specs passed against a broken rule — the first-call test used a `Date.now()`
// -sized clock, which makes `now - 0 < gapMs` false whether or not the guard
// exists, and the NaN test was aimed at a redundant `Number.isFinite` rather
// than at the comparison that actually does the work.
const { test, expect } = require('@playwright/test');
const { shouldLogSlow, formatSlowPhases } = require('../lib/slow-log');

const BASE = { thresholdMs: 5000, gapMs: 30000, now: 1_000_000, lastLoggedAt: 0 };

test.describe('shouldLogSlow', () => {
  test('a fast call is not logged', () => {
    expect(shouldLogSlow({ ...BASE, totalMs: 120 })).toBe(false);
  });

  test('a slow call is logged', () => {
    expect(shouldLogSlow({ ...BASE, totalMs: 17431 })).toBe(true);
  });

  test('exactly at the threshold counts as slow', () => {
    // MUTATION: `>=` -> `>`. A threshold of 0 must mean "log everything" — that
    // is what makes the server wiring verifiable end to end — and a boundary
    // that silently excludes itself is how a guard ends up never firing.
    expect(shouldLogSlow({ ...BASE, totalMs: 5000 })).toBe(true);
  });

  test('THE FIRST slow call is never throttled away, even on a small clock', () => {
    // MUTATION: drop `lastLoggedAt > 0 &&`.
    // The clock here is deliberately SMALL. With a Date.now()-sized `now`,
    // `now - 0` is ~1.7e12 and never under gapMs, so the guard is unreachable
    // and the mutation changes nothing — which is exactly how the first draft of
    // this test passed against the broken rule.
    expect(shouldLogSlow({
      ...BASE, now: 5000, lastLoggedAt: 0, totalMs: 9999,
    })).toBe(true);
  });

  test('a second slow call inside the gap is throttled', () => {
    expect(shouldLogSlow({
      ...BASE, totalMs: 9999, lastLoggedAt: BASE.now - 5000,
    })).toBe(false);
  });

  test('a slow call past the gap logs again', () => {
    // The load-bearing negative of the throttle: were this false, the line would
    // appear once per process lifetime and read as a problem that fixed itself.
    expect(shouldLogSlow({
      ...BASE, totalMs: 9999, lastLoggedAt: BASE.now - 31000,
    })).toBe(true);
  });

  test('a NaN or missing measurement is NOT slow', () => {
    // MUTATION: `if (!(totalMs >= thresholdMs))` -> `if (totalMs < thresholdMs)`.
    // They look equivalent and are not: `NaN < t` is false, so the inverted form
    // falls straight past the guard and logs a garbage line on EVERY request
    // forever. A missing measurement must read as "not slow", never as "slow".
    expect(shouldLogSlow({ ...BASE, totalMs: NaN })).toBe(false);
    expect(shouldLogSlow({ ...BASE, totalMs: undefined })).toBe(false);
  });
});

test.describe('formatSlowPhases', () => {
  test('names every phase, including the zero ones', () => {
    // A phase missing from the line is indistinguishable from one never
    // measured, and naming the responsible phase is the whole point.
    const line = formatSlowPhases(
      { rpc: 12.4, metrics: 0, convIds: 0, runningWork: 17400.6 }, 17431.2);
    expect(line).toBe('total=17431ms rpc=12ms metrics=0ms convIds=0ms runningWork=17401ms');
  });

  test('an unmeasured phase is marked, not dropped', () => {
    expect(formatSlowPhases({ rpc: NaN }, 5000)).toBe('total=5000ms rpc=?ms');
  });

  test('no phases still reports the total', () => {
    expect(formatSlowPhases({}, 5000)).toBe('total=5000ms');
    expect(formatSlowPhases(null, 5000)).toBe('total=5000ms');
  });
});
