// @ts-check
// #561 - GET /api/mc/efforts on the real server: auth, the `mc-efforts` capability, the shape, a lead
// with a child as ONE effort that needs you, and the 409 a non-authority answers. The rules are
// pinned in mc-efforts.spec.js (pure).
const fs = require('fs');
const path = require('path');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE_CONFIG_MS = 5600; // server.js re-reads config.json at most every 5 s

test.describe('#561 GET /api/mc/efforts', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);

  test('needs auth, and the capability is advertised', async () => {
    const anon = await noAuthCtx();
    expect((await anon.get('/api/mc/efforts', { maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();
    const ctx = await authCtx();
    expect((await (await ctx.get('/api/version')).json()).capabilities).toContain('mc-efforts');
    await ctx.dispose();
  });

  test('the shape: efforts, idle, machines with live/working/slots, servers, complete, generatedAt', async () => {
    const ctx = await authCtx();
    const r = await ctx.get('/api/mc/efforts');
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(Array.isArray(b.efforts)).toBe(true);
    expect(Array.isArray(b.idle)).toBe(true);
    expect(b.complete).toBe(true);
    expect(Number.isFinite(b.generatedAt)).toBe(true);
    expect(b.servers[0]).toMatchObject({ ok: true });
    const me = b.machines.find((m) => m.name === b.servers[0].name);
    expect(me).toMatchObject({ ok: true });
    expect(Number.isInteger(me.live)).toBe(true);
    expect(Number.isInteger(me.working)).toBe(true);
    expect(me.slots).toBeGreaterThan(0); // this server's own session limit
    await ctx.dispose();
  });

  test('a lead and the child it started are ONE effort; the child\'s wait on you makes it needs-you; its items are not also Not running', async () => {
    const ctx = await authCtx();
    const stamp = Date.now();
    const made = await ctx.post('/api/sessions', { data: { name: `mc-effort-lead-${stamp}`, autoCommand: '' } });
    expect(made.status()).toBe(200);
    const lead = (await made.json()).id;
    let kid = null;
    try {
      const k = await ctx.post('/api/sessions', { data: { name: `mc-effort-kid-${stamp}`, autoCommand: '', parentId: lead } });
      expect(k.status()).toBe(200);
      kid = (await k.json()).id;
      const hook = { 'X-WT-Hook-Token': readHookToken() };
      const c = await pwRequest.newContext({ baseURL: BASE });
      expect((await c.post(`/api/session/${lead}/report`, { headers: hook, data: {
        items: [{ ref: 'ado:9201', state: 'in-progress', stage: 'fixing' }], wait: { on: 'external', what: 'review of the PR' } } })).status()).toBe(200);
      expect((await c.post(`/api/session/${kid}/report`, { headers: hook, data: {
        items: [{ ref: 'ado:9202', state: 'in-progress', stage: 'fixing' }], wait: { on: 'you', what: 'OK to re-run?' } } })).status()).toBe(200);
      await c.dispose();
      let e = null;
      let body = null;
      for (let i = 0; i < 40; i++) {
        if (i) await sleep(300);
        body = await (await ctx.get('/api/mc/efforts')).json();
        e = body.efforts.find((x) => x.id === lead);
        if (e && e.state === 'needs-you') break;
      }
      expect(e, 'the lead has an effort').toBeTruthy();
      expect(body.efforts.some((x) => x.id === kid), 'the child is no effort of its own').toBe(false);
      expect(e.state).toBe('needs-you');
      expect(e.sessions.map((s) => [s.id, s.depth])).toEqual([[lead, 0], [kid, 1]]);
      expect(e.needsYou.map((c2) => [c2.sessionId, c2.what])).toEqual([[kid, 'OK to re-run?']]);
      expect(e.items.map((i) => i.key).sort()).toEqual(['ado:9201', 'ado:9202']);
      expect(body.idle.flatMap((g) => g.items.map((i) => i.key))).not.toContain('ado:9201');
      expect(e.partial).toBe(false);
      // The supervisor runs only on the lease authority: here none is configured, so no verdicts.
      expect(e.verdict).toBeNull();
    } finally {
      if (kid) await ctx.delete(`/api/sessions/${kid}`).catch(() => {});
      await ctx.delete(`/api/sessions/${lead}`).catch(() => {});
      await ctx.dispose();
    }
  });

  test('wiring (source gate): the verdicts are read from the ONE supervisor state both routes serve, behind mcRefusal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/api/mc/efforts'"), src.indexOf("// --- API: #523 Mission Control: lines of work ---"));
    expect(route).toContain('mcRefusal(supervisorAuthority())');
    expect(route).toContain('supervisorStateNow(cfg)');
    // The supervisor page and MC share the one function: no second copy of the stateOf call.
    expect(src.match(/supervisorLib\.stateOf\(/g)).toHaveLength(1);
    expect(src).toMatch(/app\.get\('\/api\/supervisor\/state'[\s\S]{0,700}supervisorStateNow\(cfg\)/);
  });

  test('a server that is not the authority answers 409 naming it', async () => {
    const before = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
    fs.writeFileSync(CFG_FILE, JSON.stringify({ ...(before ? JSON.parse(before) : {}), cluster: [{ name: 'zeta', url: 'http://127.0.0.1:1' }], leases: { authority: 'zeta' } }, null, 2));
    await sleep(LIVE_CONFIG_MS);
    try {
      const ctx = await authCtx();
      const r = await ctx.get('/api/mc/efforts');
      expect(r.status()).toBe(409);
      expect(await r.json()).toEqual({ role: 'peer', authority: { name: 'zeta', url: 'http://127.0.0.1:1' } });
      await ctx.dispose();
    } finally {
      if (before === null) fs.unlinkSync(CFG_FILE); else fs.writeFileSync(CFG_FILE, before);
      await sleep(LIVE_CONFIG_MS);
    }
  });
});
