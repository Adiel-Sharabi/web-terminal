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
const setResetAt = (client, id, fiveHResetAt) => rpc(client, 'setFiveHResetAt', { id, fiveHResetAt });
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
