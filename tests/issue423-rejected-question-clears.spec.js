// @ts-check
// #423 - a question the user REJECTS ("Chat about this") fires no hook, so the server
// must learn it is over from the transcript.
//
// MEASURED on claude 2.1.319 (2026-11-08, isolated rig, 6 runs): PreToolUse(AskUserQuestion)
// carries `tool_use_id`, equal to the transcript tool_use id 6/6; the rejected tool_result
// (is_error, toolDenialKind "user-rejected") is written within ~10 ms of the key; then NO
// hook at all until the main agent's next tool or Stop, 27-38 s later. Before the fix the
// live question stood for that whole reply: the inbox card, the board and any freshly
// opened session screen offered it, and a press typed keys into a working Claude.
//
// The rule (server.js checkPendingQuestion): a captured question with a real tool_use_id is
// over when the transcript holds a tool_result for THAT id - on a 1 s timer with no viewer,
// and at each read (/pending-question, the rows' waitingFor). Matched by id only. The worker
// hears it as the PostToolUse Claude did not send: questionPending false, status working.
//
// Drives the real path: POST /api/hook -> server -> worker; the transcript is a fixture
// under the trusted Claude projects root (safeTranscriptPath), appended to as Claude would.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { BASE, AUTH, readHookToken, claudeProjectsRoot } = require('./test-helpers');

const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-423-fixture__');
const WATCH_MS = 1000; // server.js QUESTION_WATCH_MS
// Long enough for two ticks of the watch: a negative must outlast the timer that would
// have made it positive, or it proves nothing.
const OUTLAST_MS = 2 * WATCH_MS + 600;
let _n = 0;

const TOOL_INPUT = {
  questions: [{
    header: 'Plan', question: 'Which parts?', multiSelect: true,
    options: [{ label: 'Delete now' }, { label: 'Prevent it' }],
  }],
};

