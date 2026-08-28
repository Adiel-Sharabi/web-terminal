// @ts-check
// #179 — a submit that never reached the agent, driven through the REAL worker.
//
// The bug: the compose bar submits into whatever the TUI is showing. When that is not a
// composer (`/usage`, a slash menu, a permission prompt, a crashed TUI back at bash) the
// bytes are swallowed as navigation and the user's words are gone with no error
// anywhere. Measured on claude 2.1.250 — see scripts/rig/probe-altscreen-block.js — and
// the same measurement is why there is no "blocked" detector to test here: not one
// blocking state emitted a distinguishing byte, so the worker verifies the OUTCOME
// instead. This spec pins that verification.
//
// Driven the way CLAUDE.md requires: a real pty-worker.js on an isolated pipe, real
// TYPE_PTY_IN frames, real hookEvent RPCs. `__testGetWrites` proves the bytes reached
// the PTY; the broadcast frames prove what the worker concluded about them.
//
// WT_SUBMIT_CONFIRM_MS shortens the window so the timeout can be observed without
// waiting out the registry's real value (which stays the SSOT — see lib/agents.js).

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agents = require('../lib/agents');

const CONFIRM_MS = 700;          // the shortened window this worker runs with
const CLAUDE_GAP = agents.submitPolicy('claude').gapMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      WT_SUBMIT_CONFIRM_MS: String(CONFIRM_MS),
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

/** Collect every broadcast event the worker emits, so a test can assert on absence too. */
function collectEvents(client) {
  const seen = [];
  client.on('frame', (frame) => {
    if (frame.type !== ipc.TYPE_JSON) return;
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
    if (msg && msg.event) seen.push(msg);
  });
  return {
    unconfirmed: (id) => seen.filter((m) => m.event === 'submitUnconfirmed' && m.params && m.params.id === id),
  };
}

const typeInto = (client, id, text) => client.send(ipc.encodePtyIn(id, Buffer.from(text, 'utf8')));

