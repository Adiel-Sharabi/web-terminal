'use strict';
// The backward walk through a session's scrollback for the WEB client (#178) —
// a port of the companion's rule in `ai-terminal/lib/util/scrollback_window.dart`
// (#167/#174), which carries the full write-up and the measurements behind every
// constant here. Read that file before changing anything in this one.
//
// ## Why this is a port and not a reuse
//
// The rule is one rule and now has two implementations, which is exactly the
// drift this codebase keeps paying for. There is no way to share a Dart library
// with `app.html`'s inline JS, so the choice was: port it, or leave the web
// client with the arithmetic that produced #167 on the other client. The honest
// consolidation is to move the anchoring INTO `GET /api/sessions/:id/scrollback`
// — one implementation, both clients sending an anchor instead of computing a
// cut — and that is a separate, additive change. Until then: **the Dart file is
// the canonical statement of the rule**, this is its port, and
// `tests/scrollback-window.spec.js` mirrors the Dart fixtures so the two cannot
// silently disagree about behaviour.
//
// ## Why an absolute byte offset is not a position
//
// `GET /api/sessions/:id/scrollback` slices a buffer whose **head the worker
// trims on every PTY write** (`pty-worker.js`, 2 MB cap). A single response is
// exact, but offset 0 means a *different byte* on every request and nothing in
// the response says so — `total` sits pinned at the cap. So a walk that
// remembers "I have everything from byte X onwards" and next asks for
// `[X - step, X)` re-harvests the bytes the session emitted in between, exactly.
//
// `app.html`'s own arithmetic had the same disease in a mirrored form: its
// window is TAIL-relative (`total - historyOffset - CHUNK`) with `total` re-read
// every fetch while `historyOffset` only accumulates prepended lengths, so it
// drifted under tail GROWTH instead of head trimming. Same duplication, opposite
// sign.
//
// ## The rule: anchor on content, cut where the content repeats
//
// After each fetch keep a **head anchor** — the first bytes of the slice just
// consumed, i.e. the text that now begins everything on screen. The next request
// deliberately **over-fetches** by the anchor's length so the anchor is inside
// the returned slice even when nothing drifted, and the slice is cut where the
// anchor reappears. Everything from the cut on is already on screen and dropped.
//
// The guarantee is **conditional, not absolute**: where the anchor is
// unambiguous the harvest cannot repeat itself, and where it is ambiguous the
// walk STOPS rather than guess. The failure mode is less history — never history
// that repeats itself, and never a silent hole.

/** How much older scrollback one backward step pulls in. */
const SCROLLBACK_DEEPEN_BYTES = 262144;

/**
 * The FIRST anchor length tried at each step, and therefore how far past the
 * known window a request over-fetches. 4 KB: short enough that the over-fetch is
 * noise (1.5% of a step), long enough that ~35 lines of agent-TUI scrollback
 * *including* their escape sequences would have to repeat byte for byte to
 * false-match.
 */
const SCROLLBACK_ANCHOR_BYTES = 4096;

/**
 * The anchor lengths ONE step may try, as multiples of [SCROLLBACK_ANCHOR_BYTES]
 * — 4 KB, 16 KB, 64 KB.
 *
 * The top rung is bounded by the server, not by taste: `server.js` silently
 * clamps a `limit` above `SCROLLBACK_RANGE_MAX` (524288), and the clamp would
 * cut off exactly the over-fetch the anchor lives in — escalation would then
 * fail as "anchor not found" for a reason unrelated to the content. The largest
 * request this ladder can produce is
 * `SCROLLBACK_DEEPEN_BYTES + 16 * SCROLLBACK_ANCHOR_BYTES` = 327680. The spec
 * asserts that rather than trusting this comment.
 */
const SCROLLBACK_ANCHOR_LADDER = [1, 4, 16];

/**
 * Where the newest `budget` code units of a `total`-length scrollback begin.
 *
 * The endpoint pages FORWARD from `offset`, so fetching the tail means asking
 * for `total - budget`. Omitting the offset asks for the OLDEST bytes instead,
 * which is the whole defect this exists to prevent.
 */
function scrollbackTailOffset(total, budget) {
  const start = total - budget;
  return start > 0 ? start : 0;
}

/** Nothing to show, and the walk does not move. */
const NO_HARVEST = Object.freeze({ text: '', _earliest: -1, _anchor: '', _generation: -1 });

class ScrollbackWindow {
  /**
   * @param {{stepBytes?: number, anchorBytes?: number}} [opts] the defaults are
   *   the shipped ones; the parameters exist so a spec can drive the same rules
   *   over a small buffer.
   */
  constructor(opts = {}) {
    this.stepBytes = opts.stepBytes || SCROLLBACK_DEEPEN_BYTES;
    this.anchorBytes = opts.anchorBytes || SCROLLBACK_ANCHOR_BYTES;
    this._earliest = 0;
    this._exhausted = true;
    this._anchorMaterial = '';
    this._rung = 0;
    this._generation = 0;
  }

