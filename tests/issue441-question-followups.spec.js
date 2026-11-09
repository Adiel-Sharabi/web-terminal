// @ts-check
// #441 - follow-ups to #423 (a rejected question clears from the transcript).
//
// 1. Esc on a question in the terminal rejects it with no hook, like Chat - but then the
//    turn is OVER. MEASURED on claude 2.1.319 (2026-11-09, isolated rig, hooks captured):
//    3 Esc runs (compact single, side-by-side, multi-select) fired no hook at all after
//    the Esc (not even the idle Notification, watched 57-75 s); the result line's
//    `toolUseResult` is the plain "User rejected tool use", and the line after it is
//    "[Request interrupted by user for tool use]". 5 Chat runs wrote an "Error: ..." string
//    there and fired Stop 2.2-2.6 s after the key. Before this the session read 'working' after an
//    Esc until the 5-minute stale rule; now it reads idle.
// 4. The row poll that clears the question used to return status 'waiting' with
//    waitingFor null (the worker's status was read before the clear reached it).
// 5. A failed transcript read must not mark the file's size and mtime as seen.
//
// Drives the real path: POST /api/hook -> server -> worker; the transcript is a fixture
// under the trusted Claude projects root (safeTranscriptPath), appended to as Claude would.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BASE, AUTH, readHookToken, claudeProjectsRoot } = require('./test-helpers');
const { toolResultOutcome } = require('../lib/transcript');

const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-441-fixture__');
const WATCH_MS = 1000; // server.js QUESTION_WATCH_MS
const OUTLAST_MS = 2 * WATCH_MS + 600; // a negative must outlast the timer that would flip it
let _n = 0;

const TOOL_INPUT = {
  questions: [{
    header: 'Plan', question: 'Which parts?', multiSelect: true,
    options: [{ label: 'Delete now' }, { label: 'Prevent it' }],
  }],
};

// The three result lines Claude writes for an AskUserQuestion, as measured (#441/#423).
const ESC_RESULT = 'User rejected tool use';
const CHAT_RESULT = 'Error: The user doesn\'t want to proceed with this tool use. The tool use was rejected';

