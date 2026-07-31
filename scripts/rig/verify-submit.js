#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, that a LONG prompt actually submits to Claude.
//
// This drives the REAL stack the app drives — HTTP login -> create a Claude session ->
// terminal WebSocket -> send `text\r` as ONE frame, exactly as the client does — and
// asserts Claude actually STARTS A TURN. Nothing here touches production.
//
// Why a LONG prompt: Claude's TUI folds a big enough single read into a paste and
// swallows the trailing CR. Measured directly against the TUI, atomic `text\r`:
//   20 chars submitted | 40 submitted | 60 submitted | 80 NOT | 120 NOT
// A short prompt therefore "worked" and a real one was typed and never sent. The worker
// now withholds the CR and writes it alone after submit.gapMs, which submits at ANY
// length — this script is what proves that end to end.
//
//   node scripts/rig/rig.js up          # sync working tree + (re)start the rig
//   node scripts/rig/verify-submit.js

const { WS_BASE, login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

// >80 chars: past the point where an atomic text+CR stops submitting.
const LONG = 'reply with exactly the single word OK and nothing else, no punctuation, no explanation';
const SHORT = 'say OK';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STARTED = /esc to interrupt|✻|✽|●\s|Crunch|tokens|Thinking/i;
// Claude's composer caret, not the shell's `$`. A bare `>` matches far too much, and typing
// before Claude is up puts the prompt into bash — where nothing ever submits.
const COMPOSER = /❯/;

async function createSession(cookie) {
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-submit',
    cwd: require('../scratch-dirs').DIRS.rig,
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  return id;
}

/** Type `text` + CR as ONE frame (exactly what the client sends) and watch for a turn. */
async function runCase(cookie, id, label, text) {
  const term = await openTerminal(cookie, id); // ACTIVE viewer — see rig-ws.js

  // Wait for Claude's composer to be ready (never guess with a fixed sleep).
  for (let i = 0; i < 60 && !COMPOSER.test(term.text()); i++) await sleep(500);
  await sleep(2500);

  const mark = term.text().length;
  term.send(text + '\r');                    // ONE frame — the client's atomic submit

  let started = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (STARTED.test(term.text().slice(mark))) { started = true; break; }
  }
  term.close();
  console.log(`  ${started ? 'PASS' : 'FAIL'}  ${label} (${text.length} chars) -> ${started ? 'submitted' : 'NOT submitted'}`);
  return started;
}

(async () => {
  console.log(`[verify] rig ${WS_BASE}`);
  const cookie = await login();
  const id = await createSession(cookie);
  console.log(`[verify] claude session ${id}\n`);

  const shortOk = await runCase(cookie, id, 'SHORT prompt', SHORT);
  const longOk = await runCase(cookie, id, 'LONG prompt ', LONG);

  await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});

  console.log('');
  if (shortOk && longOk) {
    console.log('[verify] PASS — both submit. The long prompt is the one that used to park.');
    process.exit(0);
  }
  console.log('[verify] FAIL — a prompt did not submit.');
  process.exit(1);
})().catch((e) => { console.error('[verify] error:', e.message); process.exit(1); });
