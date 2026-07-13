'use strict';
// The two turn-lifecycle keys on the PTY input path: the CR that SUBMITS a turn, and the
// Esc that INTERRUPTS one. Both are decided here, as pure functions over the raw frame; the
// policy that says whether an agent needs them lives in lib/agents.js.
//
// The submit CR — how a keystroke frame must be delivered to an agent whose TUI folds a
// whole read into a paste.
//
// Codex's TUI (paste_burst.rs) coalesces every byte of one read into pasted content. A
// frame like `hello\r` therefore lands as the text `hello` plus a NEWLINE in its
// composer — never Enter — so the prompt is typed but never submitted.
//
// Claude's TUI does the same thing; it just needs a bigger read to trip it, which is
// why it looked exempt for a long time. Measured against the real TUI, atomic `text\r`:
// 20/40/60 chars submitted, 80 and 120 did NOT — so a short prompt worked and a real
// one was typed and never sent. Split the CR off and every length submits. (#44 still
// holds: the WORKER owns the delayed CR, so a client dying in the gap cannot lose it.)
//
// The fix is timing, not bytes: hold back the trailing CR and write it alone, after the
// agent's `submit.gapMs`. Measured against codex 0.144.0 — a CR split off by <=30ms is
// still absorbed into the paste; >=60ms submits. Bracketed paste does not exempt it: a
// CR immediately after the `ESC[201~` close in the SAME write is absorbed too, and the
// same close followed by a delayed CR submits. Only the gap matters.
//
// Clients stay unchanged (and unaware): every one of them — web, companion, and any
// future one — is corrected at the single point where the bytes meet the PTY.

const CR = 0x0d;
const ESC = 0x1b;

/** The CR that submits, as its own frame. */
const CR_FRAME = Buffer.from([CR]);

/**
 * Is this frame the Esc KEY — the interrupt — rather than the lead byte of an escape
 * sequence?
 *
 * Every other use of 0x1b on this path carries payload behind it in the SAME frame: an arrow
 * is `ESC [ A`, a bracketed paste opens with `ESC [ 200 ~`. A frame that is 0x1b and nothing
 * else can only be the Esc key. That is why the test is on the frame's LENGTH, not on a
 * prefix — matching a leading ESC would read every arrow key as an interrupt.
 */
function isEscapeKey(data) {
  return !!data && data.length === 1 && data[0] === ESC;
}


/**
 * Split a PTY input frame that ends in a submit CR.
 *
 * Returns `null` when the frame needs no special handling — which is the common case and
 * must stay cheap:
 *   - a bare `\r` (nothing precedes it, so nothing can absorb it),
 *   - anything not ending in `\r` (ordinary typing, escape sequences, an open paste).
 *
 * Otherwise returns `{ head, cr }`: `head` is written immediately, `cr` after the gap.
 * `head` is a view into `data`, not a copy.
 */
function splitTrailingCr(data) {
  if (!data || data.length < 2) return null;
  if (data[data.length - 1] !== CR) return null;
  return { head: data.subarray(0, data.length - 1), cr: CR_FRAME };
}

module.exports = { splitTrailingCr, isEscapeKey, CR_FRAME };
