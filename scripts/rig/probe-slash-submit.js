#!/usr/bin/env node
'use strict';
// Can a slash command be submitted as ONE FRAME, the way a BUTTON would send it?
//
// WHY THIS HAS TO BE MEASURED BEFORE A BUTTON IS BUILT. Every slash command this
// codebase has ever sent was TYPED: `session_screen.dart` streams a live `/`-line
// to the PTY character by character so Claude's slash menu narrows as you go, and
// the eventual submit frame is a BARE CR carrying no text at all (#55, and the
// reason #179's slash gate reads an accumulated line rather than the frame).
//
// A button has no typing phase. It sends `/clear` + CR as one compose submission —
// a path down which NO slash command has ever gone. Two things could go wrong and
// neither is visible without measuring:
//
//   1. The open slash menu is a SELECTOR. Enter commits the HIGHLIGHTED row, and
//      Claude's menu is FUZZY: `/clear` also lists /code-review, /codebase-to-course,
//      /simplify, /doctor. If the highlight is not on the row we typed, the button
//      runs a command the user never asked for. That is #19/#84/#143's failure
//      class exactly — the same keystroke meaning different things per layout.
//   2. A burst write is read as a PASTE (paste_burst, #55). A pasted `/line` may
//      not open the menu at all, or may not be treated as a command.
//
// ---------------------------------------------------------------------------
// TWO EARLIER CUTS OF THIS PROBE GAVE WRONG ANSWERS. Both are recorded, because
// the mistakes are the ones this repo keeps paying for.
//
// CUT 1 judged each case with a regex over the screen delta —
// `/context (usage|left|window)/i` for /context. It matched in 1ms. Not because
// the command ran, but because THE SLASH MENU'S OWN DESCRIPTION TEXT reads
// "Visualize current context usage as a colored grid". The menu that proves the
// command did NOT run contains the very words used to prove it did. No detector
// here may be a phrase the menu can print.
//
// CUT 2 counted new `.jsonl` files in Claude's project directory, on the theory
// that /clear starts a new conversation. A new file appeared for /context too —
// which starts no turn and clears nothing — so the count measured "a session ran",
// not "the command ran".
//
// What survives: a command's OWN observable effect. /context paints a panel no
// menu row contains; /clear destroys conversation state, which is checked BOTH
// structurally (the server's published agentSessionId must change — the conversation
// identity from CLAUDE.md) and BEHAVIOURALLY (a fact taught before the clear must
// be gone after it). The behavioural check is the one that cannot be faked.
// ---------------------------------------------------------------------------
//
// Usage:
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-slash-submit.js
//
// Runs entirely against the rig (port 7999, own worker, own data dir, own config).
// It cannot touch production.

const { login, api, WS_BASE } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMPOSER = /❯/;                                          // #147 readiness marker
const STARTED = /esc to interrupt|✻|✽|Crunch|Thinking/i;

const RIG_CWD = DIRS.rig;

// A nonsense token Claude cannot know from anywhere but the pre-clear turn.
const SECRET = 'ZORBAX-7741';

async function newClaudeSession(cookie, name) {
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name, cwd: RIG_CWD,
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  return id;
}

/** The server's published conversation identity for a session (CLAUDE.md: agentSessionId). */
async function conversationId(cookie, id) {
  const res = await api(cookie, 'GET', '/api/sessions');
  const list = Array.isArray(res) ? res : (res.sessions || []);
  const row = list.find((s) => s.id === id);
  return row ? (row.agentSessionId || null) : null;
}

async function waitComposer(term, budgetMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (COMPOSER.test(term.text())) return Date.now() - t0;
    await sleep(250);
  }
  return null;
}

/** Send AS A BUTTON WOULD: the whole line and its CR in ONE frame. */
function submitAtomic(term, line) { term.send(line + '\r'); }

/** Send THE WAY TYPING DOES TODAY: live `/`-line, then a BARE CR (#55). */
async function submitTyped(term, line) {
  for (const ch of line) { term.send(ch); await sleep(35); }
  await sleep(500);
  term.send('\r');
}

/** Run a prompt and return everything the PTY emitted while answering it. */
async function ask(term, prompt, settleMs = 12000) {
  const mark = term.text().length;
  submitAtomic(term, prompt);
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && !STARTED.test(term.text().slice(mark))) await sleep(250);
  await sleep(settleMs);
  return term.text().slice(mark);
}

const flat = (s, n = 300) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
   .replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '')
   .replace(/\s+/g, ' ').trim().slice(-n);

