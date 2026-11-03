// @ts-check
// #413 - work-item resume, end to end against the real test server and worker. The rules
// are pinned in work-items.spec.js; this pins that the server APPLIES them on every path a
// session's work can end by: a person's close, the process ending by itself (the crash
// path), and a hand-off. Each must (a) run the configured command once per work item with
// the payload on stdin and (b) leave an event line the item's routes return.
//
// The configured command is tests/fixtures/work-item-hook-sink.js, which writes its stdin
// to a scratch directory. The live config (config.test.json, re-read every
// LIVE_CONFIG_TTL) is edited for this file and restored after it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken } = require('./test-helpers');

const SINK = path.join(__dirname, 'fixtures', 'work-item-hook-sink.js');
const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, '..', 'handoffs.test');
const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wt413-sink-'));

const adoRef = () => `ado:${900000 + Math.floor(Math.random() * 99999)}`;

async function agentPost(id, route, body, headers = { 'X-WT-Hook-Token': readHookToken() }) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/${route}`, { data: body, headers });
  const out = { status: r.status(), json: await r.json().catch(() => ({})) };
  await c.dispose();
  return out;
}
async function agentGet(id, route, headers = { 'X-WT-Hook-Token': readHookToken() }) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.get(`/api/session/${id}/${route}`, { headers });
  const out = { status: r.status(), json: await r.json().catch(() => ({})) };
  await c.dispose();
  return out;
}
async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', { data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
/** Every payload the sink received for [sessionId]. */
function payloadsFor(sessionId) {
  return fs.readdirSync(OUT).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return null; }
  }).filter((p) => p && p.sessionId === sessionId);
}
const enc = (ref) => encodeURIComponent(ref);

let cfgBefore = null;
function writeCfg(extra) {
  const base = cfgBefore ? JSON.parse(cfgBefore) : {};
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...base, ...extra }, null, 2));
}

test.describe('#413 work-item resume - server', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];

  test.beforeAll(async () => {
    cfgBefore = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    writeCfg({
      workItemHook: { command: process.execPath, args: [SINK, OUT], timeoutMs: 20000 },
      machineCapabilities: ['builds', 'host:ci-vm-1'],
    });
    const c = await authCtx();
    // The server re-reads the live config every few seconds: wait until it has.
    await until(async () => {
      const m = await (await c.get('/api/machine')).json();
      return Array.isArray(m.capabilities) && m.capabilities.includes('builds');
    }, 'the live config to be read', 20000);
    await c.dispose();
  });
  test.afterAll(() => {
    if (cfgBefore === null) fs.rmSync(CFG_FILE, { force: true }); else fs.writeFileSync(CFG_FILE, cfgBefore);
  });
  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    const list = await (await ctx.get('/api/sessions')).json();
    for (const s of list) {
      if (made.some((n) => s.name === n || s.name === `${n} (2)`)) await ctx.delete(`/api/sessions/${s.id}`);
    }
    await ctx.dispose();
  });

  test('the routes sit behind auth and refuse a malformed ref', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.get(`/api/work-items/${enc('ado:1')}/events`)).status()).toBe(401);
    expect((await anon.get(`/api/work-items/${enc('ado:1')}`)).status()).toBe(401);
    await anon.dispose();
    expect((await ctx.get(`/api/work-items/${enc('ado:x1')}/events`)).status()).toBe(400);
    expect((await ctx.get(`/api/work-items/${enc('../../etc')}`)).status()).toBe(400);
    const none = await ctx.get(`/api/work-items/${enc('ado:1')}/events`);
    expect(none.status()).toBe(200);
    expect(await none.json()).toMatchObject({ key: 'ado:1', events: [] });
  });

  test('close: a report is an event, and closing runs the command once per item with the payload', async () => {
    const name = `wi-close-${Date.now()}`; made.push(name);
    const r = await ctx.post('/api/sessions', { data: { name } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    const a = adoRef();
    const b = adoRef();
    expect((await agentPost(id, 'report', { items: [{ ref: a, title: 'first', state: 'planning' }, { ref: b, title: 'second', state: 'in-progress' }], headline: 'two items' })).status).toBe(200);
    // The same report again is no new touch; a state change is.
    expect((await agentPost(id, 'report', { items: [{ ref: a, title: 'first', state: 'planning' }, { ref: b, title: 'second', state: 'in-progress' }], headline: 'two items' })).status).toBe(200);
    expect((await agentPost(id, 'report', { items: [{ ref: a, title: 'first', state: 'in-progress' }, { ref: b, title: 'second', state: 'in-progress' }], headline: 'two items' })).status).toBe(200);
    const ev = await (await ctx.get(`/api/work-items/${enc(a)}/events`)).json();
    expect(ev.events.map((e) => `${e.event}:${e.state}`)).toEqual(['reported:planning', 'reported:in-progress']);
    expect(ev.events[0]).toMatchObject({ sessionId: id, sessionName: name, key: a });

    expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(200);
    const got = await until(() => (payloadsFor(id).length >= 2 ? payloadsFor(id) : null), 'one payload per item');
    expect(got.length).toBe(2);
    const ver = await (await ctx.get('/api/version')).json();
    const pa = got.find((p) => p.item.ref === a);
    expect(pa).toMatchObject({ v: 1, reason: 'closed', sessionId: id, sessionName: name, machine: ver.serverName,
      item: { ref: a, key: a, state: 'in-progress', title: 'first' } });
    expect(pa.report).toMatchObject({ headline: 'two items' });
    expect(pa.report.items.map((i) => i.ref)).toEqual([a, b]);
    expect(pa.brief.items.map((i) => i.ref)).toEqual([a, b]);
    expect(got.find((p) => p.item.ref === b)).toMatchObject({ reason: 'closed' });

    const view = await until(async () => {
      const v = await (await ctx.get(`/api/work-items/${enc(a)}`)).json();
      return v.last && v.last.event === 'closed' ? v : null;
    }, 'the closed event');
    expect(view.last).toMatchObject({ event: 'closed', sessionId: id, state: 'in-progress', headline: 'two items' });
    expect(view.sessions).toEqual([id]);
  });

  test('crash path: a session whose process ends by itself is recorded as exited, and its card is written', async () => {
    const name = `wi-exit-${Date.now()}`; made.push(name);
    const r = await ctx.post('/api/sessions', { data: { name, autoCommand: 'sleep 4; exit 7' } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    const a = adoRef();
    expect((await agentPost(id, 'report', { items: [{ ref: a, title: 'crashy', state: 'in-progress' }] })).status).toBe(200);
    const p = await until(() => payloadsFor(id)[0], 'the exited payload', 40000);
    expect(p).toMatchObject({ reason: 'exited', item: { ref: a } });
    const ev = await (await ctx.get(`/api/work-items/${enc(a)}/events`)).json();
    expect(ev.events.map((e) => e.event)).toEqual(['reported', 'exited']);
  });

  test('hand-off: the verdict writes the card with the brief file; the agent-side resume route returns it', async () => {
    const name = `wi-handoff-${Date.now()}`; made.push(name);
    const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    await until(async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id)?.agentReady === true, 'ready');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    const a = adoRef();
    expect((await agentPost(id, 'report', { items: [{ ref: a, title: 'handed', state: 'in-progress' }], wait: { on: 'external', what: 'PR review' } })).status).toBe(200);
    await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 80 } } });
    await until(async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id)?.status === 'idle', 'idle');
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    const briefFile = path.join(HANDOFF_DIR, `handoff-${id}.md`);
    fs.writeFileSync(briefFile, '# brief\nnext: wait for the PR\n');
    // Kept open (canClose false): the card is written at the VERDICT, whatever happens next.
    expect((await agentPost(id, 'handoff-report', { canClose: false, why: 'a stash only I know about' })).status).toBe(200);
    const p = await until(() => payloadsFor(id).find((x) => x.reason === 'handoff'), 'the hand-off payload');
    expect(p).toMatchObject({ item: { ref: a }, handoffBriefFile: briefFile, verdict: { canClose: false, why: 'a stash only I know about' } });

    // What a `continue ado:N` starts from, through the hook token an agent holds.
    expect((await agentGet(id, `work-item/${enc(a)}`, {})).status).toBe(401);
    const v = await agentGet(id, `work-item/${enc(a)}`);
    expect(v.status).toBe(200);
    expect(v.json.last).toMatchObject({ event: 'handoff', handoffBriefFile: briefFile });
    expect(v.json.handoffBrief).toMatchObject({ file: briefFile, text: '# brief\nnext: wait for the PR\n' });
    expect(typeof v.json.text).toBe('string');
    expect(v.json.text).toContain(a);
  });

  test('machine capabilities: /api/machine, /api/version and the cluster view carry the configured list', async () => {
    const m = await (await ctx.get('/api/machine')).json();
    expect(m.capabilities).toEqual(['builds', 'host:ci-vm-1']);
    expect(m.capabilitiesError).toBeNull();
    const v = await (await ctx.get('/api/version')).json();
    expect(v.machineCapabilities).toEqual(['builds', 'host:ci-vm-1']);
    expect(v.capabilities).toContain('work-items');
    const cl = await (await ctx.get('/api/cluster/sessions')).json();
    expect(cl.servers[0].machineCapabilities).toEqual(['builds', 'host:ci-vm-1']);

    // A malformed list is refused whole, and says so.
    writeCfg({ workItemHook: { command: process.execPath, args: [SINK, OUT] }, machineCapabilities: ['builds', 'Bad Cap'] });
    const bad = await until(async () => {
      const x = await (await ctx.get('/api/machine')).json();
      return x.capabilities === null ? x : null;
    }, 'the malformed list to be read', 20000);
    expect(bad.capabilitiesError).toMatch(/Bad Cap|capabilit/);
  });
});
