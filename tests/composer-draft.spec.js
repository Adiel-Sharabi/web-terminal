// @ts-check
// #479 - the composer-draft rule (lib/composer-draft.js): is a person's unsent text sitting
// in the agent's input box? Every key's effect here is the one measured on claude 2.1.325
// (scripts/rig/probe-draft-keys.js). The NEGATIVE cases carry the weight: a false "empty"
// lets the server's prompt submit a person's draft with it, which is the bug.
const { test, expect } = require('@playwright/test');
const { EMPTY, UNKNOWN, PICKER, PICKER_SENT, TEXT_MAX, hasDraft, applyInput, applySubmitted } = require('../lib/composer-draft');

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
    expect(draft([UP, CR])).toBe(true); // an UNKNOWN box: only a possible submit (gate review 2)
    expect(after([UP, CR])).toEqual(PICKER_SENT);
    expect(hasDraft(applySubmitted(after([UP, CR])))).toBe(false); // ...that the agent's report confirms
    expect(draft(['', CR])).toBe(false); // an empty box stays empty
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
    expect(draft([ESC, CR])).toBe(false);
  });

  test('Rewind: two lone Escs, or a CR on /rewind, may open a picker that writes INTO the box', () => {
    // Measured: Esc Esc on an empty box opens Rewind; Up, CR, CR (confirm) put the chosen
    // prompt back in the box. The keys are the picker's: no CR or Ctrl-C says the box is empty.
    for (const keys of [[ESC, ESC], [`${ESC}${ESC}`], ['abc', ESC, ESC], ['/rewind', CR], ['/checkpoint', CR], [`/rewind${CR}`], ['  /rewind x', CR]]) {
      const st = after(keys);
      expect(st.picker, JSON.stringify(keys)).toBe(true);
      expect(hasDraft(st)).toBe(true);
      expect(draft([...keys, UP, CR, CR])).toBe(true);
      expect(draft([...keys, CR, CTRL('c')], { idle: true })).toBe(true);
      expect(draft([...keys, ESC, CR])).toBe(true);
    }
    // A terminal's own reply between the Escs is no key: still the pair.
    expect(after([ESC, CSI('I'), ESC]).picker).toBe(true);
    expect(after([ESC, CSI('12;40R'), ESC]).picker).toBe(true);
    // Negatives: a key between the Escs, an arrow (ESC [ A is no lone Esc), another command.
    expect(after(['abc', ESC, 'x', ESC])).toEqual({ text: 'abcx', cur: 4, esc: true });
    expect(after([ESC, UP, ESC]).picker).toBeUndefined();
    expect(after([`${ESC}${ESC}[A`]).picker).toBeUndefined();
    // Any other `/` line: it may run a command, or the completion a partial one highlights
    // (`/rewi`, unmeasured), and a command fires no UserPromptSubmit (measured, `/cost`): a
    // possible submit, held until the agent next reports one.
    for (const line of ['/cost', '/rewinder', '/rewi', '/', ' /rw']) {
      expect(after([line, CR]), line).toEqual(PICKER_SENT);
    }
    // A Tab completion, then Enter: UNKNOWN + CR, also only a possible submit.
    expect(after(['/rew', TAB, CR])).toEqual(PICKER_SENT);
    // A path is not a command line: a submit (Claude sends it as a prompt).
    expect(after(['fix a/b', CR])).toEqual(EMPTY);
  });

  test('a CR while the status is not known (after a hot reload) may answer a selector', () => {
    expect(after(['abc', CR], { uncertain: true })).toEqual(PICKER_SENT);
    expect(after([UP, CR], { uncertain: true })).toEqual(PICKER_SENT);
    expect(after([CR], { uncertain: true })).toEqual(EMPTY); // nothing in the box to send
    // Negative: with the status known, the measured submit.
    expect(after(['abc', CR], { uncertain: false })).toEqual(EMPTY);
  });

  test('a control key the rule does not follow may open a mode: Ctrl-C does not end it', () => {
    // Ctrl-R (history search), Ctrl-G (the editor), Ctrl-O (the transcript)...
    for (const c of ['r', 'g', 'o', 'v', 'd', 'l', 't', 'b']) {
      expect(after([CTRL(c)]), c).toEqual(PICKER);
      expect(draft(['foo', CTRL(c), 'bar', CTRL('c')], { idle: true }), c).toBe(true);
    }
    expect(after([String.fromCharCode(0x1f)])).toEqual(PICKER);
    // Measured: Ctrl-R + text + Enter submits the match (UserPromptSubmit fires).
    expect(hasDraft(applySubmitted(after([CTRL('r'), 'READY', CR])))).toBe(false);
    expect(hasDraft(applySubmitted(after([`${CTRL('r')}READY${CR}`])))).toBe(false);
  });

  test('a modified key: only those that cannot recall history or type leave an empty box empty', () => {
    for (const k of [CSI('1;5D'), CSI('1;5C'), CSI('1;2H'), CSI('1;2F'), CSI('3;5~'), CSI('5;5~')]) {
      expect(draft([k]), JSON.stringify(k)).toBe(false);
    }
    // Ctrl-Up, Shift-Up, Alt-Up, Ctrl-Down (history), Shift-Enter in two encodings (a newline).
    for (const k of [CSI('1;5A'), CSI('1;2A'), CSI('1;3A'), CSI('1;5B'), CSI('13;2u'), CSI('27;2;13~'), CSI('2;5~')]) {
      expect(after([k]), JSON.stringify(k)).toEqual(UNKNOWN);
    }
  });

  test('kept across a hot reload: never the text, and a picker comes back a picker', () => {
    const { keptValue, fromKept } = require('../lib/composer-draft');
    const T = 1794812906679;
    expect(keptValue(after(['secret words']), T)).toBe(T);
    expect(JSON.stringify(keptValue(after(['secret words']), T))).not.toContain('secret');
    expect(keptValue(EMPTY, T)).toBeNull();
    expect(keptValue(undefined, T)).toBeNull();
    for (const st of [UNKNOWN, PICKER, PICKER_SENT]) {
      const back = fromKept(JSON.parse(JSON.stringify(keptValue(st, T))));
      expect(back).toEqual({ st, since: T });
    }
    // A draft comes back UNKNOWN (the text was never kept).
    expect(fromKept(keptValue(after(['abc']), T))).toEqual({ st: UNKNOWN, since: T });
    // Unreadable values are dropped, never thrown on.
    for (const v of [null, 'x', {}, { since: 'x' }, { picker: true }, NaN]) expect(fromKept(v)).toBeNull();
  });

  test('a picker ends only on the agent\'s report of a submit (UserPromptSubmit)', () => {
    // Nothing pressed after the last CR: the submit left the box empty.
    expect(hasDraft(applySubmitted(after([ESC, ESC, 'hi', CR])))).toBe(false);
    expect(after([ESC, ESC, 'hi', CR])).toEqual(PICKER_SENT);
    // Keys after the last CR: nobody followed them - a draft, that a CR then clears.
    expect(applySubmitted(after([ESC, ESC, CR, 'y']))).toEqual(UNKNOWN);
    expect(applyInput(applySubmitted(after([ESC, ESC, CR, 'y'])), CR)).toEqual(PICKER_SENT);
    expect(hasDraft(applySubmitted(applyInput(applySubmitted(after([ESC, ESC, CR, 'y'])), CR)))).toBe(false);
    // A terminal reply after the CR is no key.
    expect(after([ESC, ESC, CR, CSI('I')])).toEqual(PICKER_SENT);
    // Alt-Enter is no submit.
    expect(after([ESC, ESC, `x${ESC}${CR}`])).toEqual(PICKER);
    // Any other state already followed the submitting CR: the report changes nothing.
    expect(applySubmitted(after(['abc']))).toEqual({ text: 'abc', cur: 3 });
    expect(applySubmitted(EMPTY)).toEqual(EMPTY);
    expect(applySubmitted(UNKNOWN)).toEqual(UNKNOWN);
    expect(applySubmitted(undefined)).toBeUndefined();
  });

  test('a 256 KB frame of edits stays linear (Ctrl-W walked a regex: quadratic, hours)', () => {
    const CAP = 256 * 1024;
    // Whole keys only, and a draft just under TEXT_MAX: the rule must still be FOLLOWING the
    // text at the end (an UNKNOWN box skips every edit, and the timing would prove nothing).
    const N = TEXT_MAX - 10;
    const fill = (unit) => unit.repeat(Math.floor((CAP - N) / unit.length));
    const base = 'x'.repeat(N);
    for (const [name, frame] of [
      ['a, Ctrl-W', base + fill(`a${CTRL('w')}`)],
      ['spaces, Ctrl-W', ' '.repeat(N) + fill(`a ${CTRL('w')}`)],
      ['Left', base + fill(LEFT)],
      ['a, Backspace', base + fill(`a${BS}`)],
      ['Ctrl-A, Ctrl-E', base + fill(`${CTRL('a')}${CTRL('e')}`)],
      ['Home, Delete, x', base + fill(`${HOME}${DEL}x`)],
    ]) {
      const t0 = Date.now();
      const st = applyInput(EMPTY, frame);
      expect(Date.now() - t0, name).toBeLessThan(1500); // measured ~130 ms worst on Office; the regex: 37 s for 2000 keys
      expect(st.text, `${name}: still followed`).not.toBeNull();
    }
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
    // Measured: trailing spaces go with the word before them.
    expect(after(['abc  ', CTRL('w')])).toEqual(EMPTY);
    expect(after(['ab cd  ', CTRL('w')])).toEqual({ text: 'ab ', cur: 3 });
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
    // Another control key: a possible mode (its own test below).
    expect(after([CTRL('r')])).toEqual(PICKER);
    // A cursor move over text Claude moves by grapheme (non-ASCII), or a line edit on two lines.
    expect(after(['שלום', LEFT])).toEqual(UNKNOWN);
    expect(after([`a${LF}b`, CTRL('u')])).toEqual(UNKNOWN);
    // Backspace never clears UNKNOWN; a CR makes it a possible submit, the report clears it.
    expect(draft([UP, BS, BS, BS])).toBe(true);
    expect(hasDraft(applySubmitted(after([UP, BS, CR])))).toBe(false);
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
