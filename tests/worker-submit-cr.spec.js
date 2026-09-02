// @ts-check
// The submit fix (#55 §5), driven through the REAL input path.
//
// A prompt sent from chat (or typed+Enter in one burst) reaches the worker as ONE
// TYPE_PTY_IN frame ending in CR. Every agent TUI we ship folds one read into a paste, so
// that CR lands as a newline in its composer and the prompt is never submitted — the bug
// where a chat prompt sat there "Queued" forever. Codex does it at any length; Claude needs
// a bigger read to trip it (measured: atomic `text\r` submitted at 20/40/60 chars, NOT at
// 80 or 120), which is why a short test prompt "worked" and a real one silently parked. The
// worker must write the text now and the CR alone, submitGapMs later.
//
// Ordinary char-by-char typing is untouched: it sends a LONE CR, which is never split.
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

  test('claude: the submit CR is withheld and written alone after the gap', async () => {
    // Claude folds a long read into a paste as well: measured on the real TUI, an
    // atomic `text\r` submitted at 20/40/60 chars but NOT at 80 or 120 — a short prompt
    // worked and a real one was typed and never sent. Splitting submits at any length.
    const id = await newSession('claude');
    const claudeGap = agents.submitPolicy('claude').gapMs;

    typeInto(client, id, 'hello\r');

    await sleep(Math.max(20, claudeGap / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['hello']);

    await sleep(claudeGap);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['hello', '\r']);
  });

  test('plain shell (agent null): the default splits the submit CR too', async () => {
    const id = await newSession(null);
    const gap = agents.submitPolicy(null).gapMs;

    typeInto(client, id, 'ls -la\r');

    await sleep(Math.max(20, gap / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['ls -la']);

    await sleep(gap);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['ls -la', '\r']);
  });

  test('plain shell: ordinary char-by-char typing is NEVER rewritten', async () => {
    // The split only ever touches a frame that is text ENDING in CR (a bulk submit).
    // A shell user typing normally sends single chars and then a LONE CR, which
    // splitTrailingCr leaves alone — so interactive typing is untouched and undelayed.
    const id = await newSession(null);

    typeInto(client, id, 'l');
    typeInto(client, id, 's');
    typeInto(client, id, '\r');
    await sleep(Math.max(40, GAP / 4));

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['l', 's', '\r']);
  });

  test('claude: a multi-line bracketed paste keeps the block whole, delays only the CR', async () => {
    const id = await newSession('claude');
    const ESC = String.fromCharCode(0x1b);
    const block = `${ESC}[200~line one\rline two${ESC}[201~`;
    const claudeGap = agents.submitPolicy('claude').gapMs;

    typeInto(client, id, block + '\r');

    await sleep(Math.max(20, claudeGap / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block]);

    await sleep(claudeGap);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([block, '\r']);
  });

  test('codex: a bare CR is written immediately — nothing precedes it to be pasted', async () => {
    const id = await newSession('codex');

    typeInto(client, id, '\r');
    await sleep(Math.max(20, GAP / 4));

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual(['\r']);
  });

  // An images-only submit, exactly as the companion sends it: the staged image goes out as
  // its own `ESC[200~<path>ESC[201~` frame, and with no prompt text to carry it there is
  // nothing left in the submit frame but a BARE CR. Two frames, microseconds apart — which
  // the TUI reads as one, folding the CR into the paste and swallowing the Enter. Reported
  // on the S25: the image landed on the terminal line and a second Enter was needed.
  //
  // Without the cross-frame rule this test fails on the FIRST assertion: the lone CR is
  // written immediately, in the same breath as the paste close.
  test('claude: an image paste + a bare CR still submits — the CR waits out the gap', async () => {
    const id = await newSession('claude');
    const claudeGap = agents.submitPolicy('claude').gapMs;
    const ESC = String.fromCharCode(0x1b);
    const image = `${ESC}[200~C:\\dev\\web-terminal\\clipboard-images\\clip-1.png${ESC}[201~`;

    typeInto(client, id, image);   // the staged attachment
    typeInto(client, id, '\r');    // buildComposeSubmission('') — nothing but the submit

    await sleep(Math.max(20, claudeGap / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([image]);

    await sleep(claudeGap);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([image, '\r']);
  });

  test('codex: several images then a bare CR — only the last close shades the CR', async () => {
    const id = await newSession('codex');
    const ESC = String.fromCharCode(0x1b);
    const one = `${ESC}[200~/tmp/clip-1.png${ESC}[201~`;
    const two = `${ESC}[200~/tmp/clip-2.png${ESC}[201~`;

    typeInto(client, id, one);
    typeInto(client, id, two);
    typeInto(client, id, '\r');

    await sleep(Math.max(20, GAP / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([one, two]);

    await sleep(GAP);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([one, two, '\r']);
  });

  // The other half of the rule, and the one that keeps interactive use honest: the paste
  // only shades a CR for as long as the agent's own gap. A user who attaches an image and
  // then thinks for a moment before pressing Enter must not be made to wait again.
  test('claude: a bare CR long after the paste is written immediately', async () => {
    const id = await newSession('claude');
    const claudeGap = agents.submitPolicy('claude').gapMs;
    const ESC = String.fromCharCode(0x1b);
    const image = `${ESC}[200~/tmp/clip.png${ESC}[201~`;

    typeInto(client, id, image);
    await sleep(claudeGap + 80);   // the paste has long since been read
    typeInto(client, id, '\r');
    await sleep(30);               // far less than the gap: an undelayed CR is already out

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([image, '\r']);
  });

  test('claude: a later keystroke clears the paste — the CR after it is not delayed', async () => {
    // Pins the shading to the LAST bytes written rather than to a sticky "this session has
    // pasted" flag: once anything else has gone down the wire, the paste is behind us and
    // every subsequent lone CR is an ordinary lone CR again. Without this, one image attach
    // would slow every Enter for the rest of the session.
    const id = await newSession('claude');
    const ESC = String.fromCharCode(0x1b);
    const image = `${ESC}[200~/tmp/clip.png${ESC}[201~`;

    typeInto(client, id, image);
    typeInto(client, id, 'x');
    typeInto(client, id, '\r');
    await sleep(40);

    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([image, 'x', '\r']);
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

  // Renaming a session mirrors the new name into Claude's TUI as `/rename <name>`.
  // That injection wrote a raw LF and bypassed submitLine entirely, so the slash
  // command was TYPED into the prompt box and a newline added — never submitted.
  // It is the same LF-is-not-Enter bug submitLine's own comment records having
  // broken auto-continue; this call site was simply never migrated. Gated on the
  // real RPC so the fix is proven through the path the app actually uses.
  test('renameSession submits /rename with a split CR — never an LF', async () => {
    // The rename mirror only fires for a Claude session; `echo claude` satisfies
    // that guard without launching a real agent from the test suite.
    const { id } = await rpc(client, 'createSession', {
      cwd: dataDir, name: 'Before', agent: 'claude', autoCommand: 'echo claude',
    });
    await sleep(400); // let the PTY + autoCommand settle so we snapshot cleanly
    const before = writesOf(await rpc(client, '__testGetWrites', { id })).length;

    await rpc(client, 'renameSession', { id, name: 'My New Name' });

    const claudeGap = agents.submitPolicy('claude').gapMs;
    await sleep(claudeGap + 200);
    const after = writesOf(await rpc(client, '__testGetWrites', { id })).slice(before);

    // Text first, then the CR ALONE — the split that stops the TUI folding the
    // whole burst into a paste and swallowing the Enter.
    expect(after).toEqual(['/rename My New Name', '\r']);
    // The original bug, pinned explicitly: no LF may reach the PTY.
    expect(after.join('')).not.toContain('\n');
  });
});

// --- the long DICTATED prompt (#213), driven through the real input path ------
//
// Reported 2026-09-02: a ~1500-character dictated prompt looked complete in the compose
// box and reached the terminal as its tail alone. Dictation emits no line breaks, and
// `buildComposeSubmission` brackets on exactly one predicate — does the buffer contain a
// newline — so a dictated paragraph is the one long prompt still handed to the TUI raw.
// Measured on the rig (probe-paste-single-line.js, claude 2.1.251, verdict from the
// transcript): unbracketed is whole at 988 and loses its first 1024 characters EXACTLY at
// 1588, twice; bracketed is whole at 588/1588/2588.
//
// The client is unchanged and unaware — this is the worker correcting the bytes where they
// meet the PTY, the same place and the same reason as the CR split above.
test.describe('a long single-line submit is declared a paste (#213)', () => {
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
    await sleep(150);
    await rpc(client, '__testGetWrites', { id });
    return id;
  }

  const ESC = String.fromCharCode(0x1b);
  const OPEN = ESC + '[200~';
  const CLOSE = ESC + '[201~';
  const CLAUDE_GAP = agents.submitPolicy('claude').gapMs;
  const LIMIT = agents.submitPolicy('claude').bracketAbove;

  test('claude: a newline-free prompt over the threshold is wrapped, CR still split', async () => {
    const id = await newSession('claude');
    // The reported shape: one long line, no newline anywhere, so the client sends it raw.
    const dictated = 'so first we want to reflect the user if there is a problem '.repeat(26);
    expect(dictated).not.toContain('\n');
    expect(dictated.length).toBeGreaterThan(1024);

    typeInto(client, id, dictated + '\r');

    // The body goes out NOW, wrapped — and the CR is still withheld, because wrapping a
    // body must not cost it the split that makes its Enter an Enter.
    await sleep(Math.max(20, CLAUDE_GAP / 4));
    expect(writesOf(await rpc(client, '__testGetWrites', { id })))
      .toEqual([OPEN + dictated + CLOSE]);

    await sleep(CLAUDE_GAP * 2);
    expect(writesOf(await rpc(client, '__testGetWrites', { id })))
      .toEqual([OPEN + dictated + CLOSE, '\r']);
  });

  test('claude: a prompt UNDER the threshold is byte-identical to before', async () => {
    const id = await newSession('claude');
    const short = 'x'.repeat(LIMIT - 1);

    typeInto(client, id, short + '\r');

    await sleep(CLAUDE_GAP * 2);
    // No markers anywhere: ordinary prompts must keep the exact bytes they had.
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([short, '\r']);
  });

  // Undeclared means never — the behaviour every agent had before the field existed. A
  // shell whose readline has bracketed paste off would take the markers as literal text.
  test('plain shell: a long prompt is NOT wrapped — it declares no threshold', async () => {
    const id = await newSession(null);
    const gap = agents.submitPolicy(null).gapMs;
    const long = 'y'.repeat(2000);

    typeInto(client, id, long + '\r');

    await sleep(gap * 2);
    expect(writesOf(await rpc(client, '__testGetWrites', { id }))).toEqual([long, '\r']);
  });

  test('claude: an already-bracketed multi-line paste is passed through untouched', async () => {
    const id = await newSession('claude');
    // What the client sends for a multi-line buffer today. It must not be double-wrapped:
    // the body carries ESC, so the rule refuses it rather than trying to sanitise it.
    const body = OPEN + 'line one\rline two\r'.repeat(80) + CLOSE;
    expect(body.length).toBeGreaterThan(LIMIT);

    typeInto(client, id, body + '\r');

    await sleep(CLAUDE_GAP * 2);
    const writes = writesOf(await rpc(client, '__testGetWrites', { id }));
    expect(writes).toEqual([body, '\r']);
    expect(writes[0].startsWith(OPEN + OPEN)).toBe(false);
  });
});
