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
const { admits, decide, giveUp } = require('../lib/reconnect-buffer');

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

  // #209 — the proxy STOPS reconnecting, and everything it was holding goes with the
  // socket. `decide` covers the refusal; this covers the abandonment, which is the
  // opposite case and until now the silent one.
  //
  // WHY THESE LIVE HERE AND NOT ONLY IN THE INTEGRATION TEST. Two of the three facts
  // below are otherwise reachable only through a 37-second cluster-proxy run against a
  // dead peer, and the third — the unconditional latch — is not reachable from outside
  // AT ALL: it guards a window inside a closing socket, where by construction no notice
  // could ever be sent to observe. The rule is testable even where the race is not.
  test('the give-up reports what was LOST, which is not what was HELD', () => {
    // Once the buffer latched, `count` is pinned at maxEntries and every later write in
    // that outage was refused into no array. Reporting `count` alone would tell somebody
    // who typed 105 things that it lost 100 — with a precise figure, which is the shape
    // this whole family of notices exists to avoid.
    const loss = giveUp({
      count: LIMITS.maxEntries, bytes: 4000, latched: true,
      refusedCount: 5, refusedBytes: 60,
    });
    expect(loss.writes).toBe(105);
    expect(loss.bytes).toBe(4060);
  });

  test('a buffer that never refused anything reports exactly what it held', () => {
    const loss = giveUp(open(3, 35));
    expect(loss.writes).toBe(3);
    expect(loss.bytes).toBe(35);
  });

  test('an EMPTY buffer is not a loss — zero, so the caller says nothing', () => {
    expect(giveUp(open(0, 0)).writes).toBe(0);
  });

  test('the state a give-up leaves behind is LATCHED, even when nothing was lost', () => {
    // The half no integration test can see. `close()` moves a socket to CLOSING and the
    // transport keeps delivering messages until the peer's close frame arrives; anything
    // admitted in that window lands in a buffer nothing will ever flush. An empty buffer
    // has the identical window, so the latch cannot hang off "something was lost" — and
    // a conditional latch would pass every other test in this file.
    expect(giveUp(open(0, 0)).next.latched).toBe(true);
    expect(giveUp(open(7, 70)).next.latched).toBe(true);
  });

  test('and that state REFUSES the next write, which is what the latch is for', () => {
    // Stated as the invariant rather than as a field: what matters is not that a boolean
    // is true but that a write arriving in the closing window cannot be admitted.
    const after = giveUp(open(0, 0)).next;
    expect(decide(after, 5, LIMITS).admit).toBe(false);
    // And silently — `decide` answers a latched buffer with notify:false, so a socket
    // that is going away never grows a second banner.
    expect(decide(after, 5, LIMITS).notify).toBe(false);
  });

  test('giving up is PURE — the caller adopts `next`, the module keeps nothing', () => {
    const state = { count: 4, bytes: 40, latched: false, refusedCount: 1, refusedBytes: 9 };
    const before = JSON.stringify(state);
    expect(giveUp(state).writes).toBe(5);
    expect(giveUp(state).writes).toBe(5);
    expect(JSON.stringify(state)).toBe(before);
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
