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
//   Esc Esc on an empty box,       open Rewind: confirming a message puts it back IN the
//   or `/rewind` + Enter           box (Esc Esc mid-turn put the interrupted prompt back)
//                                  - a PICKER, below. Esc there closes it, box empty
//   a slash command + Enter        empties the box and fires NO UserPromptSubmit (/cost)
//   Ctrl-R + text + Enter          submits the history match (UserPromptSubmit fires);
//                                  Ctrl-R + Ctrl-C leaves the box empty
//   Enter mid-turn, then Esc       the queued message is submitted on its own turn; the
//                                  box is empty
//   Ctrl-W after trailing spaces   deletes the spaces and the word before them
//
// FAIL CLOSED. Anything the rule cannot follow exactly - history, a key it does not know,
// an Alt combination, a cursor move over text that is not plain ASCII (Claude moves by
// grapheme), a line edit in a multi-line draft, a paste whose end is not in the frame -
// makes the state UNKNOWN, which reads as a draft. An idle Ctrl-C clears UNKNOWN; a CR on
// it is only a possible submit (it may land in a completion, an editor, a picker opened by
// a recalled `/rewind`): PICKER_SENT, below, which the agent's report of the submit ends.
// So is a CR on a `/` line (a slash command fires no UserPromptSubmit, measured, and a
// partial one runs its highlighted completion) and any CR while the session's status is
// not known (after a hot reload, a CR may be a selector's answer). A control key the rule
// does not follow (Ctrl-R history search, Ctrl-G the editor, Ctrl-O the transcript) may
// open a mode that writes into the box or swallows Ctrl-C: PICKER.
// A false draft holds the server's prompts (deferred, retried, never dropped) until the
// person next sends or clears their line; it rides the session row as `composerDraft` (for
// clients) and the supervisor's Journal lists it under "Needs you". A false EMPTY would type over a
// person's words, which is the bug. So every doubt resolves to "draft".
//
// Keys a person presses into a SELECTOR (a permission prompt, a question, a startup
// dialog) do not reach the composer: the caller does not feed the first frame of a waiting
// period here, and feeds the rest `uncertain` (an approval fires no hook, so the session
// reads waiting while the approved tool runs and the composer takes text again). Nor does
// the caller feed a session whose agent declares no composer (a plain shell) (server.js).
//
// Keys that were NOT measured are never followed as edits: a mouse click (only the wheel is
// no key), 0x08, a paste holding a TAB or a CR, Ctrl-W over bare spaces, and an Esc or
// Ctrl-C after a submit from an idle box, before that turn's Stop (`justSent`: Claude may
// put an interrupted prompt back) all fail closed. An idle Ctrl-C clears the line even with
// a `/` command or an `@` file menu open (measured).
//
// No record reads as EMPTY: a session nobody typed into since this server began tracking.
// Across a hot reload the server keeps which sessions held a draft (not the text), and a
// kept draft comes back UNKNOWN.
//
// Pure: no I/O, no clock. The text lives in the server's memory only, never on disk and
// never in a log.

const { onlyTerminalReports } = require('./ansi');

const ESC = String.fromCharCode(0x1b);
const EMPTY = Object.freeze({ text: '', cur: 0 });
const UNKNOWN = Object.freeze({ text: null, cur: null });
// A PICKER that writes text INTO the box may be open: Rewind (measured, 2.1.325: Esc Esc on
// an empty box opens it, and confirming a message puts that message back in the box; Esc
// Esc mid-turn put the interrupted prompt back). Its keys are the picker's, so no key -
// not a CR, not Ctrl-C - says what is in the box after. Only the agent's own report of a
// submit (UserPromptSubmit, applySubmitted) ends it. PICKER_SENT: the last key was a CR,
// so a submit reported now left the box empty.
const PICKER = Object.freeze({ text: null, cur: null, picker: true });
const PICKER_SENT = Object.freeze({ text: null, cur: null, picker: true, sent: true });
// A CR on this line opens the Rewind picker (`/checkpoint` is its alias). A CR on any other
// `/` line may have run a command (no UserPromptSubmit follows; the box measured empty after
// `/cost`) or a completion of one (unmeasured): PICKER_SENT.
const REWIND_RE = /^[ ]*\/(?:rewind|checkpoint)(?:[ ]|$)/;
const SLASH_RE = /^[ ]*\//;
// A draft longer than this is not followed character by character: it is a draft. It also
// bounds each key's cost (an edit rescans the text): a 256 KB frame stays well under 1 s.
const TEXT_MAX = 2048;

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

