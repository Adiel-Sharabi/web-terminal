// @ts-check
// #65 — unified "compacting" state, worker-owned.
//
// The chat lens needs an in-progress "Compacting conversation…" indicator for
// BOTH triggers: a user's own /compact (Claude fires the PreCompact hook) and
// this repo's existing API-error auto-recovery /compact (scheduleAutoContinue,
// see api-error-detect.spec.js). Both must set the SAME session.compacting
// field (setCompacting/clearCompacting in pty-worker.js) so the client reads
// one shape regardless of source.
//
// Same harness as tests/worker-interrupt-status.spec.js (spawn pty-worker.js on
// an isolated pipe, drive it with real IPC RPCs) plus the event-collector from
// tests/api-error-detect.spec.js, needed here to assert on the 'compacting'
// broadcast frames themselves (not just the polled session summary).
//
// To watch the first two tests fail without the fix: comment out the
// `setCompacting(session, 'hook')` call in the PreCompact case of handleHook —
// sessionSummary().compacting stays false and no broadcast fires.

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
      WT_API_ERROR_FAST: '1', // shrinks API_ERROR_COMPACT_FALLBACK_MS to 300ms — same
                               // constant setCompacting reuses for its fallback timer
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

const inject = (client, id, data) => rpc(client, '__testInjectOutput', { id, data });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findSession(client, id) {
  const { sessions } = await rpc(client, 'listSessions');
  return sessions.find(s => s.id === id);
}

const OVERLOADED = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.\r\n';

// Tolerance for comparing a timestamp read in THIS process against one stamped in
// the worker process. Wide enough to absorb Windows' coarse timer granularity
// (~15.6ms by default), far too small to let a stale or zeroed value pass.
const CLOCK_SKEW_MS = 250;

test.describe('#65 — unified compacting state', () => {
  test('PreCompact hook: sets compacting true + compactingSince, and broadcasts it', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'precompact', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      const before = Date.now();
      await rpc(client, 'hookEvent', { id, event: 'PreCompact' });

      const frame = await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === true);
      // `before` is read in THIS process; `since` is stamped by Date.now() in the
      // WORKER process. Nothing makes two processes' clock reads agree to the
      // millisecond, so a strict >= asserts something the platform does not
      // promise — it failed on a hosted Windows runner by exactly 1ms
      // (expected >= …505, received …504). What the test actually cares about is
      // that `since` is stamped around now rather than left at 0 or a stale
      // value, so allow a small skew. Same tolerance idea as cluster-token.spec.js:37.
      expect(frame.params.since).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);

      const found = await findSession(client, id);
      expect(found.compacting).toBe(true);
      expect(typeof found.compactingSince).toBe('number');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('an idle hook after PreCompact clears compacting, with a clear broadcast', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'precompact-idle', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await rpc(client, 'hookEvent', { id, event: 'PreCompact' });
      await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === true);
      expect((await findSession(client, id)).compacting).toBe(true);

      // Claude settling (Stop) is the normal end-of-compact signal.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });

      const cleared = await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === false);
      expect(cleared.params.since).toBeNull();
      const found = await findSession(client, id);
      expect(found.compacting).toBe(false);
      expect(found.compactingSince).toBeNull();

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('no idle hook arrives: the fallback timer clears compacting on its own', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir); // WT_API_ERROR_FAST=1 -> 300ms fallback
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'precompact-fallback', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await rpc(client, 'hookEvent', { id, event: 'PreCompact' });
      await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === true);

      // No Stop/idle hook — only the fallback timer can clear it.
      const cleared = await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === false, 2000);
      expect(cleared.params.since).toBeNull();
      expect((await findSession(client, id)).compacting).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('clearing an already-clear session is a no-op — idempotent, no stray broadcast', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'idempotent', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      // Idle hooks with nothing compacting must never emit a 'compacting' frame.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await sleep(200);
      expect(ev.events.some(e => e.event === 'compacting' && e.params.id === id)).toBe(false);
      expect(!!(await findSession(client, id)).compacting).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('API-error auto-recovery /compact also sets compacting (same field, source auto-recovery)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'auto-recovery', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'finish the refactor' });

      // Walk the escalation ladder to attempt 3, which is the /compact step.
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');

      const frame = await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === true);
      expect(typeof frame.params.since).toBe('number');
      expect((await findSession(client, id)).compacting).toBe(true);

      // The idle hook that lets the compact-replay fire also clears compacting.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await ev.waitFor(e => e.event === 'compacting' && e.params.id === id && e.params.compacting === false);
      expect((await findSession(client, id)).compacting).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
