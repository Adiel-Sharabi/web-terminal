// @ts-check
// The worker version published by /api/version comes from the IPC HANDSHAKE, not from
// reading pty-worker.js off disk — and that distinction is the entire point of the
// field, because the failure it exists to expose is disk and process DISAGREEING
// (a hot reload restarts server.js and leaves the old worker running).
//
// tests/api.spec.js cannot pin that: the Playwright server runs a worker from this same
// checkout, so live and on-disk are equal by construction there and a refactor to
// `fs.readFileSync('pty-worker.js')` would satisfy it unchanged. These tests drive a
// STUB worker answering a sentinel version that appears nowhere on disk, so that
// refactor goes red here.
const { test, expect } = require('@playwright/test');
const path = require('path');
const crypto = require('crypto');

function requireIpc() { return require(path.join(__dirname, '..', 'lib', 'ipc.js')); }
function requireWorkerClient() { return require(path.join(__dirname, '..', 'lib', 'worker-client.js')); }

function pipeName() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-test-${crypto.randomUUID()}`
    : `/tmp/wt-test-${crypto.randomUUID()}.sock`;
}

/**
 * A stub worker that answers `ping` however the caller asks it to, and every other RPC
 * with an empty result. `pong` is a function so a test can vary the reply.
 */
async function stubWorker(pipe, pong) {
  const ipc = requireIpc();
  const server = ipc.createServer(pipe);
  await server.listening();
  server.on('connection', (conn) => {
    conn.on('frame', (frame) => {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id == null) return;
      const result = msg.method === 'ping' ? pong() : {};
      conn.send(ipc.encodeJson({ id: msg.id, result }));
    });
  });
  return server;
}

test.describe('worker version comes from the handshake', () => {
  test('workerVersion() returns exactly what the worker reported, not anything on disk', async () => {
    const pipe = pipeName();
    // Deliberately NOT a version that exists anywhere in this repo.
    const SENTINEL = '99.98.97-sentinel';
    const server = await stubWorker(pipe, () => ({ ok: true, version: SENTINEL }));
    const wc = requireWorkerClient().create();
    try {
      await wc.connect(pipe, { maxAttempts: 10, delayMs: 50 });
      expect(wc.isConnected()).toBe(true);
      expect(wc.workerVersion()).toBe(SENTINEL);
    } finally {
      wc.close();
      await server.close();
    }
  });

  test('workerVersion() is null once the client is closed — it can never name a departed worker', async () => {
    const pipe = pipeName();
    const server = await stubWorker(pipe, () => ({ ok: true, version: '1.2.3-sentinel' }));
    const wc = requireWorkerClient().create();
    try {
      await wc.connect(pipe, { maxAttempts: 10, delayMs: 50 });
      expect(wc.workerVersion()).toBe('1.2.3-sentinel');
      wc.close();
      expect(wc.isConnected()).toBe(false);
      expect(wc.workerVersion()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test('a worker that reports no version connects, but publishes null rather than a guess', async () => {
    const pipe = pipeName();
    const server = await stubWorker(pipe, () => ({ ok: true })); // older worker: no version field
    const wc = requireWorkerClient().create();
    try {
      await wc.connect(pipe, { maxAttempts: 10, delayMs: 50 });
      expect(wc.isConnected()).toBe(true);
      expect(wc.workerVersion()).toBeNull();
    } finally {
      wc.close();
      await server.close();
    }
  });
});