/// A picker may be open: what [rest] (the rest of a frame) leaves. A terminal's own reply
/// is no key; a frame ending in a CR (not Alt-Enter) may have submitted; anything else is
/// a key into the picker.
function pickerStep(st, rest) {
  if (!rest || onlyTerminalReports(rest)) return st;
  return rest.endsWith('\r') && !rest.endsWith(`${ESC}\r`) ? PICKER_SENT : PICKER;
}

/// The composer after the agent reports a prompt submitted (its UserPromptSubmit hook). It
/// ends a picker: the box is empty if nothing was pressed after the last CR, else holds
/// keys nobody followed. Any other state already followed the submitting CR: unchanged.
function applySubmitted(state) {
  if (state && state.unconfirmed === true) return EMPTY;
  if (!state || state.picker !== true) return state;
  return state.sent === true ? EMPTY : UNKNOWN;
}

/// The composer after the agent's turn ends (its Stop hook): a prompt submitted from an idle
/// box can no longer be put back by an interrupt (`justSent`, below).
function applyStopped(state) {
  if (!state || state.justSent !== true) return state;
  return state.esc === true ? { text: state.text, cur: state.cur, esc: true } : { text: state.text, cur: state.cur };
}

// A CR the worker saw start no turn in time (#179): the words may still be in the box, or
// the turn's hook may only be late (a slow hook spawn): a draft that the agent's report of
// the submit, if it comes, empties. Any key makes it a plain UNKNOWN.
const UNCONFIRMED = Object.freeze({ text: null, cur: null, unconfirmed: true });
/// The composer after the worker reports a CR produced no turn (#179 submitUnconfirmed). A
/// picker stays one. Only a box the rule saw EMPTY after that CR becomes UNCONFIRMED: keys
/// typed between the CR and the report (the worker's watch runs on through them) are text a
/// late submit report must not erase, so anything else is a plain UNKNOWN (gate review 5).
function applyUnconfirmed(state) {
  if (state && (state.picker === true || state.unconfirmed === true)) return state; // a repeat report
  if (state && state.text !== '') return UNKNOWN;
  return UNCONFIRMED;
}

/// The composer after the server typed its own prompt + CR into an empty box: a submit, so
/// an interrupt before that turn's Stop may put it back, as after a person's (`justSent`).
function applyServerSubmit() {
  return { text: '', cur: 0, justSent: true };
}

