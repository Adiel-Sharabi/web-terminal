// @ts-check
// #228 - the cap-prompt detector has NEVER matched in production, and an absence
// cannot say why.
//
// `usage-limit:` (logged unconditionally by detectUsageLimitPromptInOutput the
// moment matchUsageLimitPrompt returns an answer) appears ZERO times in this
// fleet's worker log, which spans 2026-04-19 to 2026-09-11 and contains all three
// real 5h cap events. Re-confirmed 2026-09-11 with a POSITIVE CONTROL, because a
// negative sweep that silently finds nothing confirms whatever you hoped for: the
// same grep finds `usage` 7 times in that file, none of them this line. Every
// arming came from the metrics route instead.
//
// Four things could be true and nobody has looked: the selector is no longer
// rendered; it is rendered but does not survive stripAnsiForScan; it survives but
// MENU_OPTION_LINE's sibling-option rule does not hold; or it was never drawn. So
// the instrument writes down what the terminal WAS showing at the one moment that
// state is entered, and the three facts it reports separate all four cases.
//
// WHAT THIS SPEC IS REALLY GUARDING. Two things, and neither is "the log line
// exists":
//   1. the sample cannot leak. It lands in logs/error.log, which is read over
//      /api/exec and pasted into PUBLIC issues. The negative assertion in "nothing
//      but wording survives" is the load-bearing one, so it is written with a
//      POSITIVE CONTROL beside it - an empty sample would satisfy it for free.
//   2. the matcher was not loosened. That is the one fix #228 rules out in bold: a
//      loosened matcher makes this repo's own source type a digit into a live
//      composer. The rule's own cases live in tests/usage-limit.spec.js and are not
//      copied here; what is asserted here is that reading it through the instrument
//      gives the same answers.
//
// THE TRIGGER PHRASE IS DERIVED, NEVER TYPED. Every fixture below builds the
// sentence from the registry's own pattern at run time, so this FILE contains no
// copy of it and can never become the trigger that #138 exists to prevent - which
// is why it is absent from the file list in tests/usage-limit.spec.js's "this
// repo's own source is not a trigger phrase". The guard on SENTENCE below says the
// derivation is still a literal string rather than a regex with metacharacters in
// it.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ipc = require('../lib/ipc');
const agents = require('../lib/agents');
const capSample = require('../lib/cap-sample');

const CFG = agents.usageLimitPromptFor('claude');
const SENTENCE = CFG.pattern.source;

const ESC = String.fromCharCode(27);        // never a raw control byte in this file
const BS = String.fromCharCode(92);         // a backslash, so a Windows path is real
const CARET = String.fromCodePoint(0x276f); // the selection cursor the TUI draws
const CRLF = '\r\n';

/** The captured render's SHAPE, with the sentence derived rather than copied. */
function render(sentence) {
  return [
    '',
    'What do you want to do?',
    CARET + ' 1. ' + sentence,
    '  2. Upgrade your plan',
    '  3. Upgrade to Team plan',
    '',
    'Enter to confirm',
    '',
  ].join(CRLF);
}

/** pty-worker.js's stripAnsiForScan, which is what the detector sees. */
function strip(s) {
  return s.replace(new RegExp(ESC + BS + '[[0-9;?]*[ -/]*[@-~]', 'g'), '');
}

const textOf = (d) => d.lines.map((l) => l.text).join(' ');