  /** The longest anchor the ladder can reach — and so how much head is kept. */
  get _maxAnchorBytes() {
    return this.anchorBytes * SCROLLBACK_ANCHOR_LADDER[SCROLLBACK_ANCHOR_LADDER.length - 1];
  }

  /** How long the anchor is on THIS attempt at the current step. */
  get _rungBytes() { return this.anchorBytes * SCROLLBACK_ANCHOR_LADDER[this._rung]; }

  /** The anchor actually matched on this attempt: the head of the screen, clipped. */
  get _activeAnchor() {
    return this._anchorMaterial.length <= this._rungBytes
      ? this._anchorMaterial
      : this._anchorMaterial.slice(0, this._rungBytes);
  }

  /**
   * Moves to the next rung, or reports that there is nothing longer to try.
   *
   * Refusing to climb when the screen's own head is already shorter than the
   * rung asked for matters: every rung costs a whole extra round trip, and a
   * rung that yields a byte-identical anchor is guaranteed to reach the
   * byte-identical verdict.
   */
  _escalateAnchor() {
    if (this._rung >= SCROLLBACK_ANCHOR_LADDER.length - 1) return false;
    const before = this._activeAnchor.length;
    this._rung++;
    if (this._activeAnchor.length > before) return true;
    this._rung = SCROLLBACK_ANCHOR_LADDER.length - 1;
    return false;
  }

  /** The head of the screen, kept at the longest length any rung could ask for. */
  _headMaterial(data) {
    return data.length <= this._maxAnchorBytes ? data : data.slice(0, this._maxAnchorBytes);
  }

  /** The offset the last fetch started at — a REQUEST coordinate, nothing more. */
  get earliest() { return this._earliest; }

  /** Whether the walk has stopped (start reached, fetch failed, anchor lost). */
  get exhausted() { return this._exhausted; }

  /** The head anchor of everything on screen, at this attempt's length. */
  get anchor() { return this._activeAnchor; }

  /** The current walk. Bumped by [reset] and [noteReplay]. */
  get generation() { return this._generation; }

  /**
   * Abandons the current walk — a fresh attach replay is about to land, and any
   * request already in flight belongs to history that no longer lines up.
   */
  reset() {
    this._generation++;
    this._earliest = 0;
    this._exhausted = true;
    this._anchorMaterial = '';
    this._rung = 0;
  }

  /** Stops the walk where it is, keeping the history already loaded. */
  stop() { this._exhausted = true; }

  /**
   * Records the attach replay — `data` is the newest slice already on screen and
   * `offset` is where the server said it begins. Starts a new walk, so anything
   * in flight from the previous one is rejected by [consume] from here on.
   *
   * **Seeding `earliest` from the replay is what fixes `app.html`'s "the first
   * backfill re-prepends what is already visible".** Its `historyOffset` started
   * at 0 and was never told how big the replay was, so the first real fetch
   * asked for `[total - 32768, total)` while `scrollbackReplayLimit` defaults to
   * exactly 32768 — it prepended the whole visible screen above itself.
   */
  noteReplay(data, offset) {
    this._generation++;
    this._earliest = offset;
    this._exhausted = offset <= 0;
    this._anchorMaterial = this._headMaterial(data || '');
    this._rung = 0;
  }

  /**
   * The next range to fetch, or null when there is nothing older to ask for.
   *
   * The range runs one `stepBytes` back from the window already held, to the
   * current rung's anchor length PAST it. That over-fetch is the whole trick:
   * with no drift the anchor begins exactly at `earliest`, so without it the
   * anchor would sit one byte past the end of the slice and could never match.
   */
  nextRequest() {
    if (this._exhausted) return null;
    if (this._earliest <= 0) { this._exhausted = true; return null; }
    const start = scrollbackTailOffset(this._earliest, this.stepBytes);
    const end = this._earliest + this._rungBytes;
    return { offset: start, limit: end - start, generation: this._generation };
  }

