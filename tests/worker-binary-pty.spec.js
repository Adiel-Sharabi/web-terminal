// @ts-check
// Issue #13: switch node-pty to binary mode (encoding: null) so term.onData
// emits Buffers, scrollback stores Buffers, and broadcastPtyOut no longer
// allocates a Buffer.from per subscriber.
//
// Windows caveat: node-pty's windowsPtyAgent.js hardcodes
// `_outSocket.setEncoding('utf8')` regardless of the `encoding` option, so on
// Windows term.onData still emits strings. The worker normalizes string→Buffer
// once in the onData handler so the rest of the pipeline (scrollback chunk
// list, broadcastPtyOut) operates on Buffers uniformly — tests below verify
// the uniform-Buffer invariant via the __testScrollbackChunkTypes test RPC.
//
// These tests cover:
//   1. After PTY output, scrollback chunks are Buffers (invariant) and
//      getScrollback returns matching bytes.
//   2. Non-UTF-8 byte injection: feeding raw bytes (0xFF 0xFE) does not crash,
//      concatScrollback survives, and the bytes are round-trippable via the
//      __testScrollbackBytesHex RPC.
//   3. Attach streaming end-to-end: PTY_OUT binary frames continue to deliver.
//   4. Persistence: save scrollback containing non-ASCII UTF-8 (emoji), reload
//      in a fresh worker, verify the content is recovered byte-for-byte.
//   5. broadcastPtyOut frame format: verify the outgoing PTY_OUT frame's
//      payload bytes exactly match the Buffer stored in scrollback (no
//      re-encoding / no Buffer.from dup allocation).

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

