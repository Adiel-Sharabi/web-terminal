// @ts-check
// API-error detection + auto-continue (escalation ladder).
//
// Spawns pty-worker.js with an isolated pipe + temp data dir (same harness as
// worker-session.spec.js). Detection runs in the worker's PTY-output path, so
// we feed bytes through it with the test-only __testInjectOutput RPC (which
// routes through the same processPtyOutput() the real term.onData uses).
//
// Timers are shrunk via WT_API_ERROR_FAST=1 and the auto-continue toggle is
// forced via WT_AUTO_CONTINUE_API_ERROR so the tests are deterministic and
// independent of the on-disk config.json.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const { connectClient, rpc, stopWorker } = require('./worker-ipc');   // #262 - one owner for the budget

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

function spawnWorker(pipePath, dataDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
      WT_API_ERROR_FAST: '1',
      WT_HOOK_STOP_DEBOUNCE_MS: '20',
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
    stop: () => stopWorker(proc),
  };
}

/** Buffers every event frame and lets tests await specific ones. */
function makeEventCollector(client) {
  const events = [];
  const waiters = [];
  function onFrame(frame) {
    if (frame.type !== ipc.TYPE_JSON) return;
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
    if (!msg.event) return;
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(msg); }
    }
  }
  client.on('frame', onFrame);
  return {
    events,
    waitFor(pred, timeoutMs = 3000) {
      const existing = events.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: null };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error('timeout waiting for event'));
        }, timeoutMs);
        w.resolve = (m) => { clearTimeout(timer); resolve(m); };
        waiters.push(w);
      });
    },
    apiActions() {
      return events.filter(e => e.event === 'apiError' && e.params && e.params.action);
    },
    stop() { client.off('frame', onFrame); },
  };
}