test.describe('#228 - lib/cap-sample.js, the pure rules', () => {
  test('the fixture derivation is still a literal sentence', () => {
    // If the registry's pattern ever gains metacharacters, every fixture below
    // quietly stops containing the sentence and every assertion starts measuring
    // something else. Fail here instead, where the reason is visible.
    expect(/^[A-Za-z ]+$/.test(SENTENCE)).toBe(true);
  });

  test('hypothesis 1/2 vs 3: the real render reports all three facts positive', () => {
    const raw = 'some earlier output' + CRLF + render(SENTENCE);
    const d = capSample.describeCapTail(raw, strip(raw), CFG);
    expect(d.sentenceInRaw).toBe(true);
    expect(d.sentenceInStripped).toBe(true);
    expect(d.optionLines).toBe(3);
    expect(d.matcherAnswer).toBe('1');
    expect(d.anchored).toBe(true);
    // The option rows reach the log MARKED, which is the evidence the sibling rule
    // is questioned on. Redaction erases the caret and the box glyphs (they are
    // outside the surviving character class), so `opt` is the only way a reader can
    // see what MENU_OPTION_LINE thought of each line.
    expect(d.lines.filter((l) => l.opt).length).toBe(3);
  });

  test('hypothesis 4: nothing on screen reports every fact negative', () => {
    const raw = ('a plain shell doing ordinary work' + CRLF).repeat(40);
    const d = capSample.describeCapTail(raw, strip(raw), CFG);
    expect(d.sentenceInRaw).toBe(false);
    expect(d.sentenceInStripped).toBe(false);
    expect(d.optionLines).toBe(0);
    expect(d.matcherAnswer).toBeNull();
    expect(d.anchored).toBe(false);
    expect(d.lines.length).toBeGreaterThan(0);   // the tail is still written down
  });

  test('hypothesis 3: a render the stripper leaves prefixed is PRESENT but unmatchable', () => {
    // A COLON-form SGR (ECMA-48 allows it; stripAnsiForScan's parameter class is
    // `[0-9;?]` and does not, which is the drift #192 recorded). The sentence is
    // contiguous in the raw bytes, so it survives into the stripped text - but the
    // line now starts with an un-stripped escape instead of a number, so
    // MENU_OPTION_LINE cannot see an option there.
    const raw = ['', ESC + '[38:5:196m1. ' + SENTENCE, ESC + '[38:5:196m2. Upgrade your plan', ''].join(CRLF);
    const d = capSample.describeCapTail(raw, strip(raw), CFG);
    expect(d.sentenceInRaw).toBe(true);
    expect(d.sentenceInStripped).toBe(true);
    expect(d.optionLines).toBe(0);
    expect(d.matcherAnswer).toBeNull();
  });

  test('hypothesis 3: a CURSOR-POSITIONED repaint carries a whole screen on one line', () => {
    // A TUI need not emit a newline per row - it can position with CUP and rewrite.
    // Stripped, the rows run together, and a ^-anchored option rule can never match.
    // This is the case the per-line chunking exists to keep readable.
    const glued = 'What do you want to do?' + ESC + '[3;1H' + CARET + ' 1. ' + SENTENCE
      + ESC + '[4;1H' + '  2. Upgrade your plan';
    const d = capSample.describeCapTail(glued, strip(glued), CFG);
    expect(d.sentenceInStripped).toBe(true);
    expect(d.optionLines).toBe(0);
    expect(d.matcherAnswer).toBeNull();
  });

  test('the barriers are read, not loosened: a lone option is still prose', () => {
    // The rule's own cases are in tests/usage-limit.spec.js and are deliberately not
    // duplicated. This says only that #228's instrument did not quietly relax them,
    // which is the one fix the issue rules out.
    const lone = ['', '1. ' + SENTENCE, ''].join(CRLF);
    expect(capSample.describeCapTail(lone, strip(lone), CFG).matcherAnswer).toBeNull();
    const prose = 'I would ' + SENTENCE.toLowerCase() + ', but I will not.';
    expect(capSample.describeCapTail(prose, strip(prose), CFG).matcherAnswer).toBeNull();
  });

  test('an agent with no declared selector reports nothing and claims nothing', () => {
    const raw = render(SENTENCE);
    const d = capSample.describeCapTail(raw, strip(raw), null);
    expect(d.sentenceInRaw).toBe(false);
    expect(d.sentenceInStripped).toBe(false);
    expect(d.matcherAnswer).toBeNull();
  });

  test('nothing but wording survives into the sample', () => {
    // THE LOAD-BEARING NEGATIVE. Every specific below is a shape that has actually
    // appeared in this fleet's terminals. The positive control at the end is what
    // stops an empty sample from satisfying the whole test for free.
    const specifics = [
      'C:' + BS + 'Users' + BS + 'adiel' + BS + 'secrets' + BS + 'id_rsa',
      '~/.ssh/config',
      './src/secret.env',
      // ASSEMBLED, NOT WRITTEN. scripts/check-no-secrets.js scans SOURCE for an
      // Anthropic-key shape and a MagicDNS hostname shape, and a fixture that must
      // PROVE those get redacted would otherwise trip the repo's own scanner.
      // Splitting the literal keeps the runtime value byte-identical - the thing
      // under test is unchanged - while leaving no match in the file. Weakening the
      // fixture instead would have quietly stopped testing the shape that matters.
      //
      // The patterns are described in WORDS on purpose. The first draft of this
      // comment quoted them as regexes, and the word-boundary escape in them was
      // read as an escape by the editing channel and written as a literal U+0008 -
      // three of them, in a comment about a safety gate, caught by a DIFFERENT
      // safety gate (tests/control-bytes.spec.js). That is the recorded hazard
      // exactly: an escape written through a channel that interprets it arrives as
      // the control character, and no renderer shows you.
      'sk-ant-' + 'api03-abcdefabcdefabcdefabcdef',
      'someone@example.com',
      'https://a-host.example.ts' + '.net/s/abc',
      'deadbeefcafebabe0123456789abcdef',
      '3289c196-1018-44db-80c1-4400071d4b90',
    ];
    const raw = ('reading ' + specifics.join(' and ') + ' ok' + CRLF).repeat(12);
    const d = capSample.describeCapTail(raw, strip(raw), CFG);
    const out = textOf(d);
    for (const s of specifics) expect(out, `whole specific must not survive: ${s}`).not.toContain(s);
    // ...and not as a FRAGMENT either. A token rule cannot see across a space, so a
    // half-redacted path is the failure mode that has already cost this repo a real
    // leak (lib/notification-shape.js's own `_looksLikePath` note).
    for (const frag of ['id_rsa', 'secret.env', 'sk-' + 'ant', 'example.com', 'ts' + '.net', 'deadbeef', '4400071d']) {
      expect(out, `fragment must not survive: ${frag}`).not.toContain(frag);
    }
    // POSITIVE CONTROL: the sample is not empty, and the WORDING - the entire
    // product of the redaction - came through.
    expect(d.lines.length).toBeGreaterThan(0);
    expect(out).toContain('reading');
    expect(out).toContain('<path>');
  });

  test('a very long line is BROKEN, not truncated away', () => {
    // redactNotificationMessage caps at 200 characters, so a screen that arrived as
    // one 3000-character line would otherwise reach the log as its first 200 - and
    // that shape is itself one of the four hypotheses, so losing its tail would
    // destroy the evidence for the thing being measured.
    const long = 'alpha ' + 'padding '.repeat(360) + 'omega';
    expect(long.length).toBeGreaterThan(2000);
    const d = capSample.describeCapTail(long, long, CFG);
    expect(d.lines.length).toBeGreaterThan(1);
    for (const l of d.lines) expect(l.len).toBeLessThanOrEqual(capSample.CAP_LINE_CHARS);
    // Both ENDS of the line reached the log. The far end is the one a per-line cap
    // would have thrown away.
    const out = textOf(d);
    expect(out).toContain('alpha');
    expect(out).toContain('omega');
  });

  test('the cooldown lets a genuine second cap event through', () => {
    const t = 1_700_000_000_000;
    expect(capSample.shouldSampleCapTail(null, t)).toBe(true);
    expect(capSample.shouldSampleCapTail(t, t + 1000)).toBe(false);
    expect(capSample.shouldSampleCapTail(t, t + capSample.CAP_SAMPLE_COOLDOWN_MS)).toBe(true);
    // It guards a flap around isCapBlocked's own boundary, which is
    // CAP_BLOCK_GRACE_MS (10 minutes) past the resume moment - so it must clear that
    // - while staying far below the 5h window, so the next real cap event is still
    // captured.
    const { CAP_BLOCK_GRACE_MS } = require('../lib/usage-limit');
    expect(capSample.CAP_SAMPLE_COOLDOWN_MS).toBeGreaterThan(CAP_BLOCK_GRACE_MS);
    expect(capSample.CAP_SAMPLE_COOLDOWN_MS).toBeLessThan(5 * 60 * 60 * 1000);
  });
});

