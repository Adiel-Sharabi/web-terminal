// @ts-check
// #466 - supervisor phase 1 against the real server: `goal` on POST /api/sessions, a wait
// target in the report route, the journal every server keeps (GET /api/journal), and the
// gated prompt route (POST /api/sessions/:id/prompt). The rules are pinned in
// supervisor-phase1.spec.js; this pins that the server APPLIES them. The cluster graph and
// the orphan rule need two servers: supervisor-cluster.spec.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken } = require('./test-helpers');

const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, '..', 'handoffs.test');
const SUP_LOG = path.join(HANDOFF_DIR, 'supervisor-log.jsonl');
const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const TAG = '[web-terminal supervisor]';
// A launch that draws Claude's composer and its settle answer (#147/#404), so the session is ready.
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}
async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', { data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}
async function report(id, body) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, { data: body, headers: { 'X-WT-Hook-Token': readHookToken() } });
  const out = { status: r.status(), json: await r.json().catch(() => ({})) };
  await c.dispose();
  return out;
}
const supLog = (id) => (fs.existsSync(SUP_LOG) ? fs.readFileSync(SUP_LOG, 'utf8') : '').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);

test.describe('#466 supervisor phase 1 - server', () => {
  test.setTimeout(90000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];
  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
  const create = async (data) => {
    const r = await ctx.post('/api/sessions', { data: { name: `sup-${crypto.randomUUID().slice(0, 8)}`, autoCommand: '', ...data } });
    const body = await r.json().catch(() => ({}));
    if (r.status() === 200) made.push(body.id);
    return { status: r.status(), body };
  };

  test.beforeEach(async () => { ctx = await authCtx(); made = []; });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });

  test('a goal rides on the row; a goal that cannot be kept exactly is refused and nothing is created', async () => {
    const { status, body } = await create({ goal: '  ship the journal  ' });
    expect(status).toBe(200);
    expect((await rowOf(body.id)).spawn).toMatchObject({ goal: 'ship the journal' });
    const before = (await (await ctx.get('/api/sessions')).json()).length;
    for (const goal of [5, 'x'.repeat(301), `two${String.fromCodePoint(10)}lines`]) {
      const r = await create({ goal });
      expect(r.status, JSON.stringify(goal)).toBe(400);
      expect(r.body.error).toContain('goal');
    }
    expect((await (await ctx.get('/api/sessions')).json()).length).toBe(before);
  });

  test('a wait target is kept and published; a lead target needs a lead', async () => {
    const lead = (await create({})).body.id;
    const kid = (await create({ parentId: lead })).body.id;
    const items = [{ ref: '#1', title: 'x', state: 'in-progress' }];
    const target = { kind: 'pr', provider: 'github', repo: 'o/r', number: 7 };
    const ok = await report(lead, { items, wait: { on: 'external', what: 'review', target, checkBy: 30 } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await rowOf(lead)).brief.wait).toMatchObject({ on: 'external', what: 'review', target, checkBy: 30 });
    // The same lead target: refused for the session with no lead, accepted for its child.
    const noLead = await report(lead, { items, wait: { on: 'external', what: 'the lead', target: { kind: 'lead' } } });
    expect(noLead.status).toBe(400);
    expect(noLead.json.error).toContain('no lead');
    expect((await report(kid, { items, wait: { on: 'external', what: 'the lead', target: { kind: 'lead' } } })).status).toBe(200);
    // Waiting on itself, and a malformed target: refused, and the earlier wait stands.
    expect((await report(kid, { items, wait: { on: 'external', what: 'me', target: { kind: 'session', id: kid } } })).json.error).toContain('itself');
    const bad = await report(lead, { items, wait: { on: 'external', what: 'x', target: { kind: 'pr', provider: 'github' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('"repo"');
    expect((await rowOf(lead)).brief.wait.target).toEqual(target);
  });

  test('the journal records an open and a close, with the goal and why it ended', async () => {
    const since = Date.now() - 1;
    const { body } = await create({ goal: 'journal me', spawnedBy: 'a-lead' });
    const id = body.id;
    expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(200);
    made = made.filter((x) => x !== id);
    const page = await until(async () => {
      const j = await (await ctx.get(`/api/journal?since=${since}`)).json();
      return j.events.some((e) => e.id === id && e.event === 'closed') ? j : null;
    }, 'the closed line');
    const mine = page.events.filter((e) => e.id === id);
    expect(mine.map((e) => e.event)).toEqual(['opened', 'closed']);
    expect(mine[0]).toMatchObject({ via: 'api', goal: 'journal me', spawnedBy: 'a-lead' });
    expect(mine[1]).toMatchObject({ why: 'closed' });
    expect(typeof page.machine).toBe('string');
    // Paged from a cursor: nothing before it comes back.
    const later = await (await ctx.get(`/api/journal?since=${mine[1].at}`)).json();
    expect(later.events.filter((e) => e.id === id)).toEqual([]);
  });

  test('the gated prompt: refused with why, delivered only when every gate allows it', async () => {
    const cfgBefore = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    try {
      // The typing gate counts from the server's start (keystrokes are not remembered across a
      // reload), and the suite's server started minutes ago: shorten it, like check-in-routes.
      fs.writeFileSync(CFG_FILE, JSON.stringify({ ...(cfgBefore ? JSON.parse(cfgBefore) : {}), checkIn: { typingQuietMin: 0.01 } }, null, 2));
      await sleep(5500); // past LIVE_CONFIG_TTL

      // A plain shell has no agent to prompt.
      const shell = (await create({})).body.id;
      const s = await ctx.post(`/api/sessions/${shell}/prompt`, { data: { text: 'hello' } });
      expect(s.status()).toBe(409);
      expect(await s.json()).toEqual({ delivered: false, refused: 'no-agent' });
      expect(supLog(shell).map((l) => l.event)).toContain('prompt-refused');

      const r = await ctx.post('/api/sessions', { data: { name: `sup-agent-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH } });
      const id = (await r.json()).id;
      made.push(id);
      await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
      const conv = crypto.randomUUID();
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
      // Mid-turn: refused.
      const busy = await ctx.post(`/api/sessions/${id}/prompt`, { data: { text: 'hello' } });
      expect(await busy.json()).toEqual({ delivered: false, refused: 'not-idle' });
      expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
      // A bad body is refused before any gate; nothing is typed.
      expect((await ctx.post(`/api/sessions/${id}/prompt`, { data: { text: 'a\nb' } })).status()).toBe(400);
      expect((await ctx.post(`/api/sessions/${id}/prompt`, { data: { text: 'x', tag: 'check-in' } })).status()).toBe(400);
      // Idle, ready, nothing over it: delivered, as one tagged line.
      const d = await ctx.post(`/api/sessions/${id}/prompt`, { data: { text: 'your wait changed' } });
      expect(d.status()).toBe(200);
      expect(await d.json()).toEqual({ delivered: true });
      await until(async () => (await (await ctx.get(`/api/sessions/${id}/scrollback`)).text()).includes(`${TAG} your wait changed`), 'the prompt in the terminal');
      expect(supLog(id).map((l) => l.event)).toContain('prompt-delivered');
    } finally {
      fs.writeFileSync(CFG_FILE, cfgBefore === null ? '{}' : cfgBefore);
      await sleep(5500);
    }
  });

  test('the routes sit behind auth; an unknown session is 404', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE });
    const id = crypto.randomUUID();
    for (const [m, p] of [['get', '/api/journal'], ['get', '/api/supervisor/state'], ['post', `/api/sessions/${id}/prompt`]]) {
      const r = m === 'get' ? await anon.get(p, { maxRedirects: 0 }) : await anon.post(p, { data: { text: 'x' }, maxRedirects: 0 });
      expect([401, 302], `${m} ${p}`).toContain(r.status());
    }
    await anon.dispose();
    expect((await ctx.post(`/api/sessions/${id}/prompt`, { data: { text: 'x' } })).status()).toBe(404);
    expect((await ctx.post('/api/sessions/not-an-id/prompt', { data: { text: 'x' } })).status()).toBe(404);
    // The suite's server is no lease authority: it says so instead of serving a graph.
    expect(await (await ctx.get('/api/supervisor/state')).json()).toMatchObject({ role: 'none' });
  });
});
