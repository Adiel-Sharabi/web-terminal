'use strict';
// #190 - the agent's STARTUP SELECTOR FAMILY: a dialog that parks a brand-new
// session BEFORE its composer exists, and eats the first prompt sent to it.
//
// ## The bug
//
// Opening a session in a folder Claude does not yet trust lands on a selector.
// Nothing in the session's state says so - no hook fires, and no distinguishing
// DEC private mode is emitted (measured: no alt-screen, the same answer #179 got
// for every blocking state it looked at) - so the session looks like an ordinary
// idle one. You type a prompt, send it, and the keystrokes are taken as
// navigation. The trailing CR then CONFIRMS the highlighted row, and the
// highlighted row is `No, exit`: the agent is not merely deaf, it is GONE, and
// the next prompt goes to bash.
//
// #147 already refuses a submit until the composer marker appears, and #202
// already stopped THIS dialog from flipping that latch (it draws the same caret
// as the composer, without the NO-BREAK SPACE). What is left is the 45s ceiling:
// `armReadyFallback` forces the gate open when no marker ever arrives, because
// the alternative - a session stuck on "starting" forever - is worse than the bug
// (#147). That ceiling is right for the ABSENCE of evidence. It is wrong when
// there is POSITIVE evidence of what is on screen, which is what this file is.
//
// ## MEASURED off a real PTY - claude 2.1.268, 2026-09-11
//
// `scripts/rig/probe-trust-prompt.js capture`, run with WT_TRUST_PROBE_PARENT
// pointed at a directory with no trusted ancestor (trust is INHERITED, so nothing
// under an already-trusted tree can ever show this - the rig's own scratch parent
// included). Unchanged from the 2.1.251 capture recorded in CLAUDE.md, and
// `--dangerously-skip-permissions` does NOT suppress it:
//
//     Quick safety check: Is this a project you created or one you trust? (Like
//     your own code, a well-known open source project, or work from your team).
//     ...
//     > No, exit
//       Yes, I trust this folder
//
//     Enter to confirm . Esc to cancel
//
// It is a THIRD layout - neither #19's compact (numbered digits) nor its
// side-by-side (a preview box). The options carry NO NUMBERS, so a
// `usageLimitPrompt`-style digit has nothing to press, and the DEFAULT ROW IS THE
// DESTRUCTIVE ONE.
//
// ## THE DIALOG EMITS NO SPACES, and that is the whole reason this module exists
//
// Every word is positioned with CHA (CSI <col> G). The captured bytes are
// literally:
//
//     CSI 2G  SGR  <caret>  CSI 4G No,  CSI 8G exit  SGR
//     CSI 4G Yes,  CSI 9G I  CSI 11G trust  CSI 17G this  CSI 22G folder
//     CSI 2G  SGR  Enter  CSI 8G to  CSI 11G confirm  ...
//
// So an ANSI-stripped stream reads `Quicksafetycheck:Isthis...` and
// `Yes,Itrustthisfolder`. The longest contiguous literal in the whole dialog is
// ONE WORD. Any matcher that greps the stripped stream for a sentence as a human
// reads it can never match - which is why `renderLine` comes first and everything
// else works on its output.
//
// ## Why it cannot fire on this repo's own source (#138's rule)
//
// #138 is the precedent: a detector whose match causes an ACTION is not a
// reading. Its phrase was captured verbatim into a `lib/agents.js` comment, so a
// Claude session that merely `cat`'d that file typed a stray digit into its own
// composer.
//
// The gates here are not wording at all - they are properties of the RENDERING,
// and each one needs a literal ESC byte sitting hard against specific text:
//
//   1. a cursor row: U+276F IMMEDIATELY followed by CSI <n> G. A source file
//      cannot contain that pair - `tests/control-bytes.spec.js` gates this repo
//      against literal C0 bytes, and this file builds both characters from
//      `String.fromCharCode`.
//   2. a SIBLING option row: another line whose first positioning is a CHA to the
//      same column the cursor row's label sits at. One row is prose; a selector
//      always offers a choice.
//   3. the family's commit affordance in the RENDERED text (`Enter to confirm`),
//      within a few rows of the last option.
//
// All three, ANDed. And the worker only scans a session that has not yet reached
// its composer (the #147 latch), so a session working in this checkout is not
// being scanned at all by the time it could `cat` anything.
//
// ## FAMILY by shape, MEMBER by sentence - two tiers, two risks
//
// It is a family, not one dialog: a fresh cwd under a checkout carrying a
// CLAUDE.md parks on `Allow external CLAUDE.md file imports?` with the same shape
// exactly (unnumbered, caret then CHA, no spaces, `Enter to confirm`, and a
// refusing default row). Folder trust is inherited by descendants; that
// inheritance is trust-specific, so "the tree is trusted" does NOT mean "no
// selector will block a new session".
//
// So the SHAPE alone is enough to REPORT a block - that action is reversible (a
// submit is refused and explained, and the words stay in the box) and
// self-healing (answering the dialog draws the composer, which clears
// everything). Pressing a KEY is a different risk entirely: the rows are
// unnumbered and the default is destructive, so a wrong guess exits the agent.
// That needs a declared sentence, and the sentence it needs is THE LABEL OF THE
// ROW WE WILL PRESS - matching exactly what is acted on rather than a title near
// it.
//
// ## The keys are read off the RENDER, never assumed
//
// `matchUsageLimitPrompt` reads its digit off the rendered menu so a reordered
// render still picks "stop and wait" rather than a plan upgrade. Same rule here
// with no digits to read: count the rows between the cursor row and the row whose
// label matches, and emit that many arrows. A render that reorders its options
// moves the cursor with them and the count follows. If the row is not there at
// all there is no answer, and nothing is pressed.
//
// PURE (text in, description out) so every branch is unit-testable; pty-worker.js
// owns the one place this meets a real PTY.

