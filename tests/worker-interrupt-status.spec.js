// @ts-check
// #55 §6 — Esc interrupts a turn, so the session must go idle PROMPTLY.
//
// Claude Code fires no hook when a turn is interrupted (Stop does not run on a user
// interrupt), and the worker's status is otherwise driven entirely by hooks. So an
// interrupted session kept reporting "Claude is working" until correctStaleStatus rescued
// it — five minutes later, and only once both the hook clock and the output clock had gone
// quiet — while the terminal lens plainly showed an idle agent.
//
// The worker writes the Esc byte to the PTY itself, so it is the one component that can
// know. These tests drive the REAL worker over a real IPC pipe and send a REAL TYPE_PTY_IN
// frame — the same path a keypress in the browser or the companion takes.
//
// To watch them fail without the fix: set claude's `interrupt.onEscape` to false in
// lib/agents.js and re-run — the first test goes red (status stays 'working').

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agents = require('../lib/agents');

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

const ESC = '\x1b';
const typeInto = (client, id, text) => client.send(ipc.encodePtyIn(id, Buffer.from(text, 'latin1')));
const statusOf = async (client, id) => (await rpc(client, 'getSession', { id })).status;

test.describe('#55 §6 — Esc interrupt flips a working session to idle', () => {
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

  async function newSession(agent) {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: `s-${agent || 'shell'}`, agent });
    await sleep(150); // let the PTY settle
    return id;
  }

  /** Put the session in the state a real turn puts it in: Claude's own hook says 'working'. */
  async function startTurn(id) {
    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'do a thing' });
    expect(await statusOf(client, id)).toBe('working');
  }

  test('claude: Esc during a turn goes idle at once — no 5-minute wait', async () => {
    const id = await newSession('claude');
    await startTurn(id);

    typeInto(client, id, ESC);
    await sleep(120);

    expect(await statusOf(client, id)).toBe('idle');
  });

  test('claude: the Esc byte still reaches the PTY — the status flip does not swallow it', async () => {
    const id = await newSession('claude');
    await startTurn(id);
    await rpc(client, '__testGetWrites', { id }); // ignore the auto-command noise

    typeInto(client, id, ESC);
    await sleep(120);

    const { writes } = await rpc(client, '__testGetWrites', { id });
    const sent = writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('latin1')));
    expect(sent.join('')).toContain(ESC);
  });

  test('claude: an ARROW key is not an interrupt — a leading ESC is not the Esc key', async () => {
    const id = await newSession('claude');
    await startTurn(id);

    typeInto(client, id, `${ESC}[A`); // up arrow: ESC [ A, one frame
    await sleep(120);

    expect(await statusOf(client, id)).toBe('working');
  });

  test('claude: Esc at a permission prompt does NOT flip — that Esc rejects the tool', async () => {
    // 'waiting' means Claude is asking to run something. Esc there declines it and Claude
    // carries on; its next hook reports the truth. Reading that as "the agent stopped" would
    // flash a false idle (and, at notify level 'all', a false "Claude is done" push).
    const id = await newSession('claude');
    await rpc(client, 'hookEvent', { id, event: 'PermissionRequest' });
    expect(await statusOf(client, id)).toBe('waiting');

    typeInto(client, id, ESC);
    await sleep(120);

    expect(await statusOf(client, id)).toBe('waiting');
  });

  test('plain shell: Esc never touches status — it belongs to vim / less / a menu', async () => {
    const id = await newSession(null);
    const before = await statusOf(client, id);

    typeInto(client, id, ESC);
    await sleep(120);

    expect(await statusOf(client, id)).toBe(before);
  });

  test('claude: a normal keystroke is not an interrupt', async () => {
    const id = await newSession('claude');
    await startTurn(id);

    typeInto(client, id, 'x');
    await sleep(120);

    expect(await statusOf(client, id)).toBe('working');
  });

  test('claude: an Esc that lands MID-GAP reports idle only once the byte is delivered', async () => {
    // Status is read off the bytes at DELIVERY, not on arrival. A frame arriving while a
    // submit CR is withheld queues behind it (that is the ordering guarantee), so an Esc
    // sent in that window has NOT reached the PTY yet — and the withheld CR is still about
    // to submit. Flipping to idle on arrival would report an interrupt that had not happened.
    const id = await newSession('claude');
    const gap = agents.submitPolicy('claude').gapMs;
    await startTurn(id);

    typeInto(client, id, 'a follow-up prompt\r'); // arms the gap: text now, CR after `gap`
    await sleep(Math.max(15, gap / 5));
    typeInto(client, id, ESC);                    // lands mid-gap -> queued behind the CR

    // Still working: the Esc is queued, not delivered.
    await sleep(Math.max(15, gap / 5));
    expect(await statusOf(client, id)).toBe('working');

    // Once the gap elapses the CR goes out, the queue drains, the Esc lands — and only then
    // does the session report idle. Order on the PTY is preserved.
    await sleep(gap + 150);
    expect(await statusOf(client, id)).toBe('idle');

    const { writes } = await rpc(client, '__testGetWrites', { id });
    const sent = writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('latin1')));
    expect(sent.slice(-3)).toEqual(['a follow-up prompt', '\r', ESC]);
  });
});
