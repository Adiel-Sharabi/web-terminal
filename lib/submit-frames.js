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
//
// The gap is between the CR and WHATEVER PRECEDES IT ON THE WIRE — not merely what
// precedes it in the same frame. The TUI's burst detector works on reads; our frame
// boundaries are invisible to it. Two frames written microseconds apart land in one read
// and are folded together exactly as if they had been one frame all along.

const CR = 0x0d;
const ESC = 0x1b;

/** The CR that submits, as its own frame. */
const CR_FRAME = Buffer.from([CR]);

/** The bracketed-paste close — the bytes a TUI's paste burst ends on. */
const PASTE_CLOSE = '\x1b[201~';
const PASTE_CLOSE_BUF = Buffer.from(PASTE_CLOSE, 'latin1');

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
 * Does this frame END a bracketed paste?
 *
 * A paste close is the one thing that can still absorb a CR arriving in the NEXT frame:
 * the TUI's burst detector reads bytes, not frames, so a CR written microseconds after
 * the close is folded into the very same paste it would have been folded into inside one
 * frame. That is not theory — it is the image-attach bug: the compose bar sends each
 * staged image as `ESC[200~<path>ESC[201~` and, when the prompt is images-only, the submit
 * as a BARE CR right behind it. Each frame is individually innocent; together they are the
 * measured `close + immediate CR` case, and the image was typed into the composer and
 * never sent (reported on the S25 companion: "the image moved to the terminal line but was
 * not sent — I had to press Enter again").
 *
 * Accepts a Buffer or a string — the worker writes both.
 */
function endsBracketedPaste(data) {
  if (!data || !data.length) return false;
  if (typeof data === 'string') return data.endsWith(PASTE_CLOSE);
  return data.length >= PASTE_CLOSE_BUF.length
    && data.subarray(data.length - PASTE_CLOSE_BUF.length).equals(PASTE_CLOSE_BUF);
}

/**
 * Split a PTY input frame that ends in a submit CR.
 *
 * Returns `null` when the frame needs no special handling — which is the common case and
 * must stay cheap:
 *   - anything not ending in `\r` (ordinary typing, escape sequences, an open paste),
 *   - a bare `\r` on a COLD PTY: nothing was just written, so nothing can absorb it.
 *
 * `afterPasteClose` is that coldness, decided by the caller (it owns the clock): the last
 * bytes this PTY was given closed a bracketed paste, recently enough that the TUI can
 * still fold this CR into it. Only then is a lone CR held back — so ordinary char-by-char
 * shell typing, which is what makes the overwhelming majority of lone CRs, stays exactly
 * as immediate as it has always been.
 *
 * Otherwise returns `{ head, cr }`: `head` is written immediately, `cr` after the gap.
 * `head` is a view into `data`, not a copy, and is EMPTY for a held-back lone CR.
 */
function splitTrailingCr(data, { afterPasteClose = false } = {}) {
  if (!data || data.length === 0) return null;
  if (data[data.length - 1] !== CR) return null;
  if (data.length === 1 && !afterPasteClose) return null;
  return { head: data.subarray(0, data.length - 1), cr: CR_FRAME };
}

module.exports = { splitTrailingCr, isEscapeKey, endsBracketedPaste, CR_FRAME };
