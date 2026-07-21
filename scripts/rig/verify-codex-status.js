#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, that a real Codex session's status is driven by
// its own OSC 9 notifications — the channel that replaces hooks (lib/osc9-notify.js).
//
// This drives the REAL stack: HTTP login -> create a Codex session -> terminal
// WebSocket -> submit a prompt whose tool call needs permission -> assert the SERVER
// reports the session as `waiting`. Nothing here touches production.
//
// Why it needs to exist. Two halves were already proven separately: a real codex 0.144.0
// PTY emits `ESC]9;Codex wants to edit 0 files BEL` when it asks permission (captured off
// the wire), and the worker turns exactly those bytes into `waiting` (worker-osc9-status
// spec, via the real processPtyOutput path). This closes the join — a real Codex process,
// spawned by the real worker, moving a real session's dot.
//
// The sandbox/approval flags are passed with -c rather than relying on config.toml, so
// the run is self-contained and proves the mechanism even on a machine where
// scripts/install-codex-notify.js has not been run. sandbox_mode="read-only" is what
// FORCES the approval: on a trusted project (c:\dev is trusted here) Codex otherwise
// just runs the command and never asks.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/verify-codex-status.js

const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An already-trusted cwd that no live session uses — a fresh dir would hit Codex's
// trust prompt and block forever.
const CWD = 'C:\\dev\\sampleProject1';

// The autoCommand is run BY A SHELL, so every -c value must keep its quotes: a TOML
// string needs them, and bash strips bare double quotes, turning
// `notification_method="osc9"` into an invalid bare value that Codex rejects at
// startup. Single-quoting each override is what survives the shell.
const AUTO = [
  'codex',
  "-c 'tui.notifications=true'",
  `-c 'tui.notification_method="osc9"'`,
  `-c 'tui.notification_condition="always"'`,
  `-c 'approval_policy="on-request"'`,
  `-c 'sandbox_mode="read-only"'`,
].join(' ');

// The composer's status line — `gpt-5.5 high · C:\dev\sampleProject1` — which only
// renders once the TUI is interactive and ready for input.
//
// Deliberately NOT "esc to interrupt" or a caret glyph: a cold start prints "Booting
// MCP server… esc to interrupt", and the npm shim can print a self-update log ("Update
// ran successfully! Please restart Codex.") and drop straight back to the shell. Both
// false-positive a loose regex, and the prompt then goes to bash, where it submits
// nothing — the run "fails" for a reason unrelated to what is under test.
//
// Also NOT the startup banner ("OpenAI Codex (v0.144.0)"): that WAS contiguous text in
// 0.144.0 and is not in 0.144.6, so matching it broke on a routine auto-update. The
// model/effort line is drawn as one run and survived the bump.
const TUI_READY = /gpt-[0-9.]+(?:-\w+)?\s+(?:minimal|low|medium|high|xhigh)/i;

async function statusOf(cookie, id) {
  const list = await api(cookie, 'GET', '/api/sessions');
  const arr = Array.isArray(list) ? list : (list.sessions || []);
  const s = arr.find((x) => x.id === id);
  return s && s.status;
}

async function waitFor(fn, label, timeoutMs, stepMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

(async () => {
  const cookie = await login();
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-codex-status', cwd: CWD, autoCommand: AUTO, agent: 'codex',
  });
  console.log(`session ${id} created (agent=codex)`);

  let failed = false;
  const term = await openTerminal(cookie, id);
  try {
    const up = await waitFor(async () => TUI_READY.test(term.text()), 'tui', 60000);
    if (!up) {
      console.log('--- tail of terminal output ---');
      console.log(term.text().slice(-1500));
      throw new Error('Codex TUI never came up — see the tail above');
    }
    console.log('Codex TUI is up');
    await sleep(3000); // let MCP servers finish booting; a cold TUI shows "esc to interrupt"

    const before = await statusOf(cookie, id);
    console.log(`status before prompt: ${before}`);

    // Submit as ONE frame ending in CR, exactly as the client does — the worker splits
    // the CR itself (submit.gapMs), which is what makes it actually submit.
    term.send('Create a file named RIGPROBE.txt containing the word HELLO. Do it now.\r');
    console.log('prompt submitted; waiting for the approval request…');

    const waiting = await waitFor(async () => (await statusOf(cookie, id)) === 'waiting', 'waiting', 90000);
    if (waiting) {
      console.log('PASS: server reports status=waiting — the OSC 9 approval drove it');
    } else {
      failed = true;
      console.log(`FAIL: status never became waiting (last=${await statusOf(cookie, id)})`);
      console.log('--- tail of terminal output ---');
      console.log(term.text().slice(-1200));
    }

    // Esc rejects the escalation. Codex emits NO notification when declined, so this
    // also exercises the worker's lone-Esc rule (agents.interruptsOnEscape).
    term.send('\x1b');
    const settled = await waitFor(async () => {
      const s = await statusOf(cookie, id);
      return s && s !== 'waiting' ? s : null;
    }, 'settled', 30000);
    console.log(settled ? `after Esc: status=${settled}` : 'after Esc: status did not leave waiting');
  } catch (e) {
    failed = true;
    console.error('ERROR', e.message);
  } finally {
    term.close();
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); console.log('session deleted'); } catch {}
  }
  process.exit(failed ? 1 : 0);
})();