const { stripAnsi } = require('./ansi');

// EVERY control character and every non-ASCII character here is BUILT, never
// typed. This repo has shipped a dead assertion from a `\b` that arrived as a
// literal, and a literal ESC in source breaks grep, diffs and editors. The source
// of this file is ASCII-only and `tests/control-bytes.spec.js` gates it.
const ESC = String.fromCharCode(0x1b);
const BS = String.fromCharCode(0x5c); // backslash, for regexes assembled as strings
const CARET = String.fromCodePoint(0x276f);

/**
 * CHA (CSI <n> G) - "put the cursor at column n", 1-based. The family's only
 * positioning primitive, and the reason a stripped stream is unreadable.
 */
const CHA_G = new RegExp(ESC + BS + '[(' + BS + 'd{1,4})G', 'g');

/** A cursor row: the selection caret with a CHA hard against it. Gate 1. */
const CURSOR_AT = new RegExp(CARET + ESC + BS + '[(' + BS + 'd{1,4})G');

/**
 * A line that OPENS with a CHA - ignoring SGR, which carries no position. The
 * capture group is that column, or the line does not match at all.
 *
 * This is what makes "is the row beside it a sibling OPTION" structural rather
 * than a guess about indentation: a sibling is positioned to the very column the
 * cursor row's own label sits at.
 */
const LEADING_CHA = new RegExp(
  '^(?:' + ESC + BS + '[[0-9;]*m)*' + ESC + BS + '[(' + BS + 'd{1,4})G'
);

/** How far below the last option row the commit affordance may sit. */
const FOOTER_WINDOW = 4;

/** Guards against a pathological screen; a dialog is a few rows, not a stream. */
const MAX_OPTIONS = 12;

/** Rendered labels are short; a runaway line is truncated rather than published. */
const LABEL_CAP = 200;

/**
 * May the worker TYPE the answer to a recognised member, on a server whose config
 * has never said either way? (#190)
 *
 * **OFF, and that is an explicit decision rather than a placeholder.** Trusting a
 * folder is the thing that gates the agent reading, editing and executing what is
 * in it - the one question in this family whose whole purpose is to be answered by
 * a person. Automating it is defensible on a sole-user box with sessions opened in
 * directories the user chose, and indefensible as a default nobody was asked about,
 * so it is a config key with the answer recorded in it.
 *
 * REPORTING the block is unconditional and needs no key: it refuses a submit and
 * explains, which loses nothing and is exactly what #190 is about.
 *
 * Here rather than at either call site because BOTH processes need it and they must
 * agree: pty-worker.js decides whether to write, and server.js fills it in on
 * `GET /api/config` for a key the file omits. #240 is what two copies of one default
 * cost - the API reported a setting the server did not have, and a PUT that echoed
 * the object back persisted the misreport. docs/CONFIGURATION.md documents this
 * value; keep it in step there, since prose cannot import.
 */
const AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT = false;

// The three things we ever write here. Arrows are CSI sequences, so `isEscapeKey`
// (lib/submit-frames.js) cannot read one as an interrupt - and a session at a
// selector is not `working`, which is the gate that rule sits behind anyway.
const DOWN = ESC + '[B';
const UP = ESC + '[A';
const CR = String.fromCharCode(0x0d);

/**
 * One line of raw terminal output, rendered as the columns a human sees.
 *
 * CHA is honoured as padding BEFORE the escapes are stripped; everything else
 * goes through lib/ansi.js, which is this repo's one owner of that rule (#192
 * briefly had three copies and the newest had already drifted).
 *
 * LIMIT, stated rather than discovered later: this is not a terminal emulator. It
 * handles the one positioning primitive this dialog family uses and nothing else
 * - no CUF/CUB, no wrapping, no overwrite semantics. That is enough because the
 * measurement above shows CHA is all Claude uses to lay these out, and it is
 * deliberately less than an emulator so it stays pure and cheap enough for the
 * PTY hot path. The companion has a real emulator and asks the same question of
 * its buffer instead (#210).
 */
