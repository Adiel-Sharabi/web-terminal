// @ts-check
// #190 - a session parked on Claude's startup selector must NOT be published as able
// to take a prompt, driven through the REAL worker.
//
// ## What is red without the fix, and why it is this assertion and not another
//
// #202 already stopped the trust dialog from flipping #147's readiness latch, so such
// a session starts out correctly NOT ready. The bug is one line later: #147's 45s
// ceiling (`armReadyFallback`) forces the gate open when no composer marker ever
// arrives - which is right for `claude: command not found`, and wrong for a screen we
// have recognised. So the load-bearing assertion is the one taken AFTER the ceiling
// has passed: before this change the session flips to `agentReady: true` there and the
// compose bar submits into a selector whose default row is `No, exit`, confirming EXIT.
//
// Every assertion's verdict is the worker's own published state or `__testGetWrites` -
// the exact bytes written to the PTY. Never a screen: this repo's most repeated
// methodological rule, and it applies with extra force to a selector, where the screen
// cannot tell a highlighted row from a committed one.
//
// The bytes injected are the REAL ones, captured off a live PTY (claude 2.1.268,
// 2026-09-11, scripts/rig/probe-trust-prompt.js capture with WT_TRUST_PROBE_PARENT
// pointed at a directory with no trusted ancestor). `__testInjectOutput` feeds them
// through the exact path `term.onData` uses, so nothing here is a reimplementation.
//
// Built from code points, never typed - see tests/blocking-prompt.spec.js for why.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agents = require('../lib/agents');

const ESC = String.fromCodePoint(0x001b);
const CARET = String.fromCodePoint(0x276f);
const NBSP = String.fromCodePoint(0x00a0);
const CR = String.fromCodePoint(0x000d);
const DOWN = ESC + '[B';

const at = (n) => `${ESC}[${n}G`;

/** The captured trust dialog, as bytes. Not one literal space anywhere in it. */
const TRUST_DIALOG = [
  `${at(2)}Quick${at(8)}safety${at(15)}check:${at(22)}Is${at(25)}this${at(30)}a${at(32)}project${at(40)}you${at(44)}trust?`,
  '',
  `${at(2)}${ESC}[38;2;177;185;249m${CARET}${at(4)}No,${at(8)}exit${ESC}[39m`,
  `${at(4)}Yes,${at(9)}I${at(11)}trust${at(17)}this${at(22)}folder`,
  '',
  `${at(2)}${ESC}[38;2;153;153;153mEnter${at(8)}to${at(11)}confirm${at(19)}.${at(21)}Esc${at(25)}to${at(28)}cancel${ESC}[39m`,
].join('\r\n');

/** The composer, which is what answering the dialog produces. Caret + NO-BREAK SPACE. */
const COMPOSER = `${ESC}[38;2;136;136;136m${'-'.repeat(8)}${ESC}[39m\r\n${CARET}${NBSP}${ESC}[2mTry`;

// Short enough to keep the spec quick, long enough that the injection below lands well
// inside it. The DEFAULT is 45s (#147); what is under test is the decision the timer
// makes when it fires, not its length.
const FALLBACK_MS = 700;
const GAP_MS = agents.blockingPromptsFor('claude').answerGapMs;

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

