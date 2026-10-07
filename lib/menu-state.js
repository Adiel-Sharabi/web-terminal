'use strict';
// --- Is the agent's composer reachable, or is a menu/panel covering it? (#316) -----
//
// A Claude session parked in `/status`, `/usage`, `/model`, `/config` or Agent View
// reads idle, while a prompt sent to it goes nowhere (or, in Agent View, starts a
// different session). #179 measured that no such state emits a distinguishing DEC
// mode; #210 measured the rule on a RENDERED screen. The worker renders nothing, so
// this is the byte-stream form of the same idea, measured with
// scripts/rig/probe-menu-state.js against claude 2.1.29x:
//
//   after opening /status, /usage, /model, /config, Agent View:
//     the composer marker (readiness.composer, U+276F + U+00A0) is NOT written, and a
//     panel footer is: "Esc to cancel", "Esc to clear", "enter to return"
//   after Esc out of them, and at the end of every turn:
//     the composer marker IS written again
//   while idle: Claude writes nothing at all (0 bytes in 8s)
//
// So the rule is ORDER, not presence: whichever of the two was written LAST says what
// is on screen. A footer after the last composer = a panel is up; a composer after the
// last footer = the composer is back. Nothing written since = unchanged, which is right
// because an idle TUI repaints nothing.
//
// Words in Claude's panels are positioned with CHA and carry no spaces (#190), so a
// footer is matched with "CHA or space or SGR" between its words; the provider declares
// the phrases (lib/agents.js readiness.panelFooter), never this file.
//
// Display only: a verdict here changes what a row SAYS, never a byte written to a PTY,
// so the #138 hazard (our own source printing the phrase) costs at most a wrong chip
// for the rest of a turn — and a turn always ends by redrawing the composer.
//
// Pure: no I/O, no clock reads except through `now`.

// How much of the previous chunk to keep, so a marker or footer split across two PTY
// reads is still seen. A footer with its escapes is under 100 bytes.
const CARRY = 256;

/// @param {RegExp|null} composer  the provider's composer marker
/// @param {RegExp|null} footer    the provider's panel-footer phrases
/// @returns {{ push(chunk: string|Buffer, now?: number): boolean, inMenu: boolean, since: number|null } | null}
function createMenuDetector(composer, footer) {
  if (!(composer instanceof RegExp) || !(footer instanceof RegExp)) return null;
  const c = new RegExp(composer.source, composer.flags.replace('g', '') + 'g');
  const f = new RegExp(footer.source, footer.flags.replace('g', '') + 'g');
  let carry = '';
  const state = {
    inMenu: false,
    since: null,
    /** Feed one PTY chunk. Returns true when the verdict CHANGED. */
    push(chunk, now = Date.now()) {
      const buf = carry + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
      carry = buf.slice(-CARRY);
      const lastC = lastIndexOf(c, buf);
      const lastF = lastIndexOf(f, buf);
      if (lastC < 0 && lastF < 0) return false;
      const next = lastF > lastC;
      if (next === state.inMenu) return false;
      state.inMenu = next;
      state.since = next ? now : null;
      return true;
    },
  };
  return state;
}

function lastIndexOf(re, s) {
  re.lastIndex = 0;
  let i = -1;
  let m;
  while ((m = re.exec(s))) {
    i = m.index;
    if (m[0].length === 0) re.lastIndex++;
  }
  return i;
}

module.exports = { createMenuDetector, CARRY };
