// @ts-check
// Issue #69 — auto-resume a session ~1 minute after its 5h usage-limit window
// resets, by sending the SAME 'continue' the API-error escalation ladder sends
// (submitLine — see pty-worker.js). Extends that machine with a second trigger:
// a known fiveHResetAt (today, only Codex reports one — lib/metrics-codex.js) arms
// a ONE-SHOT timer instead of a detected "API Error" string.
//
// Drives the REAL worker over IPC — same harness as tests/api-error-detect.spec.js —
// so setFiveHResetAt, the arm/cancel/fire logic, and submitLine's CR-split all run
// for real. Timers are shrunk via WT_AUTO_RESUME_FAST=1 (mirrors WT_API_ERROR_FAST)
// and the opt-in gate is forced via WT_AUTO_RESUME_ON_RESET so tests are deterministic
// and independent of the on-disk config.json (default OFF).

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-worker-test-${crypto.randomUUID()}`
    : `/tmp/wt-worker-test-${crypto.randomUUID()}.sock`;
}

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'wt-worker-data-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'scrollback'), { recursive: true });
  return dir;
}

function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function spawnWorker(pipePath, dataDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
      WT_AUTO_RESUME_FAST: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    proc,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      let exited = false;
      proc.once('exit', () => { exited = true; resolve(); });
      try { proc.kill(); } catch {}
      setTimeout(() => { if (!exited) { try { proc.kill('SIGKILL'); } catch {} resolve(); } }, 3000);
    }),
  };
}

async function connectClient(pipePath, timeoutMs = 5000) {
  const client = ipc.createClient(pipePath, { retry: true, retryDelayMs: 100 });
  await Promise.race([
    client.connected(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('worker never ready')), timeoutMs)),
  ]);
  return client;
}

function rpc(client, method, params = {}, timeoutMs = 5000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('frame', onFrame);
      reject(new Error(`RPC ${method} timed out`));
    }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      client.off('frame', onFrame);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    }
    client.on('frame', onFrame);
    client.send(ipc.encodeJson({ id, method, params }));
  });
}

/** Buffers every event frame and lets tests await specific ones. */
function makeEventCollector(client) {
  const events = [];
  const waiters = [];
  function onFrame(frame) {
    if (frame.type !== ipc.TYPE_JSON) return;
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
    if (!msg.event) return;
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(msg); }
    }
  }
  client.on('frame', onFrame);
  return {
    events,
    waitFor(pred, timeoutMs = 3000) {
      const existing = events.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: null };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error('timeout waiting for event'));
        }, timeoutMs);
        w.resolve = (m) => { clearTimeout(timer); resolve(m); };
        waiters.push(w);
      });
    },
    stop() { client.off('frame', onFrame); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';
const typeInto = (client, id, text) => client.send(ipc.encodePtyIn(id, Buffer.from(text, 'latin1')));
// #138 — the worker arms on an OBSERVED cap block, never on a bare timestamp, so the
// RPC carries both. Defaulted to true here so the pre-existing #69 cases keep testing
// what they were written to test (timing, one-shot, cancel) rather than the new gate;
// the gate has its own cases below, which pass capBlocked:false.
const inject = (client, id, data) => rpc(client, '__testInjectOutput', { id, data });
const setResetAt = (client, id, fiveHResetAt, capBlocked = true) =>
  rpc(client, 'setFiveHResetAt', { id, fiveHResetAt, capBlocked });
async function findSession(client, id) {
  const { sessions } = await rpc(client, 'listSessions');
  return sessions.find((s) => s.id === id);
}
/** __testGetWrites returns strings or JSON-encoded Buffers; normalise to strings. */
function writesOf(result) {
  return (result.writes || []).map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('utf8')));
}

test.describe('#69 — 5h usage-limit auto-resume', () => {
  test('opted-in session with a near-future resetAt gets exactly ONE continue at reset+delay', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-fire', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 150;
      const armed = await setResetAt(client, id, resetAt);
      expect(armed.fiveHResetAt).toBe(resetAt);
      expect((await findSession(client, id)).fiveHResetAt).toBe(resetAt);

      // Fires at resetAt + AUTO_RESUME_DELAY_MS (fast: 50ms).
      const fired = await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id);
      expect(fired.params.resetAt).toBe(resetAt);
      expect(Date.now()).toBeGreaterThanOrEqual(resetAt); // never fires before the reset itself

      // submitLine writes the text now and the submit CR submitGapMs later (#55) — the
      // gap isn't shrunk by WT_AUTO_RESUME_FAST (that's WT_API_ERROR_FAST's job), so
      // wait past the real default gap (150ms) before asserting the CR landed.
      await sleep(250);
      const { writes } = await rpc(client, '__testGetWrites', { id });
      const sent = writesOf({ writes });
      expect(sent).toContain('continue');
      expect(sent).toContain('\r');
      expect(sent.filter((w) => w === 'continue').length).toBe(1);

      // One-shot: waiting longer must not produce a second continue or a loop.
      await sleep(300);
      const after = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(after.filter((w) => w === 'continue').length).toBe(1);
      expect(ev.events.filter((e) => e.event === 'autoResume').length).toBe(1);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('Esc before the reset fires cancels the pending continue', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-esc', agent: 'claude', autoCommand: '' });

      // Put the session into a real 'working' turn — the state Esc actually interrupts.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'do a thing' });
      expect((await findSession(client, id)).status).toBe('working');

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt);

      typeInto(client, id, ESC); // interrupts the turn -> noteInterrupt -> cancelAutoResume
      await sleep(80);
      expect((await findSession(client, id)).status).toBe('idle');

      // Wait well past resetAt + delay: no continue, no autoResume event.
      await sleep(400);
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // #227 — THE FIELD FAILURE. This test used to assert the opposite, and the helper
  // above defaults capBlocked to true, so it pinned the cancel winning FOR A SESSION
  // THAT WAS STILL CAPPED — which is exactly what reached a user. Measured as a pair
  // inside ONE worker process, both armed for the SAME reset instant: the session
  // prompted after arming produced no log line at all when that instant came; the
  // session that was not fired 20 ms into it. Not their only difference, but the only one
  // that can reach the timer.
  //
  // A submitted prompt proves the user is PRESENT, not that the quota returned. While
  // the account is capped that prompt cannot run — so cancelling on it defeats the
  // feature with the most natural human response to the thing it exists to fix.
  test('#227 — a retry while STILL CAPPED keeps the resume, and it still fires', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    // The stop debounce is shrunk so the session can get back to idle inside the test,
    // which is what really happens: the retry is accepted, the cap refuses it, and the
    // session falls straight back to idle (in production, one minute later).
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1', WT_HOOK_STOP_DEBOUNCE_MS: '20' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-uprompt', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 250;
      await setResetAt(client, id, resetAt); // capBlocked: true — genuinely capped
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      // The user reacts to the cap the way anyone does: they try again.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'still here' });
      // THE ASSERTION THAT WAS MISSING. Asserting only on the write below would have
      // stayed green through a cancel that merely re-armed by luck somewhere else;
      // this names the timer itself, which is the thing that was destroyed.
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      // ...and the prompt goes nowhere, because the cap is still in force.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await sleep(120);
      expect((await findSession(client, id)).status).toBe('idle');

      await sleep(400); // well past resetAt + delay
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(true);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // #227 — AND IT CANNOT LOOP, which the re-arm makes a load-bearing property rather
  // than an idle one. The resume's own `continue` is a real submit, so Claude answers it
  // with a UserPromptSubmit hook (seen in production 300ms after every successful
  // resume) — which now lands on the re-arm path. The one-shot is what closes it:
  // fireAutoResume consumes autoResumeFiredForResetAt BEFORE it writes, so the hook that
  // its own write provokes finds the window already spent and arms nothing.
  //
  // WHAT THIS TEST DOES AND DOES NOT PIN, because the distinction was a review finding:
  // it is a behavioural guard against a loop, NOT a pin on the one-shot ordering. Delete
  // the one-shot line and this still passes — the re-arm fires on the next tick while
  // that same hook has just set the session `working`, so the fire-time `working` guard
  // refuses it instead. The loop is closed twice over, which is why no ordering claim
  // belongs here.
  test('#227 — a resume cannot re-arm on its OWN continue: one continue, not a loop', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-noloop', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt);
      await sleep(400);
      expect(ev.events.filter((e) => e.event === 'autoResume' && e.params.id === id).length).toBe(1);

      // Claude's answer to the continue we just sent.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'continue' });
      expect((await findSession(client, id)).autoResumeArmed).toBe(false);

      await sleep(400);
      expect(ev.events.filter((e) => e.event === 'autoResume' && e.params.id === id).length).toBe(1);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent.filter((w) => w === 'continue').length).toBe(1);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // ...and the fix is exactly one event wide. The signal is not "is the user back" but
  // WHAT THEY ASKED FOR: Esc says stop (above), a prompt says go (the test above), and
  // a TOOL RUNNING is the one that genuinely proves the cap is not in force — an agent
  // that is executing is not an agent the quota is refusing. Non-vacuous: the timer is
  // asserted present first, so this cannot pass by never arming.
  test('#227 — a TOOL running still cancels it: work is proof the cap is not in force', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-pretool', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt);
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      await rpc(client, 'hookEvent', { id, event: 'PreToolUse', tool: 'Bash' });
      expect((await findSession(client, id)).autoResumeArmed).toBe(false);

      await sleep(400);
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('opted-out session with a resetAt is never touched', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-disabled', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt); // still recorded — see fiveHResetAt below
      expect((await findSession(client, id)).fiveHResetAt).toBe(resetAt);

      await sleep(400); // well past resetAt + delay
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('opted-in session with no known resetAt is never touched', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-noresetat', agent: 'claude', autoCommand: '' });
      // Never call setFiveHResetAt — fiveHResetAt stays null.
      expect((await findSession(client, id)).fiveHResetAt).toBeNull();

      await sleep(300);
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // --- #138: a reset time is a SCHEDULE, not a diagnosis -------------------
  // These are the cases #69 could not distinguish. Each must go RED against the
  // pre-#138 worker, which armed on the timestamp alone.

  test('#138 — an idle session that is NOT cap-blocked is never resumed, even past its reset', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'notblocked', agent: 'claude', autoCommand: '' });

      // The exact shape #69 would have fired on: feature ON, a real reset time, an
      // idle session — but no observed block. This is the session you finished with.
      const resetAt = Date.now() + 150;
      const r = await setResetAt(client, id, resetAt, false);
      expect(r.fiveHResetAt).toBe(resetAt); // the timestamp is still RECORDED...
      expect(r.capBlocked).toBe(false);     // ...and still not a reason to act
      expect((await findSession(client, id)).capBlocked).toBe(false);

      await sleep(400); // well past resetAt + delay
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — a block that lifts before the reset elapses cancels the pending resume', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'blocklifts', agent: 'claude', autoCommand: '' });

      // Armed on a real block...
      const resetAt = Date.now() + 250;
      await setResetAt(client, id, resetAt, true);
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      // ...then the quota frees up (or the user resumed by hand) BEFORE it fires.
      // The same timestamp, a different reading: the wait is over, so the nudge is
      // no longer wanted. This is the case a fire-time re-check exists for.
      await setResetAt(client, id, resetAt, false);
      expect((await findSession(client, id)).autoResumeArmed).toBe(false);

      await sleep(400);
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#137 — auto-resume is ON by default: no WT_AUTO_RESUME_ON_RESET, no config', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    // Deliberately NO WT_AUTO_RESUME_ON_RESET — this asserts the shipped default, which
    // #69 had as OFF. The worker reads config.json from its own data dir (empty here),
    // so `liveConfig('autoResumeOnReset', true)` falls through to the code default.
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'default-on', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt, true);

      const fired = await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 4000);
      expect(fired.params.resetAt).toBe(resetAt);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // --- #138: the cap PROMPT, the signal a real limit event actually produces ----
  // Claude blocks on a selector at the cap rather than falling idle. These drive the
  // real worker with the captured render.

  const ESC_SEQ = String.fromCharCode(27);
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  // The captured render, claude-code 2.1.234 (the screenshot on #138). Assembled
  // from parts rather than pasted as one escaped blob so the SGR codes and the box
  // arrow stay readable — the thing under test is the sentence, and a paraphrase
  // would test a string we invented rather than the one Claude prints.
  const LIMIT_PROMPT = [
    '',
    ESC_SEQ + '[1mWhat do you want to do?' + ESC_SEQ + '[0m',
    ESC_SEQ + '[36m\u276f 1. Stop and wait for limit to reset' + ESC_SEQ + '[0m',
    '  2. Upgrade your plan',
    '  3. Upgrade to Team plan',
    '',
    ESC_SEQ + '[2mEnter to confirm \u00b7 Esc to cancel' + ESC_SEQ + '[0m',
    '',
  ].join('\r\n');

  test('#138 — the cap prompt is answered with "stop and wait", exactly once', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1', WT_API_ERROR_FAST: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'limit-prompt', agent: 'claude', autoCommand: '' });

      await inject(client, id, LIMIT_PROMPT);
      const answered = await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id);
      // Option 1 by DIGIT, never a bare Enter on whatever is highlighted — options 2
      // and 3 are plan upgrades.
      expect(answered.params.answered).toBe('1');

      await sleep(150);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent.filter((w) => w === '1').length).toBe(1);

      // A repaint of the same prompt must not type a second digit — once the selector
      // closes, a stray digit lands in the composer.
      await inject(client, id, LIMIT_PROMPT);
      await sleep(200);
      const after = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(after.filter((w) => w === '1').length).toBe(1);

      // And the sighting is a block signal in its own right, published for the UI.
      const found = await findSession(client, id);
      expect(found.limitPromptAt).toBeTruthy();

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — a PLAIN SHELL printing the same text is never typed into', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      // No agent, no hook — catting a logfile or this very test file must not make
      // the server press keys in someone's shell.
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'plain-shell', autoCommand: '' });

      await inject(client, id, LIMIT_PROMPT);
      await sleep(300);

      expect(ev.events.some((e) => e.event === 'usageLimitPrompt' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('1');
      expect((await findSession(client, id)).limitPromptAt).toBeFalsy();

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — prose mentioning the phrase is NOT a menu, and is never answered', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'prose', agent: 'claude', autoCommand: '' });

      // The agent talking ABOUT the limit, or this repo's own docs scrolling past in
      // a Claude session. No numbered option => no menu => nothing to answer. The
      // gate is what keeps a text match from becoming a keystroke in your terminal.
      await inject(client, id, ['I would stop and wait for limit to reset, but...', ''].join(CRLF));
      await sleep(300);

      expect(ev.events.some((e) => e.event === 'usageLimitPrompt' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('1');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — the option is answered by ITS OWN number, not an assumed position', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reordered', agent: 'claude', autoCommand: '' });

      // Same menu, "stop and wait" rendered third. Answering a hardcoded 1 here would
      // buy a plan upgrade — which is exactly why the digit is read off the render.
      await inject(client, id, [
        '',
        '1. Upgrade your plan',
        '2. Upgrade to Team plan',
        '3. Stop and wait for limit to reset',
        '',
      ].join(CRLF));

      const answered = await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id);
      expect(answered.params.answered).toBe('3');
      await sleep(150);
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).toContain('3');
      expect(sent).not.toContain('1');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — a seen cap prompt arms the resume on its own, with no metrics push', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'prompt-arms', agent: 'claude', autoCommand: '' });

      await inject(client, id, LIMIT_PROMPT);
      await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id);

      // capBlocked:false — server.js has NOT corroborated from metrics. The direct
      // observation must be sufficient on its own, or the strongest signal we have
      // would be the one that cannot act.
      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt, false);

      const fired = await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 4000);
      expect(fired.params.resetAt).toBe(resetAt);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // --- review findings: the latch must not outlive the reason for it ----------

  test('#138 — a cap prompt seen earlier does NOT arm a LATER, unblocked window', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'stale-latch', agent: 'claude', autoCommand: '' });

      // The cap prompt is seen and answered...
      await inject(client, id, LIMIT_PROMPT);
      await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id);

      // ...then the user comes back and submits a prompt of their own. They have
      // dealt with it; the sighting is no longer evidence of anything.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'carry on' });
      expect((await findSession(client, id)).limitPromptAt).toBeFalsy();

      // Hours later a NEW window's reset arrives, with the account NOT capped.
      // Arming on the stale latch here would type `continue` into a session the
      // user had finished with - the exact harm the gate exists to prevent.
      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt, false);

      await sleep(400);
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#138 — a cap prompt SPLIT across two PTY reads is still answered', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'split-read', agent: 'claude', autoCommand: '' });

      // A read boundary falls wherever the kernel put it. Cut the option line in
      // half: without a carry across chunks neither half matches and the session
      // hangs on a question nobody answers.
      const cut = LIMIT_PROMPT.indexOf('wait for limit');
      await inject(client, id, LIMIT_PROMPT.slice(0, cut));
      await sleep(60);
      await inject(client, id, LIMIT_PROMPT.slice(cut));

      const answered = await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id, 4000);
      expect(answered.params.answered).toBe('1');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#142 — a CODEX session loads its window but is never auto-resumed (permanent decision)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'codex-noarm', agent: 'codex', autoCommand: '' });

      // Codex reports a real reset time from its rollout, and a real block - so the
      // session list still shows it as held. But nothing may TYPE into it, and this
      // is now a DECIDED outcome rather than a gap awaiting evidence: #142 captured a
      // real Codex cap event (Office, 2026-08-02T20:26:58.735Z) and it does not block
      // on anything answerable — the turn ends and the composer returns on its own,
      // so there is nothing stuck for an auto-resume to rescue. lib/agents.js's Codex
      // `autoResume: { arm: false }` records that reasoning; this test pins the
      // consequence — arming off an inferred percentage alone still writes nothing.
      const resetAt = Date.now() + 150;
      const r = await setResetAt(client, id, resetAt, true);
      expect(r.fiveHResetAt).toBe(resetAt); // the window IS loaded...
      expect(r.capBlocked).toBe(true);      // ...and the block IS recorded
      expect((await findSession(client, id)).autoResumeArmed).toBe(false); // but nothing is armed

      await sleep(400); // well past resetAt + delay
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('survives a worker cold restart — re-arms from the ABSOLUTE resetAt and catches up', async () => {
    const pipe1 = workerPipePath();
    const dataDir = makeTempDataDir();
    let worker = spawnWorker(pipe1, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    let sessionId;
    try {
      let client = await connectClient(pipe1);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-coldrestart', agent: 'claude', autoCommand: '' });
      sessionId = id;

      // Arm, then kill the worker before it can fire (fast delay is 50ms — a resetAt
      // 150ms out gives us room to persist + shut down cleanly before fireAt).
      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt);
      await rpc(client, 'flushState'); // belt-and-suspenders: setFiveHResetAt already fsync'd
      await client.close();
      await worker.stop();

      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'));
      const cfg = saved.find((s) => s.id === id);
      expect(cfg.fiveHResetAt).toBe(resetAt);
      expect(cfg.autoResumeFiredForResetAt).toBeFalsy(); // not yet handled — worker died first

      // Let wall-clock time pass resetAt + delay WHILE THE WORKER IS DOWN.
      await sleep(400);

      // Second worker, same dataDir: restoreSessionsOnStartup re-arms from the
      // persisted absolute resetAt, sees it already elapsed, and fires almost at once.
      const pipe2 = workerPipePath();
      worker = spawnWorker(pipe2, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
      client = await connectClient(pipe2);

      // #138 — the RESET TIME survives on disk; the OBSERVED BLOCK does not, on
      // purpose (a blocked flag restored hours later would arm on a reading nobody
      // took). server.js re-pushes it within a poll of the worker coming back —
      // it clears its de-dup memo on the worker's disconnect precisely so it will —
      // and this stands in for that push. The catch-up itself is still what's under
      // test: fireAt is already in the past, so arming must fire immediately rather
      // than wait for another window.
      expect(cfg.fiveHResetAt).toBe(resetAt); // re-assert: the timestamp came back from disk
      await setResetAt(client, sessionId, resetAt, true);

      let sent = [];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        sent = writesOf(await rpc(client, '__testGetWrites', { id }));
        if (sent.includes('continue')) break;
        await sleep(150);
      }
      expect(sent).toContain('continue');
      // submitLine's CR lands submitGapMs after the text (real default gap: 150ms —
      // WT_AUTO_RESUME_FAST only shrinks the post-reset wait, not the submit gap).
      await sleep(250);
      sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).toContain('\r');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});

// --- #147 x #138: the resume must not type into an agent that is still BOOTING ---
//
// This bug belongs to neither change on its own, which is why it had to be found by
// reading them together. fireAutoResume ends in submitLine — a WORKER-originated PTY
// write, and no other site in the worker gates a write on readiness (#147 gates the
// CLIENT's submit). armAutoResumeTimer runs on the restore path with
// Math.max(0, fireAt - Date.now()), which is ZERO for a window that turned over while
// the worker was down. So a cold restart of a capped session re-arms and fires while
// `claude --resume <id>` is still starting — and a restored session boots SLOWER than
// a cold one — and `continue` lands on bash. #147 exactly, produced by the feature
// meant to rescue the session. The `status === 'working'` guard cannot catch it:
// a booting session is not working.
test.describe('#147 — a resume waits for the agent to exist', () => {
  const CARET = String.fromCodePoint(0x276f); // #190: the composer writes this,
  const NBSP = String.fromCodePoint(0x00a0);  // then U+00A0. A bare caret is a shell prompt.

  /** Poll until the worker has actually written the launch command (the ready scan
   *  is not armed until then). Asserting the precondition beats sleeping a guess. */
  async function launched(client, id) {
    for (let i = 0; i < 80; i++) {
      const res = await rpc(client, '__testGetWrites', { id });
      if ((res.writes || []).some((w) => String(w).includes('launching'))) return true;
      await sleep(100);
    }
    return false;
  }

  test('a reset that comes due mid-boot DEFERS the continue, then sends it once the composer is up', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    // The 45s ceiling is pushed out of the way on purpose: this spec is about the
    // MARKER releasing the deferral, and a fallback firing mid-test would prove
    // nothing about it.
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1', WT_READY_FALLBACK_MS: '60000' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      // An autoCommand is what arms the readiness gate (a session with none is a
      // plain shell). Inert on purpose — readiness is driven through the real
      // PTY-output path below rather than by booting an actual agent.
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'resume-booting', agent: 'claude', autoCommand: 'echo launching-claude',
      });
      expect(await launched(client, id)).toBe(true);
      expect((await findSession(client, id)).agentReady).toBe(false);

      // The window turns over while the agent is still starting.
      const resetAt = Date.now() + 100;
      await setResetAt(client, id, resetAt, true);

      // Well past fireAt (resetAt + 50ms fast delay) and past submitLine's gap.
      await sleep(600);
      const duringBoot = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(duringBoot).not.toContain('continue');
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);
      // DEFERRED, not abandoned: the window is real and the session still needs it.
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      // The composer appears — the same path term.onData feeds.
      await inject(client, id, '\r\n' + CARET + NBSP + 'try "fix"\r\n');
      const fired = await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 5000);
      expect(fired.params.resetAt).toBe(resetAt);

      await sleep(250); // submitLine writes the CR submitGapMs after the text
      const sent = writesOf(await rpc(client, '__testGetWrites', { id }));
      expect(sent).toContain('continue');
      expect(sent).toContain('\r');
      expect(sent.filter((w) => w === 'continue').length).toBe(1);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('a session with no readiness gate at all is unaffected — it fires at once', async () => {
    // The guard must be narrow. A plain shell, an unknown agent and a session with
    // no autoCommand are ready from birth, and delaying THEM would be a new bug.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1', WT_READY_FALLBACK_MS: '60000' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'resume-ready', agent: 'claude', autoCommand: '' });
      expect((await findSession(client, id)).agentReady).toBe(true);

      const resetAt = Date.now() + 100;
      await setResetAt(client, id, resetAt, true);
      await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 3000);

      await sleep(250);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});

// --- #138: a fire that declines to type must not spend the evidence ------------
test.describe('#138 — a skipped fire keeps what it knows', () => {
  // The captured selector, as processPtyOutput sees it after the SGR codes are
  // stripped. Assembled here rather than shared so this spec reads on its own.
  const MENU = ['', 'What do you want to do?', '❯ 1. Stop and wait for limit to reset',
                '  2. Upgrade your plan', '  3. Upgrade to Team plan', ''].join('\r\n');

  test('a session that is WORKING at the reset keeps its observed cap sighting', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1', WT_API_ERROR_FAST: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'skip-working', agent: 'claude', autoCommand: '' });

      // The cap prompt is SEEN (limitPromptAt set), and the session is mid-turn when
      // its window comes round — so the fire correctly declines to nudge it.
      await inject(client, id, MENU);
      await ev.waitFor((e) => e.event === 'usageLimitPrompt' && e.params.id === id);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'carry on' });
      expect((await findSession(client, id)).status).toBe('working');

      // UserPromptSubmit clears the sighting (the user is demonstrably back), so
      // re-establish it the way a repaint would before arming. WT_API_ERROR_FAST
      // shrinks the answer cooldown so the second render is seen rather than ignored.
      await sleep(150);
      await inject(client, id, MENU);
      await sleep(120);
      expect((await findSession(client, id)).limitPromptAt).toBeTruthy();

      const resetAt = Date.now() + 100;
      await setResetAt(client, id, resetAt, false); // armed on the sighting alone
      await sleep(500);

      // Skipped, as it should be — but the sighting must SURVIVE. It used to be
      // cleared above the `working` check, so a fire that then declined to type threw
      // the observation away with the one-shot already consumed: that window had
      // nothing left to arm on and the session never resumed.
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');
      expect((await findSession(client, id)).limitPromptAt).toBeTruthy();

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});

// --- #137: switching a session OFF must not destroy its schedule ---------------
//
// The opt-out used to travel as `fiveHResetAt: null`, the one cancel signal every
// worker version already understood — and setFiveHResetAt PERSISTS a null. So a row
// reading "resumes 14:32", toggled off and straight back on, came back with no reset
// time at all; the re-push that would restore it is gated on metrics still speaking,
// which for a capped Claude session (it stops pushing its status line) is false past
// the 4h TTL. The row then read "on hold" forever and the session never resumed —
// precisely the loss that gate exists to prevent.
test.describe('#137 — the per-session opt-out is not destructive', () => {
  test('disabling keeps the reset time, and re-enabling re-arms from it', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'optout', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 400;
      await rpc(client, 'setFiveHResetAt', { id, fiveHResetAt: resetAt, capBlocked: true });
      expect((await findSession(client, id)).autoResumeArmed).toBe(true);

      // The user clicks the badge off. This says NOTHING about the window.
      const off = await rpc(client, 'setFiveHResetAt', { id, enabled: false });
      expect(off.enabled).toBe(false);
      expect(off.fiveHResetAt).toBe(resetAt); // the schedule survives the cancel
      const disabled = await findSession(client, id);
      expect(disabled.autoResumeArmed).toBe(false);
      expect(disabled.fiveHResetAt).toBe(resetAt);

      // Past the moment it would have fired: nothing was typed.
      await sleep(600);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).not.toContain('continue');
      expect(ev.events.some((e) => e.event === 'autoResume' && e.params.id === id)).toBe(false);

      // Clicked back on, with no metrics push in between — the worker still knows
      // when the window turns over, so it re-arms from that and fires the catch-up.
      const on = await rpc(client, 'setFiveHResetAt', { id, enabled: true });
      expect(on.fiveHResetAt).toBe(resetAt);
      await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 3000);
      await sleep(250);
      expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toContain('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('an older server.js that sends no `enabled` field arms exactly as before', async () => {
    // Absent must mean "unchanged, and the default is ON". Reading it as OFF would
    // silently disable the whole feature against a server mid-upgrade.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'legacy-push', agent: 'claude', autoCommand: '' });

      const resetAt = Date.now() + 100;
      const res = await rpc(client, 'setFiveHResetAt', { id, fiveHResetAt: resetAt, capBlocked: true });
      expect(res.enabled).toBe(true);
      await ev.waitFor((e) => e.event === 'autoResume' && e.params.id === id, 3000);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
