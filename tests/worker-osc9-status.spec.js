// @ts-check
// Codex status from OSC 9, driven through the REAL PTY-output path.
//
// Codex's hooks are unusable unattended (only `managed` hooks run; trust is bound to a
// sha256 of the hook definition; `codex exec` runs none), so a Codex session's status
// never left 'active' — no dot, no attention record, no push. Its TUI does write
// notifications into the PTY as OSC 9, and the worker already reads every byte.
//
// Bytes captured from a real codex-cli 0.144.0 session on 2026-07-21: an approval
// emitted `ESC]9;Codex wants to edit 0 files BEL` with the approval UI on screen.
//
// __testInjectOutput feeds processPtyOutput — the same function term.onData calls — so
// these specs exercise the shipped path, not a reimplementation of it.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

const IDLE_DEBOUNCE = 120; // WT_HOOK_STOP_DEBOUNCE_MS below
const OSC9 = (body) => `\x1b]9;${body}\x07`;
const APPROVAL = 'Codex wants to edit 0 files';

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-osc9-test-${crypto.randomUUID()}`
    : `/tmp/wt-osc9-test-${crypto.randomUUID()}.sock`;
}

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'wt-osc9-data-' + crypto.randomUUID());
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
      WT_HOOK_STOP_DEBOUNCE_MS: String(IDLE_DEBOUNCE),
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

test.describe('Codex status from OSC 9 in the PTY stream', () => {
  let worker, client, dataDir, pipePath, events;

  test.beforeEach(async () => {
    pipePath = workerPipePath();
    dataDir = makeTempDataDir();
    worker = spawnWorker(pipePath, dataDir);
    client = await connectClient(pipePath);
    events = [];
    client.on('frame', (frame) => {
      if (frame.type !== ipc.TYPE_JSON) return;
      try {
        const msg = JSON.parse(frame.payload.toString('utf8'));
        if (msg.event) events.push(msg);
      } catch {}
    });
  });

  test.afterEach(async () => {
    try { client.close(); } catch {}
    await worker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  async function newSession(agent) {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: `s-${agent || 'shell'}`, agent });
    await sleep(200); // let the PTY settle so shell banner output is out of the way
    return id;
  }

  const inject = (id, data) => rpc(client, '__testInjectOutput', { id, data });
  const summaryOf = async (id) =>
    (await rpc(client, 'listSessions')).sessions.find((s) => s.id === id);
  const statusEvents = () => events.filter((e) => e.event === 'statusChanged');

  test('an approval notification puts the session in waiting', async () => {
    const id = await newSession('codex');
    await inject(id, OSC9(APPROVAL));
    await sleep(60);

    expect((await summaryOf(id)).status).toBe('waiting');
    const ev = statusEvents().pop();
    expect(ev.params.status).toBe('waiting');
    expect(ev.params.notifyType).toBe('approval_needed');
  });

  test('the approval push names the right agent, not Claude', async () => {
    // This event now reaches the phone for Codex too; "Claude needs your approval"
    // on a Codex session sends the user to the wrong place.
    const id = await newSession('codex');
    await inject(id, OSC9(APPROVAL));
    await sleep(60);

    const ev = statusEvents().pop();
    expect(ev.params.notifyMsg).toContain('Codex');
    expect(ev.params.notifyMsg).not.toContain('Claude');
  });

  test('a turn-complete notification settles the session to idle', async () => {
    const id = await newSession('codex');
    await inject(id, OSC9(APPROVAL));      // waiting first, so idle is a real change
    await sleep(60);
    await inject(id, OSC9('All done — I updated two files.'));
    await sleep(IDLE_DEBOUNCE + 150);      // idle goes through the shared debounce

    expect((await summaryOf(id)).status).toBe('idle');
  });

  test('a notification split across two chunks still lands', async () => {
    // PTY reads split wherever the OS decides; a notification fires exactly once, so
    // a split one that is dropped is a status that never updates.
    const id = await newSession('codex');
    const whole = OSC9(APPROVAL);
    await inject(id, whole.slice(0, 9));
    await sleep(30);
    expect((await summaryOf(id)).status).not.toBe('waiting');

    await inject(id, whole.slice(9));
    await sleep(60);
    expect((await summaryOf(id)).status).toBe('waiting');
  });

  test('OSC 9 does NOT set hookStatus — Claude`s API-error recovery stays off', async () => {
    // The trap this pins: isClaudeSession() treats hookStatus as proof the session is
    // Claude, and that gates the API-error sniff whose recovery TYPES into the PTY
    // ("continue", then "/compact" plus a replay). Arming that on a Codex session
    // would have it typing Claude's recovery into Codex's composer.
    const id = await newSession('codex');
    await inject(id, OSC9(APPROVAL));
    await sleep(60);

    const s = await summaryOf(id);
    expect(s.status).toBe('waiting');       // the status DID update...
    expect(s.hookStatus).toBe(false);       // ...without claiming to be hook-driven
  });

  test('a Claude session ignores OSC 9 — it is hook-driven', async () => {
    // Claude's status comes from hooks. Reading its output as well would double-drive
    // it, and any OSC 9 its TUI emits would fight the hook stream.
    const id = await newSession('claude');
    const before = (await summaryOf(id)).status;
    await inject(id, OSC9(APPROVAL));
    await sleep(80);

    expect((await summaryOf(id)).status).toBe(before);
  });

  test('a plain shell ignores OSC 9 — anything can print an escape sequence', async () => {
    // The load-bearing default. OSC 9 is a general terminal notification: vim, a build
    // script or a stray printf can emit one, and none of them is an agent.
    const id = await newSession(null);
    const before = (await summaryOf(id)).status;
    await inject(id, OSC9(APPROVAL));
    await sleep(80);

    expect((await summaryOf(id)).status).toBe(before);
  });

  test('ordinary output never moves the status', async () => {
    const id = await newSession('codex');
    const before = (await summaryOf(id)).status;
    await inject(id, 'building...\r\n\x1b]0;some-title\x07done\r\n');
    await sleep(80);

    expect((await summaryOf(id)).status).toBe(before);
  });
});
