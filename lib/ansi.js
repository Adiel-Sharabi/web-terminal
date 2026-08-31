'use strict';
// --- Terminal escape sequences, removed from text that is not a terminal ------
//
// ONE owner, and it exists because there were briefly three. `lib/transcript.js`
// has stripped stored prose since the beginning; #192 then added a second copy
// to `lib/user-turn.js` for a command-output body, and that copy was already
// WEAKER — its CSI parameter class was `[0-9;?]`, which misses the rest of
// ECMA-48's parameter range (`:` `<` `=` `>`), so a colon-form SGR like
// `ESC[38:5:196m` survived it. Two copies of one rule drifting apart within a
// single change is exactly the failure this repo keeps paying for, so the rule
// moved here and both callers import it.
//
// Not a full terminal parser — just enough to neutralise anything that slipped
// into text destined for a chat bubble, a recap card or a speech synthesiser,
// none of which can render a cursor movement or a colour.

// ESC is never stored as a raw byte in source: a literal 0x1b in a file breaks
// grep output, diffs and editors that eat control characters.
const _ESC = String.fromCharCode(0x1b); // ESC
const _BEL = String.fromCharCode(0x07); // BEL — one OSC terminator
const _BS = String.fromCharCode(0x5c);  // backslash — the regex needs it literally

const ANSI_RE = new RegExp(
  _ESC + _BS + '[[0-?]*[ -/]*[@-~]'                         // CSI: ESC [ params intermediates final(@-~)
  + '|' + _ESC + _BS + '][^' + _BEL + _ESC + ']*(?:' + _BEL + '|' + _ESC + _BS + _BS + ')' // OSC: ESC ] ... (BEL|ST)
  + '|' + _ESC + '[@-_]',                                   // Fe: ESC + 0x40-0x5F
  'g'
);

/// [s] with every escape sequence removed; '' for anything that is not a string.
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : '';
}

module.exports = { ANSI_RE, stripAnsi };
