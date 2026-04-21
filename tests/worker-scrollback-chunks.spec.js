// @ts-check
// Issue #12: scrollback stored as a list of chunks + running total byte length
// instead of a plain string[] re-joined on every read.
//
// Before the fix:
//   - attachSession / getScrollback each called scrollback.join('') to build
//     the return payload — O(N) alloc on every reconnect, per-session.
//   - 5 sessions × ~1 MB × many reconnects = MB/s of alloc + GC churn.
//
// After the fix:
//   - scrollback is { chunks: string[], totalLen: number }.
//   - term.onData / __testInject push into chunks, update totalLen.
//   - Trim shifts (or head-slices) the oldest chunk when totalLen exceeds
//     MAX_SCROLLBACK_SIZE.
//   - Readers call concatScrollback(scrollback) which does exactly one concat.
//
// These tests verify:
//   1. Functional — chunks push + concat returns the same bytes back.
//   2. Trim — past MAX_SCROLLBACK_SIZE (2 MB), old data is dropped and the
//      stored total stays at/under the limit.
//   3. Repeated attach — the chunks array is preserved across 20 attach
//      cycles (the read path does not mutate the stored chunks).
//   4. Persistence round-trip — save, kill worker, restart, and scrollback
//      is restored byte-for-byte.
//   5. Legacy on-disk format (multi-chunk string[]) still loads correctly.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024;

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

