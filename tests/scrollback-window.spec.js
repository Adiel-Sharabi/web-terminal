// @ts-check
// lib/scrollback-window.js — the content-anchored backward walk the WEB client
// uses to deepen a session's scrollback (#178), ported from the companion's
// rule (ai-terminal/lib/util/scrollback_window.dart, #167).
//
// These mirror the Dart suite's fixtures on purpose: one rule with two
// implementations can only stay one rule if both are pinned by the same shapes.
//
// The model below is the SERVER, faithfully enough for the walk to be wrong
// against it if the rule is wrong: a capped buffer whose HEAD is trimmed as new
// output arrives, sliced by `offset`/`limit` out of a `total` that sits pinned at
// the cap. That head-trim is the whole reason an absolute offset is not a
// position, and a model without it cannot fail the way production does.
const { test, expect } = require('@playwright/test');
const {
  ScrollbackWindow,
  scrollbackTailOffset,
  SCROLLBACK_DEEPEN_BYTES,
  SCROLLBACK_ANCHOR_BYTES,
  SCROLLBACK_ANCHOR_LADDER,
} = require('../lib/scrollback-window');

/** A 2 MB-style ring: append at the tail, trim at the head, slice by offset. */
class ServerModel {
  constructor(initial, cap) {
    this.buf = initial;
    this.cap = cap;
  }
  /** New output arrives — this is what makes offset 0 mean a different byte. */
  emit(text) {
    this.buf += text;
    if (this.buf.length > this.cap) this.buf = this.buf.slice(this.buf.length - this.cap);
  }
  get total() { return this.buf.length; }
  slice(offset, limit) {
    const start = Math.min(offset, this.total);
    const end = Math.min(start + limit, this.total);
    return this.buf.slice(start, end);
  }
}

/** Distinct, non-repeating content so a wrong cut is detectable by inspection. */
function uniqueText(units) {
  let s = '';
  let i = 0;
  while (s.length < units) s += `[line ${i++} ${'.'.repeat(40)}]\n`;
  return s.slice(0, units);
}

/** Drive a whole walk, returning the text harvested at each step. */
function walk(win, server, steps, driftPerStep = 0, driftText = 'x') {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const req = win.nextRequest();
    if (!req) break;
    if (driftPerStep) server.emit(driftText.repeat(driftPerStep));
    const data = server.slice(req.offset, req.limit);
    const harvest = win.consume(data, req.offset, req.generation);
    win.commit(harvest);
    if (!harvest.text) break;
    out.push(harvest.text);
  }
  return out;
}

test('scrollbackTailOffset asks for the NEWEST budget, never the oldest', () => {
  // Omitting the offset (i.e. 0) asks for the oldest bytes — the whole defect.
  expect(scrollbackTailOffset(100, 30)).toBe(70);
  expect(scrollbackTailOffset(10, 30)).toBe(0); // shorter than the budget
  expect(scrollbackTailOffset(0, 30)).toBe(0);
});

test('the largest request the ladder can produce stays under SCROLLBACK_RANGE_MAX', () => {
  // server.js clamps a `limit` above 524288 SILENTLY, and the clamp would cut off
  // exactly the over-fetch the anchor lives in — escalation would then fail as
  // "anchor not found" for a reason that has nothing to do with the content.
  const top = SCROLLBACK_ANCHOR_LADDER[SCROLLBACK_ANCHOR_LADDER.length - 1];
  const largest = SCROLLBACK_DEEPEN_BYTES + top * SCROLLBACK_ANCHOR_BYTES;
  expect(largest).toBe(327680);
  expect(largest).toBeLessThanOrEqual(524288);
});

test('a walk with no replay recorded is stopped — it has nothing to anchor on', () => {
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  expect(win.exhausted).toBe(true);
  expect(win.nextRequest()).toBeNull();
});

