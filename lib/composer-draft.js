'use strict';
// --- #479 Is a person's unsent draft sitting in the agent's composer? ------------------
//
// Every prompt the server types on its own (the check-in, the hand-off, the restart hold,
// the supervisor's gated prompt) is written into the agent's input box followed by a CR.
// If a person left text there unsent, that CR submits THEIR words with ours: their
// half-typed draft is sent, and the tag that makes our prompt a system turn
// (lib/user-turn.js) is no longer at the start, so the turn reads as a person's. Seen
// 2026-11-16: `"  , [web-terminal supervisor] Close-out: ..."`.
//
// The typing gate (lib/check-in.js typedRecently) asks only whether someone typed in the
// last few minutes. This asks whether what they typed is STILL THERE. It is read from the
// keystrokes the server forwards (server.js, the WS input path), the only input a person
// can give a session, modelled as the composer's text and cursor. Measured on claude
// 2.1.325 (scripts/rig/probe-draft-keys.js, the submitted text read off UserPromptSubmit):
//
//   Enter (CR)                     submits: the box is empty after (also with an @-mention
//                                  suggestion open)
//   \ then Enter                  NOT measured: Claude documents it as a newline, so it is
//                                  read as UNKNOWN
//   Ctrl-C                         clears the draft at an idle composer; during a turn it
//                                  interrupts the turn and KEEPS the draft (so does Esc)
//   Backspace, Ctrl-W, Ctrl-U,     edit at the cursor as readline does (Ctrl-W on one
//   Ctrl-K, Delete, Left, Right,   word deletes it, Ctrl-U deletes to the line start,
//   Home/End, Ctrl-A/Ctrl-E        Ctrl-K to its end, Home + Delete deletes the first char)
//   LF (Ctrl-J)                    inserts a newline
//   a bracketed paste              inserts its text
//   Tab, Shift-Tab, PgUp           on an empty box: insert nothing
//   Esc                            keeps the draft. Esc Esc 0.7 s apart clears it, 1.8 s
//                                  apart does not: the window was not measured, so the
//                                  rule never counts Esc as a clear
//   Up / Down                      history: Up on an empty box RECALLS the last prompt,
//                                  Up on a draft replaces it
//
// FAIL CLOSED. Anything the rule cannot follow exactly - history, a key it does not know,
// an Alt combination, a cursor move over text that is not plain ASCII (Claude moves by
// grapheme), a line edit in a multi-line draft, a paste whose end is not in the frame -
// makes the state UNKNOWN, which reads as a draft. Only a CR or an idle Ctrl-C clears UNKNOWN.
// A false draft holds the server's prompts (deferred, retried, never dropped) until the
// person next sends or clears their line; the session row says so (`composerDraft`), and
// the supervisor's Journal lists it under "Needs you". A false EMPTY would type over a
// person's words, which is the bug. So every doubt resolves to "draft".
//
// Keys a person presses into a SELECTOR (a permission prompt, a question, a startup
// dialog) do not reach the composer: the caller does not feed them here while the session
// is waiting (server.js).
//
// No record reads as EMPTY: a session nobody typed into since this server began tracking.
// Across a hot reload the server keeps which sessions held a draft (not the text), and a
// kept draft comes back UNKNOWN.
//
// Pure: no I/O, no clock. The text lives in the server's memory only, never on disk and
// never in a log.

const ESC = String.fromCharCode(0x1b);
const EMPTY = Object.freeze({ text: '', cur: 0 });
const UNKNOWN = Object.freeze({ text: null, cur: null });
// A draft longer than this is not followed character by character: it is a draft.
const TEXT_MAX = 8192;

const PASTE_OPEN = `${ESC}[200~`;
const PASTE_CLOSE = `${ESC}[201~`;
// Sticky (matched AT an index, no slice): a 256 KB frame of escape sequences stays linear.
const CSI_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])/y;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/// Does [state] hold (or possibly hold) unsent text? Absent = no keystroke seen = no draft.
function hasDraft(state) {
  return Boolean(state) && state.text !== '';
}

