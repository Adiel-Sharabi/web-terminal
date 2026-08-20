#!/usr/bin/env node
'use strict';
// #147 — WHEN is a freshly spawned agent actually able to receive a prompt?
//
// The bug this measures: a new session drops you into the chat lens immediately,
// but `claude` takes seconds to boot. Until its composer exists, the PTY is still
// sitting at the BASH PROMPT, so a prompt typed and sent in that window is handed
// to bash — where it either runs as a shell command or submits nothing. The text
// is simply gone. Same on fork (`claude --resume` boots exactly as slowly).
//
// The rig already knew this. `verify-submit.js` waits on a composer glyph with the
// comment "typing before Claude is up puts the prompt into bash — where nothing
// ever submits" — knowledge that was never applied to production. This probe turns
// that folk rule into a MEASUREMENT, because the readiness marker is going into
// lib/agents.js as a provider field and CLAUDE.md is explicit that a marker must be
// measured, never assumed: keying Codex readiness on the startup banner broke on a
// routine auto-update, and `esc to interrupt` prints while a cold TUI is still
// booting MCP servers — a false positive that reads as ready.
//
// TWO THINGS ARE MEASURED, and only the second one proves anything:
//
//   1. A TIMELINE — every distinct screen state from spawn, timestamped, so a
//      candidate marker can be picked from what the TUI actually prints on THIS
//      version rather than from memory of an older one.
//   2. A VERDICT PAIR — the whole point. Submit one prompt BEFORE the candidate
//      marker appears and one AFTER, and ask the only question that matters: did a
//      turn start? "Text is visible on screen" cannot answer it — bash echoes a
//      typed line just as readily as Claude's composer does, which is precisely why
//      this bug survived. A turn starting is the sole honest detector (CLAUDE.md,
//      "The PTY/rollout is ground truth; the screen lies").
//
// The BEFORE case is expected to FAIL to start a turn. That failure IS the bug,
// reproduced — and it is what the regression test asserts against.
//
// Usage:
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-claude-ready.js
//
// Runs entirely against the rig (port 7999, own worker, own data dir). It cannot
// touch production.

const { login, api, WS_BASE } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A turn STARTED. Claude paints a spinner/among these the moment it accepts work;
// none of them can be produced by bash echoing a line back.
const STARTED = /esc to interrupt|✻|✽|●\s|Crunch|tokens|Thinking/i;

// The candidate readiness marker under test. `❯` is Claude's composer caret —
// verify-submit.js already keys on it. A bare `>` is deliberately NOT used: it
// matches shell prompts, redirects and quoted output alike.
const CANDIDATE = /❯/;

// Shell-prompt shapes, so the timeline can say "still bash" rather than leaving it
// to the reader. Git Bash prints `$` at the end of a path-coloured line.
const BASH = /\$\s*$/m;

const PROMPT = 'reply with exactly the single word OK and nothing else';

async function newClaudeSession(cookie, name) {
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name,
    cwd: DIRS.rig,
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  return id;
}

/** Poll the screen and log every state CHANGE with the ms since the PTY started. */
async function timeline(term, ms) {
  const t0 = Date.now();
  const marks = { candidate: null, bash: null };
  let last = '';
  const seen = [];
  while (Date.now() - t0 < ms) {
    const text = term.text();
    if (text !== last) {
      const at = Date.now() - t0;
      const tail = text.slice(last.length).replace(/\s+/g, ' ').trim().slice(0, 90);
      if (tail) seen.push({ at, tail });
      if (marks.bash === null && BASH.test(text)) marks.bash = at;
      if (marks.candidate === null && CANDIDATE.test(text)) marks.candidate = at;
      last = text;
    }
    if (marks.candidate !== null && Date.now() - t0 > marks.candidate + 3000) break;
    await sleep(120);
  }
  return { marks, seen };
}

/** Send ONE atomic frame (what the client sends) and report whether a TURN began. */
async function submitAndWatch(term, label) {
  const mark = term.text().length;
  term.send(PROMPT + '\r');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (STARTED.test(term.text().slice(mark))) {
      console.log(`  ${label}: a turn STARTED`);
      return true;
    }
  }
  console.log(`  ${label}: NO turn started — the prompt went nowhere`);
  return false;
}

(async () => {
  console.log(`[probe] rig ${WS_BASE}`);
  const cookie = await login();

  // --- 1. the timeline -------------------------------------------------------
  const idA = await newClaudeSession(cookie, 'ready-timeline');
  const a = await openTerminal(cookie, idA);
  console.log(`\n[1] boot timeline (session ${idA})`);
  const { marks, seen } = await timeline(a, 60000);
  for (const s of seen) console.log(`   +${String(s.at).padStart(6)}ms  ${s.tail}`);
  console.log(`\n   bash prompt visible at : ${marks.bash === null ? 'never' : marks.bash + 'ms'}`);
  console.log(`   candidate ❯ visible at : ${marks.candidate === null ? 'NEVER — marker is wrong' : marks.candidate + 'ms'}`);
  a.close();

  // --- 2. submit BEFORE the marker ------------------------------------------
  // The bug, reproduced. No wait at all: this is a user typing the instant the
  // chat lens appears.
  const idB = await newClaudeSession(cookie, 'ready-before');
  const b = await openTerminal(cookie, idB);
  console.log(`\n[2] submit IMMEDIATELY, before any marker (session ${idB})`);
  const beforeStarted = await submitAndWatch(b, '   before');
  const bashSaw = /command not found|No such file/i.test(b.text());
  console.log(`   bash reacted to it     : ${bashSaw ? 'YES — the prompt was eaten by the shell' : 'no visible shell error'}`);
  b.close();

  // --- 3. submit AFTER the marker -------------------------------------------
  const idC = await newClaudeSession(cookie, 'ready-after');
  const c = await openTerminal(cookie, idC);
  console.log(`\n[3] submit only AFTER the candidate marker (session ${idC})`);
  let waited = null;
  const t0 = Date.now();
  for (let i = 0; i < 120 && waited === null; i++) {
    if (CANDIDATE.test(c.text())) waited = Date.now() - t0;
    else await sleep(250);
  }
  console.log(`   marker seen after      : ${waited === null ? 'NEVER' : waited + 'ms'}`);
  const afterStarted = waited === null ? false : await submitAndWatch(c, '   after ');
  c.close();

  // --- verdict ---------------------------------------------------------------
  console.log('\n--- VERDICT ---------------------------------------------------');
  console.log(`  before marker -> turn started: ${beforeStarted}   (expected false — this is the bug)`);
  console.log(`  after  marker -> turn started: ${afterStarted}   (expected true  — the marker is usable)`);
  const usable = afterStarted && !beforeStarted;
  console.log(`  candidate ${CANDIDATE} is ${usable ? 'USABLE as a readiness marker' : 'NOT proven — do not ship it'}`);

  for (const id of [idA, idB, idC]) {
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch { /* best effort */ }
  }
  process.exit(usable ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