function renderLine(line) {
  const s = String(line == null ? '' : line);
  let out = '';
  let i = 0;
  CHA_G.lastIndex = 0;
  let m;
  while ((m = CHA_G.exec(s))) {
    out += stripAnsi(s.slice(i, m.index));
    const col = parseInt(m[1], 10) - 1; // CHA is 1-based
    if (out.length < col) out += ' '.repeat(col - out.length);
    i = m.index + m[0].length;
  }
  out += stripAnsi(s.slice(i));
  return out.replace(/\r/g, '').replace(/\s+$/, '');
}

/** The whole text, line by line, as the columns a human sees. */
function renderColumns(text) {
  return String(text == null ? '' : text).split(/\r?\n/).map(renderLine).join('\n');
}

/** The caret stripped off a rendered cursor row, leaving the option's own label. */
function labelOf(rendered) {
  const t = rendered.trim();
  const bare = t.startsWith(CARET) ? t.slice(CARET.length) : t;
  return bare.trim().slice(0, LABEL_CAP);
}

/** The arrow keys and the confirming CR, or nothing. See the header's two tiers. */
function answerFor(options, cursor, cfg) {
  const known = Array.isArray(cfg.known) ? cfg.known : [];
  for (const member of known) {
    if (!member || !(member.accept instanceof RegExp)) continue;
    const target = options.findIndex((o) => member.accept.test(o));
    if (target < 0) continue;
    const delta = target - cursor;
    const keys = new Array(Math.abs(delta)).fill(delta >= 0 ? DOWN : UP);
    keys.push(CR);
    return { id: member.id || null, target, keys };
  }
  return {};
}

/**
 * Is a startup selector of this agent's dialog family on screen, and can it be
 * answered?
 *
 * @param {string} raw   PTY output WITH its escapes - stripping them first destroys
 *   the only thing that makes this recognisable. Pass a chunk plus the carry of the
 *   previous one; a read boundary falls wherever the kernel put it.
 * @param {object|null} cfg  the provider's `blockingPrompts` (lib/agents.js), or
 *   null for an agent that declares none - which answers null, i.e. NEVER. A plain
 *   shell must not have a caret in its output read as an agent dialog.
 * @returns {null | {id: string|null, options: string[], cursor: number,
 *                   target: number|null, keys: string[]|null}}
 *   `id`/`keys` null means: the family is on screen and the session IS blocked, but
 *   this member is not one we know how to answer. That is the common, safe case -
 *   reporting it costs a refused submit, pressing a key on a guess costs the agent.
 */
function matchBlockingPrompt(raw, cfg) {
  if (!cfg || !(cfg.footer instanceof RegExp)) return null;
  const lines = String(raw == null ? '' : raw).split(/\r?\n/);

  for (let c = 0; c < lines.length; c++) {
    const cur = CURSOR_AT.exec(lines[c]);
    if (!cur) continue;
    // Gate 1 held: a caret with a CHA hard against it. The column it names is where
    // this option's LABEL starts, and therefore where its siblings start too.
    const labelCol = cur[1];

    // Gate 2 - the contiguous run of rows positioned to that same column. Walked in
    // BOTH directions: the cursor sits on the first row in the measured case, but a
    // render whose highlight has moved to the bottom is the same selector, and
    // requiring a follower would stop recognising it. Same above-or-below reasoning
    // as `matchUsageLimitPrompt`, which learnt it the hard way.
    const rows = [c];
    for (let i = c - 1; i >= 0 && rows.length < MAX_OPTIONS; i--) {
      const lead = LEADING_CHA.exec(lines[i]);
      if (!lead || lead[1] !== labelCol) break;
      rows.unshift(i);
    }
    for (let i = c + 1; i < lines.length && rows.length < MAX_OPTIONS; i++) {
      const lead = LEADING_CHA.exec(lines[i]);
      if (!lead || lead[1] !== labelCol) break;
      rows.push(i);
    }
    if (rows.length < 2) continue; // one row is prose; a selector offers a choice

    // Gate 3 - the commit affordance, in the RENDERED text. This is the line that
    // says the screen is waiting to be answered rather than merely drawn.
    const last = rows[rows.length - 1];
    let footer = false;
    for (let i = last + 1; i <= last + FOOTER_WINDOW && i < lines.length; i++) {
      if (cfg.footer.test(renderLine(lines[i]))) { footer = true; break; }
    }
    if (!footer) continue;

    const options = rows.map((i) => labelOf(renderLine(lines[i])));
    if (options.some((o) => o === '')) continue; // a blank row is not an option
    const cursor = rows.indexOf(c);
    return Object.assign(
      { id: null, options, cursor, target: null, keys: null },
      answerFor(options, cursor, cfg)
    );
  }
  return null;
}

module.exports = {
  renderColumns,
  renderLine,
  matchBlockingPrompt,
  CARET,
  DOWN,
  UP,
  CR,
  FOOTER_WINDOW,
  MAX_OPTIONS,
  LABEL_CAP,
  AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT,
};
