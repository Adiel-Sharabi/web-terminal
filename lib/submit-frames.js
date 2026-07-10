'use strict';
// How a keystroke frame must be delivered to an agent whose TUI folds a whole read into
// a paste.
//
// Codex's TUI (paste_burst.rs) coalesces every byte of one read into pasted content. A
// frame like `hello\r` therefore lands as the text `hello` plus a NEWLINE in its
// composer — never Enter — so the prompt is typed but never submitted. Claude Code has
// no such detector, which is why both clients send prompt+CR as one atomic frame (#44:
// a CR written later can be lost if the socket dies in the gap).
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

/** The CR that submits, as its own frame. */
const CR_FRAME = Buffer.from([CR]);

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

module.exports = { splitTrailingCr, CR_FRAME };