test.describe('#179 — the worker reports a submit that produced no agent activity', () => {
  let worker, client, dataDir, pipePath, events;

  test.beforeEach(async () => {
    pipePath = workerPipePath();
    dataDir = makeTempDataDir();
    worker = spawnWorker(pipePath, dataDir);
    client = await connectClient(pipePath);
    events = collectEvents(client);
  });

  test.afterEach(async () => {
    try { client.close(); } catch {}
    await worker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  /**
   * A Claude session that has proved its hooks reach us. `hookStatus` is the gate that
   * keeps a box without hooks installed silent, so every watched case must set it the
   * way production does — by actually delivering a hook.
   */
  async function hookedClaudeSession(name) {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name, agent: 'claude' });
    await sleep(150);
    await rpc(client, 'hookEvent', { id, event: 'Stop' });   // idle, and hookStatus now true
    return id;
  }

  test('THE BUG: a prompt that starts no turn is reported, with the bytes proven sent', async () => {
    const id = await hookedClaudeSession('blocked');

    typeInto(client, id, 'this prompt lands in /usage and is never seen again\r');

    // The submit really did reach the PTY — this is not a write that failed.
    await sleep(CLAUDE_GAP + 150);
    const writes = (await rpc(client, '__testGetWrites', { id })).writes || [];
    const text = writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('utf8'))).join('');
    expect(text).toContain('never seen again');
    expect(text.endsWith('\r')).toBe(true);

    // ...and nothing came back from the agent, so the worker says so.
    expect(events.unconfirmed(id)).toHaveLength(0);   // not yet — the window is still open
    await sleep(CONFIRM_MS + 400);
    const fired = events.unconfirmed(id);
    expect(fired).toHaveLength(1);
    expect(fired[0].params.at).toBeGreaterThan(0);
  });

  test('a hook arriving inside the window confirms the submit — nothing is reported', async () => {
    // The everyday case. Any hook will do: what is being separated is "the agent is
    // doing something" from "the TUI ate the keystrokes".
    const id = await hookedClaudeSession('confirmed');

    typeInto(client, id, 'a prompt the agent actually takes\r');
    await sleep(CLAUDE_GAP + 100);
    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'a prompt the agent actually takes' });

    await sleep(CONFIRM_MS + 400);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a session that has never delivered a hook is never watched', async () => {
    // Without this gate every submit on a box where hooks are not installed would be
    // reported as lost — noise exactly where the worker can prove nothing.
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'no-hooks', agent: 'claude' });
    await sleep(150);

    typeInto(client, id, 'a prompt on a session with no hook history\r');
    await sleep(CLAUDE_GAP + CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a slash command is never reported — /usage legitimately starts no turn', async () => {
    const id = await hookedClaudeSession('slash');

    typeInto(client, id, '/usage\r');
    await sleep(CLAUDE_GAP + CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a slash command STREAMED one character at a time is never reported either', async () => {
    // The compose bar streams a live `/`-line so the agent's slash menu narrows (#55),
    // which leaves the submit frame a BARE CR with no text in it. Reading the frame
    // alone would fire the notice on every /usage.
    const id = await hookedClaudeSession('slash-streamed');

    for (const c of '/config') typeInto(client, id, c);
    await sleep(120);
    typeInto(client, id, '\r');

    await sleep(CLAUDE_GAP + CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a plain shell is never watched — no provider, no claim', async () => {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'shell' });
    await sleep(150);
    await rpc(client, 'hookEvent', { id, event: 'Stop' });

    typeInto(client, id, 'echo hello\r');
    await sleep(CONFIRM_MS + 600);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a CODEX session is never watched — it declares no confirmation channel', async () => {
    // OSC 9 cannot produce a turn-start signal by construction (CLAUDE.md), so there is
    // nothing for a Codex submit to be confirmed BY. Undeclared means unchanged.
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: 'codex', agent: 'codex' });
    await sleep(150);
    await rpc(client, 'hookEvent', { id, event: 'Stop' });

    typeInto(client, id, 'a codex prompt\r');
    await sleep(agents.submitPolicy('codex').gapMs + CONFIRM_MS + 600);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('a session mid-COMPACTION is never watched', async () => {
    // Found in review, and invisible to the `working` gate: #129 measured that Claude
    // reports IDLE part-way through a /compact, so the session looks perfectly ordinary
    // while no hook can arrive for as long as compaction runs — far beyond this
    // window. The prompt is queued and answered when it finishes.
    const id = await hookedClaudeSession('compacting');
    await rpc(client, 'hookEvent', { id, event: 'PreCompact' });

    typeInto(client, id, 'a prompt sent while it is compacting\r');
    await sleep(CLAUDE_GAP + CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('Esc inside the window cancels the watch — the user abandoned that prompt', async () => {
    // Claude fires NO hook on a user interrupt (#55 §6), so without an explicit cancel
    // the watch runs to its timeout and reports a prompt the user themselves called
    // off. Note the session is still `idle` here, not `working`: the window that matters
    // is the second between a submit and the agent's first hook, which is exactly where
    // the interrupt gate could not see it. Found in review.
    const id = await hookedClaudeSession('escaped');

    typeInto(client, id, 'a prompt the user thinks better of\r');
    await sleep(CLAUDE_GAP + 100);
    typeInto(client, id, '\x1b');            // a LONE Esc — never an arrow (isEscapeKey)

    await sleep(CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });

  test('an ARROW key is not an interrupt and does not cancel the watch', async () => {
    // The mirror of the test above, and the reason isEscapeKey exists: `ESC [ D` is a
    // cursor key, not an abandonment, so it must leave the report intact.
    const id = await hookedClaudeSession('arrowed');

    typeInto(client, id, 'a prompt that goes nowhere\r');
    await sleep(CLAUDE_GAP + 100);
    typeInto(client, id, '\x1b[D');

    await sleep(CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(1);
  });

  test('a session already WORKING is never watched — the composer queues it', async () => {
    const id = await hookedClaudeSession('queued');
    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'the running turn' });

    typeInto(client, id, 'and then do this as well\r');
    await sleep(CLAUDE_GAP + CONFIRM_MS + 500);
    expect(events.unconfirmed(id)).toHaveLength(0);
  });
});
