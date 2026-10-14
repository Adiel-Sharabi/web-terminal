// @ts-check
// #350 - an AUTO compaction ends the turn (claude 2.1.29x): the summary is written and
// nothing runs again until a human types. The worker finishes it with a typed `continue`,
// but only on evidence the turn really stalled.
//
// THE EVIDENCE, in the order it arrives:
//   PreCompact(trigger "auto")   whose compaction it is   (a manual /compact is never nudged)
//   SessionStart(source "compact")  the compaction is over   (server.js did not forward
//                                   `source` until this change, nor PreCompact's `trigger`)
//   ...then `compactResume.graceMs` of silence from EVERY hook.
// The silence is the gate, not the session's status: after the stalled compaction the status
// can still read `working`, because no Stop ever arrived.
//
// HOW THE NEGATIVE TESTS ARE KEPT HONEST. A "nothing was typed" assertion behind a timer is
// vacuous: it passes when the window simply had not elapsed. So every negative here asks the
// worker whether a timer is ARMED (`__testCompactResumeDue` with `peek`), and every cancel
// test first proves the timer WAS armed - the cancel is then a decision observed, not an
// absence waited for. The fire itself is brought due on demand, through the very function
// its setTimeout calls, so nothing here waits out the real 15s grace.
//
// To watch the positive tests fail without the fix: delete the `submitLine(s, 'continue')`
// line in fireCompactResume (pty-worker.js). To watch the cancel tests fail: delete the
// cancelCompactResume call at the top of handleHook.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agentsLib = require('../lib/agents');
const compactResume = require('../lib/compact-resume');
const { connectClient, rpc } = require('./worker-ipc');   // #262 - one owner for the budget

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Pure rules (lib/compact-resume.js) and the registry declaration
// ---------------------------------------------------------------------------------------

test.describe('#350 - the pure rules and the registry', () => {
  test('hookFacts forwards PreCompact.trigger and SessionStart.source, allowlisted', () => {
    expect(compactResume.hookFacts('PreCompact', { trigger: 'auto' })).toEqual({ trigger: 'auto' });
    expect(compactResume.hookFacts('PreCompact', { trigger: 'manual' })).toEqual({ trigger: 'manual' });
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      expect(compactResume.hookFacts('SessionStart', { source })).toEqual({ source });
    }
  });

  test('hookFacts drops anything it does not recognise - external input is never forwarded raw', () => {
    expect(compactResume.hookFacts('PreCompact', { trigger: 'AUTO' })).toEqual({});
    expect(compactResume.hookFacts('PreCompact', { trigger: 'x'.repeat(5000) })).toEqual({});
    expect(compactResume.hookFacts('PreCompact', { trigger: { a: 1 } })).toEqual({});
    expect(compactResume.hookFacts('PreCompact', {})).toEqual({});
    expect(compactResume.hookFacts('SessionStart', { source: 'rm -rf' })).toEqual({});
    expect(compactResume.hookFacts('SessionStart', { source: ['compact'] })).toEqual({});
    expect(compactResume.hookFacts('PreCompact', null)).toEqual({});
    expect(compactResume.hookFacts('PreCompact', 'auto')).toEqual({});
  });

  test('hookFacts is keyed on the EVENT: a trigger on the wrong event, or on any other event, is ignored', () => {
    expect(compactResume.hookFacts('SessionStart', { trigger: 'auto' })).toEqual({});
    expect(compactResume.hookFacts('PreCompact', { source: 'compact' })).toEqual({});
    expect(compactResume.hookFacts('UserPromptSubmit', { trigger: 'auto', source: 'compact' })).toEqual({});
  });

  test('triggerKind reads only an explicit "auto" as auto - missing and unknown are manual', () => {
    expect(compactResume.triggerKind('auto')).toBe('auto');
    expect(compactResume.triggerKind('manual')).toBe('manual');
    expect(compactResume.triggerKind(undefined)).toBe('manual');
    expect(compactResume.triggerKind(null)).toBe('manual');
    expect(compactResume.triggerKind('Auto')).toBe('manual');
    expect(compactResume.triggerKind('')).toBe('manual');
  });

  test('finishesCompaction is SessionStart + source compact and nothing else', () => {
    expect(compactResume.finishesCompaction('SessionStart', 'compact')).toBe(true);
    for (const source of ['startup', 'resume', 'clear', undefined, null, '']) {
      expect(compactResume.finishesCompaction('SessionStart', source)).toBe(false);
    }
    expect(compactResume.finishesCompaction('PreCompact', 'compact')).toBe(false);
    expect(compactResume.finishesCompaction('Stop', 'compact')).toBe(false);
  });

  test('registry: Claude declares a grace, Codex / plain shell / unknown declare nothing', () => {
    const claude = agentsLib.compactResumePolicy('claude');
    expect(claude).toBeTruthy();
    expect(claude.graceMs).toBe(15000);
    expect(agentsLib.compactResumePolicy('codex')).toBeNull();
    expect(agentsLib.compactResumePolicy(null)).toBeNull();
    expect(agentsLib.compactResumePolicy('not-an-agent')).toBeNull();
  });

  // The server cannot be imported (it exports nothing), so the wiring that was missing - the
  // two fields stripped between /api/hook and the worker - is pinned against the SOURCE, the
  // way tests/app-input-path.spec.js pins its funnel. The behavioural half is below: the
  // worker really does act on `trigger` and `source` when they arrive.
  test('wiring: server.js spreads hookFacts into the hookEvent RPC; the worker reads trigger and source off it', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const rpcCall = server.match(/workerClient\.rpc\('hookEvent',\s*\{[^}]*\}\s*\)/);
    expect(rpcCall, "server.js must still call workerClient.rpc('hookEvent', {...})").toBeTruthy();
    expect(rpcCall[0]).toContain('compactResume.hookFacts(');

    const worker = fs.readFileSync(path.join(ROOT, 'pty-worker.js'), 'utf8');
    const handler = worker.match(/hookEvent:\s*async \(params\) => \{[\s\S]*?\n {2}\},/);
    expect(handler, 'pty-worker.js hookEvent RPC handler').toBeTruthy();
    expect(handler[0]).toContain('trigger: params.trigger');
    expect(handler[0]).toContain('source: params.source');
  });
});

