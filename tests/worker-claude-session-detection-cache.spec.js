// @ts-check
// Issue #16: cache Claude session-id detection result with mtime check.
//
// Before the fix, detectClaudeSessionIdFromDir(cwd) did a full readdir +
// per-file statSync of `~/.claude/projects/<encoded-cwd>` on every call.
// Callers include sessionSummary (every listSessions RPC + every event
// broadcast) and term.onExit cleanup — so with dozens of accumulated Claude
// .jsonl session logs, cost grew linearly with history depth on every tick.
//
// The fix: per-cwd cache keyed by the project dir's mtimeMs. A single
// fs.statSync of the dir is cheap; when mtime hasn't moved since the last
// lookup, reuse the cached sessionId. Creating/touching a .jsonl advances
// the parent dir's mtime on all major filesystems, so the cache invalidates
// naturally without any explicit signal.
//
// These tests verify:
//   1. First call does a readdir (cache miss).
//   2. Repeated calls with no file changes hit the cache (readdir count
//      stays flat).
//   3. Modifying the .jsonl's mtime (touch) — and therefore bumping the
//      parent dir's mtime — invalidates the cache; the next call re-reads.
//   4. Adding a newer .jsonl changes the detected session id.
//   5. A call against a cwd whose project dir doesn't exist returns null
//      and doesn't blow up; when the dir appears later, detection works.

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

// Use a cwd string the encoder will pass through cleanly on any platform.
// On Windows real cwds look like `C:\\dev\\foo`; on Linux like `/home/u/foo`.
// Either way the encoder just swaps separators to '-'. For deterministic
// test behavior we pick a Unix-style absolute path that works identically
// on both platforms.
function fakeCwd() {
  return '/tmp/wt-claude-' + crypto.randomUUID();
}

// Write a .jsonl "session log" into the encoded project dir and return
// its full path. Also returns the session id (derived from the filename).
function writeJsonl(claudeHome, cwd, contents = '{}\n') {
  const projectsDir = path.join(claudeHome, '.claude', 'projects');
  const projectDir = path.join(projectsDir, encodeProjectDirName(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(projectDir, id + '.jsonl');
  fs.writeFileSync(file, contents);
  return { id, file, projectDir };
}

test.describe('pty-worker Claude session-id detection cache (issue #16)', () => {
  test('repeated detection calls without file changes hit the cache', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);

      const cwd = fakeCwd();
      const { id } = writeJsonl(claudeHome, cwd);

      // Reset counters to ignore any readdirs done by worker startup paths.
      await rpc(client, '__testClaudeDetectCounters', { reset: true, clearCache: true });

      // First detection: cache miss, should readdir exactly once.
      let r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      expect(r.sessionId).toBe(id);

      let counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(1);

      // 50 more calls with no file changes — all should be cache hits.
      for (let i = 0; i < 50; i++) {
        r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
        expect(r.sessionId).toBe(id);
      }

      counters = await rpc(client, '__testClaudeDetectCounters', {});
      // Still only the one readdir from the initial miss.
      expect(counters.readdirCount).toBe(1);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test('mtime change invalidates the cache; detection picks up the newer session', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);

      const cwd = fakeCwd();
      const first = writeJsonl(claudeHome, cwd);

      await rpc(client, '__testClaudeDetectCounters', { reset: true, clearCache: true });

      // First call: miss → readdir → returns `first.id`.
      let r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      expect(r.sessionId).toBe(first.id);
      let counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(1);

      // Sleep past low-resolution filesystem mtime granularity.
      await new Promise(r2 => setTimeout(r2, 50));

      // Add a newer .jsonl — Claude writing a new session log. Writing into
      // the project dir advances its mtime on all major filesystems, so the
      // cache should invalidate on the next call.
      const second = writeJsonl(claudeHome, cwd);

      r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      // The newest .jsonl should win.
      expect(r.sessionId).toBe(second.id);
      counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(2);

      // Now stable again — repeated calls stay cache hits.
      for (let i = 0; i < 5; i++) {
        r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
        expect(r.sessionId).toBe(second.id);
      }
      counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(2);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test('missing project dir returns null and does not corrupt the cache', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);

      const cwd = fakeCwd(); // Note: we do NOT create a project dir for this cwd.

      await rpc(client, '__testClaudeDetectCounters', { reset: true, clearCache: true });

      // Dir missing → null, no readdir.
      let r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      expect(r.sessionId).toBeNull();

      // Several more calls — still null, still no readdir (stat-only fast path).
      for (let i = 0; i < 10; i++) {
        r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
        expect(r.sessionId).toBeNull();
      }
      let counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(0);

      // Create the dir and a .jsonl — detection must now pick it up on the
      // very next call. (We intentionally don't cache misses so this works
      // without any explicit invalidation.)
      const entry = writeJsonl(claudeHome, cwd);
      r = await rpc(client, '__testDetectClaudeSessionId', { cwd });
      expect(r.sessionId).toBe(entry.id);
      counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(1);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });

  test('different cwds have independent cache entries', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const claudeHome = makeTempClaudeHome();
    const worker = spawnWorker(pipe, dataDir, { WT_CLAUDE_HOME: claudeHome });
    try {
      const client = await connectClient(pipe);

      const cwdA = fakeCwd();
      const cwdB = fakeCwd();
      const a = writeJsonl(claudeHome, cwdA);
      const b = writeJsonl(claudeHome, cwdB);

      await rpc(client, '__testClaudeDetectCounters', { reset: true, clearCache: true });

      // First call per cwd → miss → readdir.
      let r = await rpc(client, '__testDetectClaudeSessionId', { cwd: cwdA });
      expect(r.sessionId).toBe(a.id);
      r = await rpc(client, '__testDetectClaudeSessionId', { cwd: cwdB });
      expect(r.sessionId).toBe(b.id);

      let counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(2);
      expect(counters.cacheSize).toBeGreaterThanOrEqual(2);

      // Further calls for both cwds stay cached.
      for (let i = 0; i < 10; i++) {
        r = await rpc(client, '__testDetectClaudeSessionId', { cwd: cwdA });
        expect(r.sessionId).toBe(a.id);
        r = await rpc(client, '__testDetectClaudeSessionId', { cwd: cwdB });
        expect(r.sessionId).toBe(b.id);
      }
      counters = await rpc(client, '__testClaudeDetectCounters', {});
      expect(counters.readdirCount).toBe(2);

      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
      rmRf(claudeHome);
    }
  });
});
