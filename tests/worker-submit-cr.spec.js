// @ts-check
// The Codex submit fix, driven through the REAL input path.
//
// A prompt sent from chat (or typed+Enter in one burst) reaches the worker as ONE
// TYPE_PTY_IN frame ending in CR. Codex's TUI folds a whole read into a paste, so that
// CR lands as a newline in its composer and the prompt is never submitted — the bug
// where a chat prompt sat there "Queued" forever. The worker must write the text now and
// the CR alone, submitGapMs later. Claude has no such detector and its clients rely on
// the frame staying atomic (#44), so a Claude session's bytes must pass through untouched.
//
// Timers run at their real length here (WT_API_ERROR_FAST off) so the gap is the gap the
// registry declares — that value is the thing under test.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agents = require('../lib/agents');

const GAP = agents.submitPolicy('codex').gapMs;

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

const typeInto = (client, id, text) => client.send(ipc.encodePtyIn(id, Buffer.from(text, 'utf8')));

test.describe('agent-aware submit CR on the PTY input path', () => {
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
    await sleep(150); // let the PTY settle before we watch its writes
    await rpc(client, '__testGetWrites', { id }); // sanity: session exists
    return id;
  }

  test('codex: `hello\\r` is delivered as text now, CR after the gap', async () => {
    const id = await newSession('codex');

    typeInto(client, id, 'hello\r');

    // Before the gap elapses the CR must NOT have been written — otherwise Codex's
    // paste-burst detector eats it and the prompt never submits.
    await sleep(Math.max(20, GAP / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['hello']);

    await sleep(GAP);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['hello', '\r']);
  });

  test('claude: the atomic frame passes through untouched (#44)', async () => {
    const id = await newSession('claude');

    typeInto(client, id, 'hello\r');
    await sleep(Math.max(40, GAP + 60));

    // One write, CR included. No splitting, no delay.
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['hello\r']);
  });

  test('plain shell (agent null): a single-line text+CR is never rewritten', async () => {
    const id = await newSession(null);

    typeInto(client, id, 'ls -la\r');
    await sleep(Math.max(40, GAP + 60));

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['ls -la\r']);
  });

  test('claude: a multi-line bracketed paste splits the final CR so it submits', async () => {
    const id = await newSession('claude');
    const ESC = String.fromCharCode(0x1b);
    const block = `${ESC}[200~line one\rline two${ESC}[201~`;
    const claudeGap = agents.submitPolicy('claude').gapMs;

    typeInto(client, id, block + '\r');

    // The paste block (close marker and all) is written at once; the CR is withheld —
    // a CR in the same read as the paste close is absorbed by Claude's TUI too.
    await sleep(Math.max(20, claudeGap / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block]);

    // After the gap the CR lands alone, and the prompt submits.
    await sleep(claudeGap);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block, '\r']);
  });

  test('codex: a bare CR is written immediately — nothing precedes it to be pasted', async () => {
    const id = await newSession('codex');

    typeInto(client, id, '\r');
    await sleep(Math.max(20, GAP / 4));

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['\r']);
  });

  test('codex: ordinary keystrokes are not delayed', async () => {
    const id = await newSession('codex');

    typeInto(client, id, 'a');
    typeInto(client, id, 'b');
    await sleep(Math.max(20, GAP / 4));

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['a', 'b']);
  });

  test('codex: input arriving during the gap queues behind the withheld CR', async () => {
    const id = await newSession('codex');

    typeInto(client, id, 'first\r');
    await sleep(Math.max(15, GAP / 6));
    typeInto(client, id, 'second');   // races the withheld CR — must NOT overtake it

    await sleep(GAP * 2);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['first', '\r', 'second']);
  });

  test('codex: two submits in a row keep their order, each with its own CR', async () => {
    const id = await newSession('codex');

    typeInto(client, id, 'one\r');
    typeInto(client, id, 'two\r');

    await sleep(GAP * 3 + 100);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['one', '\r', 'two', '\r']);
  });

  test('codex: multi-line bracketed paste keeps the block whole, delays only the final CR', async () => {
    const id = await newSession('codex');
    const ESC = String.fromCharCode(0x1b);
    const block = `${ESC}[200~line one\rline two${ESC}[201~`;

    typeInto(client, id, block + '\r');

    await sleep(Math.max(20, GAP / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block]);

    await sleep(GAP);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block, '\r']);
  });
});
