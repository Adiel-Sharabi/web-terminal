#!/usr/bin/env node
'use strict';
// #179 / #146 — WHICH terminal states swallow a prompt, and is alt-screen the
// signal that names them?
//
// The bug: the chat lens models exactly ONE blocking shape (AskUserQuestion, via
// hooks). Every full-screen TUI view — `/usage`, `/config`, Agent View (`←`) —
// swallows keystrokes as navigation, and the lens shows nothing. So the compose bar
// accepts a prompt, submits it into a TUI that is not at its composer, and the words
// are gone with no error anywhere. Same failure class as #147, later in the session.
//
// #179's own hint names alt-screen enter/leave (`ESC[?1049h` / `l`) as the candidate
// detector and says, in bold, to MEASURE it rather than assume it — because an
// unmeasured marker is exactly what #143 shipped. This is that measurement.
//
// THREE questions, and only the third one licenses the fix:
//
//   1. Does each full-screen view actually emit `ESC[?1049h`, and does leaving it
//      emit `ESC[?1049l`? (If not, alt-screen is the wrong signal and the issue
//      needs a different one.)
//   2. Does an ORDINARY turn stay OUT of the alt buffer? A detector that fires
//      while Claude is merely thinking would refuse every legitimate submit — a
//      false positive here is worse than the bug.
//   3. Does a prompt submitted INSIDE the view actually fail to start a turn?
//      That is the bug itself, reproduced. "The text appeared on screen" cannot
//      answer it (CLAUDE.md: the PTY is ground truth; the screen lies) — a TUI
//      echoes a typed line just as readily as a composer does. The only honest
//      detector is "did a turn start".
//
// Usage:
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-altscreen-block.js
//   node scripts/rig/probe-altscreen-block.js --only usage
//
// Runs entirely against the rig (port 7999, own worker, own data dir). It cannot
// touch production.

const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ESC = '\x1b';
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_LEAVE = `${ESC}[?1049l`;

// A turn STARTED. None of these can be produced by a TUI echoing a typed line.
const STARTED = /esc to interrupt|✻|✽|Crunch|Thinking|tokens/i;
// Claude's composer caret — the same marker lib/agents.js declares as `readiness`.
const COMPOSER = /❯/;

const PROMPT = 'reply with exactly the single word OK and nothing else';

/** Every ?1049 toggle in a string, in order, as 'h'/'l'. */
function toggles(s) {
  const out = [];
  const re = /\x1b\[\?1049([hl])/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/** True if `s` ends while still inside the alt buffer — lib/replay-sanitize.js's rule. */
function endsInAlt(s) {
  const t = toggles(s);
  return t.length > 0 && t[t.length - 1] === 'h';
}

async function waitFor(term, re, ms, from = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(term.text().slice(from))) return Date.now() - t0;
    await sleep(200);
  }
  return null;
}

// The views under test. `enter` is what a user does to get there; `leave` is the
// documented way back. Agent View is the one #146 was reported from — a stray `←`
// on an empty prompt line backgrounds the conversation into it.
const CASES = [
  { name: 'usage', enter: '/usage\r', leave: ESC, settle: 4000 },
  { name: 'config', enter: '/config\r', leave: ESC, settle: 4000 },
  { name: 'agentview', enter: `${ESC}[D`, leave: ESC, settle: 5000 },
];

async function newSession(cookie, name) {
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name,
    cwd: DIRS.rig,
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  return id;
}

async function bootedTerminal(cookie, name) {
  const id = await newSession(cookie, name);
  const term = await openTerminal(cookie, id);
  const at = await waitFor(term, COMPOSER, 60000);
  if (at === null) throw new Error(`${name}: composer never appeared`);
  console.log(`  composer up after ${at}ms`);
  return { id, term };
}