const inject = (client, id, data) => rpc(client, '__testInjectOutput', { id, data });
// #461 - the ladder starts only when the agent goes idle WITHOUT a Stop on the turn the error
// cut (Claude fires no Stop for it; its idle Notification comes about a minute later).
const cutIdle = (client, id) => rpc(client, 'hookEvent', { id, event: 'Notification' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findSession(client, id) {
  const { sessions } = await rpc(client, 'listSessions');
  return sessions.find(s => s.id === id);
}

const OVERLOADED = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.\r\n';
const BAD_REQUEST = 'API Error: 400 {"type":"error","error":{"message":"bad request"}}\r\n';

// #461 - the transport failures Claude prints today, verbatim from the worker logs that
// called every one of them non-transient (so no auto-continue ever ran). A plain "continue"
// resumed the measured one after 26 h idle.
const CUT_LINES = [
  'API Error: Connection lost mid-response. The response above may be incomplete.',
  'API Error: Connection closed mid-response. The response above may be incomplete.',
  'API Error: Server error mid-response. The response above may be incomplete.',
  'API Error: Response stalled mid-stream. The response above may be incomplete.',
  "API Error: Can't reach the API server \u2014 check your internet connection",
  // The TUI positions words by cursor moves, so the stripped line can lose its spaces.
  "API Error:Can'treachtheAPIserver\u2014checkyourinternetorD",
  'API Error: Can\u2019t reach the API server',
  'API Error: Unable to connect to API (ConnectionRefused)',
  'API Error: Unable to connect to API',
  'API Error: API returned an empty or malformed response',
  'API Error: The response stopped arriving.',
];
// Retrying these fails the same way: they stay flagged-only.
const PERMANENT_LINES = [
  'API Error: 400 {"type":"error","error":{"message":"bad request"}}',
  'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
  'API Error: 403 Attention Required! | Cloudflare',
  'API Error: an image in the conversation could not be processed',
  // A certificate or proxy problem: "unable to connect" alone would read transient.
  'API Error: Unable to connect to API due to SSL certificate verification error',
  'API Error: Unable to connect to API (SELF_SIGNED_CERT_IN_CHAIN)',
];

test.describe('which API errors are worth retrying (#461, lib/api-error.js)', () => {
  const { isTransientApiError } = require('../lib/api-error');
  test('every transport failure Claude prints is transient', () => {
    for (const l of CUT_LINES) expect(isTransientApiError(l), l).toBe(true);
  });
  test('the ones retrying cannot fix stay non-transient', () => {
    for (const l of PERMANENT_LINES) expect(isTransientApiError(l), l).toBe(false);
    expect(isTransientApiError('')).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });
  test('the rules it had before still hold', () => {
    for (const l of ['API Error: 529 Overloaded', 'API Error: 429 rate_limit_error', 'API Error: Request timed out.',
      'API Error: Connection error.', 'API Error: read ECONNRESET', 'API Error: fetch failed', 'API Error: 503 Service Unavailable']) {
      expect(isTransientApiError(l), l).toBe(true);
    }
  });
});

test.describe('API-error detection + auto-continue', () => {
  test('flags a Claude session and emits an apiError event on detection', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'claude-sess', autoCommand: '' });
      // Arm it as a Claude session (sets hookStatus).
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);

      const detect = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect(detect.params.transient).toBe(true);
      expect(detect.params.text).toContain('API Error: 529');

      const found = await findSession(client, id);
      expect(found.apiError).toBe(true);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('ignores API Error text in a non-Claude session', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'plain', autoCommand: '' });
      // No hook, no claude autoCommand → not a Claude session.
      await inject(client, id, OVERLOADED);
      await sleep(300);

      expect(ev.events.some(e => e.event === 'apiError' && e.params.id === id)).toBe(false);
      const found = await findSession(client, id);
      expect(!!found.apiError).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('non-transient error (400) flags but does not auto-continue', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'badreq', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, BAD_REQUEST);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      const detect = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect(detect.params.transient).toBe(false);

      await sleep(300); // longer than the (fast) backoff
      expect(ev.apiActions().length).toBe(0);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('#461: a connection lost mid-response is transient, auto-continues, and publishes when it was seen', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'cut', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      const before = await findSession(client, id);
      expect(before.apiErrorAt).toBeNull();
      const t0 = Date.now();
      await inject(client, id, CUT_LINES[0] + '\r\n');
      await cutIdle(client, id);
      const detect = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect(detect.params.transient).toBe(true);
      const a1 = await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.autoContinue === 1);
      expect(a1.params.action).toBe('continue');
      const found = await findSession(client, id);
      expect(found.apiError).toBe(true);
      expect(found.apiErrorAt).toBeGreaterThanOrEqual(t0);
      expect(found.apiErrorAt).toBeLessThanOrEqual(Date.now());
      // Cleared by the resumed turn: the time goes with it.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      const after = await findSession(client, id);
      expect(after.apiError).toBe(false);
      expect(after.apiErrorAt).toBeNull();
      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // #461 - the ladder types into a terminal, so it acts only on a turn the error CUT: the line
  // appeared while the agent worked, and the agent then idled with no Stop. Each negative
  // below breaks exactly one of those, on an otherwise-identical session.
  async function ladderCase(name, steps, agent) {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name, autoCommand: '', ...(agent ? { agent } : {}) });
      await steps(client, id, ev);
      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  }
  const quiet = async (ev, id) => { await sleep(400); return ev.apiActions().filter((e) => e.params.id === id).length; };

  test('#461: an error line in a turn that then ends with a Stop is never retried', async () => {
    await ladderCase('echo-then-stop', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, CUT_LINES[0] + '\r\n'); // e.g. a tool printing the phrase
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await cutIdle(client, id); // the later idle Notification of a finished turn
      expect(await quiet(ev, id)).toBe(0);
      expect((await findSession(client, id)).apiError).toBe(true); // flagged, never typed into
    });
  });

  test('#461: an error line drawn while the agent is idle (a redraw) is never retried', async () => {
    await ladderCase('idle-redraw', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await sleep(100);
      expect((await findSession(client, id)).status).toBe('idle');
      await inject(client, id, CUT_LINES[0] + '\r\n');
      await cutIdle(client, id);
      expect(await quiet(ev, id)).toBe(0);
    });
  });

  test('#461: no idle, no retry - an error line in a turn still running is never typed into', async () => {
    await ladderCase('no-idle', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, CUT_LINES[0] + '\r\n');
      expect(await quiet(ev, id)).toBe(0); // the old ladder had typed `continue` by now
    });
  });

  test('#461: Esc on the turn clears the error: nothing is retried, nothing published', async () => {
    await ladderCase('esc', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, CUT_LINES[0] + '\r\n');
      client.send(ipc.encodePtyIn(id, Buffer.from(String.fromCodePoint(0x1b), 'utf8')));
      await sleep(150);
      const s = await findSession(client, id);
      expect(s.status).toBe('idle');
      expect(s.apiError).toBe(false);
      expect(s.apiErrorAt).toBeNull();
      await cutIdle(client, id);
      expect(await quiet(ev, id)).toBe(0);
    }, 'claude'); // Esc interrupts only an agent that declares it (lib/agents.js)
  });

  test('#461: a Stop inside the backoff stops the typed retry (re-read when the timer fires)', async () => {
    await ladderCase('recheck', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, CUT_LINES[0] + '\r\n');
      await cutIdle(client, id);
      await sleep(100); // idled and armed (the first fast backoff is 300 ms)
      await rpc(client, 'hookEvent', { id, event: 'Stop' }); // the turn ended after all
      expect(await quiet(ev, id)).toBe(0);
    });
  });

  test('#461: a held Stop (a subagent still running) is never replaced by a later Notification', async () => {
    await ladderCase('held-stop', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await rpc(client, 'hookEvent', { id, event: 'SubagentStart', agentId: 'sub-1' });
      await inject(client, id, CUT_LINES[0] + '\r\n'); // an echo while the turn works
      await rpc(client, 'hookEvent', { id, event: 'Stop' });         // held: the subagent runs on
      await cutIdle(client, id);                                     // Claude's idle, also held
      await rpc(client, 'hookEvent', { id, event: 'SubagentStop', agentId: 'sub-1' });
      expect(await quiet(ev, id)).toBe(0); // released as the Stop it was: a finished turn
    });
  });

  test('#461: a keystroke during the backoff cancels the typed retry (it would join their line)', async () => {
    await ladderCase('typing', async (client, id, ev) => {
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, CUT_LINES[0] + '\r\n');
      await cutIdle(client, id);
      await sleep(100); // armed: the first fast backoff is 300 ms
      client.send(ipc.encodePtyIn(id, Buffer.from('h', 'utf8')));
      expect(await quiet(ev, id)).toBe(0);
    });
  });

  test('#461: an episode ends only on a turn that SUCCEEDED, never on our /compact\'s Stop', async () => {
    await ladderCase('episode', async (client, id, ev) => {
      const actions = () => ev.apiActions().filter((e) => e.params.id === id && (e.params.action === 'continue' || e.params.action === 'compact'));
      const cutOnce = async () => {
        await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
        await inject(client, id, CUT_LINES[0] + '\r\n');
        await cutIdle(client, id);
        await sleep(500);
      };
      await cutOnce(); await cutOnce(); await cutOnce(); // continue, continue, /compact
      expect(actions().map((e) => e.params.action)).toEqual(['continue', 'continue', 'compact']);
      await rpc(client, 'hookEvent', { id, event: 'Stop' }); // the /compact's own Stop -> replay
      await ev.waitFor((e) => e.event === 'apiError' && e.params.id === id && e.params.action === 'replay-prompt');
      const n = actions().length;
      await cutOnce(); // the replay was cut too: exhausted, however long it took
      expect(actions().length).toBe(n);
      // A turn that succeeds ends the episode; the next cut starts the ladder again.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await sleep(100);
      await cutOnce();
      expect(actions().slice(-1)[0].params).toMatchObject({ autoContinue: 1, action: 'continue' });
    });
  });

  test('does not auto-continue when the feature is disabled', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'disabled', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      await sleep(300);
      expect(ev.apiActions().length).toBe(0);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('apiError clears when Claude resumes working', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '0' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'clearme', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      await inject(client, id, OVERLOADED);
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === true);
      expect((await findSession(client, id)).apiError).toBe(true);

      // A new working signal (user/auto retry) clears the highlight.
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await ev.waitFor(e => e.event === 'apiError' && e.params.id === id && e.params.apiError === false);
      expect(!!(await findSession(client, id)).apiError).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('escalation ladder: continue, continue, /compact + replay, then stops', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'ladder', autoCommand: '' });
      // Capture a real user prompt for the replay step.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'finish the refactor in foo.js' });

      // Error #1 -> attempt 1 = continue
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      const a1 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      expect(a1.params.action).toBe('continue');
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' }); // resume -> clears flag

      // Error #2 -> attempt 2 = continue
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      const a2 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      expect(a2.params.action).toBe('continue');
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

      // Error #3 -> attempt 3 = /compact, then replay captured prompt on idle
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      const a3 = await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3);
      expect(a3.params.action).toBe('compact');
      // The idle hook (or fallback timer) triggers the prompt replay.
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      const replay = await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      expect(replay.params.replayText).toBe('finish the refactor in foo.js');

      // Resume, then error #4 -> exhausted, no further auto action.
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      const before = ev.apiActions().length;
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await sleep(300);
      expect(ev.apiActions().length).toBe(before);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('auto-continue submits with CR (\\r), never LF (\\n)', async () => {
    // Claude's TUI reads input in raw mode where Enter is CR. Sending LF leaves
    // the text unsubmitted, which silently broke auto-continue in production.
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'crsubmit', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'do the thing' });

      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1 && e.params.action === 'continue');
      await sleep(120); // let the deferred CR land

      const { writes } = await rpc(client, '__testGetWrites', { id });
      // Typed text and the submit key are written separately; the submit is CR.
      expect(writes).toContain('continue');
      expect(writes).toContain('\r');
      // The old bug: a single "continue\n" that Claude's TUI never submits.
      expect(writes).not.toContain('continue\n');
      expect(writes.some(w => w.includes('\n'))).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('compact-replay submits the captured prompt with CR, not LF', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'replaycr', autoCommand: '' });
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: 'finish the refactor in foo.js' });

      // Walk to attempt 3 (/compact), clearing the flag between errors.
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      await sleep(120); // let the deferred CR land

      const { writes } = await rpc(client, '__testGetWrites', { id });
      expect(writes).toContain('/compact');
      expect(writes).toContain('finish the refactor in foo.js');
      expect(writes).toContain('\r');
      expect(writes.some(w => w.includes('\n'))).toBe(false);

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  // #213 — the replay path had the same newline-only predicate as the compose bar, so a
  // long DICTATED prompt (no newline anywhere) was written raw and Claude lost its first
  // 1024 characters. This fires automatically during api-error recovery, so nobody is
  // watching it happen — which is why it gets its own guard rather than riding on the
  // compose-bar tests.
  test('compact-replay DECLARES a long single-line prompt as a paste (#213)', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', {
        cwd: os.tmpdir(), name: 'replaylong', autoCommand: '', agent: 'claude',
      });
      // The reported shape: one long line, dictated, no newline anywhere.
      const dictated = 'so first we want to reflect the user if there is a problem '.repeat(26);
      expect(dictated).not.toContain('\n');
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit', prompt: dictated });

      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      await sleep(120); // let the deferred CR land

      const { writes } = await rpc(client, '__testGetWrites', { id });
      const flat = writes.map(w => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('utf8')));
      // The body must be WRAPPED — and the raw form must not appear at all.
      expect(flat).toContain('\x1b[200~' + dictated + '\x1b[201~');
      expect(flat).not.toContain(dictated);
      expect(flat).toContain('\r');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });

  test('replay falls back to "continue" when no prompt was captured', async () => {
    const pipe = workerPipePath();
    const dataDir = makeTempDataDir();
    const worker = spawnWorker(pipe, dataDir, { WT_AUTO_CONTINUE_API_ERROR: '1' });
    try {
      const client = await connectClient(pipe);
      const ev = makeEventCollector(client);
      const { id } = await rpc(client, 'createSession', { cwd: os.tmpdir(), name: 'nofall', autoCommand: '' });
      // Arm as Claude session WITHOUT capturing a user prompt.
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });

      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 1);
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 2);
      await rpc(client, 'hookEvent', { id, event: 'PreToolUse' });
      await inject(client, id, OVERLOADED);
      await cutIdle(client, id); // #461 - the agent idles on the turn the error cut
      await ev.waitFor(e => e.event === 'apiError' && e.params.autoContinue === 3 && e.params.action === 'compact');
      await rpc(client, 'hookEvent', { id, event: 'Stop' });
      const replay = await ev.waitFor(e => e.event === 'apiError' && e.params.action === 'replay-prompt');
      expect(replay.params.replayText).toBe('continue');

      ev.stop();
      await rpc(client, 'killSession', { id });
      await client.close();
    } finally {
      await worker.stop();
      rmRf(dataDir);
    }
  });
});
