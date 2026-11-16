// @ts-check
// #479 - the composer-draft rule (lib/composer-draft.js): is a person's unsent text sitting
// in the agent's input box? Every key's effect here is the one measured on claude 2.1.325
// (scripts/rig/probe-draft-keys.js). The NEGATIVE cases carry the weight: a false "empty"
// lets the server's prompt submit a person's draft with it, which is the bug.
const { test, expect } = require('@playwright/test');
const { EMPTY, UNKNOWN, TEXT_MAX, hasDraft, applyInput } = require('../lib/composer-draft');

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BS = String.fromCharCode(0x7f);
const BS8 = String.fromCharCode(0x08);
const CTRL = (c) => String.fromCharCode(c.toUpperCase().charCodeAt(0) - 64);
const CSI = (s) => `${ESC}[${s}`;
const LEFT = CSI('D'), RIGHT = CSI('C'), UP = CSI('A'), DOWN = CSI('B'), HOME = CSI('H'), END = CSI('F'), DEL = CSI('3~');
const PASTE = (t) => `${ESC}[200~${t}${ESC}[201~`;

/** The state after each frame in turn, from no record (EMPTY). */
const after = (frames, opts) => frames.reduce((st, f) => applyInput(st, f, opts), undefined);
const draft = (frames, opts) => hasDraft(after(frames, opts));