// --- the wiring, driven through the REAL worker ------------------------------
// The rules above are pure; what they cannot show is that the worker calls them at
// the right instant and only then. These spawn pty-worker.js on its own pipe and
// send real frames, the pattern tests/worker-submit-cr.spec.js established.
//
// WT_WORKER_QUIET is deliberately NOT set here (that spec sets it): the log line IS
// the product, so the worker's stdout is the thing under test.

function workerPipePath() {
  return process.platform === 'win32'
    ? `${BS}${BS}.${BS}pipe${BS}wt-capsample-test-${crypto.randomUUID()}`
    : `/tmp/wt-capsample-test-${crypto.randomUUID()}.sock`;
}

function makeTempDataDir() {
  const dir = path.join(os.tmpdir(), 'wt-capsample-data-' + crypto.randomUUID());
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
      WT_WORKER_NO_DEFAULT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  proc.stdout.on('data', (b) => { out += b.toString('utf8'); });
  proc.stderr.on('data', (b) => { out += b.toString('utf8'); });
  return {
    proc,
    output: () => out,
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

/**
 * Poll the worker's stdout until `pred` holds. A POSITIVE assertion behind a fixed
 * timer is flaky and a NEGATIVE one is vacuous, so every negative below is ordered
 * behind a positive that polls: the barrier session's sample is written AFTER the
 * moment the absent one would have been, so once it appears the absence is a fact
 * rather than a race.
 */
async function waitForOutput(worker, pred, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred(worker.output())) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/**
 * Every line of one session's sample - the summary AND the body.
 *
 * Matched on the id's 8-character prefix, because that is what the BODY lines
 * carry (the summary carries the whole id, which contains the prefix). Filtering on
 * the full id was the first cut and it silently found the summary only, reporting
 * zero option rows for a sample that had three - an absence produced by the query,
 * which is the #228 disease in miniature. Caught by driving the real worker.
 */
const capSampleLinesFor = (worker, id) =>
  worker.output().split('\n').filter((l) => l.includes('cap-sample') && l.includes(id.slice(0, 8)));

test.describe('#228 - the worker samples the tail at the cap transition', () => {
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

  async function claudeSession(name) {
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name, agent: 'claude' });
    await sleep(150); // let the PTY settle
    return id;
  }

  const goCapBlocked = (id) => rpc(client, 'setFiveHResetAt', {
    id, fiveHResetAt: Date.now() + 3600_000, capBlocked: true, enabled: true,
  });

  test('a cap block with NO sighting writes the sample; one WITH a sighting does not', async () => {
    // SEEN: feed the render through the real PTY-output path, so the real detector
    // matches it and sets limitPromptAt. That doubles as a positive control on the
    // detector itself against the captured render's shape.
    const seen = await claudeSession('seen');
    await rpc(client, '__testInjectOutput', { id: seen, data: render(SENTENCE) });
    expect(await waitForOutput(worker, (o) => o.includes('usage-limit:') && o.includes(seen)),
      'the detector must fire for the session that HAS a sighting').toBe(true);

    // UNSEEN: put the same bytes in the scrollback WITHOUT running them past the
    // detector, which is the production shape - the selector was drawn, the detector
    // did not match it, and the metrics route noticed the block instead.
    const unseen = await claudeSession('unseen');
    await rpc(client, '__testInjectScrollbackBytes', {
      id: unseen, hex: Buffer.from(render(SENTENCE), 'utf8').toString('hex'),
    });

    await goCapBlocked(seen);
    await goCapBlocked(unseen);

    expect(await waitForOutput(worker, (o) => o.includes('cap-sample:') && o.includes(unseen)),
      'the session with no sighting must be sampled').toBe(true);
    // Ordered behind the line above: the unseen sample was written after the seen
    // one's opportunity, so its absence now is an absence, not a race.
    expect(capSampleLinesFor(worker, seen), 'a session that already SAW the prompt is not sampled').toEqual([]);

    // The sample carries the evidence #228 asked for: the sentence in the raw bytes
    // AND after the strip, option rows the matcher recognised, and the answer it
    // would have given.
    const summary = capSampleLinesFor(worker, unseen).find((l) => l.includes('cap-sample:'));
    expect(summary).toContain('sentence(raw=true stripped=true)');
    expect(summary).toContain('optionLines=3');
    expect(summary).toContain('matcher="1"');
    expect(capSampleLinesFor(worker, unseen).filter((l) => l.includes('OPT')).length).toBeGreaterThan(0);
  });

  test('a flap inside the cooldown does not write a second sample', async () => {
    const a = await claudeSession('flapper');
    await rpc(client, '__testInjectScrollbackBytes', {
      id: a, hex: Buffer.from(render(SENTENCE), 'utf8').toString('hex'),
    });
    await goCapBlocked(a);
    expect(await waitForOutput(worker, (o) => o.includes('cap-sample:') && o.includes(a))).toBe(true);
    const first = capSampleLinesFor(worker, a).length;
    expect(first).toBeGreaterThan(0);

    // false, then true again: a second genuine TRANSITION, inside the cooldown.
    await rpc(client, 'setFiveHResetAt', { id: a, capBlocked: false });
    await goCapBlocked(a);

    // A second session is the ordering barrier - its sample is written after the
    // flap's would have been, so the count below is a fact rather than a timing bet.
    const b = await claudeSession('barrier');
    await goCapBlocked(b);
    expect(await waitForOutput(worker, (o) => o.includes('cap-sample:') && o.includes(b))).toBe(true);

    expect(capSampleLinesFor(worker, a).length, 'the cooldown must suppress the second sample').toBe(first);
  });
});