function spawnWorker(pipePath, dataDir, extraEnv) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
    env: {
      ...process.env,
      WT_TEST: '1',
      WT_WORKER_PIPE: pipePath,
      WT_WORKER_DATA_DIR: dataDir,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
      WT_READY_FALLBACK_MS: String(FALLBACK_MS),
      ...extraEnv,
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

function rpc(client, method, params = {}, timeoutMs = 8000) {
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

function writesOf(result) {
  return (result.writes || []).map((w) => (typeof w === 'string' ? w : Buffer.from(w.data || w).toString('utf8')));
}

/** The worker's own answer about this session - the only verdict source here. */
async function summary(client, id) {
  const rows = await rpc(client, 'listSessions');
  return (rows.sessions || rows || []).find((s) => s.id === id);
}

test.describe('#190 a startup selector holds the submit gate shut', () => {
  let worker, client, dataDir, pipePath;

  async function start(extraEnv) {
    pipePath = workerPipePath();
    dataDir = makeTempDataDir();
    worker = spawnWorker(pipePath, dataDir, extraEnv);
    client = await connectClient(pipePath);
  }

  test.afterEach(async () => {
    try { client.close(); } catch {}
    if (worker) await worker.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    worker = null;
  });

  /**
   * A Claude session that is genuinely NOT ready yet - which needs an autoCommand.
   *
   * createSession gives a session with NO autoCommand a null readiness marker on
   * purpose (#147: gating it would block the very compose-bar submit that types
   * `claude`), so such a session is ready from birth and is out of scope for this
   * whole file. Found by this spec failing on its first run, which is the useful
   * direction for a test to fail in.
   *
   * The command itself is inert; what matters is that one EXISTS.
   */
  async function claudeSession() {
    const { id } = await rpc(client, 'createSession',
      { cwd: dataDir, name: 'blocked', agent: 'claude', autoCommand: 'echo probe' });
    await sleep(150);
    return id;
  }

  test('it is REPORTED, and survives the #147 readiness ceiling', async () => {
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '0' });
    const id = await claudeSession();

    // Before anything is on screen: not ready (booting), and nothing to explain.
    const booting = await summary(client, id);
    expect(booting.agentReady).toBe(false);
    expect(booting.blockedPrompt).toBeNull();

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });

    const blocked = await summary(client, id);
    expect(blocked.agentReady).toBe(false);
    expect(blocked.blockedPrompt).not.toBeNull();
    expect(blocked.blockedPrompt.id).toBe('folder-trust');
    expect(blocked.blockedPrompt.options).toEqual(['No, exit', 'Yes, I trust this folder']);

    // THE ASSERTION THAT IS RED WITHOUT THE FIX. Past the ceiling, the old code calls
    // `d.force()` and publishes agentReady: true for a session sitting on `No, exit`.
    await sleep(FALLBACK_MS + 400);
    const after = await summary(client, id);
    expect(after.agentReady).toBe(false);
    expect(after.blockedPrompt.id).toBe('folder-trust');
  });

  test('an ordinary boot with nothing recognised still reaches the ceiling', async () => {
    // The other half of the same decision, and the reason the hold is conditional
    // rather than a removal: #147 forbids a session stuck on "starting" forever. A
    // session that shows nothing we recognise must still be freed.
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '0' });
    const id = await claudeSession();

    await rpc(client, '__testInjectOutput', { id, data: 'bash: claude: command not found\r\n' });
    await sleep(FALLBACK_MS + 400);

    const s = await summary(client, id);
    expect(s.agentReady).toBe(true);
    expect(s.blockedPrompt).toBeNull();
  });

  test('A HOOK clears it - the escape that makes the hold unwedgeable', async () => {
    // THE ANTI-WEDGE GUARANTEE, and the most important clear path to pin. #147 is
    // explicit that there must be no state where a live session is stuck refusing to
    // submit; holding the readiness ceiling only narrows that promise to "a POSITIVE
    // event frees it", and a hook is the event that arrives whatever the screen did.
    //
    // It is also the route that needs no shell to stay alive, which makes it the one
    // assertion here that is independent of how long a bash survives.
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '0' });
    const id = await claudeSession();

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });
    await sleep(FALLBACK_MS + 300);            // past the ceiling, still held
    expect((await summary(client, id)).agentReady).toBe(false);

    await rpc(client, 'hookEvent', { id, event: 'UserPromptSubmit' });

    const s = await summary(client, id);
    expect(s.agentReady).toBe(true);
    expect(s.blockedPrompt).toBeNull();
  });

  test('the composer marker ALSO clears it - readiness still scans while held', async () => {
    // The hold must not short-circuit #147's own detector, or answering the dialog in
    // the terminal would leave the gate shut with no hook to open it. This is the
    // ordering claim (blocking detector before readiness detector in processPtyOutput)
    // made observable.
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '0' });
    const id = await claudeSession();

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });
    expect((await summary(client, id)).blockedPrompt).not.toBeNull();

    // WAIT FOR AN EXACT OBSERVATION, NOT A DURATION. #147's readiness scan does not arm
    // until the autoCommand has actually been WRITTEN - a real bash prompt plus
    // AUTO_CMD_SETTLE_MS plus the prime, measured at ~3.7s on this fleet and a different
    // number on every box. A sleep here would be a timer bet, which is this suite's
    // recurring defect rather than flake. `__testGetWrites` says exactly when it landed.
    const deadline = Date.now() + 20000;
    let armed = false;
    let gone = '';
    while (Date.now() < deadline && !armed) {
      // The session can DISAPPEAR under this poll, and the raw RPC rejection
      // ("session not found") names nothing useful. Caught so the assertion below is
      // what reports, and reports the actual cause.
      try {
        armed = writesOf(await rpc(client, '__testGetWrites', { id }))
          .some((x) => x.includes('echo probe'));
      } catch (e) { gone = e.message; break; }
      if (!armed) await sleep(200);
    }
    expect(armed,
      'the worker never wrote the autoCommand, so #147 readiness never armed and this '
        + 'rule was never exercised'
        + (gone ? ` (the session vanished first: ${gone})` : '')
        + '. On a healthy box the shell reaches its prompt in ~3.3s and the command is '
        + 'written at ~3.7s. A box whose consoles are exhausted kills bash at that '
        + 'exact moment - check `Get-CimInstance Win32_Process -Filter "Name=\'OpenConsole.exe\'"`'
        + ' against cygwin\'s ceiling of 32 before treating this as a code failure.').toBe(true);

    await rpc(client, '__testInjectOutput', { id, data: COMPOSER });

    const s = await summary(client, id);
    expect(s.agentReady).toBe(true);
    expect(s.blockedPrompt).toBeNull();
  });

  test('auto-answer OFF (the default) types NOTHING', async () => {
    // The default is off by an explicit decision, so "off means silent" is the
    // behaviour that has to be pinned - not merely the absence of a config key.
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '0' });
    const id = await claudeSession();
    const before = writesOf(await rpc(client, '__testGetWrites', { id })).length;

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });
    await sleep(GAP_MS * 3);

    expect(writesOf(await rpc(client, '__testGetWrites', { id })).slice(before)).toEqual([]);
    // ...and it is still REPORTED. Turning typing off must not turn reporting off.
    expect((await summary(client, id)).blockedPrompt.id).toBe('folder-trust');
  });

  test('auto-answer ON writes the arrows and the CR SEPARATELY', async () => {
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '1' });
    const id = await claudeSession();
    const before = writesOf(await rpc(client, '__testGetWrites', { id })).length;

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });

    // The CR must NOT have gone out with the arrow. #55 is law: one read folds into a
    // paste and swallows the trailing CR, and here that would leave the arrow applied
    // and the dialog unanswered - so the next CR to arrive (a user's submit) confirms
    // whatever row the arrow left highlighted.
    await sleep(Math.max(40, GAP_MS / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id })).slice(before)).toEqual([DOWN]);

    await sleep(GAP_MS + 300);
    expect(writesOf(await rpc(client, '__testGetWrites', { id })).slice(before)).toEqual([DOWN, CR]);
  });

  test('a plain shell is never scanned, whatever its output', async () => {
    // The registry default. A shell that cats a capture, runs a TUI, or prints a caret
    // must never have keys typed into it on our behalf - the same rule that keeps an
    // OSC 9 from a build script off a session's dot.
    await start({ WT_AUTO_ANSWER_BLOCKING_PROMPT: '1' });
    const { id } = await rpc(client, 'createSession',
      { cwd: dataDir, name: 'shell', autoCommand: 'echo probe' });
    await sleep(150);
    const before = writesOf(await rpc(client, '__testGetWrites', { id })).length;

    await rpc(client, '__testInjectOutput', { id, data: TRUST_DIALOG });
    await sleep(GAP_MS * 3);

    const s = await summary(client, id);
    expect(s.blockedPrompt).toBeNull();
    // A shell declares no readiness marker, so it is ready from birth and was never in
    // scope at all - which is the mechanism, and worth asserting rather than implying.
    expect(s.agentReady).toBe(true);
    expect(writesOf(await rpc(client, '__testGetWrites', { id })).slice(before)).toEqual([]);
  });
});
