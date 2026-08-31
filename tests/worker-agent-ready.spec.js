// @ts-check
// #147 — agent readiness, driven through the REAL PTY-output path.
//
// A newly created session drops the user straight into the chat lens, but the
// agent CLI takes seconds to boot. Until its composer exists the PTY is still
// sitting at the shell prompt, so a prompt typed and sent in that window is
// handed to BASH — it runs as a command or does nothing, and either way the text
// is gone with no error anywhere. Reported 2026-08-20 on all three companion
// platforms at once, which is what pointed at a missing SERVER-side signal
// rather than a per-client quirk.
//
// Reproduced with ground truth on the rig (scripts/rig/probe-claude-ready.js,
// claude 2.1.237, two runs): a prompt submitted before the composer marker
// started NO turn and drew "command not found" from bash; after the marker it
// started one. The marker landed at 5.0s on one run and 6.1s on the next — a
// 1.1s spread on one machine, which is why readiness is a MARKER and never an
// elapsed-time guess.
//
// __testInjectOutput feeds processPtyOutput — the same function term.onData
// calls — so these specs exercise the shipped path, not a reimplementation.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');

// What Claude's composer prints once it can accept a prompt. Registry-declared in
// lib/agents.js; restated here as the literal bytes a PTY would carry.
// #190 - the caret ALONE is not the marker and never was a faithful fixture.
// The real composer writes the caret then U+00A0 NO-BREAK SPACE; the folder-trust
// selector writes the same caret then CHA and no space at all. These fixtures passed
// against the old bare-caret marker only because it was loose enough to accept an
// approximation. Measured off a real PTY, claude 2.1.251.
//
// Built from code points on purpose: a literal NBSP is invisible in a diff and any
// editor or lint autofix that normalises whitespace turns it into U+0020, which would
// make these fixtures stop representing a composer with nothing going red.
const CARET = String.fromCodePoint(0x276f);
const NBSP = String.fromCodePoint(0x00a0);

function workerPipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wt-ready-test-${crypto.randomUUID()}`
    : `/tmp/wt-ready-test-${crypto.randomUUID()}.sock`;
}

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'wt-ready-data-' + crypto.randomUUID());
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

test.describe('#147 agent readiness on the PTY output path', () => {
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

  // An agent session is one with a command that LAUNCHES an agent — that is what
  // arms the gate, and a session with no autoCommand is deliberately not gated
  // (it is a plain shell until the user types something, and gating it would
  // block the very compose-bar submit that types `claude`).
  //
  // The command is inert on purpose: these specs drive readiness through
  // __testInjectOutput, so spawning a real agent would only add flakiness. The
  // wait covers AUTO_CMD_SETTLE_MS + AUTO_CMD_PRIME_MS, because the marker scan
  // does not start looking until the launch command has actually been written
  // (before that, the PTY is showing the SHELL and `❯` may be its prompt).
  async function newSession(agent, { autoCommand } = {}) {
    const cmd = autoCommand !== undefined
      ? autoCommand
      : (agent ? `echo launching-${agent}` : '');
    const { id } = await rpc(client, 'createSession', {
      cwd: dataDir, name: `s-${agent || 'shell'}`, agent, autoCommand: cmd,
    });
    if (!cmd) {
      await sleep(200);
      return id;
    }
    // WAIT for the command to actually be written, do not guess a duration. The
    // worker types it when it sees a shell prompt, and falls back at 5s if it
    // never recognises one — a fixed sleep would be either flaky or slow, and
    // this is the same "assert the precondition, never a timer" rule the feature
    // itself is built on.
    for (let i = 0; i < 80 && !(await armed(id)); i++) await sleep(100);
    return id;
  }

  /// True once the worker has written the launch command, i.e. once the marker
  /// scan is armed. Asserted rather than assumed so a timing change here fails
  /// loudly instead of quietly disarming every test below.
  async function armed(id) {
    const res = await rpc(client, '__testGetWrites', { id });
    return (res.writes || []).some((w) => String(w).includes('launching'));
  }

  const inject = (id, data) => rpc(client, '__testInjectOutput', { id, data });
  const summaryOf = async (id) =>
    (await rpc(client, 'listSessions')).sessions.find((s) => s.id === id);
  const readyEvents = () => events.filter((e) => e.event === 'agentReady');

  test('a new CLAUDE session is NOT ready until its composer marker appears', async () => {
    const id = await newSession('claude');
    expect(await armed(id)).toBe(true); // the scan is armed; see newSession
    // The whole bug in one assertion: the session exists, the client would happily
    // render a compose bar, and the agent cannot receive anything yet.
    expect((await summaryOf(id)).agentReady).toBe(false);

    await inject(id, `\r\n╭──────╮\r\n│ ${CARET}${NBSP}try "fix" │\r\n`);
    await sleep(60);

    expect((await summaryOf(id)).agentReady).toBe(true);
    expect(readyEvents()).toHaveLength(1);
    expect(readyEvents()[0].params.id).toBe(id);
  });

  test('the readiness edge is broadcast exactly ONCE', async () => {
    const id = await newSession('claude');
    await inject(id, CARET);
    await inject(id, `${CARET}${NBSP}and again\r\n`);
    await inject(id, 'ordinary output');
    await sleep(60);

    expect((await summaryOf(id)).agentReady).toBe(true);
    // A push per chunk would make the client re-enable submit forever.
    expect(readyEvents()).toHaveLength(1);
  });

  test('the latch survives across PTY reads — output before the marker does not reset it', async () => {
    // Chunk boundaries are where a stateful detector goes wrong: the marker
    // arrives in one read and everything before it in another.
    //
    // The BYTE-level split (the caret is 3 UTF-8 bytes and a PTY read can land
    // mid-character) is covered in tests/agent-ready.spec.js instead, and
    // deliberately so: __testInjectOutput re-encodes its payload with
    // Buffer.from(str, 'utf8'), so a partial UTF-8 sequence cannot survive the
    // trip through this RPC. Asserting it here would test the harness, not the
    // rule.
    const id = await newSession('claude');
    await inject(id, 'booting mcp servers...\r\n');
    await inject(id, 'esc to interrupt\r\n');  // a known FALSE marker — a cold TUI prints it
    await sleep(40);
    expect((await summaryOf(id)).agentReady).toBe(false);

    await inject(id, `${CARET}${NBSP}`);
    await sleep(60);
    expect((await summaryOf(id)).agentReady).toBe(true);
  });


  test('a session with NO autoCommand is never gated — it is a shell', async () => {
    // Gating one would block the compose-bar submit that types `claude` in the
    // first place, which is the opposite of what #147 is for.
    const id = await newSession('claude', { autoCommand: '' });
    expect((await summaryOf(id)).agentReady).toBe(true);
  });

  test('the marker is IGNORED until the launch command has been written', async () => {
    // `❯` is the default prompt glyph of starship, pure and several oh-my-posh
    // themes, so on such a box the shell's own prompt would flip the latch at
    // ~3.3s — before the agent was even launched — and the gate would silently
    // no-op. Found in review of PR #150.
    const { id } = await rpc(client, 'createSession', {
      cwd: dataDir, name: 's-early', agent: 'claude', autoCommand: 'echo launching-claude',
    });
    await inject(id, `${CARET} not the agent, just a fancy shell prompt`);
    await sleep(60);
    expect((await summaryOf(id)).agentReady).toBe(false);
  });

  test('a PLAIN SHELL session is ready from birth', async () => {
    // A shell IS usable at its first prompt. Gating it would refuse submit on
    // every non-agent session in the app.
    const id = await newSession(null);
    expect((await summaryOf(id)).agentReady).toBe(true);
    expect(readyEvents()).toHaveLength(0);
  });

  test('a CODEX session is ready from birth — its marker is deliberately undeclared', async () => {
    // lib/agents.js declares no readiness marker for Codex on purpose: the
    // candidate (its model/effort line) has not been measured against a real boot
    // the way Claude's caret was, and an unmeasured marker is exactly what #143
    // shipped. Undeclared means today's behaviour, unchanged — pinned here so
    // declaring one later is a deliberate act with a test to update.
    const id = await newSession('codex');
    expect((await summaryOf(id)).agentReady).toBe(true);
  });

  test('a HOOK makes a session ready even if the marker never appears', async () => {
    // The safety net. An agent that fired a hook is up, whatever its screen did —
    // so a marker that changes in a future CLI release degrades to "ready late",
    // never to "ready never". #147 is explicit that no working session may sit
    // stuck on 'starting'.
    const id = await newSession('claude');
    expect((await summaryOf(id)).agentReady).toBe(false);

    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
    await sleep(60);

    expect((await summaryOf(id)).agentReady).toBe(true);
    expect(readyEvents()).toHaveLength(1);
  });

  test('ordinary shell output never flips a claude session ready', async () => {
    // A bare '>' matches shell prompts, redirects and quoted output alike. A
    // false positive here IS the bug — it declares ready while the PTY is bash.
    const id = await newSession('claude');
    await inject(id, 'adiel@Adiel-Home MINGW64 /c/dev/web-terminal\r\n$ ');
    await inject(id, 'echo hi > out.txt\r\n');
    await sleep(60);

    expect((await summaryOf(id)).agentReady).toBe(false);
    expect(readyEvents()).toHaveLength(0);
  });
});
