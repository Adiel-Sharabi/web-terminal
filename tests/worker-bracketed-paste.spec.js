// @ts-check
// Bracketed-paste mode (DECSET 2004) re-assertion on attach.
//
// Apps like Claude Code enable bracketed paste once at startup (ESC[?2004h).
// xterm.js only wraps pastes in ESC[200~ … ESC[201~ while that mode is on;
// without it a multi-line paste sends bare CRs and each line submits, so only
// the last line survives. On a long session the enable sequence scrolls out of
// the capped (2 MB) scrollback, so a freshly-opened browser tab (re-attach)
// never sees it and multi-line paste breaks.
//
// Fix: the worker tracks the 2004 mode from the PTY stream and re-asserts it
// (prepends ESC[?2004h) on attach when it's on — even after the original
// enable has been trimmed away.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024;
const BP_ON_HEX = Buffer.from('\x1b[?2004h').toString('hex');
const BP_OFF_HEX = Buffer.from('\x1b[?2004l').toString('hex');

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
function rmRf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

function spawnWorker(pipePath, dataDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_PERSIST_SCROLLBACK: '1',
      WT_WORKER_NO_DEFAULT: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
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
function rpc(client, method, params = {}, timeoutMs = 15000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('frame', onFrame); reject(new Error(`RPC ${method} timed out`)); }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer); client.off('frame', onFrame);
      if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
    }
    client.on('frame', onFrame);
    client.send(ipc.encodeJson({ id, method, params }));
  });
}

test.describe('pty-worker bracketed-paste re-assert on attach', () => {
  test('mode ON survives the enable scrolling out of scrollback', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    let client;
    try {
      client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', { name: 'bp' });

      // App enables bracketed paste at startup.
      await rpc(client, '__testInjectScrollbackBytes', { id, hex: BP_ON_HEX });
      // …then produces > 2 MB of output, trimming the enable sequence away.
      await rpc(client, '__testInjectScrollback', { id, bytes: MAX_SCROLLBACK_SIZE + 64 * 1024 });

      const res = await rpc(client, 'attachSession', { id });
      // Re-asserted at the front even though the original enable is gone.
      expect(res.scrollback.startsWith('\x1b[?2004h')).toBe(true);
      // And the trimmed body no longer contains the original marker (proving
      // the startsWith above came from the re-assert, not surviving scrollback).
      expect(res.scrollback.slice('\x1b[?2004h'.length).includes('\x1b[?2004h')).toBe(false);
    } finally {
      if (client) client.close();
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('mode OFF is not re-asserted', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    let client;
    try {
      client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', { name: 'bp-off' });

      // Enable then disable — final state is off.
      await rpc(client, '__testInjectScrollbackBytes', { id, hex: BP_ON_HEX });
      await rpc(client, '__testInjectScrollbackBytes', { id, hex: BP_OFF_HEX });
      // Trim both out of the scrollback.
      await rpc(client, '__testInjectScrollback', { id, bytes: MAX_SCROLLBACK_SIZE + 64 * 1024 });

      const res = await rpc(client, 'attachSession', { id });
      expect(res.scrollback.startsWith('\x1b[?2004h')).toBe(false);
    } finally {
      if (client) client.close();
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('the later marker in a chunk wins (enable after disable → on)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    let client;
    try {
      client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', { name: 'bp-order' });
      // One chunk containing OFF then ON — ON is later, so result is on.
      await rpc(client, '__testInjectScrollbackBytes', { id, hex: BP_OFF_HEX + BP_ON_HEX });
      await rpc(client, '__testInjectScrollback', { id, bytes: MAX_SCROLLBACK_SIZE + 64 * 1024 });
      const res = await rpc(client, 'attachSession', { id });
      expect(res.scrollback.startsWith('\x1b[?2004h')).toBe(true);
    } finally {
      if (client) client.close();
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
