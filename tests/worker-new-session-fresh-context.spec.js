// @ts-check
// Issue #23 (regression) — "New session in a folder unexpectedly resumes the
// last Claude session."
//
// A brand-new `claude` session opened in a folder that already holds older
// conversations was coming up attached to a *previous* conversation: before
// the new session had written its own .jsonl, the worker's cwd-newest-.jsonl
// detection adopted the older file's session id and stamped it onto the new
// session. That mislabeled id then auto-opened the Chat lens on the old
// transcript and drove the server's transcript-path derivation — the exact
// "loads previous session's context" symptom.
//
// The fix (ownClaudeSessionId in pty-worker.js) gates adoption on the
// session's start time: a .jsonl is only attributed to a session if it was
// written at/after that session started. Older conversations predate the new
// session, so they are ignored (→ start fresh); the session's own .jsonl,
// written after it starts, is still adopted.
//
// These tests exercise the gate deterministically via the __testOwnClaudeSessionId
// RPC — no real shell, no sleeps: we stat the fixture .jsonl for its real mtime
// and place the synthetic session's startedAt on either side of it.

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

function makeTempClaudeHome() {
  const dir = path.join(os.tmpdir(), 'wt-claude-home-' + crypto.randomUUID());
  fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
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

// Mirror of pty-worker.js's cwd -> project-dir-name encoding.
function encodeProjectDirName(cwd) {
  return cwd.replace(/^([A-Z]):\\/, '$1--').replace(/[\\/]/g, '-');
}

function fakeCwd() {
  return '/tmp/wt-claude-' + crypto.randomUUID();
}

// Write a .jsonl "session log" into the encoded project dir and return its
// path, its derived session id, and its real on-disk mtime (ms).
function writeJsonl(claudeHome, cwd, contents = '{}\n') {
  const projectsDir = path.join(claudeHome, '.claude', 'projects');
  const projectDir = path.join(projectsDir, encodeProjectDirName(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(projectDir, id + '.jsonl');
  fs.writeFileSync(file, contents);
  const mtimeMs = fs.statSync(file).mtimeMs;
  return { id, file, projectDir, mtimeMs };
}

test.describe('pty-worker new-session fresh context (issue #23)', () => {
  test('a new session in a folder with an OLDER conversation does NOT adopt it', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);
      const cwd = fakeCwd();

      // A previous conversation already lives in this cwd.
      const prev = writeJsonl(claudeHome, cwd);

      // The new session started AFTER that .jsonl was written.
      const startedAt = prev.mtimeMs + 5000;

      // Ungated detection still returns the old id (documents the raw signal).
      const raw = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      expect(raw.sessionId).toBe(prev.id);

      // Gated attribution must NOT adopt it — the session starts fresh.
      const own = await rpc(client, '__testOwnClaudeSessionId', {
        cwd, autoCommand: 'claude --dangerously-skip-permissions', startedAt,
      });
      expect(own.sessionId).toBeNull();

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test("a session DOES adopt a .jsonl written after it started (its own convo)", async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);
      const cwd = fakeCwd();

      const own = writeJsonl(claudeHome, cwd);
      // Session started BEFORE its claude wrote the .jsonl.
      const startedAt = own.mtimeMs - 5000;

      const r = await rpc(client, '__testOwnClaudeSessionId', {
        cwd, autoCommand: 'claude', startedAt,
      });
      expect(r.sessionId).toBe(own.id);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test('an explicit --resume <id> is always honored, gate notwithstanding', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);
      const cwd = fakeCwd();

      // An older conversation exists AND the session started after it — the
      // gate would drop dir-detection, but an explicit --resume wins.
      const prev = writeJsonl(claudeHome, cwd);
      const wanted = crypto.randomUUID();

      const r = await rpc(client, '__testOwnClaudeSessionId', {
        cwd,
        autoCommand: `claude --resume ${wanted}`,
        startedAt: prev.mtimeMs + 5000,
      });
      expect(r.sessionId).toBe(wanted);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test('an empty folder yields no id (fresh session)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);
      const cwd = fakeCwd(); // no project dir / no .jsonl

      const r = await rpc(client, '__testOwnClaudeSessionId', {
        cwd, autoCommand: 'claude', startedAt: 1,
      });
      expect(r.sessionId).toBeNull();

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });
});