test('noteReplay seeds `earliest`, so the FIRST request cannot re-ask for the visible tail', () => {
  // #178 mechanism 2: app.html's historyOffset started at 0 and was never told how
  // big the replay was, so its first real fetch asked for [total-32768, total) —
  // and scrollbackReplayLimit defaults to exactly 32768. It prepended the entire
  // visible screen above itself. Seeding from the replay is what stops that.
  const total = 10000;
  const replayAt = scrollbackTailOffset(total, 2000); // 8000
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay(uniqueText(2000), replayAt);

  const req = win.nextRequest();
  // The request must END at (or just past, by the anchor over-fetch) the point the
  // replay BEGINS — never reach into the replay's own span beyond that.
  expect(req.offset).toBe(replayAt - 500);
  expect(req.offset + req.limit).toBe(replayAt + 50); // step back, anchor forward
  // The decisive property: it does not fetch the tail again.
  expect(req.offset + req.limit).toBeLessThan(total);
});

test('the request over-fetches by exactly the anchor length, or the anchor could never match', () => {
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay(uniqueText(1000), 4000);
  const req = win.nextRequest();
  // With no drift the anchor begins exactly AT `earliest`; without the over-fetch
  // it would sit one unit past the end of the slice and never be found.
  expect(req.offset + req.limit - 4000).toBe(50);
});

test('a walk over a QUIET buffer harvests each region exactly once', () => {
  const body = uniqueText(6000);
  const server = new ServerModel(body, 100000);
  const win = new ScrollbackWindow({ stepBytes: 1000, anchorBytes: 100 });
  const replayAt = scrollbackTailOffset(server.total, 1500);
  win.noteReplay(server.slice(replayAt, 1500), replayAt);

  const harvested = walk(win, server, 20);
  const joined = harvested.slice().reverse().join('');
  // Everything harvested plus the replay reconstructs the head of the buffer with
  // no repetition: the concatenation is a prefix of the original.
  expect(body.startsWith(joined)).toBe(true);
  expect(joined.length).toBeGreaterThan(3000);
});

test('THE REGRESSION: a buffer that keeps emitting does not re-harvest what is already shown', () => {
  // #178 mechanism 1. app.html's window was TAIL-relative — `total - historyOffset
  // - CHUNK` with `total` re-read every fetch while `historyOffset` only
  // accumulated prepended lengths — so every unit emitted between two backfills
  // shifted the next window that much NEWER, and it re-fetched exactly that much
  // already-visible content. Content anchoring finds the boundary wherever the
  // drift put it.
  const body = uniqueText(40000);
  const server = new ServerModel(body, 40000); // at the cap: every emit trims the head
  const win = new ScrollbackWindow({ stepBytes: 2000, anchorBytes: 200 });
  const replayAt = scrollbackTailOffset(server.total, 3000);
  win.noteReplay(server.slice(replayAt, 3000), replayAt);

  // 700 units of new output between every step — the drift that broke the arithmetic.
  const harvested = walk(win, server, 8, 700, 'N');

  expect(harvested.length).toBeGreaterThan(0);
  // No harvested chunk may overlap the one after it: joined newest-last, each
  // piece must be genuinely older than the previous screen. Assert directly that
  // the reconstruction contains no adjacent duplication.
  for (let i = 0; i < harvested.length; i++) {
    const piece = harvested[i];
    expect(piece.length).toBeGreaterThan(0);
    // A re-harvest shows up as the piece being a suffix of what is already known.
    const laterPieces = harvested.slice(0, i).join('');
    if (laterPieces.length >= piece.length) {
      expect(laterPieces.startsWith(piece)).toBe(false);
    }
  }
});

test('a slice that is EMPTY at a positive offset stops the walk, instead of re-asking for ever', () => {
  // A shrinking buffer answers a request that fell off its front with nothing, at
  // a POSITIVE offset. Without this the walk's state never changes: the same
  // request would be re-issued on every scroll for the life of the view.
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay(uniqueText(1000), 4000);
  const req = win.nextRequest();
  const harvest = win.consume('', req.offset, req.generation);
  expect(harvest.text).toBe('');
  expect(win.exhausted).toBe(true);
  expect(win.nextRequest()).toBeNull();
});

