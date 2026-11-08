// @ts-check
// #418 - the worker answers ConPTY's startup DA1 query, so a new shell is not held ~3 s.
//
// ConPTY (node-pty's bundled conpty.dll, `useConptyDll: true`) writes
// `ESC[1t ESC[c ESC[?1004h ESC[?9001h` at spawn and HOLDS the child until its DA1 query
// is answered or ~3.2 s pass. No viewer is attached at spawn, so the worker answers it
// itself (lib/conpty-startup.js): once, inside ConPTY's preamble, within 1.5 s.
//
// These run a REAL pty-worker.js on an isolated pipe and read the REAL PTY bytes the
// worker received (getScrollback), timing the first printable output (the bash prompt)
// from createSession. The control (WT_CONPTY_DA1_REPLY=0) proves the premise on the
// installed ConPTY: without the reply the hold is back. The rules that cannot be
// reached through a real spawn (the window, a coalesced preamble) are pinned in
// tests/conpty-startup.spec.js.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { connectClient, rpc, stopWorker } = require('./worker-ipc');   // #262 - one owner for the budget
const { DA1_REPLY } = require('../lib/conpty-startup');
const { stripAnsi } = require('../lib/ansi');

const ESC = String.fromCodePoint(0x1b);
const DA1_QUERY = ESC + '[c';
const PRINTABLE_RE = /[^\x00-\x20\x7f]/;

// Answered, the prompt came at ~250 ms (Home, 2026-11-07/08); unanswered at ~3260 ms.
// The bounds sit far from both, with headroom for a loaded CI box.
const FAST_MS = 1500;
const HELD_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('#418 ConPTY startup DA1 reply (real worker, real PTY)', () => {
  test.skip(process.platform !== 'win32', 'ConPTY is Windows-only');

  let worker, client, dataDir;

  async function start(extraEnv = {}) {
    const pipe = `\\\\.\\pipe\\wt-worker-test-${crypto.randomUUID()}`;
    dataDir = path.join(os.tmpdir(), 'wt-worker-data-' + crypto.randomUUID());
    fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'pty-worker.js')], {
      env: {
        ...process.env,
        WT_TEST: '1',
        WT_WORKER_PIPE: pipe,
        WT_WORKER_DATA_DIR: dataDir,
        WT_WORKER_QUIET: '1',
        WT_WORKER_NO_DEFAULT: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    worker = { proc, stop: () => stopWorker(proc) };
    client = await connectClient(pipe);
  }

  test.afterEach(async () => {
    try { client.close(); } catch {}
    if (worker) await worker.stop();
    worker = null;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  /** Creates a plain shell and times its first printable PTY output from the create. */
  async function timeFirstPrompt(name) {
    const t0 = Date.now();
    const { id } = await rpc(client, 'createSession', { cwd: dataDir, name, autoCommand: '' });
    const deadline = t0 + 12000;
    let sb = '';
    for (;;) {
      sb = String((await rpc(client, 'getScrollback', { id })).data || '');
      const afterQuery = sb.includes(DA1_QUERY) ? sb.slice(sb.indexOf(DA1_QUERY) + DA1_QUERY.length) : '';
      if (PRINTABLE_RE.test(stripAnsi(afterQuery))) break;
      // Setup failures ABORT; they are never read as a result.
      if (Date.now() > deadline) throw new Error(`setup: no prompt after ConPTY's query in 12 s; scrollback=${JSON.stringify(sb.slice(0, 400))}`);
      await sleep(25);
    }
    const elapsed = Date.now() - t0;
    // The premise: ConPTY really asked, and asked before the shell printed anything.
    const before = sb.slice(0, sb.indexOf(DA1_QUERY));
    expect(PRINTABLE_RE.test(stripAnsi(before)), `printable output before the query: ${JSON.stringify(before)}`).toBe(false);
    const got = await rpc(client, '__testGetWrites', { id });
    return { id, elapsed, got };
  }

  test('the query is answered exactly once and the prompt comes well under the ~3 s hold', async () => {
    await start();
    const { id, elapsed, got } = await timeFirstPrompt('fast');
    expect(got.terminalReplies).toEqual([DA1_REPLY]);
    expect(got.writes, 'the reply is the terminal\'s, never typed input').toEqual([]);
    expect(elapsed, 'the shell waited out ConPTY\'s DA1 timeout').toBeLessThan(FAST_MS);

    // A program that asks DA1 LATER (vim, an agent TUI) never gets a worker-written answer:
    // the same per-chunk path as real output, after the shell has drawn its prompt.
    await rpc(client, '__testInjectOutput', { id, data: DA1_QUERY });
    await rpc(client, '__testInjectOutput', { id, data: ESC + '[0c' });
    await sleep(200);
    const after = await rpc(client, '__testGetWrites', { id });
    expect(after.terminalReplies).toEqual([DA1_REPLY]);
    expect(after.writes).toEqual([]);
  });

  test('every session gets its own single answer (two at once)', async () => {
    await start();
    const [a, b] = await Promise.all([timeFirstPrompt('a'), timeFirstPrompt('b')]);
    for (const s of [a, b]) {
      expect(s.got.terminalReplies).toEqual([DA1_REPLY]);
      expect(s.elapsed).toBeLessThan(FAST_MS);
    }
  });

  test('control: with the reply off (WT_CONPTY_DA1_REPLY=0) ConPTY holds the shell again', async () => {
    await start({ WT_CONPTY_DA1_REPLY: '0' });
    const { elapsed, got } = await timeFirstPrompt('held');
    expect(got.terminalReplies).toEqual([]);
    expect(elapsed, 'ConPTY no longer holds an unanswered shell - the reply may be unnecessary').toBeGreaterThan(HELD_MS);
  });
});