function writeTranscript() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `wt_441_${process.pid}_${++_n}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ask me' }] },
  }) + '\n', 'utf8');
  return p;
}

const toolUseLine = (id) => JSON.stringify({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [
  { type: 'tool_use', id, name: 'AskUserQuestion', input: TOOL_INPUT },
] } });
const resultLine = (id, toolUseResult) => JSON.stringify({
  type: 'user', toolUseResult, toolDenialKind: 'user-rejected',
  message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: id, is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' },
  ] },
});
const interruptLine = () => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
});

/** What Claude appends on Esc: the tool_use, the plain rejection, then the interrupt line. */
function appendEsc(p, id) {
  fs.appendFileSync(p, [toolUseLine(id), resultLine(id, ESC_RESULT), interruptLine()].join('\n') + '\n', 'utf8');
}
/** What Claude appends on "Chat about this": the tool_use and the "Error: ..." rejection. */
function appendChat(p, id) {
  fs.appendFileSync(p, [toolUseLine(id), resultLine(id, CHAT_RESULT)].join('\n') + '\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('#441 toolResultOutcome (pure)', () => {
  test('null until a tool_result for THAT id exists; matched by id only', () => {
    const text = [toolUseLine('toolu_a'), resultLine('toolu_b', ESC_RESULT)].join('\n');
    expect(toolResultOutcome(text, 'toolu_a')).toBeNull();
    expect(toolResultOutcome(text, 'toolu_b')).toEqual({ interrupted: true });
    expect(toolResultOutcome('', 'toolu_a')).toBeNull();
    // The id quoted in a text block is not a result.
    expect(toolResultOutcome(JSON.stringify({ message: { content: [{ type: 'text', text: 'toolu_a' }] } }), 'toolu_a')).toBeNull();
  });

  test('only the plain rejection is an interrupt: Chat, an answer and no field are not', () => {
    expect(toolResultOutcome(resultLine('toolu_c', CHAT_RESULT), 'toolu_c')).toEqual({ interrupted: false });
    expect(toolResultOutcome(resultLine('toolu_c', { questions: [], answers: { a: 'b' } }), 'toolu_c'))
      .toEqual({ interrupted: false });
    expect(toolResultOutcome(resultLine('toolu_c', undefined), 'toolu_c')).toEqual({ interrupted: false });
    // The interrupt LINE alone does not make an answered result an interrupt: the field
    // on the result line is what is read.
    expect(toolResultOutcome([resultLine('toolu_c', CHAT_RESULT), interruptLine()].join('\n'), 'toolu_c'))
      .toEqual({ interrupted: false });
  });
});

test.describe('#441 the server after a rejected question', () => {
  let ctx, raw, id, tpath;

  const hook = async (data) => {
    const r = await raw.post('/api/hook', { headers: { 'X-WT-Session-ID': id }, data });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const ask = (toolUseId) => hook({
    hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: TOOL_INPUT,
    transcript_path: tpath, tool_use_id: toolUseId,
  });
  const pending = async () => (await (await ctx.get(`/api/sessions/${id}/pending-question`)).json()).pending;
  const row = async () => {
    const list = await (await ctx.get('/api/sessions')).json();
    return (Array.isArray(list) ? list : list.sessions || []).find((s) => s.id === id);
  };

  test.beforeAll(async () => {
    const login = await pwRequest.newContext({ baseURL: BASE });
    const res = await login.post('/login', { form: { user: AUTH.user, password: AUTH.password }, maxRedirects: 0 });
    const cookie = String(res.headers()['set-cookie'] || '').split(';')[0];
    await login.dispose();
    expect(cookie).toBeTruthy();
    ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: cookie } });
    raw = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });
  });

  test.afterAll(async () => {
    if (ctx) await ctx.dispose();
    if (raw) await raw.dispose();
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {}
  });

  test.beforeEach(async () => {
    tpath = writeTranscript();
    id = (await (await ctx.post('/api/sessions', { data: { name: `Q441-${Date.now()}` } })).json()).id;
    expect(id).toBeTruthy();
  });

  test.afterEach(async () => {
    if (id) await ctx.delete(`/api/sessions/${id}`);
    id = null;
  });

  test('Esc: the question clears and the session reads IDLE, never a permission prompt', async () => {
    expect((await ask('toolu_441_esc')).status).toBe('waiting');
    appendEsc(tpath, 'toolu_441_esc');
    // Every row read on the way must agree with itself: 'waiting' with no question would
    // be published as waitingFor 'permission' (a Stop alone holds 'waiting' through the
    // worker's idle debounce).
    const seen = [];
    await expect.poll(async () => {
      const r = await row();
      seen.push(`${r.status}/${r.waitingFor}`);
      return r.status;
    }, { timeout: 4 * WATCH_MS, intervals: [50] }).toBe('idle');
    expect(seen.filter((s) => s.endsWith('/permission'))).toEqual([]);
    expect(await pending()).toBe(false);
    expect((await row()).waitingFor).toBeNull();
  });

  test('Chat: the question clears and the session stays WORKING (Claude replies, then its own Stop)', async () => {
    expect((await ask('toolu_441_chat')).status).toBe('waiting');
    appendChat(tpath, 'toolu_441_chat');
    await expect.poll(async () => (await row()).status, { timeout: 4 * WATCH_MS }).toBe('working');
    await sleep(OUTLAST_MS);
    expect((await row()).status).toBe('working');
    expect(await pending()).toBe(false);
  });

  test('the row poll that clears the question already reads its new status', async () => {
    // Several rounds: the 1 s timer can win the race to the clear in any one of them, and
    // then the round proves nothing - so every round must agree, and most rounds are the
    // poll's own clear.
    for (let i = 0; i < 4; i++) {
      const tid = `toolu_441_poll_${i}`;
      expect((await ask(tid)).status).toBe('waiting');
      appendChat(tpath, tid);
      const r = await row();
      expect({ status: r.status, waitingFor: r.waitingFor }, `round ${i}`).toEqual({ status: 'working', waitingFor: null });
    }
  });

  test('a failed transcript read is looked at again without another write', async () => {
    test.skip(process.platform !== 'win32', 'locks a byte range the Windows way');
    expect((await ask('toolu_441_busy')).status).toBe('waiting');
    // Lock the transcript's FIRST BYTE (LockFileEx, from another process): a read that
    // covers it fails with EBUSY while a stat, an open and an append at the end all still
    // work - exactly a read that fails while the file is busy. (A share mode does not do
    // it: node opens a file held with FileShare.None for reading without complaint.)
    const lockMs = 3 * WATCH_MS;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$f = [System.IO.File]::Open($env:WT441_LOCK, "Open", "ReadWrite", "ReadWrite"); $f.Lock(0, 1); '
      + '[Console]::Out.WriteLine("locked"); [Console]::Out.Flush(); '
      + `Start-Sleep -Milliseconds ${lockMs}; $f.Unlock(0, 1); $f.Close()`],
    { windowsHide: true, env: { ...process.env, WT441_LOCK: tpath }, stdio: ['ignore', 'pipe', 'inherit'] });
    // A failed spawn fails THIS test: with no 'error' listener it would crash the worker.
    let spawnError = null;
    ps.on('error', (e) => { spawnError = e; });
    const exited = new Promise((r) => { ps.on('exit', r); ps.on('error', r); });
    await new Promise((resolve, reject) => {
      let out = '';
      ps.stdout.on('data', (d) => { out += d; if (out.includes('locked')) resolve(); });
      ps.on('exit', () => reject(new Error('the lock process exited before locking')));
      ps.on('error', (e) => reject(new Error(`the lock process did not start: ${e.message}`)));
    });
    expect(spawnError).toBeNull();
    appendChat(tpath, 'toolu_441_busy');
    // Setup, not the claim: the read must really fail and the stat really succeed, or the
    // test would pass for the wrong reason.
    const readAll = () => {
      const fd = fs.openSync(tpath, 'r');
      try { fs.readSync(fd, Buffer.alloc(16), 0, 16, 0); } finally { fs.closeSync(fd); }
    };
    expect(() => fs.statSync(tpath)).not.toThrow();
    expect(readAll).toThrow();
    expect(await pending()).toBe(true); // read failed: still pending
    await exited;
    expect(readAll).not.toThrow();
    // Nothing is written after the lock lifts: only a check that did not cache the failed
    // read's size and mtime can see the result now.
    await expect.poll(pending, { timeout: 3 * WATCH_MS }).toBe(false);
  });
});