const asciiOnly = (s) => /^[\x20-\x7e\n]*$/.test(s);

/// The composer after one person's input frame [input] (a string) is forwarded to it.
/// [idle]: the session is known to be idle at its composer (its status, server.js). Only
/// then is a Ctrl-C a clear; anywhere else it is an interrupt that keeps the draft.
function applyInput(state, input, { idle = false } = {}) {
  let st = state && (state.text === null || typeof state.text === 'string') ? state : EMPTY;
  const s = typeof input === 'string' ? input : '';
  let i = 0;
  // Known text: insert at the cursor.
  const insert = (t) => {
    if (st.text === null) return;
    const text = st.text.slice(0, st.cur) + t + st.text.slice(st.cur);
    st = text.length > TEXT_MAX ? UNKNOWN : { text, cur: st.cur + t.length };
  };
  // A key that cannot change an empty box, but whose effect on a draft is not followed.
  const emptyOnly = () => { if (st.text !== '') st = UNKNOWN; };
  // A cursor-relative edit: only on plain one-line ASCII (Claude moves by grapheme and by
  // line), anything else is a doubt. [edit] returns the next {text, cur}.
  const edit = (fn, { multiline = false } = {}) => {
    if (st.text === null || st.text === '') return;
    if (!asciiOnly(st.text) || (!multiline && st.text.includes('\n'))) { st = UNKNOWN; return; }
    st = fn(st.text, st.cur);
  };
  const backspace = () => {
    if (st.text === null || st.cur === 0) return;
    // One code point: a surrogate pair is one character to Claude.
    let n = 1;
    const lo = st.text.charCodeAt(st.cur - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && st.cur >= 2) {
      const hi = st.text.charCodeAt(st.cur - 2);
      if (hi >= 0xd800 && hi <= 0xdbff) n = 2;
    }
    st = { text: st.text.slice(0, st.cur - n) + st.text.slice(st.cur), cur: st.cur - n };
  };
  const wordRubout = () => edit((t, c) => {
    const before = t.slice(0, c);
    // Readline deletes back to whitespace; a word-character rule stops at punctuation.
    // Followed only where both agree: a run of word characters (and the spaces after it)
    // that starts at the line start or after a space.
    if (!before.length) return { text: t, cur: c }; // nothing before the cursor to delete
    const m = /[A-Za-z0-9_]*[ ]*$/.exec(before);
    const from = c - m[0].length;
    if (m[0].length && (from === 0 || before[from - 1] === ' ')) return { text: t.slice(0, from) + t.slice(c), cur: from };
    return UNKNOWN;
  });

  while (i < s.length) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (ch === '\r') {
      // Enter submits - except after a backslash, which Claude turns into a newline (unmeasured:
      // fail closed). An UNKNOWN box cannot be checked: a CR there is taken as the submit.
      st = st.text !== null && st.cur > 0 && st.text[st.cur - 1] === '\\' ? UNKNOWN : EMPTY;
      i += 1;
      continue;
    }
    if (code === 0x03) { if (idle === true) st = EMPTY; i += 1; continue; } // Ctrl-C clears an idle box
    if (ch === ESC) {
      if (s.startsWith(PASTE_OPEN, i)) {
        const end = s.indexOf(PASTE_CLOSE, i + PASTE_OPEN.length);
        if (end < 0) { st = UNKNOWN; return st; } // the paste goes on past this frame
        const body = s.slice(i + PASTE_OPEN.length, end);
        if (body.includes(ESC)) st = UNKNOWN; else insert(body);
        i = end + PASTE_CLOSE.length;
        continue;
      }
      const next = s[i + 1];
      if (next === '[') {
        // CSI: parameters [0-?], intermediates [ -/], one final [@-~].
        CSI_RE.lastIndex = i;
        const m = CSI_RE.exec(s);
        if (!m) { st = UNKNOWN; return st; }
        i += m[0].length;
        const [, params, inter, fin] = m;
        if (inter) { st = UNKNOWN; continue; }
        if (params.startsWith('<') && (fin === 'M' || fin === 'm')) continue; // an SGR mouse report
        if (fin === 'I' || fin === 'O' || fin === 'R' || fin === 'n' || fin === 'c') continue; // terminal replies
        if (fin === 'Z' && !params) { emptyOnly(); continue; } // Shift-Tab: the permission mode
        if (params.includes(';')) { emptyOnly(); continue; } // a modified key (Ctrl-Left...)
        if (fin === 'D' && !params) { edit((t, c) => ({ text: t, cur: Math.max(0, c - 1) })); continue; }
        if (fin === 'C' && !params) { edit((t, c) => ({ text: t, cur: Math.min(t.length, c + 1) })); continue; }
        if ((fin === 'H' && !params) || (fin === '~' && (params === '1' || params === '7'))) { edit((t) => ({ text: t, cur: 0 })); continue; }
        if ((fin === 'F' && !params) || (fin === '~' && (params === '4' || params === '8'))) { edit((t) => ({ text: t, cur: t.length })); continue; }
        if (fin === '~' && params === '3') { edit((t, c) => ({ text: t.slice(0, c) + t.slice(c + 1), cur: c })); continue; }
        if (fin === '~' && (params === '5' || params === '6')) { emptyOnly(); continue; } // PgUp / PgDn
        // Up / Down (history), Insert, function keys, anything else: not followed.
        st = UNKNOWN;
        continue;
      }
      if (next === 'O') {
        // SS3: the application-mode cursor keys.
        const f = s[i + 2];
        i += f === undefined ? 2 : 3;
        if (f === 'D') edit((t, c) => ({ text: t, cur: Math.max(0, c - 1) }));
        else if (f === 'C') edit((t, c) => ({ text: t, cur: Math.min(t.length, c + 1) }));
        else if (f === 'H') edit((t) => ({ text: t, cur: 0 }));
        else if (f === 'F') edit((t) => ({ text: t, cur: t.length }));
        else st = UNKNOWN;
        continue;
      }
      if (next === ']') {
        // OSC: a terminal's reply (a colour query's answer), never typed.
        OSC_RE.lastIndex = i;
        const m = OSC_RE.exec(s);
        if (!m) { st = UNKNOWN; return st; }
        i += m[0].length;
        continue;
      }
      if (next === undefined || next === ESC) { i += 1; continue; } // a lone Esc keeps the draft
      // ESC + a key: an Alt combination (Alt-Enter is a newline in some setups). Not followed;
      // and the key it carries (even a CR) is part of it, never a submit.
      st = UNKNOWN;
      i += 2;
      continue;
    }
    if (code === 0x7f || code === 0x08) { backspace(); i += 1; continue; }
    if (code === 0x17) { wordRubout(); i += 1; continue; } // Ctrl-W
    if (code === 0x15) { edit((t, c) => ({ text: t.slice(c), cur: 0 })); i += 1; continue; } // Ctrl-U
    if (code === 0x0b) { edit((t, c) => ({ text: t.slice(0, c), cur: c })); i += 1; continue; } // Ctrl-K
    if (code === 0x01) { edit((t) => ({ text: t, cur: 0 })); i += 1; continue; } // Ctrl-A
    if (code === 0x05) { edit((t) => ({ text: t, cur: t.length })); i += 1; continue; } // Ctrl-E
    if (ch === '\n') { insert('\n'); i += 1; continue; } // Ctrl-J: a newline in the draft
    if (ch === '\t') { emptyOnly(); i += 1; continue; } // Tab: completion on a draft
    if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) { st = UNKNOWN; i += 1; continue; } // other controls
    // Printable text, up to the next control character or ESC.
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) break;
      j += 1;
    }
    insert(s.slice(i, j));
    i = j;
  }
  return st;
}

module.exports = { EMPTY, UNKNOWN, TEXT_MAX, hasDraft, applyInput };
