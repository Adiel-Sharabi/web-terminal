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
// Also strips the screen-clear / alt-screen toggles that server.js previously
// removed inline, so this is the single home for replay sanitization.
//
// Stripped (all CSI, i.e. begin with ESC[ ):
//   ESC[2J / ESC[3J   — erase display (would wipe the replayed scrollback)
//   ESC[?1049h / l    — alt-screen enter/leave (would blank the screen)
//   ESC[ ...c         — DA1/DA2/DA3 device-attribute queries (and their replies)
//   ESC[ ...n         — DSR status / cursor-position queries
//
// Safety: the CSI final bytes `c` and `n` are exclusive to DA and DSR — no
// display, SGR, cursor-movement, or mode-setting sequence ends in `c`/`n`
// (those end in m, H, J, K, A-D, h, l, ...). So matching them cannot eat
// legitimate rendering output. The parameter class [0-9;] stops at the first
// non-parameter byte, so each match is bounded to a single escape sequence.
//
// Order matters: the specific 2J/3J and ?1049 branches come before the generic
// DA/DSR branch so alternation matches them as whole units.
const REPLAY_STRIP_RE = /\x1b\[[23]J|\x1b\[\?1049[hl]|\x1b\[[?>=]?[0-9;]*[cn]/g;

// Strip replay-unsafe sequences from a scrollback string. Returns the input
// unchanged when it is empty/falsy.
function sanitizeReplay(s) {
  if (!s) return s;
  return s.replace(REPLAY_STRIP_RE, '');
}

module.exports = { sanitizeReplay, REPLAY_STRIP_RE };
