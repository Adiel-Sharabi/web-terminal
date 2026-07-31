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
// --from-config DROPS the three tui overrides, so the notification channel can only come
// from THIS MACHINE'S ~/.codex/config.toml. That is a different claim and the one #82
// actually needs: not "the code works" but "this box is configured". The default mode
// cannot fail on an unconfigured machine, which is exactly how the feature shipped in
// 1.45.0 and sat inert on all three boxes for over a week without any check going red.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/verify-codex-status.js                # mechanism (self-contained)
//   node scripts/rig/verify-codex-status.js --from-config  # this machine's install

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
const FROM_CONFIG = process.argv.includes('--from-config');

// The tui overrides are what make the default mode self-contained; --from-config omits
// them so the ONLY possible source of an OSC 9 notification is config.toml. The approval
// and sandbox overrides stay in BOTH modes — they are the test fixture (they force a
// permission prompt in a trusted project), not the thing under test.
const TUI_OVERRIDES = [
  "-c 'tui.notifications=true'",
  `-c 'tui.notification_method="osc9"'`,
  `-c 'tui.notification_condition="always"'`,
];

const AUTO = [
  'codex',
  ...(FROM_CONFIG ? [] : TUI_OVERRIDES),
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

// Codex's startup update nag BLOCKS the TUI behind a select list:
//   ✨ Update available! 0.144.6 -> 0.146.0
//   › 1. Update now (runs `npm install -g @openai/codex`)
//     2. Skip     3. Skip until next version
// It appeared on 2026-07-31 and made this verifier time out with perfectly good code —
// the same false-negative class the TUI_READY comment above warns about, arriving from
// outside the repo. Any new Codex session hits it, so it is not a rig-only concern.
//
// Dismiss with ESC, NEVER Enter: the caret starts on "Update now", so a blind Enter runs
// a global npm install in the middle of a verification run. Esc cannot select a row.
// Measured 2026-07-31 against a real 0.144.6 PTY: Esc drops straight to the composer.
const UPDATE_NAG = /Update available|Update now \(runs/i;

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
  console.log(FROM_CONFIG
    ? 'mode: --from-config (no tui overrides — the notification MUST come from ~/.codex/config.toml)'
    : 'mode: self-contained (tui overrides passed with -c)');
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-codex-status', cwd: CWD, autoCommand: AUTO, agent: 'codex',
  });
  console.log(`session ${id} created (agent=codex)`);

  let failed = false;
  const term = await openTerminal(cookie, id);
  try {
    let nagDismissed = false;
    const up = await waitFor(async () => {
      if (TUI_READY.test(term.text())) return true;
      if (!nagDismissed && UPDATE_NAG.test(term.text())) {
        console.log('update nag detected — dismissing with Esc (never Enter: the caret is on "Update now")');
        term.send('\x1b');
        nagDismissed = true;
      }
      return false;
    }, 'tui', 60000);
    if (!up) {
      console.log('--- tail of terminal output ---');
      console.log(term.text().slice(-1500));
      throw new Error('Codex TUI never came up — see the tail above');
    }
    console.log('Codex TUI is up');

    // Being "up" is NOT being ready for input, and a fixed sleep is a guess that got
    // falsified: dismissing the update nag makes TUI_READY match EARLIER (the composer's
    // model/effort line renders while "Starting MCP servers (0/2)" is still ticking), and
    // 3s was no longer enough. The prompt then went into the composer and was never
    // submitted — a FAIL that looks exactly like the submit bug this repo has chased four
    // times, with nothing actually wrong.
    //
    // So wait for a real quiet signal instead: two consecutive polls whose NEW output
    // carries neither the MCP boot line nor the working spinner.
    const BUSY = /Starting MCP servers|esc to interrupt/i;
    let mark = term.text().length, calm = 0;
    const quiet = await waitFor(async () => {
      const fresh = term.text().slice(mark);
      mark = term.text().length;
      calm = BUSY.test(fresh) ? 0 : calm + 1;
      return calm >= 2;
    }, 'settle', 60000, 1500);
    console.log(quiet ? 'composer is idle — safe to submit' : 'WARN: never went quiet; submitting anyway');
    await sleep(1500);

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
      // Which failure this is depends on the mode, and saying so beats re-deriving it:
      // in --from-config an unconfigured machine fails here with working code.
      console.log(FROM_CONFIG
        ? 'HINT: --from-config relies on ~/.codex/config.toml. Run `node scripts/install-codex-notify.js --check`'
        + ' — if the three [tui] keys are missing, this box is unconfigured and the CODE is not at fault.'
        : 'HINT: the tui overrides were passed, so config.toml is not involved — suspect the worker/registry path.');
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
