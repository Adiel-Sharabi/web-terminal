'use strict';
// #146/#59 — one PTY, many viewers, ONE size. Which one?
//
// ## The bug this fixes, and how it was found
//
// #146 was reported as *"Agent View renders very bad and I can't work with it"* from a
// phone, and its own analysis blamed the alternate screen buffer, quoting Anthropic's
// docs (agent view "always renders fullscreen … regardless of the `tui` setting") and
// ConPTY's habit of coalescing positioned writes. **Both were wrong.** Measured against
// a real PTY on claude 2.1.250 (`scripts/rig/probe-altscreen-block.js`): entering Agent
// View emits **zero** `?1049` toggles, no DECSTBM, no ED and two CUP sequences in the
// whole frame. It is an ordinary inline render.
//
// The mechanism is width, and the two captures make it plain:
//
// | PTY width when Agent View was entered | result |
// |---|---|
// | 120 cols (the worker default) | 74 lines, up to ~120 columns wide |
// | 52 cols (a phone), set by a real resize first | **max line exactly 52** — Claude truncates every row itself, nothing wraps |
//
// So Claude renders perfectly for the width it is told about. A viewer NARROWER than the
// PTY then wraps every one of those long lines, which is exactly the reported symptom:
// rows clipped at the right edge, sections overprinting each other, a dead region below.
// Agent View is simply the densest full-width screen Claude draws, so it shows the fault
// first — but nothing about this is specific to it.
//
// ## Why it happened: the size was LAST-WRITER-WINS
//
// `server.js` applied every resize message immediately and the worker called
// `term.resize()` with it; neither tracked per-viewer sizes. With a phone and a desktop
// both attached, whichever relaid out last owned the PTY — and the desktop relaid out
// constantly (window resize, sidebar toggle, compose bar growing). So the phone's 52
// columns were overwritten seconds after it attached, and it spent the rest of the
// session rendering a 120-column frame into 52.
//
// ## The rule: the SMALLEST active viewer wins
//
// The same choice tmux makes for a shared session, and for the same reason: a terminal
// smaller than its viewer merely leaves space unused, while one larger than its viewer
// is unreadable. Only the second failure loses information.
//
// Two qualifications, both load-bearing:
//
//   * **Only viewers that have actually reported a size count.** An API client or a
//     socket that never sent a resize has no opinion, and letting an absent one imply
//     a tiny default would shrink the PTY for everyone.
//   * **Only ACTIVE viewers count.** A background socket already has its input dropped
//     (`ws._wtBackground`, server.js), and a phone left open in a pocket must not hold
//     a desktop session at 52 columns. This is also what makes the fix self-healing:
//     when the narrow viewer backgrounds or closes, the size is recomputed and the wide
//     viewer gets its columns back.

/** Bounds the PTY accepts — mirrored from the clamp server.js and pty-worker.js apply. */
const MIN_COLS = 1, MAX_COLS = 500;
const MIN_ROWS = 1, MAX_ROWS = 200;

function _usable(v, min, max) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : null;
}

/**
 * The size a PTY should run at, given every socket attached to it.
 *
 * @param {Iterable<{cols?:number, rows?:number, background?:boolean}>} viewers
 * @returns {{cols:number, rows:number}|null} null when no viewer has an opinion —
 *   the caller must then leave the PTY exactly as it is. Returning a default here
 *   would resize a live agent's screen because a REST client connected.
 */
function negotiateSize(viewers) {
  let cols = null, rows = null;
  for (const v of viewers || []) {
    if (!v || v.background) continue;
    const c = _usable(v.cols, MIN_COLS, MAX_COLS);
    const r = _usable(v.rows, MIN_ROWS, MAX_ROWS);
    // Both dimensions must be usable together: half a reading is not a viewer size,
    // and mixing one socket's columns with another's rows would describe no real window.
    if (c === null || r === null) continue;
    cols = cols === null ? c : Math.min(cols, c);
    rows = rows === null ? r : Math.min(rows, r);
  }
  return cols === null ? null : { cols, rows };
}

/** True when `next` actually differs from what the PTY is already running at. */
function sizeChanged(current, next) {
  if (!next) return false;
  if (!current) return true;
  return current.cols !== next.cols || current.rows !== next.rows;
}

module.exports = { negotiateSize, sizeChanged, MIN_COLS, MAX_COLS, MIN_ROWS, MAX_ROWS };
