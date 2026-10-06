// @ts-check
// #298 — the sessions dashboard's routes and hook wiring, against the real server.
// The rules themselves are pinned in session-brief.spec.js; this pins that the server
// APPLIES them: a hook folds into the brief, a prompt is answered with the instruction,
// a Stop is blocked only on proof and never twice in a row, the report route takes the
// hook token and nothing else, both session lists carry the field, and a session that
// ends is remembered.
const fs = require('fs');
const path = require('path');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken } = require('./test-helpers');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

async function newSession(ctx, name) {
  const r = await ctx.post('/api/sessions', { data: { name } });
  expect(r.status()).toBe(200);
  return (await r.json()).id;
}

async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/hook`, {
    data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken() },
  });
  const status = r.status();
  const json = await r.json().catch(() => ({}));
  await c.dispose();
  return { status, json };
}

async function report(id, body, headers = { 'X-WT-Hook-Token': readHookToken() }) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, { data: body, headers });
  const out = { status: r.status(), json: await r.json().catch(() => ({})) };
  await c.dispose();
  return out;
}

async function briefOf(ctx, id) {
  const r = await ctx.get('/api/sessions');
  const row = (await r.json()).find((s) => s.id === id);
  return row && row.brief;
}

test.describe('#298 sessions dashboard — server wiring', () => {
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string} */
  let id;

  test.beforeEach(async () => {
    ctx = await authCtx();
    id = await newSession(ctx, `brief-${Date.now()}`);
  });
  test.afterEach(async () => {
    await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });

  test('a session no hook has spoken for carries brief:null', async () => {
    expect(await briefOf(ctx, id)).toBeNull();
  });

  test('hooks fold into the brief: prompt, doing-now, and both session lists carry it', async () => {
    await hook(id, 'UserPromptSubmit', { prompt: 'fix the login bug', cwd: process.cwd() });
    await hook(id, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\server.js' } });
    const b = await briefOf(ctx, id);
    expect(b.prompt.text).toBe('fix the login bug');
    expect(b.now.text).toBe('Edit · server.js');
    expect(b.reporting).toBe('on');
    expect(b.stale.reason).toBe('nothing reported yet');
    const cl = await ctx.get('/api/cluster/sessions');
    const row = (await cl.json()).sessions.find((s) => s.id === id);
    expect(row.brief.now.text).toBe('Edit · server.js');
  });

  test('UserPromptSubmit is answered with the instruction and the current report', async () => {
    const first = await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    const ctxText = first.json.hookSpecificOutput && first.json.hookSpecificOutput.additionalContext;
    expect(first.json.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(ctxText).toContain('Current report: none yet.');
    expect(ctxText).toContain('wt-report.js');
    expect((await report(id, { items: [{ ref: '#42', title: 'Answer', state: 'blocked' }] })).status).toBe(200);
    const second = await hook(id, 'UserPromptSubmit', { prompt: 'again' });
    expect(second.json.hookSpecificOutput.additionalContext).toContain('#42 "Answer" = blocked');
  });

  test('the report route takes the hook token and NOTHING else (#297)', async () => {
    const body = { items: [{ ref: '#1', state: 'done' }] };
    expect((await report(id, body, {})).status).toBe(401);                       // direct, no token
    expect((await report(id, body, { 'X-WT-Hook-Token': 'nope' })).status).toBe(401);
    expect((await report(id, body, { 'x-forwarded-for': '203.0.113.7' })).status).toBe(401);
    expect((await report('00000000-0000-4000-8000-000000000000', body)).status).toBe(404);
    const bad = await report(id, { items: [{ ref: '#1', state: 'almost' }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('ready-for-test');
    const ok = await report(id, { items: [{ ref: '#1', title: 'T', state: 'wip' }], headline: 'h' });
    expect(ok.status).toBe(200);
    expect(ok.json.brief.items[0]).toMatchObject({ ref: '#1', state: 'in-progress', source: 'agent' });
    const b = await briefOf(ctx, id);
    expect(b.items[0].title).toBe('T');
    expect(b.headline).toBe('h');
    expect(b.stale).toBeNull();
  });

  test('a Stop is blocked on an unreported tracker change — once — and NOT forwarded', async () => {
    await report(id, { items: [{ ref: '#1', state: 'in-progress' }] });
    await hook(id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh issue close 77' } });
    const stop = await hook(id, 'Stop', {});
    expect(stop.json.decision).toBe('block');
    expect(stop.json.reason).toContain('#77');
    // Not forwarded: the worker never saw a Stop, so the response carries no status.
    expect(stop.json.status).toBeUndefined();
    // The Stop that follows a block is never blocked, whatever the report says.
    const again = await hook(id, 'Stop', { stop_hook_active: true });
    expect(again.json.decision).toBeUndefined();
    expect(again.json.ok).toBe(true);
    // And within the cooldown the SAME evidence does not block a later, ordinary Stop.
    const later = await hook(id, 'Stop', {});
    expect(later.json.decision).toBeUndefined();
  });

  test('no block when the report is current', async () => {
    await hook(id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh issue close 78' } });
    await report(id, { items: [{ ref: '#78', state: 'done' }] });
    expect((await hook(id, 'Stop', {})).json.decision).toBeUndefined();
  });

  test('pin and opt-out: pins lead; an opted-out session gets no instruction and no block', async () => {
    await hook(id, 'UserPromptSubmit', { prompt: 'x' });
    const pin = await ctx.patch(`/api/sessions/${id}/brief`, { data: { pinned: [{ ref: '#9', title: 'Pinned one' }] } });
    expect(pin.status()).toBe(200);
    expect((await pin.json()).brief.items[0]).toMatchObject({ ref: '#9', source: 'pinned' });
    expect((await ctx.patch(`/api/sessions/${id}/brief`, { data: { pinned: [{ ref: '#9', state: 'meh' }] } })).status()).toBe(400);
    expect((await ctx.patch(`/api/sessions/${id}/brief`, { data: { optOut: 'yes' } })).status()).toBe(400);
    expect((await ctx.patch(`/api/sessions/${id}/brief`, { data: { optOut: true } })).status()).toBe(200);
    const h = await hook(id, 'UserPromptSubmit', { prompt: 'y' });
    expect(h.json.hookSpecificOutput).toBeUndefined();
    await hook(id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh issue close 79' } });
    expect((await hook(id, 'Stop', {})).json.decision).toBeUndefined();
    expect((await briefOf(ctx, id)).reporting).toBe('off');
  });

  test('pinning requires a login', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.patch(`/api/sessions/${id}/brief`, { data: { optOut: true } })).status()).toBe(401);
    expect((await anon.get('/api/dashboard/closed')).status()).toBe(401);
    await anon.dispose();
  });

  test('a session that ends is listed as closed, with its work items', async () => {
    const name = `closing-${Date.now()}`;
    const closing = await newSession(ctx, name);
    await hook(closing, 'UserPromptSubmit', { prompt: 'p' });
    await report(closing, { items: [{ ref: '#5', title: 'Five', state: 'done' }] });
    await briefOf(ctx, closing); // a list read records the name
    await ctx.delete(`/api/sessions/${closing}`);
    await expect.poll(async () => {
      const j = await (await ctx.get('/api/dashboard/closed')).json();
      return j.closed.find((c) => c.id === closing) || null;
    }, { timeout: 10000 }).toMatchObject({ name, items: [{ ref: '#5', state: 'done' }] });
    expect(await briefOf(ctx, closing)).toBeUndefined();
  });

  test('scripts/wt-report.js — what the agent actually runs — reports, and says why when it cannot', async () => {
    const { spawnSync } = require('child_process');
    const script = path.join(__dirname, '..', 'scripts', 'wt-report.js');
    const run = (input, env) => spawnSync(process.execPath, [script], {
      input, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, WT_SESSION_PORT: '17681', WT_HOOK_TOKEN: readHookToken(), ...env },
    });
    const ok = run(JSON.stringify({ items: [{ ref: 'ado:24325', title: "it's quoted", state: 'committed' }] }), { WT_SESSION_ID: id });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('dashboard updated: 1 work item');
    expect((await briefOf(ctx, id)).items[0]).toMatchObject({ ref: 'ado:24325', title: "it's quoted", state: 'committed' });

    const bad = run(JSON.stringify({ items: [{ ref: '#1', state: 'nearly' }] }), { WT_SESSION_ID: id });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ready-for-test');
    expect(run('{not json', { WT_SESSION_ID: id }).status).toBe(2);
    const outside = run('{}', { WT_SESSION_ID: '' });
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('not inside a web-terminal session');
  });

  test('capability is advertised', async () => {
    const v = await (await ctx.get('/api/version')).json();
    expect(v.capabilities).toContain('session-brief');
  });
});

test.describe('#298 one helper for both session shapers', () => {
  test('/api/sessions and the cluster merge\'s local branch both call sessionBriefField', () => {
    // Four fields were each forgotten in one of these two hand-shaped lists before; a
    // behavioural test of the merge only sees the branch it happens to exercise.
    const calls = SERVER_SRC.match(/brief: sessionBriefField\(s\)/g) || [];
    expect(calls.length).toBe(2);
    const merge = SERVER_SRC.slice(SERVER_SRC.indexOf('async function _computeClusterSessions'));
    expect(merge.slice(0, merge.indexOf('result.push(...localShaped)'))).toContain('brief: sessionBriefField(s)');
  });
});