// ---------------------------------------------------------------------------------------
// The worker, over a real IPC pipe
// ---------------------------------------------------------------------------------------

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
  const proc = spawn(process.execPath, [path.join(ROOT, 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
      // Deliberately NOT WT_API_ERROR_FAST: it shrinks COMPACTING_MAX_MS to 300ms, which
      // would clear `compacting` on its own and leave the "SessionStart clears it" test
      // passing for the wrong reason. The real submit gap (150ms) is waited out instead.
      WT_API_ERROR_FAST: '0',
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
    stop() { client.off('frame', onFrame); },
  };
}

const ESC = '\x1b';

test.describe('#350 - the worker finishes a turn an auto compaction ended', () => {
  let worker, client, dataDir, ev;

  test.beforeEach(async () => {
    const pipe = workerPipePath();
    dataDir = makeTempDataDir();
    worker = spawnWorker(pipe, dataDir);
    client = await connectClient(pipe);
    ev = makeEventCollector(client);
  });

  test.afterEach(async () => {
    try { ev.stop(); } catch {}
    try { client.close(); } catch {}
    await worker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  async function newSession(agent) {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name: `cr-${agent || 'shell'}`, agent });
    await sleep(150); // let the PTY settle
    return id;
  }
  const hook = (id, event, extra = {}) => rpc(client, 'hookEvent', { id, event, ...extra });
  const statusOf = async (id) => (await rpc(client, 'getSession', { id })).status;
  const armed = async (id) => (await rpc(client, '__testCompactResumeDue', { id, peek: true })).armed;
  const writesOf = async (id) => {
    const { writes } = await rpc(client, '__testGetWrites', { id });
    return writes.map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('latin1')));
  };

  /** A turn is running, an AUTO compaction starts, and finishes. The state the bug leaves. */
  async function autoCompactionFinished(id) {
    await hook(id, 'UserPromptSubmit', { prompt: 'do a long thing' });
    await hook(id, 'PreCompact', { trigger: 'auto' });
    await hook(id, 'SessionStart', { source: 'compact' });
  }

  // --- the positive path -------------------------------------------------------------

  test('auto compaction + SessionStart(compact) + silence: `continue` is typed and submitted with a CR', async () => {
    const id = await newSession('claude');
    await autoCompactionFinished(id);

    // Armed from the REGISTRY's grace - proof the declared number is the one the worker
    // uses, with no env override standing in for it.
    const t0 = Date.now();
    const peek = await rpc(client, '__testCompactResumeDue', { id, peek: true });
    expect(peek.armed).toBe(true);
    const grace = agentsLib.compactResumePolicy('claude').graceMs;
    expect(peek.fireAt - t0).toBeGreaterThan(grace - 3000);
    expect(peek.fireAt - t0).toBeLessThanOrEqual(grace + 1000);

    // The session still reads `working`: no Stop ever arrived. The nudge must not be gated
    // on status, or it would refuse exactly the case it exists for.
    expect(await statusOf(id)).toBe('working');
    expect(await writesOf(id)).toEqual([]);

    await rpc(client, '__testCompactResumeDue', { id });   // bring it due NOW
    await sleep(400);                                       // the CR rides the 150ms submit gap

    expect(await writesOf(id)).toEqual(['continue', '\r']);
    // And it is a one-shot: nothing is left armed.
    expect(await armed(id)).toBe(false);
  });

  test('SessionStart(compact) clears the compacting indicator, with a clear broadcast', async () => {
    const id = await newSession('claude');
    await hook(id, 'UserPromptSubmit', { prompt: 'x' });
    await hook(id, 'PreCompact', { trigger: 'auto' });
    await ev.waitFor((e) => e.event === 'compacting' && e.params.id === id && e.params.compacting === true);
    expect((await rpc(client, 'getSession', { id })).compacting).toBe(true);

    await hook(id, 'SessionStart', { source: 'compact' });

    await ev.waitFor((e) => e.event === 'compacting' && e.params.id === id && e.params.compacting === false);
    expect((await rpc(client, 'getSession', { id })).compacting).toBe(false);
  });

  test('a second SessionStart(compact) with no PreCompact before it arms nothing - one compaction, one chance', async () => {
    const id = await newSession('claude');
    await autoCompactionFinished(id);
    expect(await armed(id)).toBe(true);
    await rpc(client, '__testCompactResumeDue', { id });
    await sleep(400);
    expect(await writesOf(id)).toEqual(['continue', '\r']);

    // The consumed trigger must not survive to arm a second time.
    await hook(id, 'SessionStart', { source: 'compact' });
    expect(await armed(id)).toBe(false);
  });

  // --- never armed -------------------------------------------------------------------

  test('a MANUAL /compact is never nudged', async () => {
    const id = await newSession('claude');
    await hook(id, 'UserPromptSubmit', { prompt: '/compact' });
    await hook(id, 'PreCompact', { trigger: 'manual' });
    await hook(id, 'SessionStart', { source: 'compact' });

    expect(await armed(id)).toBe(false);
    expect(await writesOf(id)).toEqual([]);
  });

  for (const [label, extra] of [
    ['no trigger at all (an older Claude)', {}],
    ['an unrecognised trigger', { trigger: 'scheduled' }],
  ]) {
    test(`${label} reads as manual - never nudged`, async () => {
      const id = await newSession('claude');
      await hook(id, 'UserPromptSubmit', { prompt: 'x' });
      await hook(id, 'PreCompact', extra);
      await hook(id, 'SessionStart', { source: 'compact' });
      expect(await armed(id)).toBe(false);
    });
  }

  test('SessionStart(compact) with no PreCompact seen (a worker restarted mid-compaction) arms nothing', async () => {
    const id = await newSession('claude');
    await hook(id, 'SessionStart', { source: 'compact' });
    expect(await armed(id)).toBe(false);
  });

  for (const source of ['startup', 'resume', 'clear', undefined]) {
    test(`SessionStart(source ${source}) is ignored exactly as before: no arm, compacting and status untouched`, async () => {
      const id = await newSession('claude');
      await hook(id, 'UserPromptSubmit', { prompt: 'x' });
      await hook(id, 'PreCompact', { trigger: 'auto' });
      const before = await rpc(client, 'getSession', { id });
      expect(before.compacting).toBe(true);

      await hook(id, 'SessionStart', source === undefined ? {} : { source });

      expect(await armed(id)).toBe(false);
      const after = await rpc(client, 'getSession', { id });
      expect(after.compacting).toBe(true);
      expect(after.status).toBe(before.status);

      // ...and the auto trigger was NOT consumed by the unrelated start: the real end of
      // the compaction still arms.
      await hook(id, 'SessionStart', { source: 'compact' });
      expect(await armed(id)).toBe(true);
    });
  }

  test('Codex declares no policy: undeclared means never', async () => {
    const id = await newSession('codex');
    await autoCompactionFinished(id);
    expect(await armed(id)).toBe(false);
    expect(await writesOf(id)).toEqual([]);
  });

  test('a plain shell declares no policy either', async () => {
    const id = await newSession(null);
    await autoCompactionFinished(id);
    expect(await armed(id)).toBe(false);
    expect(await writesOf(id)).toEqual([]);
  });

  // --- cancelled by evidence the turn carried on -------------------------------------

  for (const [event, extra] of [
    ['UserPromptSubmit', { prompt: 'something else' }],
    ['PreToolUse', {}],
    ['PostToolUse', {}],
    ['SubagentStart', {}],
    ['Stop', {}],
    ['Notification', {}],
    ['PermissionRequest', {}],
    ['PreCompact', { trigger: 'auto' }],   // a NEW compaction supersedes the nudge for the last
  ]) {
    test(`${event} within the grace cancels it - nothing is typed even when the timer is forced`, async () => {
      const id = await newSession('claude');
      await autoCompactionFinished(id);
      expect(await armed(id), 'precondition: the nudge IS armed').toBe(true);

      await hook(id, event, extra);

      expect(await armed(id)).toBe(false);
      // Forcing a fire changes nothing: there is no timer left to bring due.
      expect((await rpc(client, '__testCompactResumeDue', { id })).armed).toBe(false);
      await sleep(300);
      expect(await writesOf(id)).toEqual([]);
    });
  }

  test('Esc within the grace cancels it', async () => {
    const id = await newSession('claude');
    await autoCompactionFinished(id);
    expect(await armed(id), 'precondition: the nudge IS armed').toBe(true);

    client.send(ipc.encodePtyIn(id, Buffer.from(ESC, 'latin1')));
    await sleep(200);

    expect(await armed(id)).toBe(false);
    // The Esc byte reached the PTY - the cancel does not swallow it - and `continue` did not.
    expect((await writesOf(id)).join('')).toBe(ESC);
  });

  test('an arrow key is not Esc: it does not cancel (a leading ESC is not the Esc key)', async () => {
    const id = await newSession('claude');
    await autoCompactionFinished(id);

    client.send(ipc.encodePtyIn(id, Buffer.from(`${ESC}[A`, 'latin1')));
    await sleep(200);

    expect(await armed(id)).toBe(true);
  });

  // --- the fire-time guard -----------------------------------------------------------

  test('blocked on a permission prompt when the grace ends: nothing is typed into it', async () => {
    const id = await newSession('claude');
    // A prompt was already on screen when the compaction ended. PreCompact and SessionStart
    // change no status, so the session is still `waiting` when the timer arms - the one way
    // to reach the fire-time guard, since every other hook would have cancelled the timer.
    await hook(id, 'PermissionRequest');
    expect(await statusOf(id)).toBe('waiting');
    await hook(id, 'PreCompact', { trigger: 'auto' });
    await hook(id, 'SessionStart', { source: 'compact' });
    expect(await armed(id), 'precondition: armed').toBe(true);
    expect(await statusOf(id)).toBe('waiting');

    const r = await rpc(client, '__testCompactResumeDue', { id });   // fire it now
    expect(r.armed).toBe(true);
    await sleep(400);

    expect(await writesOf(id)).toEqual([]);
    expect(await armed(id)).toBe(false);   // skipped, not re-armed: the user will answer it
  });
});