test.describe('pty-worker binary mode (issue #13)', () => {
  test('scrollback chunks are Buffers after PTY output', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'binary-chunks', autoCommand: '',
      });

      // Drive some PTY output via the shell so real onData chunks land in
      // scrollback. Wait for the marker to round-trip so we know onData has
      // fired at least once with real shell output.
      const marker = 'BIN_MARKER_' + crypto.randomUUID().slice(0, 8);
      await rpc(client, 'attachSession', { id });
      const clientBytes = Buffer.from(`echo ${marker}\r`);
      client.send(ipc.encodePtyIn(id, clientBytes));
      const chunks = await collectPtyOut(client, id, {
        stopWhen: (s) => s.includes(marker),
        timeoutMs: 10000,
      });
      expect(Buffer.concat(chunks).toString('utf8')).toContain(marker);

      // Invariant: every entry in scrollback.chunks is a Buffer.
      const meta = await rpc(client, '__testScrollbackChunkTypes', { id });
      expect(meta.allBuffers).toBe(true);
      expect(meta.numChunks).toBeGreaterThan(0);

      // getScrollback returns a string (for the IPC JSON envelope) and the
      // string must contain the marker.
      const sb = (await rpc(client, 'getScrollback', { id })).data;
      expect(sb).toContain(marker);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('non-UTF-8 byte injection does not crash and round-trips via hex', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'binary-nonutf8', autoCommand: '',
      });

      // Let any shell startup output settle so we can isolate our injected
      // bytes at the tail.
      await new Promise(r => setTimeout(r, 300));

      // 0xFF 0xFE is an invalid UTF-8 byte pair (0xFF is never valid UTF-8;
      // 0xFE is also not valid as a leading byte). Also include a stray
      // continuation byte (0x80) in isolation. concatScrollback must not
      // throw on these; UTF-8 decode will substitute replacement chars.
      const invalidHex = 'fffe80';
      const metaBefore = await rpc(client, '__testScrollbackBytesHex', { id });
      await rpc(client, '__testInjectScrollbackBytes', { id, hex: invalidHex });
      const metaAfter = await rpc(client, '__testScrollbackBytesHex', { id });
      expect(metaAfter.hex.endsWith(invalidHex)).toBe(true);
      expect(metaAfter.hex.length).toBe(metaBefore.hex.length + invalidHex.length);

      // getScrollback converts to UTF-8 — must not crash, result must include
      // the Unicode replacement char at the tail (U+FFFD, 3 bytes in UTF-8).
      const sb = (await rpc(client, 'getScrollback', { id })).data;
      // Replacement character U+FFFD — must appear at least once because our
      // invalid bytes got substituted. Don't assert exact count (Node's UTF-8
      // decoder may emit 1 or 3 replacements for 3 bad bytes depending on
      // how it groups them), just that the decode didn't throw and emitted
      // at least one.
      expect(sb).toContain('\uFFFD');

      // Worker is still alive — a follow-up RPC succeeds.
      const ping = await rpc(client, 'ping');
      expect(ping.ok).toBe(true);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('attach streaming end-to-end: PTY_OUT frames still deliver after binary switch', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'binary-stream', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      const marker = 'STREAM_' + crypto.randomUUID().slice(0, 8);
      client.send(ipc.encodePtyIn(id, Buffer.from(`echo ${marker}\r`)));
      const chunks = await collectPtyOut(client, id, {
        stopWhen: (s) => s.includes(marker),
        timeoutMs: 10000,
      });
      expect(chunks.length).toBeGreaterThan(0);
      const joined = Buffer.concat(chunks).toString('utf8');
      expect(joined).toContain(marker);

      // Each chunk must be a Buffer (not a string) since parsePtyFrame returns
      // the raw payload bytes.
      for (const c of chunks) {
        expect(Buffer.isBuffer(c)).toBe(true);
      }

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('persistence: save scrollback with non-ASCII UTF-8, reload, recover bytes', async () => {
    const pipe1 = workerPipePath();
    const dataDir = makeTempDataDir();
    let id;
    let preRestartHex;
    // Mix of ASCII, multi-byte UTF-8 emoji, and arabic to exercise the
    // UTF-8 encode/decode round-trip through Buffer.concat + toString('utf8').
    const PAYLOAD = '==PERSIST== \u{1F680} test \u0627\u062F\u064A\u0644 ==END==';

    const worker1 = spawnWorker(pipe1, dataDir);
    try {
      const client1 = await connectClient(pipe1);
      const created = await rpc(client1, 'createSession', {
        cwd: os.tmpdir(), name: 'persist-binary', autoCommand: '',
      });
      id = created.id;

      await new Promise(r => setTimeout(r, 300));

      // Inject via the Buffer-hex RPC to exercise the Buffer chunk path.
      const payloadBuf = Buffer.from(PAYLOAD, 'utf8');
      await rpc(client1, '__testInjectScrollbackBytes', { id, hex: payloadBuf.toString('hex') });

      preRestartHex = (await rpc(client1, '__testScrollbackBytesHex', { id })).hex;
      expect(preRestartHex.endsWith(payloadBuf.toString('hex'))).toBe(true);

      await rpc(client1, 'flushState');
      await client1.close();
    } finally {
      await worker1.stop();
    }

    // On-disk file is still a JSON array of strings (format is preserved for
    // backward compatibility with existing scrollback files on disk).
    const scrollbackFile = path.join(dataDir, 'scrollback', id + '.json');
    expect(fs.existsSync(scrollbackFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(scrollbackFile, 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBe(1);
    expect(raw[0]).toContain(PAYLOAD);

    // Restart worker with the same data dir — scrollback should reload as
    // Buffer chunks, and the hex round-trip must match pre-restart bytes as
    // a prefix (followed by the "--- server restarted ---" banner bytes).
    const pipe2 = workerPipePath();
    const worker2 = spawnWorker(pipe2, dataDir);
    try {
      const client2 = await connectClient(pipe2);
      await new Promise(r => setTimeout(r, 500));

      const list = (await rpc(client2, 'listSessions')).sessions;
      const restored = list.find(s => s.id === id);
      expect(restored).toBeTruthy();

      const postRestartHex = (await rpc(client2, '__testScrollbackBytesHex', { id })).hex;
      expect(postRestartHex.startsWith(preRestartHex)).toBe(true);

      // getScrollback (UTF-8) must still contain the PAYLOAD literally.
      const sb = (await rpc(client2, 'getScrollback', { id })).data;
      expect(sb).toContain(PAYLOAD);
      expect(sb).toContain('--- server restarted ---');

      // Invariant still holds: all chunks are Buffers post-reload.
      const meta = await rpc(client2, '__testScrollbackChunkTypes', { id });
      expect(meta.allBuffers).toBe(true);

      try { await rpc(client2, 'killSession', { id }); } catch {}
      await client2.close();
    } finally {
      await worker2.stop();
      rmRf(dataDir);
    }
  });

  test('PTY_OUT frame payload matches stored scrollback bytes (no re-encode)', async () => {
    // Verify the broadcastPtyOut path does not re-encode — the bytes received
    // on the IPC wire for a given PTY output chunk should be identical to
    // what lands in the scrollback chunk list.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'no-reencode', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      // Use a marker that's unlikely to collide with shell startup output.
      const marker = 'NOENC_' + crypto.randomUUID().slice(0, 12);
      client.send(ipc.encodePtyIn(id, Buffer.from(`printf %s ${marker}; echo\r`)));

      const chunks = await collectPtyOut(client, id, {
        stopWhen: (s) => s.includes(marker),
        timeoutMs: 10000,
      });
      const wireBytesHex = Buffer.concat(chunks).toString('hex');
      expect(wireBytesHex.length).toBeGreaterThan(0);

      // Wait for any trailing prompt bytes to settle so sbHex is stable.
      await new Promise(r => setTimeout(r, 150));

      const sbHex = (await rpc(client, '__testScrollbackBytesHex', { id })).hex;

      // scrollback must contain the full wire-byte stream as a substring.
      // (scrollback also contains earlier shell startup bytes that predate
      // our attach's first PTY_OUT, and possibly trailing prompt bytes after
      // our echo completes — hence substring, not equality.)
      expect(sbHex.includes(wireBytesHex)).toBe(true);

      try { await rpc(client, 'killSession', { id }); } catch {}
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
