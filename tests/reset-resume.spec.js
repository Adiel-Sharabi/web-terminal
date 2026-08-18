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
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-fire', autoCommand: '' });

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

  test('a new UserPromptSubmit before the reset fires cancels the pending continue', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-uprompt', autoCommand: '' });

      const resetAt = Date.now() + 150;
      await setResetAt(client, id, resetAt);

      // The user (or a retry) is back before the window even reset.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'still here' });

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

  test('opted-out session with a resetAt is never touched', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_RESUME_ON_RESET: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-disabled', autoCommand: '' });

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
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-noresetat', autoCommand: '' });
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
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'notblocked', autoCommand: '' });

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
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'blocklifts', autoCommand: '' });

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
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'default-on', autoCommand: '' });

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

  test('survives a worker cold restart — re-arms from the ABSOLUTE resetAt and catches up', async () => {
    const pipe1 = workerPipePath();
    const dataDir = makeTempDataDir();
    let worker = spawnWorker(pipe1, dataDir, { WT_AUTO_RESUME_ON_RESET: '1' });
    let sessionId;
    try {
      let client = await connectClient(pipe1);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'reset-coldrestart', autoCommand: '' });
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
