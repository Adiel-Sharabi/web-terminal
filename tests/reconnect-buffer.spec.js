// @ts-check
// #201 — the cluster reconnect buffer's admission rule.
//
// The buffer holds what a browser typed while the proxy's link to a remote peer was
// down, and replays it on reconnect. Its whole polarity is a promise about what the user
// sees replayed: a refusal drops the NEWEST write, so a replay is a PREFIX of what was
// typed and never a hole in the middle of it.
//
// #201 added a BYTE bound beside the existing COUNT bound and asserted, in the comment
// right next to it, that the two share that polarity. They did not. The count bound is
// monotone by construction (`buffered.length` only grows until the flush resets it), so
// it latches for free. `bytes + size <= maxBytes` is a per-frame FIT test, so a large
// frame refused for bytes is followed by a smaller one that still fits — the exact hole
// the comment promised could not occur. The middle-hole case below is the one that was
// red before the latch; every other test here passed either way and is a guard, not a
// demonstration.
const { test, expect } = require('@playwright/test');
const { admits } = require('../lib/reconnect-buffer');

const LIMITS = { maxEntries: 100, maxBytes: 4 * 1024 * 1024 };
const open = (count, bytes) => ({ count, bytes, latched: false });

test.describe('#201 the cluster reconnect buffer admission rule', () => {
  test('an empty buffer admits an ordinary write', () => {
    expect(admits(open(0, 0), 12, LIMITS)).toBe(true);
  });

  test('THE BUG: a byte refusal must not be followed by a smaller admission', () => {
    // The reviewer's construction, entirely from legitimate frames: five near-maximal
    // ones (786,432 bytes each — the WS_INPUT_MAX worst case) leave ~262KB of headroom.
    const near = 786432;
    const bytes = near * 5;                       // 3,932,160 of 4,194,304
    expect(bytes).toBeLessThan(LIMITS.maxBytes);

    // A 300KB write does not fit. It is refused — correctly.
    expect(admits(open(5, bytes), 300 * 1024, LIMITS)).toBe(false);

    // ...and THAT is what must latch. A 100KB write typed afterwards DOES fit by
    // arithmetic, and admitting it would replay the later text with the earlier text
    // missing from the middle. Without the latch this line returns true.
    expect(admits({ count: 5, bytes, latched: true }, 100 * 1024, LIMITS)).toBe(false);
  });

  test('a latched buffer refuses even a write that would trivially fit', () => {
    // Once latched, size is irrelevant — a single keystroke behind a gap is still
    // behind a gap.
    expect(admits({ count: 0, bytes: 0, latched: true }, 1, LIMITS)).toBe(false);
  });

  test('the COUNT bound is exact, and latches on its own by being monotone', () => {
    expect(admits(open(99, 0), 1, LIMITS)).toBe(true);
    expect(admits(open(100, 0), 1, LIMITS)).toBe(false);
    // 100 entries is the ceiling whatever the bytes say.
    expect(admits(open(100, 0), 0, LIMITS)).toBe(false);
  });

  test('the BYTE bound is exact: at the ceiling passes, one over does not', () => {
    expect(admits(open(1, LIMITS.maxBytes - 10), 10, LIMITS)).toBe(true);
    expect(admits(open(1, LIMITS.maxBytes - 10), 11, LIMITS)).toBe(false);
    // A single write larger than the whole ceiling is refused from empty — it can never
    // be admitted by waiting, so this is a refusal and not a deferral.
    expect(admits(open(0, 0), LIMITS.maxBytes + 1, LIMITS)).toBe(false);
  });

  test('a zero-length write is still counted against the ENTRY bound', () => {
    // Otherwise an unbounded number of empty frames would sit in the buffer costing
    // nothing in bytes and everything in entries.
    expect(admits(open(100, 0), 0, LIMITS)).toBe(false);
  });

  test('the rule is PURE — it never mutates the state it is handed', () => {
    const state = open(5, 1000);
    const before = JSON.stringify(state);
    admits(state, 10, LIMITS);
    admits(state, LIMITS.maxBytes, LIMITS);
    expect(JSON.stringify(state)).toBe(before);
  });
});