/** Question 2's control: an ordinary turn must never look blocked. */
async function controlOrdinaryTurn(cookie) {
  console.log('\n== CONTROL: an ordinary turn ==');
  const { id, term } = await bootedTerminal(cookie, 'altscreen-control');
  try {
    const mark = term.text().length;
    term.send(PROMPT);
    await sleep(200);
    term.send('\r');
    const started = await waitFor(term, STARTED, 30000, mark);
    await sleep(3000);
    const during = term.text().slice(mark);
    const t = toggles(during);
    console.log(`  turn started: ${started !== null ? `yes (${started}ms)` : 'NO'}`);
    console.log(`  ?1049 toggles during the turn: ${t.length ? t.join(',') : 'none'}`);
    console.log(`  ends in alt buffer: ${endsInAlt(during)}`);
    return { started: started !== null, toggles: t, endsInAlt: endsInAlt(during) };
  } finally {
    term.close();
    await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
}

async function runCase(cookie, c) {
  console.log(`\n== ${c.name.toUpperCase()}: enter ${JSON.stringify(c.enter)} ==`);
  const { id, term } = await bootedTerminal(cookie, `altscreen-${c.name}`);
  const res = { name: c.name };
  try {
    // --- Q1: does entering the view emit ?1049h?
    const beforeEnter = term.text().length;
    term.send(c.enter);
    await sleep(c.settle);
    const entered = term.text().slice(beforeEnter);
    res.enterToggles = toggles(entered);
    res.inAltAfterEnter = endsInAlt(entered);
    console.log(`  toggles on enter: ${res.enterToggles.length ? res.enterToggles.join(',') : 'none'}`);
    console.log(`  inside alt buffer: ${res.inAltAfterEnter}`);

    // --- Q3: submit a prompt while the view is up. Did a turn start?
    const beforeSubmit = term.text().length;
    term.send(PROMPT);
    await sleep(300);
    term.send('\r');
    const started = await waitFor(term, STARTED, 15000, beforeSubmit);
    res.turnStartedWhileBlocked = started !== null;
    console.log(`  prompt submitted inside the view -> turn started: ${started !== null ? `YES (${started}ms)` : 'NO'}`);

    // --- Q1b: does the documented way out emit ?1049l?
    const beforeLeave = term.text().length;
    term.send(c.leave);
    await sleep(3000);
    // Agent View needs Esc then possibly a second one; give a nudge and re-check.
    let left = term.text().slice(beforeLeave);
    if (!toggles(left).includes('l')) {
      term.send(c.leave);
      await sleep(3000);
      left = term.text().slice(beforeLeave);
    }
    res.leaveToggles = toggles(left);
    res.backToComposer = COMPOSER.test(term.text().slice(beforeLeave));
    console.log(`  toggles on leave: ${res.leaveToggles.length ? res.leaveToggles.join(',') : 'none'}`);
    console.log(`  composer visible again: ${res.backToComposer}`);

    // The whole-stream reading, which is what a live detector would compute.
    res.streamEndsInAlt = endsInAlt(term.text());
    console.log(`  whole stream ends in alt: ${res.streamEndsInAlt}`);
  } finally {
    term.close();
    await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
  return res;
}

(async () => {
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const cookie = await login();

  const control = await controlOrdinaryTurn(cookie);
  const results = [];
  for (const c of CASES) {
    if (only && c.name !== only) continue;
    try { results.push(await runCase(cookie, c)); } catch (e) { console.log(`  FAILED: ${e.message}`); }
  }

  console.log('\n================ VERDICT ================');
  console.log(`control: ordinary turn started=${control.started} entersAlt=${control.toggles.includes('h')}`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(10)} enter=${(r.enterToggles || []).join('') || '-'} `
      + `inAlt=${r.inAltAfterEnter} submitStartedTurn=${r.turnStartedWhileBlocked} `
      + `leave=${(r.leaveToggles || []).join('') || '-'} backToComposer=${r.backToComposer}`,
    );
  }
  console.log('\nAlt-screen is a usable blocked-signal only if EVERY line above shows');
  console.log('inAlt=true with submitStartedTurn=false, AND the control shows entersAlt=false.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