test.describe('#479 composer draft - what a keystroke leaves in the box', () => {
  test('no record, and an empty box, hold no draft', () => {
    expect(hasDraft(undefined)).toBe(false);
    expect(hasDraft(null)).toBe(false);
    expect(hasDraft(EMPTY)).toBe(false);
    expect(hasDraft(UNKNOWN)).toBe(true);
  });

  test('the incident: stray keys left unsent are a draft', () => {
    expect(draft(['  , '])).toBe(true);
    expect(after(['  , '])).toEqual({ text: '  , ', cur: 4 });
    // Typed one key per frame, as a terminal sends them.
    expect(draft([' ', ' ', ',', ' '])).toBe(true);
  });

  test('Enter submits: the box is empty after, whatever was in it', () => {
    expect(draft(['hello', CR])).toBe(false);
    expect(draft([`hello${CR}`])).toBe(false); // the compose bar's one frame
    expect(draft([PASTE(`a${LF}b`) + CR])).toBe(false); // a bracketed multi-line submit
    expect(draft([UP, CR])).toBe(false); // even an UNKNOWN box
    // Negative: a backslash before Enter is Claude's newline, not a submit (fail closed).
    expect(after([`foo${String.fromCharCode(92)}${CR}`])).toEqual(UNKNOWN);
    expect(draft([`foo${String.fromCharCode(92)}`, CR])).toBe(true);
    // ...and text typed after the submit is a new draft.
    expect(draft([`hello${CR}x`])).toBe(true);
  });

  test('Ctrl-C clears an IDLE box only: during a turn it interrupts and keeps the draft', () => {
    expect(draft(['abc', CTRL('c')], { idle: true })).toBe(false);
    expect(draft([UP, CTRL('c')], { idle: true })).toBe(false);
    // Negative: not known idle (working, waiting, or no status yet) - the draft stays.
    expect(draft(['abc', CTRL('c')], { idle: false })).toBe(true);
    expect(draft(['abc', CTRL('c')])).toBe(true);
  });

  test('Backspace deletes one character before the cursor; to empty is no draft', () => {
    expect(draft(['abc', BS, BS, BS])).toBe(false);
    expect(draft(['abc', BS8, BS8, BS8])).toBe(false);
    // Negative: one short is still a draft.
    expect(draft(['abc', BS, BS])).toBe(true);
    // Backspace on an empty box does nothing (and is not a draft).
    expect(draft([BS, BS])).toBe(false);
    // A surrogate pair is one character.
    const emoji = String.fromCodePoint(0x1f600);
    expect(draft([emoji, BS])).toBe(false);
  });

  test('Esc keeps the draft - also twice (the clear window was not measured)', () => {
    expect(draft(['abc', ESC])).toBe(true);
    expect(draft(['abc', ESC, ESC])).toBe(true);
    expect(draft([`abc${ESC}${ESC}`])).toBe(true);
    // And on an empty box it adds nothing.
    expect(draft([ESC])).toBe(false);
  });

  test('line edits as readline: Ctrl-U, Ctrl-K, Ctrl-W, Ctrl-A, Ctrl-E, Home, End, Delete', () => {
    expect(draft(['abc', CTRL('u')])).toBe(false);
    expect(draft(['abc', CTRL('a'), CTRL('k')])).toBe(false);
    expect(draft(['abc', CTRL('w')])).toBe(false);
    expect(draft(['one two', CTRL('w'), CTRL('w')])).toBe(false);
    expect(draft(['abc', HOME, DEL, DEL, DEL])).toBe(false);
    // Negatives: what is left after the cursor or before it stays.
    expect(after(['abc', HOME, DEL])).toEqual({ text: 'bc', cur: 0 });
    expect(draft(['abc', LEFT, CTRL('u')])).toBe(true); // "c" is left
    expect(draft(['abc', LEFT, CTRL('k')])).toBe(true); // "ab" is left
    expect(draft(['one two', CTRL('w')])).toBe(true); // "one " is left
    expect(draft(['abc', HOME, CTRL('e'), BS, BS, BS])).toBe(false);
    expect(draft(['abc', CTRL('a'), END, BS, BS, BS])).toBe(false);
    // Left then Backspace edits in the middle: measured "ab" + typed + "c".
    expect(after(['abc', LEFT, 'X'])).toEqual({ text: 'abXc', cur: 3 });
    expect(draft(['abc', LEFT, BS, BS])).toBe(true); // "c" is left
    expect(draft(['abc', LEFT, RIGHT, BS, BS, BS])).toBe(false);
  });

  test('Ctrl-W is followed only where readline and a word rule agree; elsewhere it fails closed', () => {
    // "foo.bar": readline deletes it all, a word rule only "bar" - unknown, so a draft.
    expect(after(['foo.bar', CTRL('w')])).toEqual(UNKNOWN);
    expect(after(['foo ..', CTRL('w')])).toEqual(UNKNOWN);
    expect(draft([CTRL('w')])).toBe(false); // nothing to delete
  });

  test('a newline (Ctrl-J) and a paste are text', () => {
    expect(draft([LF])).toBe(true);
    expect(after(['abc', LF])).toEqual({ text: `abc${LF}`, cur: 4 });
    expect(draft([PASTE('pasted')])).toBe(true);
    expect(draft([PASTE('')])).toBe(false);
    // A paste whose end is not in the frame: unknown (fail closed).
    expect(after([`${ESC}[200~half`])).toEqual(UNKNOWN);
  });

  test('history: Up recalls a prompt into an empty box - unknown, a draft, until a submit', () => {
    expect(after([UP])).toEqual(UNKNOWN);
    // Up then Down measured empty again, but history is not followed: it stays a draft.
    expect(draft([UP, DOWN])).toBe(true);
    expect(draft([UP, BS, BS, BS, BS])).toBe(true);
    expect(draft(['abc', UP])).toBe(true);
    expect(draft([`${ESC}OA`])).toBe(true); // the application-mode Up
  });

  test('keys that type nothing into an empty box: Tab, Shift-Tab, PgUp, PgDn, arrows', () => {
    for (const k of [TAB, CSI('Z'), CSI('5~'), CSI('6~'), LEFT, RIGHT, HOME, END, DEL]) {
      expect(draft([k]), JSON.stringify(k)).toBe(false);
    }
    // ...but on a draft, Tab may complete it: unknown.
    expect(after(['ab', TAB])).toEqual(UNKNOWN);
    expect(draft(['ab', TAB, BS, BS])).toBe(true);
  });

  test('terminal replies and mouse reports are not keys', () => {
    for (const r of [CSI('I'), CSI('O'), CSI('12;40R'), CSI('0n'), CSI('?1;2c'), `${ESC}]11;rgb:0000/0000/0000${String.fromCharCode(7)}`, CSI('<64;10;5M')]) {
      expect(draft([r]), JSON.stringify(r)).toBe(false);
      expect(after(['ab', r]), JSON.stringify(r)).toEqual({ text: 'ab', cur: 2 });
    }
  });

  test('fail closed: what the rule cannot follow reads as a draft, and only a submit clears it', () => {
    // An Alt combination - even Alt-Enter is not a submit.
    expect(after([`${ESC}${CR}`])).toEqual(UNKNOWN);
    expect(after([`${ESC}b`])).toEqual(UNKNOWN);
    // An unknown key, a function key, Insert, a modified arrow over a draft.
    expect(after([CSI('2~')])).toEqual(UNKNOWN);
    expect(after([`${ESC}OP`])).toEqual(UNKNOWN);
    expect(after(['ab', CSI('1;5D')])).toEqual(UNKNOWN);
    expect(draft([CSI('1;5D')])).toBe(false); // ...that on an empty box moves nothing
    // Another control key (Ctrl-R: history search; Ctrl-G: an editor; Ctrl-_: undo).
    for (const c of ['r', 'g', 'v', 'd', 'l']) expect(after([CTRL(c)]), c).toEqual(UNKNOWN);
    expect(after([String.fromCharCode(0x1f)])).toEqual(UNKNOWN);
    // A cursor move over text Claude moves by grapheme (non-ASCII), or a line edit on two lines.
    expect(after(['שלום', LEFT])).toEqual(UNKNOWN);
    expect(after([`a${LF}b`, CTRL('u')])).toEqual(UNKNOWN);
    // Backspace never clears UNKNOWN; a CR does.
    expect(draft([UP, BS, BS, BS])).toBe(true);
    expect(draft([UP, BS, CR])).toBe(false);
    // A draft too long to follow is a draft.
    expect(after(['x'.repeat(TEXT_MAX + 1)])).toEqual(UNKNOWN);
  });

  test('a corrupt or foreign state is read as no record, never thrown on', () => {
    expect(hasDraft(applyInput(/** @type {any} */ ({ text: 5 }), ''))).toBe(false);
    expect(hasDraft(applyInput(undefined, /** @type {any} */ (null)))).toBe(false);
  });
});

