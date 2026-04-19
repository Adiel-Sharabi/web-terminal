// @ts-check
// Phase 2: Worker skeleton — spawn, ping, shutdown
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-worker-test-${crypto.randomUUID()}`
    : `/tmp/wt-worker-test-${crypto.randomUUID()}.sock`;
}

/** Spawn pty-worker.js with an isolated pipe path. Returns { proc, stop() }. */
function spawnWorker(pipePath, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
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
      proc.once('exit', () => resolve());
      try { proc.kill(); } catch {}
    }),
  };
}

/** Send a JSON RPC request, return the response payload. */
function rpc(client, method, params = {}, timeoutMs = 3000) {
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

test.describe('pty-worker skeleton', () => {
  test('spawns, accepts connection, responds to ping', async () => {
    const pipe = workerPipePath();
    const worker = spawnWorker(pipe);
    try {
      // Wait for worker to be ready — try to connect with retry
      const client = ipc.createClient(pipe, { retry: true, retryDelayMs: 200 });
      // Give the worker up to 5 seconds to start
      const connected = Promise.race([
        client.connected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('worker never ready: ' + worker.getStderr())), 5000)),
      ]);
      await connected;

      const pong = await rpc(client, 'ping');
      expect(pong).toBeTruthy();
      expect(pong.ok).toBe(true);
      expect(typeof pong.version).toBe('string');

      await client.close();
    } finally {
      await worker.stop();
    }
  });

  test('rejects unknown RPC method', async () => {
    const pipe = workerPipePath();
    const worker = spawnWorker(pipe);
    try {
      const client = ipc.createClient(pipe, { retry: true, retryDelayMs: 200 });
      await Promise.race([
        client.connected(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);

      await expect(rpc(client, 'nonexistent-method')).rejects.toThrow(/unknown method/i);

      await client.close();
    } finally {
      await worker.stop();
    }
  });
});