// ---------------------------------------------------------------------------
// CASE A — /context, the delivery question in its cleanest form.
// Verdict: the panel's own render. A slash menu row cannot draw a token tree.
// ---------------------------------------------------------------------------
async function caseContext(cookie, how) {
  const id = await newClaudeSession(cookie, `ctx-${how}`);
  const term = await openTerminal(cookie, id);
  const boot = await waitComposer(term);
  const mark = term.text().length;
  if (how === 'typed') await submitTyped(term, '/context'); else submitAtomic(term, '/context');

  // The panel draws a per-entry token tree. A box-drawing branch carrying a token
  // count is structure the MENU never prints — its rows are prose descriptions.
  // POLL for it: a fixed settle once reported "no panel" purely because the TUI
  // was still on "connecting…". An absence is only meaningful after waiting.
  // Built without escapes on purpose: this line has already been mangled twice by
  // shell/heredoc quoting, and a silently-wrong detector is what cut 1 shipped.
  const hasPanel = (t) => {
    const s = strip(t);
    for (const branch of ['\u251c', '\u2514']) {          // the box-drawing branches
      let i = -1;
      while ((i = s.indexOf(branch, i + 1)) !== -1) {
        if (/~[0-9]+tokens/i.test(s.slice(i, i + 90))) return true;
      }
    }
    return false;
  };
  const strip = (t) => t.replace(/[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[ 	]+/g, '');
  let ran = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (hasPanel(term.text().slice(mark))) { ran = true; break; }
    await sleep(400);
  }
  console.log(`
[A/${how}] /context  (composer ${boot}ms)  -> panel rendered: ${ran ? 'YES in ' + (Date.now() - t0) + 'ms' : 'NO after 40s'}`);
  console.log(`        tail: ${flat(term.text().slice(mark))}`);
  term.close(); try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch {}
  return ran;
}

// ---------------------------------------------------------------------------
// CASE B — /clear, judged on conversation state, never on the screen.
// ---------------------------------------------------------------------------
async function caseClear(cookie, how, doClear) {
  const id = await newClaudeSession(cookie, `clr-${how}`);
  const term = await openTerminal(cookie, id);
  const boot = await waitComposer(term);

  // Teach it something only this conversation can know.
  await ask(term, `Remember this token: ${SECRET}. Reply with just the word STORED.`);
  const convBefore = await conversationId(cookie, id);

  if (doClear) {
    if (how === 'typed') await submitTyped(term, '/clear'); else submitAtomic(term, '/clear');
    await sleep(12000);
  }
  const convAfter = await conversationId(cookie, id);

  // The check that cannot be faked: is the taught fact gone?
  const recall = await ask(term, 'What token did I ask you to remember? If you do not know, reply exactly UNKNOWN.', 20000);
  const clean = recall.replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '');
  const stillKnows = clean.includes(SECRET);

  console.log(`\n[B/${how}] /clear  (composer ${boot}ms)`);
  console.log(`        agentSessionId: ${convBefore} -> ${convAfter}  (${convBefore !== convAfter ? 'CHANGED' : 'unchanged'})`);
  console.log(`        still recalls ${SECRET}: ${stillKnows ? 'YES — NOT cleared' : 'no — conversation was cleared'}`);
  console.log(`        recall tail: ${flat(recall, 200)}`);
  term.close(); try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch {}
  return { convChanged: convBefore !== convAfter, cleared: !stillKnows };
}

(async () => {
  console.log(`[probe] rig ${WS_BASE}  cwd ${RIG_CWD}`);
  const cookie = await login();

  const ctxTyped = await caseContext(cookie, 'typed');
  const ctxAtomic = await caseContext(cookie, 'atomic');
  const clrControl = await caseClear(cookie, 'atomic', false);   // baseline: it MUST recall
  const clrAtomic = await caseClear(cookie, 'atomic', true);

  console.log('\n--- VERDICT ---------------------------------------------------');
  console.log(`  /context typed  -> panel rendered : ${ctxTyped}`);
  console.log(`  /context atomic -> panel rendered : ${ctxAtomic}`);
  console.log(`  CONTROL (no /clear) -> still recalls the token : ${!clrControl.cleared}  (must be true, or the detector is blind)`);
  console.log(`  /clear   atomic -> conversation cleared : ${clrAtomic.cleared} (id changed: ${clrAtomic.convChanged})`);
  // The control is load-bearing: "the token is absent" only means "cleared" if the
  // same question DOES surface the token when nothing was cleared.
  const ok = ctxAtomic && clrAtomic.cleared && !clrControl.cleared;
  console.log(`\n  a BUTTON can send \`/cmd\` + CR as ONE compose submission : ${ok ? 'YES' : 'NOT PROVEN — do not ship it'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
