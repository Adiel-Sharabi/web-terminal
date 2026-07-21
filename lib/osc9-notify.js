'use strict';
// OSC 9 desktop-notification sequences, extracted from a PTY output stream.
//
// WHY THIS EXISTS. Claude Code drives web-terminal's session status through hooks.
// Codex has hooks too, but they are unusable unattended: only `managed` hooks run,
// trust is bound to a sha256 of the hook definition, and `codex exec` runs none at
// all — so a Codex session's status never left 'active' and it got no status dot,
// no attention record and no push.
//
// Codex has a SECOND notification channel that has none of those problems. With
//
//     [tui]
//     notifications = true
//     notification_method = "osc9"
//     notification_condition = "always"   # default "unfocused" — a PTY has no focus
//
// the TUI writes its notifications straight into the terminal as OSC 9. For a normal
// user that channel is the weaker one — it only paints in their terminal emulator,
// which is why `approval-requested` on the external `notify` program is still an open
// request upstream (openai/codex#11808, #17716, #19921). For web-terminal it is the
// STRONGER one, because pty-worker.js *is* the terminal: it already reads every byte.
// So the event those issues ask for is the one we can already have.
//
// MEASURED, not read from docs (codex-cli 0.144.0, real PTY, 2026-07-21):
//   approval  -> ESC ] 9 ; Codex wants to edit 0 files BEL   (captured with the
//                approval UI on screen: "wants to", "Yes, proceed")
//   turn end  -> ESC ] 9 ; <the agent's last message> BEL
//
// NOT established: what an approval that is DECLINED emits. Sending a lone Esc produced
// no further notification, but Codex's approval UI is a select list ("Yes, proceed" /
// "No, provide feedback"), so Esc most likely never answered it — the question simply
// stayed open, which is also what the end-to-end rig run showed (the session correctly
// remained `waiting`). Do not read that silence as "declining is silent". Answering the
// prompt either way lets the turn run on and end, which fires turn-complete normally.
//
// This module owns only the BYTE rule — find complete OSC 9 sequences in a stream
// that arrives in arbitrary chunks. What a given body MEANS is agent-specific and
// therefore lives in the provider registry (lib/agents.js), never here.

// OSC 9 introducer. Codex terminates with BEL; ST (ESC \) is accepted because the
// OSC grammar allows it and a future build could switch without warning.
const INTRODUCER = '\x1b]9;';
const ST = '\x1b\\';
const BEL = '\x07';

// A partial sequence is held across chunks, so it needs a ceiling: without one, a
// stray "ESC ] 9 ;" that never terminates (a binary file catted into the terminal,
// a truncated frame) would grow the carry without bound for the life of the PTY.
// Codex's own bodies are one short line; 4 KB is far past any real notification.
const MAX_CARRY = 4096;

/**
 * Pull every COMPLETE OSC 9 body out of `carry + text`.
 *
 * Chunk-boundary safety is the whole point: PTY reads split wherever the OS
 * decides, so the introducer, the body and the terminator routinely land in
 * different chunks. Anything incomplete is returned as `carry` and prepended to
 * the next call. (The api-error sniff next door does NOT do this and can miss a
 * split phrase — it gets away with it because the phrase stays on screen and
 * repeats. A notification fires exactly once, so missing it means missing it.)
 *
 * @param {string} carry leftover from the previous chunk ('' to start)
 * @param {string} text  this chunk, decoded as utf8
 * @returns {{bodies: string[], carry: string}}
 */
function scanOsc9(carry, text) {
  const s = (typeof carry === 'string' ? carry : '') + (typeof text === 'string' ? text : '');
  const bodies = [];
  let consumed = 0;

  for (;;) {
    const start = s.indexOf(INTRODUCER, consumed);
    if (start === -1) break;
    const bodyAt = start + INTRODUCER.length;
    const bel = s.indexOf(BEL, bodyAt);
    const st = s.indexOf(ST, bodyAt);

    let end = -1, termLen = 0;
    if (bel !== -1 && (st === -1 || bel < st)) { end = bel; termLen = BEL.length; }
    else if (st !== -1) { end = st; termLen = ST.length; }

    if (end === -1) break;            // introducer seen, terminator not here yet
    bodies.push(s.slice(bodyAt, end));
    consumed = end + termLen;
  }

  return { bodies, carry: _tailToHold(s, consumed) };
}

// What must survive to the next chunk: either a started-but-unterminated sequence,
// or a trailing fragment of the introducer itself ("\x1b", "\x1b]", "\x1b]9"), which
// is why a naive indexOf-only carry drops notifications that split mid-introducer.
function _tailToHold(s, consumed) {
  const pending = s.indexOf(INTRODUCER, consumed);
  if (pending !== -1) {
    const held = s.slice(pending);
    return held.length > MAX_CARRY ? '' : held;
  }
  for (let n = Math.min(INTRODUCER.length - 1, s.length); n > 0; n--) {
    const tail = s.slice(s.length - n);
    if (INTRODUCER.startsWith(tail)) return tail;
  }
  return '';
}

module.exports = { scanOsc9, MAX_CARRY };
