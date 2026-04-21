// @ts-check
// Issue #10: skip writing unchanged scrollback every 30s.
//
// Before the fix, the 30s periodic saveAllScrollback(false) wrote every
// session's scrollback to disk regardless of whether anything had changed.
// With 10 idle sessions of ~2 MB each that's ~20 MB of wasted disk writes
// per tick. The fix adds a per-session `dirty` flag set by term.onData and
// cleared by saveScrollback; the periodic path skips !dirty sessions, while
// forced saves (flushState, shutdown) still write everything.
//
// These tests verify:
//   1. Periodic save (force=false) writes only dirty sessions — idle sessions
//      are NOT rewritten.
//   2. After a periodic save, the just-saved session's file is NOT touched
//      again on a second periodic save (dirty flag cleared).
//   3. Forced save (force=true) writes every session regardless of dirty.

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

// Returns { mtimeMs, size } for a scrollback file, or null if missing.
function fileStat(dataDir, id) {
  const f = path.join(dataDir, 'scrollback', id + '.json');
  try { const s = fs.statSync(f); return { mtimeMs: s.mtimeMs, size: s.size }; }
  catch { return null; }
}

test.describe('pty-worker dirty-flag skip on periodic save', () => {
  test('periodic save skips clean sessions and writes dirty ones', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      // Three sessions. All start dirty because the shell banner / prompt
      // emits bytes through term.onData right after spawn. We first do a
      // FORCED save to drain everyone's dirty flag (baseline), then make
      // ONE session dirty, do a periodic save, and check only that session
      // was written.
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await rpc(client, 'createSession', {
          cwd: os.tmpdir(), name: `dirty-${i}`, autoCommand: '',
        });
        ids.push(id);
      }

      // Give the PTYs a moment to emit their startup output so dirty=true
      // across the board, then baseline-flush (force=true) to clear flags
      // and create the initial files.
      await new Promise(r => setTimeout(r, 500));
      await rpc(client, '__testSaveAllScrollback', { sync: true, force: true });

      // All three files must exist after baseline.
      const baseline = ids.map(id => fileStat(dataDir, id));
      for (const s of baseline) expect(s).not.toBeNull();

      // Wait long enough that a subsequent write will produce a different
      // mtime even on low-resolution filesystems (Windows NTFS: ~1-16ms,
      // but some FAT variants round to 2s — pick a safe 50ms).
      await new Promise(r => setTimeout(r, 50));

      // Dirty ONE session by injecting scrollback. The other two stay clean.
      await rpc(client, '__testInjectScrollback', { id: ids[0], bytes: 4096 });

      // Periodic-style save: sync=true (so mtime reflects the write before
      // we read it), force=false (the 30s interval's semantics).
      await rpc(client, '__testSaveAllScrollback', { sync: true, force: false });

      const afterPeriodic = ids.map(id => fileStat(dataDir, id));

      // Session 0 (dirty) must have been rewritten — mtime advanced OR size
      // grew. Sessions 1 & 2 (clean) must be unchanged.
      expect(afterPeriodic[0]).not.toBeNull();
      const changed0 = afterPeriodic[0].mtimeMs !== baseline[0].mtimeMs
        || afterPeriodic[0].size !== baseline[0].size;
      expect(changed0).toBe(true);

      for (const i of [1, 2]) {
        expect(afterPeriodic[i]).not.toBeNull();
        expect(afterPeriodic[i].mtimeMs).toBe(baseline[i].mtimeMs);
        expect(afterPeriodic[i].size).toBe(baseline[i].size);
      }

      // Second periodic save immediately after: nothing is dirty now
      // (session 0's save cleared its flag), so NOTHING should be written.
      await new Promise(r => setTimeout(r, 50));
      await rpc(client, '__testSaveAllScrollback', { sync: true, force: false });
      const afterSecondPeriodic = ids.map(id => fileStat(dataDir, id));
      for (let i = 0; i < 3; i++) {
        expect(afterSecondPeriodic[i].mtimeMs).toBe(afterPeriodic[i].mtimeMs);
        expect(afterSecondPeriodic[i].size).toBe(afterPeriodic[i].size);
      }

      // Forced save: every session written regardless of dirty flag.
      await new Promise(r => setTimeout(r, 50));
      await rpc(client, '__testSaveAllScrollback', { sync: true, force: true });
      const afterForced = ids.map(id => fileStat(dataDir, id));
      for (let i = 0; i < 3; i++) {
        // mtime must advance (or size change) — every file rewritten.
        const changed = afterForced[i].mtimeMs !== afterSecondPeriodic[i].mtimeMs
          || afterForced[i].size !== afterSecondPeriodic[i].size;
        expect(changed).toBe(true);
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

  test('flushState forces save regardless of dirty flag', async () => {
    // flushState is the RPC server.js calls on graceful shutdown. It MUST
    // write every session — losing scrollback because dirty=false at
    // shutdown is the exact failure mode the `force` flag guards against.

    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);

      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'flush-check', autoCommand: '',
      });

      await new Promise(r => setTimeout(r, 300));
      // Baseline-flush so dirty=false.
      await rpc(client, 'flushState');
      const baseline = fileStat(dataDir, id);
      expect(baseline).not.toBeNull();

      await new Promise(r => setTimeout(r, 50));
      // Nothing changed — session is clean. flushState must STILL rewrite.
      await rpc(client, 'flushState');
      const afterFlush = fileStat(dataDir, id);
      const changed = afterFlush.mtimeMs !== baseline.mtimeMs
        || afterFlush.size !== baseline.size;
      expect(changed).toBe(true);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