/// The composer after one person's input frame [input] (a string) is forwarded to it.
/// [idle]: the session is known to be idle at its composer (its status, server.js). Only
/// then is a Ctrl-C a clear; anywhere else it is an interrupt that keeps the draft.
/// [uncertain]: the session's status is not known (no statusChanged since this server
/// started): a CR on text may be a selector's answer, so only the agent's report of a
/// submit says the box emptied.
function applyInput(state, input, { idle = false, uncertain = false } = {}) {
  let st = state && (state.text === null || typeof state.text === 'string') ? state : EMPTY;
  const s = typeof input === 'string' ? input : '';
  if (st.picker === true) return pickerStep(st, s);
  if (st.unconfirmed === true) {
    if (!s || onlyTerminalReports(s)) return st;
    st = UNKNOWN;
  }
  // `esc`: the last key was a lone Esc (it may be in the previous frame). A second one with
  // no key between opens Rewind (a terminal's reply between them is no key).
  let escPending = st.esc === true;
  // `justSent`: a CR submitted from an idle box, and that turn has not ended (applyStopped).
  // Keys typed since do not end it. An Esc or Ctrl-C now interrupts the turn, and Claude may
  // put the prompt back in the box (seen with Esc Esc mid-turn; a lone key right after a
  // submit was not measured): UNKNOWN, and the interrupt is spent.
  let justSent = st.justSent === true;
  if (escPending || justSent) st = st.text === null ? UNKNOWN : { text: st.text, cur: st.cur };
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
    // Readline deletes back to whitespace; a word-character rule stops at punctuation.
    // Followed only where both agree: a run of word characters (and the spaces after it)
    // that starts at the line start or after a space.
    if (!c) return { text: t, cur: c }; // nothing before the cursor to delete
    // A backward walk from the cursor, never a regex anchored at `$` (an unanchored one
    // retries from every start: quadratic, a 256 KB frame blocked the event loop).
    let from = c;
    while (from > 0 && t[from - 1] === ' ') from -= 1;
    const wordEnd = from;
    while (from > 0 && /[A-Za-z0-9_]/.test(t[from - 1])) from -= 1;
    // Spaces with no word before them were not measured.
    if (from < wordEnd && (from === 0 || t[from - 1] === ' ')) return { text: t.slice(0, from) + t.slice(c), cur: from };
    return UNKNOWN;
  });

  while (i < s.length) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    const wasEsc = escPending;
    escPending = false; // any key ends a pending Esc; a terminal's reply below keeps it
    const wasSent = justSent;
    if (wasSent && (code === 0x03 || (ch === ESC && (s[i + 1] === undefined || s[i + 1] === ESC)))) { st = UNKNOWN; justSent = false; }
    if (ch === '\r') {
      // On `/rewind` it opens the picker; the rest of the frame is the picker's.
      if (st.text !== null && REWIND_RE.test(st.text)) return pickerStep(PICKER, s.slice(i + 1));
      // A CR the rule cannot see land - on an UNKNOWN box, on a `/` line, or with the status
      // not known - is a possible submit: only the agent's report of it empties the box.
      if (st.text === null || (st.text !== '' && (uncertain === true || SLASH_RE.test(st.text)))) {
        return pickerStep(PICKER_SENT, s.slice(i + 1));
      }
      // Enter submits - except after a backslash, which Claude turns into a newline (unmeasured:
      // fail closed).
      if (st.cur > 0 && st.text[st.cur - 1] === '\\') st = UNKNOWN;
      else { st = EMPTY; if (idle === true) justSent = true; } // a CR mid-turn queues: measured empty after Esc
      i += 1;
      continue;
    }
    // Ctrl-C clears an idle box (measured, also with a `/` or `@` menu open); after a submit
    // whose turn has not ended it interrupts that turn (above).
    if (code === 0x03) { if (idle === true && !wasSent) st = EMPTY; i += 1; continue; }
    if (ch === ESC) {
      if (s.startsWith(PASTE_OPEN, i)) {
        const end = s.indexOf(PASTE_CLOSE, i + PASTE_OPEN.length);
        if (end < 0) { st = UNKNOWN; return st; } // the paste goes on past this frame
        const body = s.slice(i + PASTE_OPEN.length, end);
        // ESC, TAB (a completion) or CR (Windows line ends) in a paste: not measured.
        if (/[\x1b\t\r]/.test(body)) st = UNKNOWN; else insert(body);
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
        if (params.startsWith('<') && (fin === 'M' || fin === 'm')) {
          // An SGR mouse report. The wheel (button 64/65) scrolls; a click may move the cursor
          // or pick a menu row (not measured): an empty box stays empty, a draft is a doubt.
          if (/^<6[45];/.test(params)) escPending = wasEsc; else emptyOnly();
          continue;
        }
        if (fin === 'I' || fin === 'O' || fin === 'R' || fin === 'n' || fin === 'c') { escPending = wasEsc; continue; } // terminal replies
        if (fin === 'Z' && !params) { emptyOnly(); continue; } // Shift-Tab: the permission mode
        if (params.includes(';')) {
          // A modified key. Only those that cannot recall history or type anything (Ctrl-Left,
          // Shift-Home, Ctrl-Delete, Ctrl-PgUp...) leave an empty box empty: a modified Up or
          // Down (history), Shift-Enter (`ESC[13;2u`, `ESC[27;2;13~`: a newline) and anything
          // else are not followed.
          if ('CDHF'.includes(fin) || (fin === '~' && /^[1345678];/.test(params))) emptyOnly(); else st = UNKNOWN;
          continue;
        }
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
        escPending = wasEsc;
        continue;
      }
      if (next === undefined || next === ESC) {
        // A lone Esc keeps the draft; the second of two with no key between opens Rewind.
        if (wasEsc) return pickerStep(PICKER, s.slice(i + 1));
        escPending = true;
        i += 1;
        continue;
      }
      // ESC + a key: an Alt combination (Alt-Enter is a newline in some setups). Not followed;
      // and the key it carries (even a CR) is part of it, never a submit.
      st = UNKNOWN;
      i += 2;
      continue;
    }
    if (code === 0x7f) { backspace(); i += 1; continue; }
    if (code === 0x08) { emptyOnly(); i += 1; continue; } // Ctrl-Backspace in xterm.js: only 0x7f was measured
    if (code === 0x17) { wordRubout(); i += 1; continue; } // Ctrl-W
    if (code === 0x15) { edit((t, c) => ({ text: t.slice(c), cur: 0 })); i += 1; continue; } // Ctrl-U
    if (code === 0x0b) { edit((t, c) => ({ text: t.slice(0, c), cur: c })); i += 1; continue; } // Ctrl-K
    if (code === 0x01) { edit((t) => ({ text: t, cur: 0 })); i += 1; continue; } // Ctrl-A
    if (code === 0x05) { edit((t) => ({ text: t, cur: t.length })); i += 1; continue; } // Ctrl-E
    if (ch === '\n') { insert('\n'); i += 1; continue; } // Ctrl-J: a newline in the draft
    if (ch === '\t') { emptyOnly(); i += 1; continue; } // Tab: completion on a draft
    // Another control key may open a mode (Ctrl-R search, Ctrl-G editor, Ctrl-O transcript)
    // that writes into the box or takes Ctrl-C itself: the rest of the frame is that mode's.
    if (code < 0x20) return pickerStep(PICKER, s.slice(i + 1));
    if (code >= 0x80 && code <= 0x9f) { st = UNKNOWN; i += 1; continue; } // a C1 control
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
  if (!escPending && !justSent) return st;
  return { text: st.text, cur: st.cur, ...(escPending ? { esc: true } : {}), ...(justSent ? { justSent: true } : {}) };
}

/// What the server keeps on disk for one session's draft (never its text): `since` alone for
/// a draft, `{ since, picker, sent }` for a picker, so a hot reload cannot turn a picker
/// into a draft a CR clears. null: nothing to keep.
function keptValue(state, since) {
  if (!hasDraft(state) || !Number.isFinite(since)) return null;
  return state.picker === true ? { since, picker: true, ...(state.sent === true ? { sent: true } : {}) } : since;
}

/// The state a kept value comes back as: a draft as UNKNOWN (the text was never kept), a
/// picker as itself. null for anything unreadable.
function fromKept(v) {
  const since = v && typeof v === 'object' ? v.since : v;
  if (!Number.isFinite(since)) return null;
  if (v && typeof v === 'object' && v.picker === true) return { st: v.sent === true ? PICKER_SENT : PICKER, since };
  return { st: UNKNOWN, since };
}

module.exports = { EMPTY, UNKNOWN, PICKER, PICKER_SENT, TEXT_MAX, hasDraft, applyInput, applySubmitted, applyStopped, applyUnconfirmed, applyServerSubmit, keptValue, fromKept };
