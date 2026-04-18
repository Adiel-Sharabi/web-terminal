// @ts-check
// Phase 3: Session management RPCs via worker
//
// These tests spawn pty-worker.js as a child process with an isolated pipe path
// and a temp directory for sessions.json/scrollback/. They verify the session
// management surface that server.js will use over IPC.

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

/** Spawn pty-worker.js with an isolated pipe + data dir. Returns { proc, stop() }. */
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
      // Failsafe — force-kill after 3s if still alive
      setTimeout(() => { if (!exited) { try { proc.kill('SIGKILL'); } catch {} resolve(); } }, 3000);
    }),
  };
}

/** Connect an IPC client to the worker with a reasonable wait. */
async function connectClient(pipePath, timeoutMs = 5000) {
  const client = ipc.createClient(pipePath, { retry: true, retryDelayMs: 100 });
  await Promise.race([
    client.connected(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('worker never ready')), timeoutMs)),
  ]);
  return client;
}

/** Send a JSON RPC request, return the response result. */
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

/** Collect events from the worker for a period of time. */
function collectEvents(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('frame', onFrame);
      reject(new Error(`timed out waiting for event`));
    }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.event && predicate(msg)) {
        clearTimeout(timer);
        client.off('frame', onFrame);
        resolve(msg);
      }
    }
    client.on('frame', onFrame);
  });
}

test.describe('pty-worker session RPCs', () => {
  test('createSession returns {id,name}; listSessions shows it', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id, name } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'test-create', autoCommand: '',
      });
      expect(id).toBeTruthy();
      expect(name).toBe('test-create');

      const { sessions } = await rpc(client, 'listSessions');
      expect(Array.isArray(sessions)).toBe(true);
      const found = sessions.find(s => s.id === id);
      expect(found).toBeTruthy();
      expect(found.name).toBe('test-create');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('getScrollback eventually shows shell output', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'test-scrollback', autoCommand: '',
      });

      // Poll scrollback until it contains something (shell prompt).
      let sawOutput = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const { data } = await rpc(client, 'getScrollback', { id, limit: 1024 * 1024 });
        if (data && data.length > 0) {
          sawOutput = true;
          break;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      expect(sawOutput).toBe(true);

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('renameSession changes name', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'original', autoCommand: '',
      });

      await rpc(client, 'renameSession', { id, name: 'renamed' });
      const { sessions } = await rpc(client, 'listSessions');
      const found = sessions.find(s => s.id === id);
      expect(found.name).toBe('renamed');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('updateSessionAutoCommand updates autoCommand', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'auto-cmd', autoCommand: 'initial',
      });

      const { autoCommand } = await rpc(client, 'updateSessionAutoCommand', {
        id, autoCommand: 'updated-cmd',
      });
      expect(autoCommand).toBe('updated-cmd');

      const { sessions } = await rpc(client, 'listSessions');
      const found = sessions.find(s => s.id === id);
      expect(found.autoCommand).toBe('updated-cmd');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('killSession removes session from list', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'to-kill', autoCommand: '',
      });

      await rpc(client, 'killSession', { id });

      // Poll briefly — worker may clean up asynchronously via term.onExit.
      let stillPresent = true;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { sessions } = await rpc(client, 'listSessions');
        if (!sessions.find(s => s.id === id)) { stillPresent = false; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      expect(stillPresent).toBe(false);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('hookEvent UserPromptSubmit sets status to working', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'hook-work', autoCommand: '',
      });

      const { status } = await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      expect(status).toBe('working');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('hookEvent Stop sets status to idle', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir);
    try {
      const client = await connectClient(pipe);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'hook-stop', autoCommand: '',
      });

      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      const { status } = await rpc(client, 'hookEvent', { id, event: 'Stop' });
      expect(status).toBe('idle');

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('session configs persist across worker restarts', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();

    // First worker: create a session and gracefully shut down so sessions.json is saved.
    let worker = spawnWorker(pipe, dataDir);
    let client = await connectClient(pipe);
    const { id } = await rpc(client, 'createSession', {
      cwd: os.tmpdir(), name: 'persist-me', autoCommand: '',
    });
    // Flush state so sessions.json is written even if Windows kill skips handlers.
    await rpc(client, 'flushState');
    await client.close();
    await worker.stop();

    // sessions.json should exist in the data dir with our session
    const sessionsFile = path.join(dataDir, 'sessions.json');
    expect(fs.existsSync(sessionsFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    expect(saved.find(s => s.id === id)).toBeTruthy();

    // Second worker: should restore the session automatically on startup.
    const pipe2 = workerPipePath();
    worker = spawnWorker(pipe2, dataDir);
    try {
      client = await connectClient(pipe2);
      // Give it a moment to restore
      let restored = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { sessions } = await rpc(client, 'listSessions');
        if (sessions.find(s => s.id === id && s.name === 'persist-me')) { restored = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      expect(restored).toBe(true);

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('scrollback persists across worker restarts', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();

    let worker = spawnWorker(pipe, dataDir);
    let client = await connectClient(pipe);
    const { id } = await rpc(client, 'createSession', {
      cwd: os.tmpdir(), name: 'scrollback-persist', autoCommand: '',
    });

    // Wait for shell to emit some output so there's something in the scrollback.
    const deadline1 = Date.now() + 10000;
    let baseline = '';
    while (Date.now() < deadline1) {
      const { data } = await rpc(client, 'getScrollback', { id, limit: 1024 * 1024 });
      if (data && data.length > 50) { baseline = data; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(baseline.length).toBeGreaterThan(0);

    // Flush state to disk before shutting down — on Windows, proc.kill is synchronous
    // and doesn't let signal handlers run.
    await rpc(client, 'flushState');

    await client.close();
    await worker.stop();

    // Scrollback file should exist
    const sbFile = path.join(dataDir, 'scrollback', id + '.json');
    expect(fs.existsSync(sbFile)).toBe(true);

    // Restart worker on a fresh pipe, confirm the session's scrollback was preserved.
    const pipe2 = workerPipePath();
    worker = spawnWorker(pipe2, dataDir);
    try {
      client = await connectClient(pipe2);
      let restoredData = '';
      const deadline2 = Date.now() + 5000;
      while (Date.now() < deadline2) {
        const { sessions } = await rpc(client, 'listSessions');
        if (sessions.find(s => s.id === id)) {
          const { data } = await rpc(client, 'getScrollback', { id, limit: 1024 * 1024 });
          if (data && data.length > 0) { restoredData = data; break; }
        }
        await new Promise(r => setTimeout(r, 100));
      }
      expect(restoredData.length).toBeGreaterThan(0);

      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
