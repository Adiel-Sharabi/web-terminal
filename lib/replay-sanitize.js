'use strict';

// Sanitize terminal scrollback BEFORE it is replayed into a freshly-attached
// xterm. Replay is fundamentally different from live output: at replay time the
// shell is sitting idle at a prompt with nothing reading terminal replies.
//
// The bug this fixes ("1;2c1;2cclaude ..." garbage on a fresh prompt):
//   A TUI program (Claude Code) emits terminal *queries* while it runs —
//   Device Attributes (DA, "ESC[c") and Device Status Report / cursor-position
//   (DSR, "ESC[6n"). Those query bytes are part of the PTY output stream, so
//   they get captured into scrollback. xterm.js auto-answers any query it sees
//   in term.write(), sending the reply back through onData -> the PTY. During a
//   live session that is correct (the program is waiting for the answer). But
//   when stale queries are *replayed* into a new terminal, xterm answers them
//   into an idle shell, and the reply ("1;2c", "<row>;<col>R", ...) lands on the
//   command line as if the user had typed it. Stripping the queries from the
//   replay removes the trigger; a live program re-issues its queries over the
//   live stream and gets fresh answers as normal.
//
// BUFFER-AWARE erase handling (fullscreen support):
//   Claude Code's "/tui fullscreen" mode runs in the terminal's ALTERNATE
//   screen buffer (DECSET ?1049h ... ?1049l). Its frames are absolute-cursor
//   addressed and repainted with erase-display (2J). Two rules keep replay
//   faithful for BOTH classic and fullscreen sessions:
//     - The ?1049h/l toggles are ALWAYS preserved, so a reconnect / instant-
//       switch re-enters the alt buffer instead of dumping fullscreen frames
//       into the main buffer (which left xterm in the normal buffer while
//       Claude believed it owned the alt buffer — fullscreen broke on reconnect).
//     - Erase-display (ESC[2J / ESC[3J) is stripped ONLY in the normal buffer,
//       where replaying a clear would wipe the scrollback the user scrolls back
//       through. INSIDE the alt buffer the clears are KEPT so the fullscreen
//       frame repaints cleanly on replay.
//
// Stripped:
//   ESC[ ...c         — DA1/DA2/DA3 device-attribute queries (and their replies)
//   ESC[ ...n         — DSR status / cursor-position queries
//   ESC[2J / ESC[3J   — erase display, ONLY while in the normal (non-alt) buffer
// Preserved:
//   ESC[?1049h / l    — alt-screen enter/leave (drives the buffer switch)
//   ESC[2J / ESC[3J   — erase display, while in the alternate buffer
//   everything else   — SGR, cursor moves, mouse-tracking + bracketed-paste modes
//
// Safety: the CSI final bytes `c` and `n` are exclusive to DA and DSR — no
// display, SGR, cursor-movement, or mode-setting sequence ends in `c`/`n`
// (those end in m, H, J, K, A-D, h, l, ...). So matching them cannot eat
// legitimate rendering output. The parameter class [0-9;] stops at the first
// non-parameter byte, so each match is bounded to a single escape sequence.

// DA/DSR terminal queries — always stripped, in every buffer.
const DA_DSR_RE = /\x1b\[[?>=]?[0-9;]*[cn]/g;

// Erase-display (ED2/ED3) — stripped only in the normal buffer.
const ERASE_DISPLAY_RE = /\x1b\[[23]J/g;

// Alt-screen enter/leave (DECSET 1049). Captured so split() keeps the toggles
// in the result array (odd indices), letting us flip the in-alt-buffer state.
const ALT_SPLIT_RE = /(\x1b\[\?1049[hl])/;
const ALT_ENTER = '\x1b[?1049h';
const ALT_LEAVE = '\x1b[?1049l';

// Back-compat export: callers that only want query-stripping (DA/DSR) can use
// this single-pass regex directly.
const REPLAY_STRIP_RE = DA_DSR_RE;

// True if the string ends while still INSIDE the alternate screen buffer — i.e.
// the last ?1049 toggle was an enter (h) with no matching leave (l). The worker
// uses this on restore: a session respawned after a worker/host restart gets a
// FRESH shell in the NORMAL buffer, but its saved scrollback may end mid-alt
// (e.g. Claude was killed in fullscreen and never emitted ?1049l). Replaying
// that strands xterm in the alt buffer showing a frozen stale frame while the
// live shell writes to the hidden normal buffer — which reads as "can't type".
// The worker appends a corrective ?1049l so the replay lands back in the normal
// buffer to match the fresh shell.
function endsInAltScreen(s) {
  if (!s) return false;
  let inAlt = false;
  const re = /\x1b\[\?1049([hl])/g;
  let m;
  while ((m = re.exec(s))) inAlt = m[1] === 'h';
  return inAlt;
}

// Strip replay-unsafe sequences from a scrollback string. Returns the input
// unchanged when it is empty/falsy.
function sanitizeReplay(s) {
  if (!s) return s;
  // Split at the alt-screen toggles so each content segment can be sanitized
  // according to which buffer it belongs to.
  const parts = s.split(ALT_SPLIT_RE);
  let inAlt = false;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ALT_ENTER) { inAlt = true; out += part; continue; }
    if (part === ALT_LEAVE) { inAlt = false; out += part; continue; }
    // Always strip DA/DSR queries; strip erase-display only outside the alt buffer.
    let seg = part.replace(DA_DSR_RE, '');
    if (!inAlt) seg = seg.replace(ERASE_DISPLAY_RE, '');
    out += seg;
  }
  return out;
}

module.exports = { sanitizeReplay, REPLAY_STRIP_RE, endsInAltScreen };
