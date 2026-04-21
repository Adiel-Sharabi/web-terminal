// @ts-check
// Issue #17: periodic scrollback save must yield between sessions.
//
// Before the fix, saveAllScrollback looped synchronously over every session
// and ran JSON.stringify on each scrollback (up to ~1-2 MB) in a single tick.
// With 10 sessions that's enough to freeze the event loop for 50-200 ms
// every 30 seconds, showing up as periodic keystroke-echo stutters.
//
// These tests verify:
//   1. All scrollbacks are still saved correctly after the async refactor.
//   2. The event loop is not blocked for the whole save duration — a timer
//      scheduled while the save is in flight fires without excessive delay.

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

function rpc(client, method, params = {}, timeoutMs = 10000) {
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

test.describe('pty-worker scrollback save yields between sessions', () => {
  test('all scrollbacks are persisted after async save', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      // Create several sessions and inject ~512KB of scrollback into each.
      const NUM_SESSIONS = 6;
      const INJECT_BYTES = 512 * 1024;
      const ids = [];
      for (let i = 0; i < NUM_SESSIONS; i++) {
        const { id } = await rpc(client, 'createSession', {
          cwd: os.tmpdir(), name: `save-yield-${i}`, autoCommand: '',
        });
        await rpc(client, '__testInjectScrollback', { id, bytes: INJECT_BYTES });
        ids.push(id);
      }

      // Trigger the same async save path the 30s interval uses, with sync=true
      // so files land on disk before we inspect them.
      await rpc(client, '__testSaveAllScrollback', { sync: true });

      // Every session should have a scrollback file on disk containing its data.
      for (const id of ids) {
        const f = path.join(dataDir, 'scrollback', id + '.json');
        expect(fs.existsSync(f)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
        expect(Array.isArray(parsed)).toBe(true);
        const total = parsed.reduce((n, s) => n + s.length, 0);
        // We injected INJECT_BYTES plus whatever the shell emitted on startup —
        // total must be at least what we injected.
        expect(total).toBeGreaterThanOrEqual(INJECT_BYTES);
      }

      for (const id of ids) {
        try { await rpc(client, 'killSession', { id }); } catch {}
      }
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('event loop is not blocked for the full save duration', async () => {
    // Measure the worker's own event-loop block time during saveAllScrollback.
    // The worker runs a setImmediate probe loop in parallel with the save and
    // reports the longest gap between probe ticks.
    //
    // Without yielding: one huge gap ~= whole save duration (all sessions
    //   JSON.stringify'd in one synchronous stretch).
    // With yielding: maxGap is dominated by a single session's work — far
    //   smaller than the total duration for a many-session workload.

    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      // 10 sessions, each with ~1.5 MB of injected scrollback. Roughly the
      // workload that issue #17 describes.
      const NUM_SESSIONS = 10;
      const INJECT_BYTES = 1.5 * 1024 * 1024;
      const ids = [];
      for (let i = 0; i < NUM_SESSIONS; i++) {
        const { id } = await rpc(client, 'createSession', {
          cwd: os.tmpdir(), name: `yield-${i}`, autoCommand: '',
        });
        await rpc(client, '__testInjectScrollback', { id, bytes: INJECT_BYTES });
        ids.push(id);
      }

      // Use sync=false so each saveScrollback dispatches fs.writeFile and
      // returns almost immediately — the gap we measure comes almost purely
      // from JSON.stringify, not from disk I/O. This isolates the behavior
      // of interest: whether the loop yields between sessions.
      const { duration, maxGap, ticks } = await rpc(
        client, '__testMeasureSaveBlock', { sync: false }, 60000
      );
      // eslint-disable-next-line no-console
      console.log(`[yield-test] duration=${duration}ms maxGap=${maxGap}ms ticks=${ticks}`);

      // Sanity: the probe must have ticked at least once per session —
      // confirming the loop yielded (via setImmediate) between sessions.
      // Without the fix, the entire save completes in one tick and `ticks`
      // would be 1.
      expect(ticks).toBeGreaterThanOrEqual(NUM_SESSIONS);

      // The core assertion: maxGap must be well under the full save time.
      // With yields, maxGap is per-session work. Without yields, maxGap ==
      // duration. We accept up to 70% — plenty of headroom for a single
      // slow session's stringify to dominate, while still catching a full
      // regression (which would put maxGap/duration at effectively 1.0).
      //
      // Only assert the ratio if the save was long enough to be meaningful
      // (>=100ms) — otherwise timer resolution dominates.
      if (duration >= 100) {
        expect(maxGap).toBeLessThan(duration * 0.7);
      }

      for (const id of ids) {
        try { await rpc(client, 'killSession', { id }); } catch {}
      }
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