test('a response from an ABANDONED walk is dropped without touching the state', () => {
  // An attach re-armed the walk while the request was in flight. Writing
  // `earliest` from it is the corruption that leaves a hole in history.
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay(uniqueText(1000), 4000);
  const req = win.nextRequest();
  const staleGen = req.generation;

  win.noteReplay(uniqueText(1000), 2000); // a fresh attach
  const before = win.earliest;
  const harvest = win.consume(uniqueText(600), req.offset, staleGen);
  win.commit(harvest);
  expect(harvest.text).toBe('');
  expect(win.earliest).toBe(before); // untouched
});

test('an anchor nowhere in the slice stops the walk rather than prepending a duplicate', () => {
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay('ANCHORTEXT'.repeat(5), 4000);
  const req = win.nextRequest();
  // A slice that shares nothing with the anchor — the buffer moved further than a
  // whole step.
  const harvest = win.consume('z'.repeat(req.limit), req.offset, req.generation);
  expect(harvest.text).toBe('');
  expect(win.exhausted).toBe(true);
});

test('a PERIODIC region escalates the anchor before giving up, and never cuts on a repeat', () => {
  // A repainting TUI, or an idle agent printing blank lines, fills the buffer with
  // a region that matches at every period, and the bound's own drift slack lets a
  // later occurrence win. Cutting there is the duplication this exists to stop.
  const period = 'FRAME-------\n'; // 13 units
  const win = new ScrollbackWindow({ stepBytes: 600, anchorBytes: 26 }); // anchor = 2 periods
  win.noteReplay(period.repeat(40), 3000);

  const first = win.nextRequest();
  expect(first.limit).toBe(600 + 26);
  // The slice is the same frame over and over: the anchor matches everywhere.
  const harvest = win.consume(period.repeat(80), first.offset, first.generation);
  expect(harvest.text).toBe(''); // refused
  expect(win.exhausted).toBe(false); // ...but escalated rather than stopped

  const second = win.nextRequest();
  expect(second.offset).toBe(first.offset); // the SAME step, re-asked
  expect(second.limit).toBeGreaterThan(first.limit); // with a longer anchor
});

test('escalation climbs the ladder and stops honestly at the top rung', () => {
  const period = 'AB';
  const win = new ScrollbackWindow({ stepBytes: 600, anchorBytes: 8 });
  win.noteReplay(period.repeat(500), 3000);
  const limits = [];
  for (let i = 0; i < 5; i++) {
    const req = win.nextRequest();
    if (!req) break;
    limits.push(req.limit);
    win.commit(win.consume(period.repeat(400), req.offset, req.generation));
  }
  // Three rungs (x1, x4, x16) then the walk stops rather than guess a boundary.
  expect(limits).toEqual([608, 632, 728]);
  expect(win.exhausted).toBe(true);
});

test('a successful step drops back to the CHEAP rung', () => {
  // Escalation is a property of the STEP that needed it, not of the walk: the
  // periodic region is behind the boundary now, and carrying its rung forward
  // would over-fetch on every remaining step for nothing.
  const win = new ScrollbackWindow({ stepBytes: 600, anchorBytes: 26 });
  const period = 'FRAME-------\n';
  win.noteReplay(period.repeat(40), 3000);
  const a = win.nextRequest();
  win.consume(period.repeat(80), a.offset, a.generation); // escalate
  const b = win.nextRequest();
  expect(b.limit).toBeGreaterThan(a.limit);

  // Now answer with a slice whose head is unique and which ENDS with the anchor.
  const anchor = win.anchor;
  const older = uniqueText(500);
  const harvest = win.consume(older + anchor, b.offset, b.generation);
  win.commit(harvest);
  expect(harvest.text).toBe(older);

  const c = win.nextRequest();
  expect(c.limit).toBe(600 + 26); // back to the base rung
});

test('reaching the start of the buffer ends the walk', () => {
  const win = new ScrollbackWindow({ stepBytes: 500, anchorBytes: 50 });
  win.noteReplay(uniqueText(300), 0); // the replay already begins at byte 0
  expect(win.exhausted).toBe(true);
  expect(win.nextRequest()).toBeNull();
});
