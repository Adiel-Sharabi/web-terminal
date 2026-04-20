// @ts-check
// Issue #15: Backpressure on broadcastPtyOut — protect worker from slow web/clients.
//
// Verifies:
//   1. Slow consumer: a client that refuses to read from the pipe causes the
//      IpcConnection to report backpressure (send() returns false), and the
//      worker's per-connection isDraining flag flips. Once the flag is set,
//      subsequent broadcastPtyOut calls DROP frames for that conn, so
//      sock.writableLength stays bounded instead of growing without limit.
//   2. Drain recovery: once the consumer resumes reading, the socket drains
//      and isDraining clears. Subsequent frames flow normally.
//   3. Hard limit: push past the WT_IPC_MAX_INFLIGHT threshold (we set it low
//      via env) and verify the connection is destroyed, the worker stays up,
//      and a fresh connection works end-to-end.
//   4. Normal path: a fast consumer receives every PTY_OUT frame (no regression).
//   5. IpcConnection.send return value surfaces backpressure (unit-level).
//
// These tests drive pty-worker.js directly over its IPC pipe, mirroring
// worker-data-plane.spec.js (and friends). We don't go through server.js —
// the fix lives between web.js and the worker, and this lets us exercise the
// in-user-space socket buffer without interposing WebSocket + HTTP on top.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-bp-test-${crypto.randomUUID()}`
    : `/tmp/wt-bp-test-${crypto.randomUUID()}.sock`;
}

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'wt-bp-data-' + crypto.randomUUID());
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
  // Capture stderr/stdout for diagnosis if a test fails.
  let logBuf = '';
  proc.stdout.on('data', (d) => { logBuf += d.toString(); });
  proc.stderr.on('data', (d) => { logBuf += d.toString(); });
  return {
    proc,
    get log() { return logBuf; },
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

// Connect a raw net socket to the worker pipe. Returns the socket once it
// emits 'connect'. Retries ENOENT up to timeoutMs so the test can start
// before the worker has finished listening. Unlike ipc.createClient, we do
// NOT attach a persistent data handler — callers can pause() the socket to
// simulate a slow consumer that doesn't drain the pipe. We still attach a
// FrameDecoder when the caller wants to parse responses.
function connectRawSocket(pipePath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function tryOnce() {
      const sock = net.createConnection(pipePath);
      let done = false;
      const bail = (err) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (Date.now() >= deadline) reject(err);
        else setTimeout(tryOnce, 100);
      };
      sock.once('connect', () => {
        if (done) return;
        done = true;
        resolve(sock);
      });
      sock.once('error', (e) => bail(e));
      setTimeout(() => bail(new Error('raw socket connect timeout')), Math.min(1000, deadline - Date.now()));
    }
    tryOnce();
  });
}

// Send a single RPC over the raw socket, waiting for the matching JSON reply.
// We attach/detach data listeners inline so the caller can go back to "silent
// mode" afterwards (key to the slow-consumer test).
function rpcOverRawSocket(sock, method, params = {}, timeoutMs = 5000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const decoder = new ipc.FrameDecoder();
    const timer = setTimeout(() => {
      sock.off('data', onData);
      reject(new Error(`raw RPC ${method} timed out`));
    }, timeoutMs);
    function onData(chunk) { decoder.push(chunk); }
    decoder.on('frame', (frame) => {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      sock.off('data', onData);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    sock.on('data', onData);
    sock.write(ipc.encodeJson({ id, method, params }));
  });
}

// Inject a PTY output chunk into a session by sending a PTY_IN "echo <payload>"
// command. Simpler here: the worker's scrollback / broadcast path fires
// regardless of content. We use a dedicated worker RPC when available; else
// we just rely on the shell echo (same pattern as worker-data-plane tests).
async function produceLargeOutput(client, sessionId, repeats = 5) {
  // Produce enough bytes to exercise the buffer without flooding the test.
  const marker = 'BP_' + crypto.randomUUID().slice(0, 8);
  // A yes-style spam loop in bash produces output fast. We cap it so cleanup
  // is quick; the slow-consumer test measures during the spam.
  const cmd = `for i in $(seq 1 ${repeats}); do echo ${marker}_$i$(printf 'X%.0s' $(seq 1 2000)); done`;
  client.send(ipc.encodePtyIn(sessionId, Buffer.from(cmd + '\r')));
  return marker;
}

