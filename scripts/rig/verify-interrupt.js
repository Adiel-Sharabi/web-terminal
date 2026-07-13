#!/usr/bin/env node
'use strict';
// END-TO-END, on the ORPHAN RIG: does a lone 0x1b actually STOP a real Claude turn?
//
// This is the premise the whole of #55 §6 rests on. The worker now reads a lone Esc sent to
// a *working* session as "the turn is over" and reports idle at once (Claude fires no hook
// on an interrupt, so five minutes of stale "Claude is working" was the alternative). That
// inference is only sound if Esc really does end the turn — so this proves it against the
// real TUI, through the stack the app drives:
//
//   HTTP login -> create a Claude session -> terminal WebSocket (as an ACTIVE viewer, or
//   every keystroke is silently dropped — see rig-ws.js) -> start a real turn -> send a
//   LONE 0x1b as one frame, exactly what xterm sends for the Esc key -> watch the PTY.
//
// The PTY is ground truth. A turn that is running emits a stream of output; an interrupted
// one goes quiet. So the assertion is: output was flowing before the Esc, and stops after.
//
// NOT proven here: the status flip itself. A rig session gets no hooks (they are hard-coded
// to production's port — see rig.js), so its status never leaves 'active'. That half is
// proven against the real worker in tests/worker-interrupt-status.spec.js.
//
//   node scripts/rig/rig.js up          # sync working tree + (re)start the rig
//   node scripts/rig/verify-interrupt.js

const { WS_BASE, login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Claude's composer caret, not the shell's `$`. A bare `>` matches far too much, and typing
// before Claude is up puts the prompt into bash — where nothing ever submits.
const COMPOSER = /❯/;
const WORKING = /esc to interrupt|✻|✽|Crunch|Thinking|Pondering|Puzzling|Noodling/i;

// Long enough that the turn is certainly still running when the Esc lands.
const PROMPT = 'count slowly from 1 to 40, one number per line, thinking about each one';

/** How many bytes the PTY emits over `ms` — a running turn is noisy, a stopped one is not. */
async function outputOver(term, ms) {
  const before = term.text().length;
  await sleep(ms);
  return term.text().length - before;
}

(async () => {
  console.log('[interrupt] rig ' + WS_BASE);
  const cookie = await login();
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-interrupt',
    cwd: 'C:\\dev\\wt-rig',
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  console.log(`[interrupt] claude session ${id}`);

  const term = await openTerminal(cookie, id); // ACTIVE viewer — see rig-ws.js

  for (let i = 0; i < 60 && !COMPOSER.test(term.text()); i++) await sleep(500);
  await sleep(2500);
  console.log('[interrupt] composer ready');

  // --- start a real turn -------------------------------------------------
  let mark = term.text().length;
  term.send(PROMPT + '\r');

  let running = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (WORKING.test(term.text().slice(mark))) { running = true; break; }
  }
  console.log(`[interrupt] turn running: ${running}`);
  if (!running) {
    console.log('\n[interrupt] FAIL — the prompt never started a turn, so there is nothing to');
    console.log('            interrupt. (Did it reach Claude at all? See rig-ws.js.)');
    term.close();
    await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
    process.exit(1);
  }

  // A running turn is noisy. Measure it, so "quiet" afterwards means something.
  const busyBytes = await outputOver(term, 2000);
  console.log(`[interrupt] PTY output while running:   ${busyBytes} bytes / 2s`);

  // --- interrupt it: a LONE 0x1b, exactly what xterm sends for the Esc key ---
  term.send('\x1b');
  console.log('[interrupt] sent a lone 0x1b (the Esc key)');
  await sleep(1500); // let the TUI settle after the interrupt

  const quietBytes = await outputOver(term, 2000);
  console.log(`[interrupt] PTY output after the Esc:   ${quietBytes} bytes / 2s`);

  const screen = term.text().slice(-1500).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(-6);
  console.log('[interrupt] tail of the screen:\n  ' + screen.join('\n  '));

  term.close();
  await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});

  // A turn that is still running keeps redrawing its spinner; an interrupted one goes quiet.
  const stopped = quietBytes * 4 < busyBytes;
  if (stopped) {
    console.log('\n[interrupt] PASS — a lone 0x1b ends a real Claude turn: the PTY went quiet.');
    console.log('            So the worker is right to report idle on it (#55 §6).');
    process.exit(0);
  }
  console.log('\n[interrupt] FAIL — the PTY is still busy after the Esc; the turn did NOT stop,');
  console.log('            so treating a lone Esc as "the turn is over" would be wrong.');
  process.exit(1);
})().catch((e) => { console.error('[interrupt] error:', e.message); process.exit(1); });
