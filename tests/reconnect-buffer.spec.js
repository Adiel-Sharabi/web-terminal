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
const { admits, decide } = require('../lib/reconnect-buffer');

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

// #204 — the refusal above was SILENT to the browser, which is the one thing #193 says
// it must not be. `localWs` is open throughout (the REMOTE link is what is down), so
// the notice always had somewhere to go.
//
// The interesting half is not "report it" but "report it ONCE". A latched buffer refuses
// every subsequent keystroke, so reporting each one would answer an outage the user
// types through with a banner per character — noise that teaches them to ignore the one
// notice that mattered. The latch is what makes one the right number, which is why the
// reporting rule is derived from it here rather than written as an `if` at the call site.
test.describe('#204 how many refusals the browser is told about', () => {
  test('an admitted write reports nothing', () => {
    expect(decide(open(0, 0), 12, LIMITS)).toEqual({ admit: true, notify: false });
  });

  test('the FIRST refusal of an outage is reported', () => {
    expect(decide(open(LIMITS.maxEntries, 0), 1, LIMITS)).toEqual({ admit: false, notify: true });
    // ...whichever bound it hit. Both are refusals for the same reason from the user's
    // side: what you typed while the link was down did not fit.
    expect(decide(open(0, LIMITS.maxBytes), 1, LIMITS)).toEqual({ admit: false, notify: true });
  });

  test('every LATER refusal in the same outage is silent', () => {
    // This is the whole point. Without the `!latched` guard a sustained outage answers
    // every keystroke with its own notice.
    const latched = { count: LIMITS.maxEntries, bytes: 0, latched: true };
    expect(decide(latched, 1, LIMITS)).toEqual({ admit: false, notify: false });
    expect(decide(latched, 999999, LIMITS)).toEqual({ admit: false, notify: false });
  });

  test('after a flush clears the latch, the next outage reports again', () => {
    // The flush resets count/bytes/latched together (server.js, the remote `open`
    // handler). A cleared latch must not be a permanently silenced one — the next
    // outage is a new fact and deserves its own notice.
    const afterFlush = open(0, 0);
    expect(decide(afterFlush, 12, LIMITS).notify).toBe(false); // fits, nothing to say
    expect(decide(open(LIMITS.maxEntries, 0), 1, LIMITS).notify).toBe(true);
  });

  test('deciding is PURE too — no counter hidden in the module', () => {
    // A "report once" rule implemented with module state would report once per PROCESS,
    // not once per outage, and would be shared by every proxied session on the server.
    const state = open(LIMITS.maxEntries, 0);
    expect(decide(state, 1, LIMITS).notify).toBe(true);
    expect(decide(state, 1, LIMITS).notify).toBe(true);
    expect(JSON.stringify(state)).toBe(JSON.stringify(open(LIMITS.maxEntries, 0)));
  });
});