test.describe('pty-worker scrollback chunk store (issue #12)', () => {
  test('chunks append + concat returns bytes back byte-for-byte', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'chunks-append', autoCommand: '',
      });

      // Let PTY startup noise settle, then capture the baseline.
      await new Promise(r => setTimeout(r, 300));
      const baseline = (await rpc(client, 'getScrollback', { id })).data;

      // Inject three distinct chunks with known content.
      await rpc(client, '__testInjectScrollbackChunk', { id, data: 'AAA' });
      await rpc(client, '__testInjectScrollbackChunk', { id, data: 'BBBB' });
      await rpc(client, '__testInjectScrollbackChunk', { id, data: 'CCCCC' });

      // getScrollback should return the baseline + all three chunks in order.
      const got = (await rpc(client, 'getScrollback', { id })).data;
      expect(got.length).toBe(baseline.length + 3 + 4 + 5);
      expect(got.endsWith('AAABBBBCCCCC')).toBe(true);

      // Internal chunk count reflects the three injections (plus whatever
      // chunks term.onData produced for baseline).
      const meta = await rpc(client, '__testScrollbackMeta', { id });
      expect(meta.numChunks).toBeGreaterThanOrEqual(3);
      expect(meta.totalLen).toBe(got.length);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('trim past MAX_SCROLLBACK_SIZE drops old chunks and respects limit', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'chunks-trim', autoCommand: '',
      });

      await new Promise(r => setTimeout(r, 200));

      // Inject a tagged "old" chunk, then flood past the cap with chunks
      // of filler. The old tag must be evicted; the flooder tail must win.
      const OLD_TAG = 'THIS_IS_OLD_AND_SHOULD_BE_DROPPED';
      await rpc(client, '__testInjectScrollbackChunk', { id, data: OLD_TAG });

      // Pump ~3 MB of filler via the bulk RPC to force trim. Each call adds
      // 512 KB until totalLen comfortably exceeds MAX_SCROLLBACK_SIZE (2 MB).
      for (let i = 0; i < 6; i++) {
        await rpc(client, '__testInjectScrollback', { id, bytes: 512 * 1024 });
      }

      const meta = await rpc(client, '__testScrollbackMeta', { id });
      // totalLen MUST be at-or-under the cap.
      expect(meta.totalLen).toBeLessThanOrEqual(MAX_SCROLLBACK_SIZE);
      // The old tag should be gone — trim evicted the head chunks first.
      // Request with a generous limit so getScrollback doesn't secondary-trim.
      const full = (await rpc(client, 'getScrollback', { id, limit: MAX_SCROLLBACK_SIZE * 2 })).data;
      expect(full.includes(OLD_TAG)).toBe(false);
      // And the total length of getScrollback must also match totalLen.
      expect(full.length).toBe(meta.totalLen);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('repeated attach cycles preserve the chunks array', async () => {
    // Verify: the read path (concatScrollback) does NOT mutate the stored
    // chunks. After 20 attaches the number of chunks should be identical
    // to what it was before the attach loop (baseline + our injections).
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'chunks-attach', autoCommand: '',
      });

      await new Promise(r => setTimeout(r, 300));

      // Push a fixed number of known chunks, then freeze any background
      // PTY output by reading the chunk count right after.
      for (let i = 0; i < 5; i++) {
        await rpc(client, '__testInjectScrollbackChunk', { id, data: `ATTACH-${i}-` });
      }
      // Small pause to let anything else settle.
      await new Promise(r => setTimeout(r, 100));
      const before = await rpc(client, '__testScrollbackMeta', { id });
      const firstAttach = (await rpc(client, 'attachSession', { id })).scrollback;

      // 20 attach cycles. Detach in between so clientCount doesn't grow unbounded
      // (not strictly necessary but matches real reconnect patterns).
      let lastData = firstAttach;
      for (let i = 0; i < 20; i++) {
        const attach = (await rpc(client, 'attachSession', { id })).scrollback;
        expect(attach).toBe(lastData);
        lastData = attach;
        await rpc(client, 'detachSession', { id });
      }

      const after = await rpc(client, '__testScrollbackMeta', { id });
      // Chunks array is preserved exactly — concat does not flatten it.
      expect(after.numChunks).toBe(before.numChunks);
      expect(after.totalLen).toBe(before.totalLen);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('persistence round-trip: save, restart, load restores scrollback', async () => {
    const pipe1 = workerPipePath();
    const dataDir = makeTempDataDir();
    let id;
    let preRestart;
    const MARKER = 'PERSIST_MARKER_' + crypto.randomUUID();

    // --- First worker: create session, inject known data, flush, stop. -----
    const worker1 = spawnWorker(pipe1, dataDir);
    try {
      const client1 = await connectClient(pipe1);
      const created = await rpc(client1, 'createSession', {
        cwd: os.tmpdir(), name: 'persist-check', autoCommand: '',
      });
      id = created.id;

      await new Promise(r => setTimeout(r, 300));

      await rpc(client1, '__testInjectScrollbackChunk', { id, data: MARKER });
      await rpc(client1, '__testInjectScrollbackChunk', { id, data: '---TAIL---' });

      preRestart = (await rpc(client1, 'getScrollback', { id })).data;
      expect(preRestart.includes(MARKER)).toBe(true);

      // Flush forces write of sessions.json + scrollback/<id>.json.
      await rpc(client1, 'flushState');
      await client1.close();
    } finally {
      await worker1.stop();
    }

    // --- Verify on-disk file is a JSON array of string(s). -------------------
    const scrollbackFile = path.join(dataDir, 'scrollback', id + '.json');
    expect(fs.existsSync(scrollbackFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(scrollbackFile, 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    // New format writes a single concatenated string. Verify.
    expect(raw.length).toBe(1);
    expect(raw[0]).toBe(preRestart);

    // --- Second worker: same data dir, restore session, check scrollback. ---
    const pipe2 = workerPipePath();
    const worker2 = spawnWorker(pipe2, dataDir);
    try {
      const client2 = await connectClient(pipe2);
      // Wait a moment for restore to complete.
      await new Promise(r => setTimeout(r, 500));

      const list = (await rpc(client2, 'listSessions')).sessions;
      const restored = list.find(s => s.id === id);
      expect(restored).toBeTruthy();

      const postRestart = (await rpc(client2, 'getScrollback', { id })).data;
      // The restored scrollback should contain the marker we injected and
      // be followed by the "--- server restarted ---" banner (and any new
      // shell startup output). The prefix must match preRestart exactly.
      expect(postRestart.startsWith(preRestart)).toBe(true);
      expect(postRestart.includes(MARKER)).toBe(true);
      expect(postRestart.includes('--- server restarted ---')).toBe(true);

      try { await rpc(client2, 'killSession', { id }); } catch {}
      await client2.close();
    } finally {
      await worker2.stop();
      rmRf(dataDir);
    }
  });

  test('legacy on-disk format (multi-chunk array) still loads', async () => {
    // The old format was a JSON array of many small strings (one per
    // term.onData). loadScrollback returns it as-is and createSession
    // spreads each entry into the new chunks list. This test writes a
    // legacy-shaped file by hand, boots a worker, and verifies the
    // reconstituted scrollback matches the concatenation.
    const dataDir = makeTempDataDir();
    const sessionId = crypto.randomUUID();
    const legacyChunks = ['LEG1-', 'LEG2-', 'LEG3'];
    const expected = legacyChunks.join('');

    // Seed sessions.json so the worker restores this session on startup.
    fs.writeFileSync(path.join(dataDir, 'sessions.json'),
      JSON.stringify([{
        id: sessionId, name: 'legacy-format', cwd: os.tmpdir(),
        autoCommand: '', claudeSessionId: null,
      }]));
    // Seed legacy-shape scrollback file.
    fs.writeFileSync(path.join(dataDir, 'scrollback', sessionId + '.json'),
      JSON.stringify(legacyChunks));

    const pipe = workerPipePath();
    // NOTE: don't set WT_WORKER_NO_DEFAULT=1 here because we want the
    // restore path to run. Actually the default-session flag only applies
    // when saved.length === 0, which it isn't here, so either setting is
    // fine. Keep WT_WORKER_NO_DEFAULT for consistency.
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      await new Promise(r => setTimeout(r, 500));

      const list = (await rpc(client, 'listSessions')).sessions;
      const restored = list.find(s => s.id === sessionId);
      expect(restored).toBeTruthy();

      const sb = (await rpc(client, 'getScrollback', { id: sessionId })).data;
      // The legacy chunks are present, in order, followed by the restart
      // banner and any shell startup output.
      expect(sb.startsWith(expected)).toBe(true);
      expect(sb.includes('--- server restarted ---')).toBe(true);

      // Chunk layout: after restore we have the legacy chunks as individual
      // entries (spread from loadScrollback), plus the banner, plus any
      // startup chunks from the spawned shell.
      const meta = await rpc(client, '__testScrollbackMeta', { id: sessionId });
      expect(meta.numChunks).toBeGreaterThanOrEqual(legacyChunks.length + 1);

      try { await rpc(client, 'killSession', { id: sessionId }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