function writeTranscript() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `wt_423_${process.pid}_${++_n}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ask me' }] },
  }) + '\n', 'utf8');
  return p;
}

/** What Claude appends when the question is turned down: the tool_use (written only
 *  now - a pending question is never in the transcript) and its rejected result. */
function appendRejection(p, toolUseId) {
  fs.appendFileSync(p, [
    JSON.stringify({ type: 'assistant', message: { id: `msg_${toolUseId}`, role: 'assistant', content: [
      { type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: TOOL_INPUT },
    ] } }),
    JSON.stringify({ type: 'user', toolUseResult: { toolDenialKind: 'user-rejected' }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: 'The user wants to chat about this' },
    ] } }),
  ].join('\n') + '\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('#423 a rejected question clears from the transcript', () => {
  let ctx, raw, ws, frames, id, tpath;

  const hook = async (data) => {
    const r = await raw.post('/api/hook', { headers: { 'X-WT-Session-ID': id }, data });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const ask = (toolUseId) => hook({
    hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: TOOL_INPUT,
    transcript_path: tpath, ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  });
  const pending = async () => (await (await ctx.get(`/api/sessions/${id}/pending-question`)).json()).pending;
  const row = async () => {
    const list = await (await ctx.get('/api/sessions')).json();
    return (Array.isArray(list) ? list : list.sessions || []).find((s) => s.id === id);
  };
  const statusFrames = () => frames
    .map((f) => f.notification || f)
    .filter((n) => n && n.sessionId === id)
    .map((n) => n.status);

  test.beforeAll(async () => {
    // One login, its cookie used for the API context AND the notify socket.
    const login = await pwRequest.newContext({ baseURL: BASE });
    const res = await login.post('/login', { form: { user: AUTH.user, password: AUTH.password }, maxRedirects: 0 });
    const cookie = String(res.headers()['set-cookie'] || '').split(';')[0];
    await login.dispose();
    expect(cookie).toBeTruthy();
    ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: cookie } });
    raw = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });
    // The notify socket is how the proactive clear is seen WITHOUT any route being read.
    frames = [];
    ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/notify', { headers: { Cookie: cookie } });
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  });

  test.afterAll(async () => {
    if (ws) ws.close();
    if (ctx) await ctx.dispose();
    if (raw) await raw.dispose();
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {}
  });

  test.beforeEach(async () => {
    tpath = writeTranscript();
    id = (await (await ctx.post('/api/sessions', { data: { name: `Q423-${Date.now()}` } })).json()).id;
    expect(id).toBeTruthy();
  });

  test.afterEach(async () => {
    if (id) await ctx.delete(`/api/sessions/${id}`);
    id = null;
  });

  test('with NO viewer polling, the rejected result clears the question and the worker works', async () => {
    expect((await ask('toolu_423_proactive')).status).toBe('waiting');
    frames.length = 0;
    appendRejection(tpath, 'toolu_423_proactive');
    // Predicate: a status push for this session reading 'working', with no route read in
    // between - only the server's own timer can have produced it.
    await expect.poll(statusFrames, { timeout: 4 * WATCH_MS, intervals: [100] }).toContain('working');
    expect(await pending()).toBe(false);
    const r = await row();
    expect(r.status).toBe('working');
    expect(r.waitingFor).toBeNull();
  });

  test('the reads clear it at once, and the row never names a permission prompt', async () => {
    expect((await ask('toolu_423_read')).status).toBe('waiting');
    appendRejection(tpath, 'toolu_423_read');
    // Read immediately: the 1 s timer has (almost always) not ticked yet, so the route's
    // own check is what answers. Either way the answer must be "not pending".
    expect(await pending()).toBe(false);
    const r = await row();
    // Not 'permission': waitingFor('waiting', no question) would read as one.
    expect(r.waitingFor).toBeNull();
  });

  test('the rows clear it at once too', async () => {
    expect((await ask('toolu_423_rows')).status).toBe('waiting');
    appendRejection(tpath, 'toolu_423_rows');
    const r = await row();
    expect(r.waitingFor).toBeNull();
    await expect.poll(async () => (await row()).status, { timeout: 2 * WATCH_MS }).toBe('working');
  });

  test('a tool_result for a DIFFERENT id clears nothing', async () => {
    expect((await ask('toolu_423_mine')).status).toBe('waiting');
    appendRejection(tpath, 'toolu_423_someone_else');
    await sleep(OUTLAST_MS);
    expect(await pending()).toBe(true);
    const r = await row();
    expect(r.status).toBe('waiting');
    expect(r.waitingFor).toBe('question');
  });

  test('an identical re-ask is not cleared by the earlier rejection', async () => {
    await ask('toolu_423_first');
    appendRejection(tpath, 'toolu_423_first');
    await expect.poll(pending, { timeout: 4 * WATCH_MS }).toBe(false);
    // Same words, a new call: only its own result may end it.
    expect((await ask('toolu_423_again')).status).toBe('waiting');
    await sleep(OUTLAST_MS);
    expect(await pending()).toBe(true);
    expect((await row()).waitingFor).toBe('question');
  });

  test('with no real tool_use_id the question stands until a hook, as before', async () => {
    expect((await ask(null)).status).toBe('waiting');
    appendRejection(tpath, 'toolu_423_unlinked');
    await sleep(OUTLAST_MS);
    expect(await pending()).toBe(true);
    expect((await row()).waitingFor).toBe('question');
    // The hooks that always cleared it still do.
    await hook({ hook_event_name: 'Stop' });
    expect(await pending()).toBe(false);
  });

  test('the worker flag drops: an idle Notification afterwards idles the session (#239 gate open)', async () => {
    await ask('toolu_423_idle');
    // Control: while the question stands, an idle Notification must NOT idle it (#98/#239).
    await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    await sleep(500);
    expect((await row()).status).toBe('waiting');
    appendRejection(tpath, 'toolu_423_idle');
    await expect.poll(async () => (await row()).status, { timeout: 4 * WATCH_MS }).toBe('working');
    await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    await expect.poll(async () => (await row()).status, { timeout: 3000 }).toBe('idle');
  });

  test('a malformed tool_use_id is ignored, never matched', async () => {
    // Not an id Claude writes: no watch, so even a result naming the same string clears nothing.
    const bad = '../toolu_423 bad';
    expect((await ask(bad)).status).toBe('waiting');
    appendRejection(tpath, bad);
    await sleep(OUTLAST_MS);
    expect(await pending()).toBe(true);
  });
});
