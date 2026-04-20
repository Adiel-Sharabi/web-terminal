// @ts-check
// Issue #9: O(1) session id lookup — verify sessionIdOf correctly identifies
// each session's id, especially when many sessions exist and hook events fire.
//
// The original implementation of sessionIdOf was a linear scan of the sessions
// Map: `for (const [id, s] of sessions) if (s === session) return id`. This
// test stresses the lookup path by creating multiple sessions and firing hook
// events for each, asserting that statusChanged events carry the correct id.
//
// This test is intentionally written to be correctness-only (not a perf test)
// so it stays deterministic. If sessionIdOf ever returns the wrong id (e.g.,
// a bug returning null or the first-match id), the statusChanged event for
// a given session would carry a different id than the one we hit with hookEvent,
// and the assertion would fail.
//
// The test uses the same helpers/style as tests/worker-session.spec.js.

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

/**
 * Collect the next statusChanged event matching `predicate`. Resolves with the
 * event's params. Rejects on timeout.
 */
function waitForStatusChanged(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('frame', onFrame);
      reject(new Error(`timed out waiting for statusChanged`));
    }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.event === 'statusChanged' && predicate(msg.params)) {
        clearTimeout(timer);
        client.off('frame', onFrame);
        resolve(msg.params);
      }
    }
    client.on('frame', onFrame);
  });
}

test.describe('pty-worker sessionIdOf correctness (#9)', () => {
  test('hookEvent broadcasts statusChanged with correct id for each of many sessions', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      // Create several sessions so sessionIdOf has work to do.
      const N = 5;
      const ids = [];
      for (let i = 0; i < N; i++) {
        const { id } = await rpc(client, 'createSession', {
          cwd: os.tmpdir(), name: `id-lookup-${i}`, autoCommand: '',
        });
        ids.push(id);
      }

      // For each session, fire UserPromptSubmit (idle->working) and confirm
      // the broadcasted statusChanged carries the correct session id.
      // This exercises sessionIdOf(session) inside handleHook.
      for (const id of ids) {
        const pending = waitForStatusChanged(client, p => p.id === id && p.status === 'working');
        const { status } = await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
        expect(status).toBe('working');
        const params = await pending;
        expect(params.id).toBe(id);
        expect(params.status).toBe('working');
      }

      // Also exercise a transition back to idle to re-fire sessionIdOf on each.
      for (const id of ids) {
        const pending = waitForStatusChanged(client, p => p.id === id && p.status === 'idle');
        await rpc(client, 'hookEvent', { id, event: 'Stop' });
        const params = await pending;
        expect(params.id).toBe(id);
        expect(params.status).toBe('idle');
      }

      // Clean up
      for (const id of ids) {
        await rpc(client, 'killSession', { id });
      }
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('listSessions returns each session with its own id (no cross-talk)', async () => {
    // sessionSummary calls correctStaleStatus which calls sessionIdOf. This
    // test confirms that after creating many sessions, listSessions returns
    // the full set of unique ids matching what createSession returned.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      const N = 8;
      const created = [];
      for (let i = 0; i < N; i++) {
        const { id, name } = await rpc(client, 'createSession', {
          cwd: os.tmpdir(), name: `list-${i}`, autoCommand: '',
        });
        created.push({ id, name });
      }

      const { sessions } = await rpc(client, 'listSessions');
      for (const { id, name } of created) {
        const found = sessions.find(s => s.id === id);
        expect(found).toBeTruthy();
        expect(found.name).toBe(name);
      }

      // All ids distinct
      const listedIds = sessions.map(s => s.id);
      const unique = new Set(listedIds);
      expect(unique.size).toBe(listedIds.length);

      for (const { id } of created) {
        await rpc(client, 'killSession', { id });
      }
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