test.describe('#479 every writer of a server prompt reads it', () => {
  const MIN = 60 * 1000;
  const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
  const { promptRefusal } = require('../lib/safe-prompt');
  const { checkInBlock, checkInConfig } = require('../lib/check-in');
  const { autoBlock, handoffConfig } = require('../lib/handoff');
  const { closeRefusal } = require('../lib/closeout');
  const sup = require('../lib/supervisor');
  const ready = { agent: 'claude', agentReady: true, status: 'idle', inMenu: false, blockedPrompt: null, waitingFor: null, compacting: false, brief: {} };
  const quiet = { now: T0, startedAt: T0 - 60 * MIN, inputAt: undefined, cfg: checkInConfig({ typingQuietMin: 10 }) };

  test('the gated prompt (the supervisor, the close-out) refuses "draft"', () => {
    const ctx = { ...quiet, brief: {}, hold: false, busy: false };
    expect(promptRefusal(ready, ctx)).toBeNull();
    expect(promptRefusal(ready, { ...ctx, draft: true })).toBe('draft');
    // A person still typing reads as typing first (the same hold, the older name).
    expect(promptRefusal(ready, { ...ctx, draft: true, inputAt: T0 - 1000 })).toBe('typing');
  });

  test('the check-in refuses "draft" (and logs it: it is a skip worth logging)', () => {
    const opts = { ...quiet, supported: true };
    expect(checkInBlock(ready, opts)).not.toBe('draft');
    expect(checkInBlock(ready, { ...opts, draft: true })).toBe('draft');
    expect(require('../lib/check-in').skipWorthLogging('draft')).toBe(true);
  });

  test('the automatic hand-off refuses "draft"', () => {
    const cfg = handoffConfig({ auto: true });
    expect(autoBlock({}, cfg, { now: T0 })).toBeNull();
    expect(autoBlock({}, cfg, { now: T0, draft: true })).toBe('draft');
  });

  test('the close refuses "draft": closing would destroy the person\'s text', () => {
    const clean = { askedAt: T0, state: 'clean', left: '', at: T0 + MIN };
    const ok = { row: { status: 'idle', compacting: false, clients: 0 }, brief: { reported: { wait: { on: 'done', what: 'x', at: T0 } }, closeout: clean },
      by: 'agent', viewers: 0, favorite: false, work: [], hold: false, handoff: null, closeoutAt: T0 + MIN, typing: false, children: 0 };
    expect(closeRefusal(ok)).toBeNull();
    expect(closeRefusal({ ...ok, draft: true })).toBe('draft');
  });

  test('the Journal: a session holding a left draft is under Needs you, and its node says so', () => {
    const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
    const g = sup.buildGraph([{ name: 'alpha', ok: true, sessions: [
      { id: id(1), status: 'idle', clients: 0, brief: { wait: { on: 'self', what: 'x', at: T0 } }, composerDraft: { since: T0 - 20 * MIN } },
      { id: id(2), status: 'idle', clients: 0, brief: { wait: { on: 'self', what: 'x', at: T0 } } },
      { id: id(3), status: 'idle', clients: 0, brief: { wait: { on: 'you', what: 'pick', at: T0 } }, composerDraft: { since: T0 } },
    ] }], T0);
    const st = sup.stateOf({ graph: g, verdicts: {}, journal: [], cfg: sup.supervisorConfig(null), now: T0 });
    expect(st.needsYou).toEqual([id(3), id(1)]); // once each
    expect(st.live).toEqual([id(2)]);
    expect(st.sessions.find((n) => n.id === id(1)).composerDraft).toEqual({ since: T0 - 20 * MIN });
    expect(st.sessions.find((n) => n.id === id(2)).composerDraft).toBeNull();
    // A peer's malformed field is dropped, never trusted.
    expect(sup.nodeOf({ id: id(4), composerDraft: { since: 'x' } }, 'alpha').composerDraft).toBeNull();
  });
});
