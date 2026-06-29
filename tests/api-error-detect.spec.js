// @ts-check
// API-error detection + auto-continue (escalation ladder).
//
// Spawns pty-worker.js with an isolated pipe + temp data dir (same harness as
// worker-session.spec.js). Detection runs in the worker's PTY-output path, so
// we feed bytes through it with the test-only __testInjectOutput RPC (which
// routes through the same processPtyOutput() the real term.onData uses).
//
// Timers are shrunk via WT_API_ERROR_FAST=1 and the auto-continue toggle is
// forced via WT_AUTO_CONTINUE_API_ERROR so the tests are deterministic and
// independent of the on-disk config.json.

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
      WT_API_ERROR_FAST: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });
  return {
    proc,
    getStdout: () => stdout,
    getStderr: () => stderr,
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
    apiActions() {
      return events.filter(e => e.event === 'apiError' && e.params && e.params.action);
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
const BAD_REQUEST = 'API Error: 400 {"type":"error","error":{"message":"bad request"}}\r\n';

test.describe('API-error detection + auto-continue', () => {
  test('flags a Claude session and emits an apiError event on detection', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'claude-sess', autoCommand: '' });
      // Arm it as a Claude session (sets hookStatus).
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);

      const detect = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect(detect.params.transient).toBe(true);
      expect(detect.params.text).toContain('API Error: 529');

      const found = await findSession(client, id);
      expect(found.apiError).toBe(true);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('ignores API Error text in a non-Claude session', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'plain', autoCommand: '' });
      // No hook, no claude autoCommand → not a Claude session.
      await inject(client, id, OVERLOADED);
      await sleep(300);

      expect(ev.events.some(e => e.event === 'apiError' && e.params.id === id)).toBe(false);
      const found = await findSession(client, id);
      expect(!!found.apiError).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('non-transient error (400) flags but does not auto-continue', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'badreq', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, BAD_REQUEST);
      const detect = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect(detect.params.transient).toBe(false);

      await sleep(300); // longer than the (fast) backoff
      expect(ev.apiActions().length).toBe(0);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('does not auto-continue when the feature is disabled', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'disabled', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      await sleep(300);
      expect(ev.apiActions().length).toBe(0);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('apiError clears when Claude resumes working', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'clearme', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect((await findSession(client, id)).apiError).toBe(true);

      // A new working signal (user/auto retry) clears the highlight.
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === false);
      expect(!!(await findSession(client, id)).apiError).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('escalation ladder: continue, continue, /compact + replay, then stops', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'ladder', autoCommand: '' });
      // Capture a real user prompt for the replay step.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'finish the refactor in foo.js' });

      // Error #1 -> attempt 1 = continue
      await inject(client, id, OVERLOADED);
      const a1 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      expect(a1.params.action).toBe('continue');
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' }); // resume -> clears flag

      // Error #2 -> attempt 2 = continue
      await inject(client, id, OVERLOADED);
      const a2 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      expect(a2.params.action).toBe('continue');
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      // Error #3 -> attempt 3 = /compact, then replay captured prompt on idle
      await inject(client, id, OVERLOADED);
      const a3 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3);
      expect(a3.params.action).toBe('compact');
      // The idle hook (or fallback timer) triggers the prompt replay.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      const replay = await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      expect(replay.params.replayText).toBe('finish the refactor in foo.js');

      // Resume, then error #4 -> exhausted, no further auto action.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      const before = ev.apiActions().length;
      await inject(client, id, OVERLOADED);
      await sleep(300);
      expect(ev.apiActions().length).toBe(before);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('auto-continue submits with CR (\\r), never LF (\\n)', async () => {
    // Claude's TUI reads input in raw mode where Enter is CR. Sending LF leaves
    // the text unsubmitted, which silently broke auto-continue in production.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'crsubmit', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'do the thing' });

      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1 && e.params.action === 'continue');
      await sleep(120); // let the deferred CR land

      const { writes } = await rpc(client, '__testGetWrites', { id });
      // Typed text and the submit key are written separately; the submit is CR.
      expect(writes).toContain('continue');
      expect(writes).toContain('\r');
      // The old bug: a single "continue\n" that Claude's TUI never submits.
      expect(writes).not.toContain('continue\n');
      expect(writes.some(w => w.includes('\n'))).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('compact-replay submits the captured prompt with CR, not LF', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'replaycr', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'finish the refactor in foo.js' });

      // Walk to attempt 3 (/compact), clearing the flag between errors.
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      await sleep(120); // let the deferred CR land

      const { writes } = await rpc(client, '__testGetWrites', { id });
      expect(writes).toContain('/compact');
      expect(writes).toContain('finish the refactor in foo.js');
      expect(writes).toContain('\r');
      expect(writes.some(w => w.includes('\n'))).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('replay falls back to "continue" when no prompt was captured', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'nofall', autoCommand: '' });
      // Arm as Claude session WITHOUT capturing a user prompt.
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });

      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      const replay = await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      expect(replay.params.replayText).toBe('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
