// @ts-check
// Phase 4: Binary PTY data plane over IPC.
//
// Verifies that PTY output from the worker is delivered as TYPE_PTY_OUT
// binary frames (not JSON-encoded ptyData events), that keystrokes sent
// as TYPE_PTY_IN binary frames reach the PTY, that data is routed only
// to connections attached to that session, and that detaching stops the
// PTY_OUT flow for that session.

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

/** Collect PTY_OUT binary frames for a given session for up to timeoutMs or until stop predicate is satisfied. */
function collectPtyOut(client, sessionId, { stopWhen, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      client.off('frame', onFrame);
      resolve(chunks);
    }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_PTY_OUT) return;
      const parsed = ipc.parsePtyFrame(frame);
      if (parsed.sessionId !== sessionId) return;
      chunks.push(parsed.data);
      if (stopWhen && stopWhen(Buffer.concat(chunks).toString('utf8'))) {
        clearTimeout(timer);
        client.off('frame', onFrame);
        resolve(chunks);
      }
    }
    client.on('frame', onFrame);
  });
}

/** Count PTY_OUT frames received over a period, for any matching session in ids. */
function countPtyOut(client, idsSet, windowMs) {
  return new Promise((resolve) => {
    const counts = {};
    for (const id of idsSet) counts[id] = 0;
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_PTY_OUT) return;
      const parsed = ipc.parsePtyFrame(frame);
      if (idsSet.has(parsed.sessionId)) counts[parsed.sessionId]++;
    }
    client.on('frame', onFrame);
    setTimeout(() => {
      client.off('frame', onFrame);
      resolve(counts);
    }, windowMs);
  });
}

test.describe('pty-worker binary data plane', () => {
  test('attach receives PTY output as TYPE_PTY_OUT binary frames', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'binary-out', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      // Wait for some PTY_OUT binary frames to arrive from the shell prompt.
      const collectPromise = collectPtyOut(client, id, { timeoutMs: 6000 });

      // Send keystrokes as TYPE_PTY_IN so the shell echoes something back.
      const frame = ipc.encodePtyIn(id, Buffer.from('echo PHASE4_MARK\r'));
      client.send(frame);

      // Collect until we see the marker echoed back.
      const chunks = await Promise.race([
        collectPtyOut(client, id, { stopWhen: (s) => s.includes('PHASE4_MARK'), timeoutMs: 10000 }),
        collectPromise,
      ]);
      const joined = Buffer.concat(chunks).toString('utf8');
      expect(chunks.length).toBeGreaterThan(0);
      expect(joined).toContain('PHASE4_MARK');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('TYPE_PTY_IN frame reaches the PTY (round-trip via echo)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'binary-in', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      // Send a unique marker via TYPE_PTY_IN frame.
      const marker = 'WT_INPUT_' + crypto.randomUUID().slice(0, 8);
      client.send(ipc.encodePtyIn(id, Buffer.from('echo ' + marker + '\r')));

      const chunks = await collectPtyOut(client, id, {
        stopWhen: (s) => s.includes(marker),
        timeoutMs: 10000,
      });
      const joined = Buffer.concat(chunks).toString('utf8');
      expect(joined).toContain(marker);

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('PTY output routed only to connections attached to that session', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id: idA } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'session-A', autoCommand: '',
      });
      const { id: idB } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'session-B', autoCommand: '',
      });

      // Attach only to A.
      await rpc(client, 'attachSession', { id: idA, scrollbackLimit: 1024 * 1024 });

      // Send input to A (attached) and B (not attached).
      const markerA = 'ROUTING_A_' + crypto.randomUUID().slice(0, 8);
      const markerB = 'ROUTING_B_' + crypto.randomUUID().slice(0, 8);

      // Start collector BEFORE sending.
      const countsPromise = countPtyOut(client, new Set([idA, idB]), 5000);

      client.send(ipc.encodePtyIn(idA, Buffer.from('echo ' + markerA + '\r')));
      client.send(ipc.encodePtyIn(idB, Buffer.from('echo ' + markerB + '\r')));

      const counts = await countsPromise;
      expect(counts[idA]).toBeGreaterThan(0);
      expect(counts[idB]).toBe(0);

      await rpc(client, 'killSession', { id: idA });
      await rpc(client, 'killSession', { id: idB });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('after detachSession, no more PTY_OUT frames for that session', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'detach-stop', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      // Trigger output and wait until at least one PTY_OUT arrives.
      const marker1 = 'BEFORE_' + crypto.randomUUID().slice(0, 8);
      client.send(ipc.encodePtyIn(id, Buffer.from('echo ' + marker1 + '\r')));
      const before = await collectPtyOut(client, id, {
        stopWhen: (s) => s.includes(marker1),
        timeoutMs: 10000,
      });
      expect(Buffer.concat(before).toString('utf8')).toContain(marker1);

      // Detach (clientCount drops to 0). Now send more input — worker should not emit PTY_OUT.
      await rpc(client, 'detachSession', { id });

      // Give a small grace so any in-flight frames drain first.
      await new Promise(r => setTimeout(r, 100));

      const counts = await countPtyOut(client, new Set([id]), 3000);
      // Send some input AFTER detaching — should not produce PTY_OUT frames for this session.
      client.send(ipc.encodePtyIn(id, Buffer.from('echo AFTER\r')));
      // Re-count in a fresh window
      const counts2 = await countPtyOut(client, new Set([id]), 2000);
      expect(counts[id]).toBe(0);
      expect(counts2[id]).toBe(0);

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
