// @ts-check
// The auto-command (session restore) must reach the shell WHOLE.
//
// A freshly spawned shell can swallow the FIRST byte written to it as it finishes
// arming its terminal input (Windows ConPTY + MSYS bash, entering readline). After a
// COLD restart — where every session restores at once and the shell is slow to settle
// — the restore typed `claude --resume <id>` and bash received `laude --resume <id>`:
// "bash: laude: command not found", and the session came up dead.
//
// The worker therefore sends a throwaway PRIME (space + DEL — readline types it and
// erases it, so the line is left clean and no extra prompt is printed) BEFORE the real
// command. If a byte is eaten it is spent on the prime, and the command lands whole.
// This spec drives the real worker and asserts the exact bytes it writes to the PTY.

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

function spawnWorker(pipePath, dataDir) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
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

function rpc(client, method, params = {}, timeoutMs = 5000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('frame', onFrame); reject(new Error(`RPC ${method} timed out`)); }, timeoutMs);
    function onFrame(frame) {
      if (frame.type !== ipc.TYPE_JSON) return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      client.off('frame', onFrame);
      if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
    }
    client.on('frame', onFrame);
    client.send(ipc.encodeJson({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** __testGetWrites returns strings or JSON-encoded Buffers; normalise to strings. */
function writesOf(result) {
  return (result.writes || []).map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('utf8')));
}

const PRIME = ' \x7f'; // space + DEL — must match pty-worker's AUTO_CMD_PRIME

test.describe('auto-command reaches the shell whole (restore prime)', () => {
  let worker, client, dataDir, pipePath;

  test.beforeEach(async () => {
    pipePath = workerPipePath();
    dataDir = makeTempDataDir();
    worker = spawnWorker(pipePath, dataDir);
    client = await connectClient(pipePath);
  });

  test.afterEach(async () => {
    try { client.close(); } catch {}
    await worker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  /** Poll until the auto-command has been written (prompt-detect + settle + prime gap). */
  async function waitForAutoCommand(id, cmd, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let writes = [];
    while (Date.now() < deadline) {
      writes = writesOf(await rpc(client, '__testGetWrites', { id }));
      if (writes.some((w) => w.includes(cmd))) return writes;
      await sleep(150);
    }
    return writes;
  }

  test('the command is preceded by a throwaway prime, so a swallowed byte is not its first char', async () => {
    const cmd = 'echo hello-restore';
    const { id } = await rpc(client, 'createSession', {
      cwd: dataDir,
      name: 'restore-prime',
      autoCommand: cmd,
    });

    const writes = await waitForAutoCommand(id, cmd);

    // The command was typed, and it is INTACT — not missing its first character.
    const cmdWrite = writes.find((w) => w.includes(cmd));
    expect(cmdWrite, `auto-command never written; writes=${JSON.stringify(writes)}`).toBeTruthy();
    expect(cmdWrite).toBe(cmd + '\n');

    // A prime was written BEFORE it — that is the byte a re-arming tty eats, not the
    // `c` of `claude`.
    const primeIdx = writes.indexOf(PRIME);
    const cmdIdx = writes.indexOf(cmdWrite);
    expect(primeIdx, `no prime in writes=${JSON.stringify(writes)}`).toBeGreaterThanOrEqual(0);
    expect(primeIdx).toBeLessThan(cmdIdx);
  });

  test('the prime types-and-erases, so it cannot corrupt the command line', () => {
    // Space then DEL: readline inserts the space and immediately deletes it. If the
    // space is the byte that gets eaten, the lone DEL is a no-op on an empty line.
    expect(PRIME).toBe(' \x7f');
    expect(PRIME.length).toBe(2);
    expect(PRIME.charCodeAt(1)).toBe(0x7f);
  });

  test('a session with no auto-command writes nothing to the PTY', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'no-cmd', autoCommand: '' });
    await sleep(1500); // well past settle + prime

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([]);
  });
});