  /**
   * Folds a fetched slice into the walk, returning the text genuinely older than
   * everything already on screen. **The walk does not move until [commit] is
   * handed the result.**
   *
   * `generation` must be the one carried by the request this answers. A mismatch
   * means an attach re-armed the walk while the request was in flight; the
   * response is dropped without touching any state, because writing `earliest`
   * from it is exactly the corruption that leaves a hole in history.
   *
   * **When the boundary cannot be established the walk STOPS**, for all four
   * reasons it can fail: the slice is empty AT ANY OFFSET (a shrinking buffer
   * answers a request that fell off its front with nothing, and a walk that
   * stayed armed there would re-issue the identical request for ever); there is
   * no anchor to cut on; the anchor is nowhere in the slice (the buffer moved
   * further than a whole step); or the anchor repeats at every length the ladder
   * can reach. In each case the boundary is unknown, and both ways of guessing
   * are worse than stopping — keeping the slice duplicates what is already on
   * screen (the reported bug), and skipping it while still advancing leaves a
   * silent HOLE, which is the same class of lie.
   */
  consume(data, offset, generation) {
    if (generation !== this._generation) return NO_HARVEST;
    if (offset <= 0) this._exhausted = true;
    if (!data) { this._exhausted = true; return NO_HARVEST; }

    const previous = this._activeAnchor;
    // No anchor means nothing to cut on. "Nothing is on screen yet, so this
    // slice can duplicate nothing" is unsound: an attach whose HTTP replay came
    // back empty still ends up with a terminal filled by the SOCKET replay, and
    // prepending the whole slice uncut lands it on top of text it overlaps.
    if (!previous) { this._exhausted = true; return NO_HARVEST; }

    // Where the boundary would sit if nothing had drifted. An upper BOUND, not a
    // guess: head-trimming strips strictly more from the front on every request,
    // so drift pulls the anchor EARLIER into the slice, and a match past this
    // point is a self-repeat inside text already on screen — a repainting TUI
    // supplies those by the screenful, and cutting there is the duplication this
    // exists to stop.
    let limit = this._earliest - offset;
    if (limit < 0) { this._exhausted = true; return NO_HARVEST; }
    // The bound is a WALK coordinate; the slice may be shorter than the walk
    // expects (persistScrollback is off by default, so a worker restart collapses
    // a session's scrollback and it regrows from there).
    if (limit > data.length) limit = data.length;

    // Within the bound, the LAST occurrence. An earlier match is content the
    // later one proves is genuinely older, and cutting there discards it for good.
    const cut = data.lastIndexOf(previous, limit);
    if (cut < 0) { this._exhausted = true; return NO_HARVEST; }

    // ...unless the anchor REPEATS, in which case "the last occurrence" is not
    // evidence of anything. Scan forward from one anchor-length below the match:
    // a hit before it proves the region is periodic and the cut cannot be
    // trusted. Forward, not backward, so the scan is bounded by the anchor
    // length instead of the whole slice.
    const from = cut > previous.length ? cut - previous.length : 0;
    if (from < cut && data.indexOf(previous, from) < cut) {
      // Periodic AT THIS ANCHOR LENGTH — a much weaker statement than
      // "unknowable". Retry the SAME step with a longer anchor first; only when
      // the longest rung still self-matches is stopping honest.
      if (!this._escalateAnchor()) this._exhausted = true;
      return NO_HARVEST;
    }

    return {
      text: data.slice(0, cut),
      _earliest: offset,
      _anchor: this._headMaterial(data),
      _generation: generation,
    };
  }

  /**
   * Moves the walk onto `harvest` — call it once the harvest has been accounted
   * for, whether or not it produced anything to show. A harvest from an
   * abandoned walk is ignored, for the same reason [consume] drops one.
   */
  commit(harvest) {
    if (!harvest || harvest._generation !== this._generation) return;
    this._earliest = harvest._earliest;
    this._anchorMaterial = harvest._anchor;
    // Back to the cheap rung. Escalation is a property of the STEP that needed
    // it, not of the walk: the periodic region is now behind the boundary, and
    // carrying its rung forward would over-fetch 64 KB on every remaining step.
    this._rung = 0;
    if (this._earliest <= 0) this._exhausted = true;
  }
}

const _api = {
  ScrollbackWindow,
  scrollbackTailOffset,
  SCROLLBACK_DEEPEN_BYTES,
  SCROLLBACK_ANCHOR_BYTES,
  SCROLLBACK_ANCHOR_LADDER,
};

// Dual-mode ON PURPOSE, and it is what makes this a shared rule rather than a
// third copy of one. `app.html` is a single page of inline JS with no bundler,
// so the only ways to give the browser this rule were to paste it in (a copy
// that drifts from the copy the spec tests — the exact failure this file exists
// to stop repeating) or to serve the same bytes to both. server.js serves it at
// `/lib/scrollback-window.js`, behind the same blanket auth as every other page
// route, so the Node spec and the browser execute the SAME file.
/* istanbul ignore else */
if (typeof module !== 'undefined' && module.exports) module.exports = _api;
else if (typeof self !== 'undefined') self.WTScrollback = _api;