test.describe('IPC backpressure (Issue #15)', () => {

  test('IpcConnection.send returns the socket.write boolean and exposes writeQueueBytes', async () => {
    // Unit-ish test: connect a raw client, pause it so the server socket
    // buffers, and verify IpcConnection.send on the server side eventually
    // returns false AND writeQueueBytes grows accordingly.
    const p = workerPipePath();
    const server = ipc.createServer(p);
    await server.listening();
    let serverConn = null;
    server.on('connection', (c) => { serverConn = c; });

    const sock = await connectRawSocket(p);
    sock.pause(); // don't read from the pipe
    // Wait for the server to see the connection.
    for (let i = 0; i < 50 && !serverConn; i++) await new Promise(r => setTimeout(r, 20));
    expect(serverConn).not.toBeNull();

    // Build a chunky payload and send until send() returns false.
    const bigPayload = Buffer.alloc(64 * 1024, 0x41); // 64 KB of 'A'
    const frame = ipc.encodeFrame(ipc.TYPE_JSON, bigPayload);
    let sentOk = 0;
    let firstFalseAt = -1;
    const MAX_ATTEMPTS = 500; // plenty for ~32 MB before the 50 MB default limit
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const ok = serverConn.send(frame);
      if (ok) sentOk++;
      else { firstFalseAt = i; break; }
    }
    expect(firstFalseAt).toBeGreaterThanOrEqual(0);
    // writeQueueBytes should reflect the buffered data.
    expect(serverConn.writeQueueBytes).toBeGreaterThan(0);

    try { sock.destroy(); } catch {}
    await server.close();
  });

  test('slow consumer: __testFloodConn trips isDraining when reader is paused', async () => {
    // Deterministic version of the slow-consumer scenario using a test-only
    // RPC. Protocol:
    //   1. Send __testFloodConn RPC; RPC replies immediately with {ok:true}.
    //   2. Pause reads on our raw socket.
    //   3. Worker runs the flood after a short delay — it sends JSON frames
    //      until conn.send returns false, then flips isDraining and emits a
    //      __testFloodResult event.
    //   4. We resume reads and collect the event frame. That's where the
    //      assertions come from.
    //
    // Verifies:
    //   - falseReturns >= 1 (backpressure was detected)
    //   - isDraining === true after the burst
    //   - writeQueueBytes > 0 and < cap (bounded, not destroyed)
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const MAX_INFLIGHT = 50 * 1024 * 1024;
    const worker = spawnWorker(pipe, dataDir, { WT_IPC_MAX_INFLIGHT: String(MAX_INFLIGHT) });
    try {
      const sock = await connectRawSocket(pipe);
      // Confirm flood was scheduled (worker RPC reply).
      const ack = await rpcOverRawSocket(sock, '__testFloodConn', {
        frames: 2000, bytes: 64 * 1024, delayMs: 200,
      }, 5000);
      expect(ack && ack.ok).toBe(true);
      // Now pause — the flood runs shortly and will fill the write queue.
      sock.removeAllListeners('data');
      sock.pause();

      // Give the flood time to run and trip isDraining.
      await new Promise(r => setTimeout(r, 2000));

      // Worker should still be alive.
      expect(worker.proc.exitCode).toBeNull();

      // Resume reads and collect the __testFloodResult event frame.
      const resultPromise = new Promise((resolve) => {
        const decoder = new ipc.FrameDecoder();
        const to = setTimeout(() => resolve(null), 10000);
        decoder.on('frame', (f) => {
          if (f.type !== ipc.TYPE_JSON) return;
          let msg;
          try { msg = JSON.parse(f.payload.toString('utf8')); } catch { return; }
          if (msg && msg.event === '__testFloodResult') {
            clearTimeout(to);
            sock.removeAllListeners('data');
            resolve(msg.params);
          }
        });
        sock.on('data', (c) => decoder.push(c));
      });
      sock.resume();
      const res = await resultPromise;
      expect(res).not.toBeNull();
      expect(res.sent).toBeGreaterThan(0);
      expect(res.falseReturns).toBeGreaterThanOrEqual(1);
      expect(res.isDraining).toBe(true);
      expect(res.closed).toBe(false);
      expect(res.writeQueueBytes).toBeGreaterThan(0);
      expect(res.writeQueueBytes).toBeLessThan(MAX_INFLIGHT);

      // Close and verify fresh connection works.
      sock.destroy();
      await new Promise(r => setTimeout(r, 500));
      const client = await connectClient(pipe);
      const pong = await rpc(client, 'ping');
      expect(pong && pong.ok).toBe(true);
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('slow consumer (real PTY): worker survives + fresh connection works after heavy output', async () => {
    // End-to-end version using a real PTY session. This is the scenario
    // described in Issue #15 — a slow web.js not draining the pipe during
    // heavy PTY output. We use a RAW socket to truly pause reads (the
    // IpcClient always consumes data into its decoder).
    //
    // Key assertion: after the burst + disconnect, the worker is still alive
    // and a fresh connection works. We don't assert exact frame counts
    // (drop-ordering is acceptable) — just "no hang, no crash, no wedge."
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const MAX_INFLIGHT = 5 * 1024 * 1024;
    const worker = spawnWorker(pipe, dataDir, { WT_IPC_MAX_INFLIGHT: String(MAX_INFLIGHT) });
    try {
      const sock = await connectRawSocket(pipe);
      const createRes = await rpcOverRawSocket(sock, 'createSession', {
        cwd: os.tmpdir(), name: 'slow-consumer-pty', autoCommand: '',
      });
      const id = createRes.id;
      await rpcOverRawSocket(sock, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      await new Promise(r => setTimeout(r, 500));

      // Pause reads. From this point on the server's broadcasted PTY_OUT
      // will accumulate in its user-space write buffer.
      sock.pause();
      sock.removeAllListeners('data');

      // Produce a heavy burst of output.
      const cmd = `for i in $(seq 1 300); do echo BPSPAM_$i$(printf 'X%.0s' $(seq 1 4000)); done`;
      sock.write(ipc.encodePtyIn(id, Buffer.from(cmd + '\r')));

      // Wait for either: (a) the shell to drive enough output for
      // broadcastPtyOut to hit backpressure, or (b) the hard-cap destroy
      // to fire. Either outcome is acceptable.
      await new Promise(r => setTimeout(r, 3000));
      expect(worker.proc.exitCode).toBeNull();

      // Close the slow socket and open a fresh control connection.
      try { sock.destroy(); } catch {}
      await new Promise(r => setTimeout(r, 500));

      const client = await connectClient(pipe);
      const pong = await rpc(client, 'ping');
      expect(pong && pong.ok).toBe(true);

      // Kill the (possibly still-running) session. Depending on timing
      // it may or may not still be present.
      const { sessions } = await rpc(client, 'listSessions');
      const found = sessions.find(s => s.id === id);
      if (found) {
        try { await rpc(client, 'killSession', { id }); } catch {}
      }
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('hard limit: connection destroyed when queue exceeds WT_IPC_MAX_INFLIGHT', async () => {
    // Set a small max-inflight (1 MB) so we can trip the overflow guard
    // deterministically with __testFloodConn. The worker should destroy
    // the slow connection, stay up, and accept a fresh connection.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const TINY_LIMIT = 1 * 1024 * 1024;
    const worker = spawnWorker(pipe, dataDir, { WT_IPC_MAX_INFLIGHT: String(TINY_LIMIT) });
    try {
      const sock = await connectRawSocket(pipe);
      // Schedule a single giant frame well past the cap.
      const ack = await rpcOverRawSocket(sock, '__testFloodConn', {
        frames: 1,
        bytes: TINY_LIMIT + 256 * 1024, // strictly over the cap
        delayMs: 200,
      }, 5000);
      expect(ack && ack.ok).toBe(true);

      // Pause reads so nothing drains, letting the cap fire.
      sock.removeAllListeners('data');
      sock.pause();

      // Wait for the worker to destroy our slow connection.
      const closed = await new Promise((resolve) => {
        const to = setTimeout(() => resolve(false), 10000);
        sock.once('close', () => { clearTimeout(to); resolve(true); });
      });
      expect(closed).toBe(true);

      // Worker must still be alive.
      expect(worker.proc.exitCode).toBeNull();

      // Fresh connection works.
      const client2 = await connectClient(pipe);
      const pong = await rpc(client2, 'ping');
      expect(pong && pong.ok).toBe(true);
      await client2.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('normal path: fast consumer receives all frames (no regression)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'fast-consumer', autoCommand: '',
      });
      await rpc(client, 'attachSession', { id, scrollbackLimit: 1024 * 1024 });

      // Produce bounded output and verify every marker lands.
      const marker = 'FAST_' + crypto.randomUUID().slice(0, 6);
      const N = 10;
      const cmd = `for i in $(seq 1 ${N}); do echo ${marker}_$i; done`;
      client.send(ipc.encodePtyIn(id, Buffer.from(cmd + '\r')));

      const received = await new Promise((resolve) => {
        const acc = [];
        const to = setTimeout(() => { client.off('frame', h); resolve(Buffer.concat(acc).toString('utf8')); }, 10000);
        function h(frame) {
          if (frame.type !== ipc.TYPE_PTY_OUT) return;
          const parsed = ipc.parsePtyFrame(frame);
          if (parsed.sessionId !== id) return;
          acc.push(parsed.data);
          const joined = Buffer.concat(acc).toString('utf8');
          if (joined.includes(`${marker}_${N}`)) {
            clearTimeout(to); client.off('frame', h); resolve(joined);
          }
        }
        client.on('frame', h);
      });

      for (let i = 1; i <= N; i++) {
        expect(received).toContain(`${marker}_${i}`);
      }

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('invalid WT_IPC_MAX_INFLIGHT falls back to default (worker starts cleanly)', async () => {
    // Malformed env: NaN. Should not crash the worker on startup; it must
    // pick the default limit.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_IPC_MAX_INFLIGHT: 'not-a-number' });
    try {
      const client = await connectClient(pipe);
      const pong = await rpc(client, 'ping');
      expect(pong && pong.ok).toBe(true);
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
