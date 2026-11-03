// @ts-check
// #415 - the server routes behind cluster token renewal, end to end on the suite server.
// The rules (lifetime, grace, when to renew, the 14-day flag) are pinned with a fake clock
// in peer-tokens.spec.js; this spec proves the routes apply them:
//
//   GET  /api/cluster/token            - the holder learns its own token's expiry
//   POST /api/cluster/token/renew      - the holder exchanges it; the old one keeps working
//   POST /api/cluster/peer-tokens/renew - the CALLER side, forced: this server renews the
//        token it holds for a peer and stores it, and /api/cluster/sessions reports it.
//
// The caller-side test makes the suite server ITS OWN PEER (a cluster entry pointing at
// 127.0.0.1:17681), so both halves of a renewal run against real code with no second
// server. The entry is removed again in `finally`; the token files are the suite's own
// (WT_API_TOKENS_FILE / WT_CLUSTER_TOKENS_FILE, set in playwright.config.js).
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE, authCtx } = require('./test-helpers');

const DAY = 24 * 60 * 60 * 1000;
const TOKENS_FILE = process.env.WT_CLUSTER_TOKENS_FILE || path.join(__dirname, '..', 'cluster-tokens.test.json');
const SELF_PEER = 'http://127.0.0.1:17681';

async function mint(ctx, label) {
  const r = await ctx.post('/api/cluster/client-token', { data: { label } });
  expect(r.status()).toBe(200);
  return r.json();
}
async function bearer(token) {
  return pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

test.describe('#415 cluster token renewal routes', () => {
  test('a minted token reports its expiry; a cookie session has no token to ask about', async () => {
    const ctx = await authCtx();
    try {
      const m = await mint(ctx, 'renew-info');
      expect(typeof m.expires).toBe('number');
      expect(Math.abs(m.expires - (Date.now() + 90 * DAY))).toBeLessThan(60 * 1000);
      const b = await bearer(m.token);
      const info = await (await b.get('/api/cluster/token')).json();
      expect(info).toEqual({ label: 'client:renew-info', created: expect.any(Number), expires: m.expires });
      await b.dispose();
      // ?token= authenticates the request (WS upgrades use it) but is not the holder asking
      const q = await pwRequest.newContext({ baseURL: BASE });
      expect((await q.post(`/api/cluster/token/renew?token=${m.token}`)).status()).toBe(400);
      await q.dispose();
      expect((await ctx.get('/api/cluster/token')).status()).toBe(400);
      expect((await ctx.post('/api/cluster/token/renew')).status()).toBe(400);
    } finally { await ctx.dispose(); }
  });

  test('renew: a fresh token with the same label; the old one still works (grace)', async () => {
    const ctx = await authCtx();
    try {
      const m = await mint(ctx, 'renew-me');
      const old = await bearer(m.token);
      const r = await old.post('/api/cluster/token/renew');
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.token).not.toBe(m.token);
      const fresh = await bearer(body.token);
      expect((await fresh.get('/api/version')).status()).toBe(200);
      expect((await fresh.get('/api/cluster/token')).ok()).toBe(true);
      expect((await (await fresh.get('/api/cluster/token')).json()).label).toBe('client:renew-me');
      // the old token is cut to the grace period, not revoked on the spot
      expect((await old.get('/api/version')).status()).toBe(200);
      const oldInfo = await (await old.get('/api/cluster/token')).json();
      expect(oldInfo.expires).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);
      expect(oldInfo.expires).toBeGreaterThan(Date.now() + 6 * DAY);
      await old.dispose(); await fresh.dispose();

      const bogus = await bearer('0'.repeat(64));
      expect((await bogus.post('/api/cluster/token/renew')).status()).toBe(401);
      await bogus.dispose();
    } finally { await ctx.dispose(); }
  });

  test('caller side: learns an old entry, flags < 14 days, re-learns, renews, stores', async () => {
    const ctx = await authCtx();
    const cfgBefore = await (await ctx.get('/api/config')).json();
    const opened = [];
    const holderCtx = async (t) => { const c = await bearer(t); opened.push(c); return c; };
    try {
      const m = await mint(ctx, 'cluster:self-peer');
      const asPeer = await holderCtx(m.token);
      // Register the suite server as its own peer, the way a peer hands over a token.
      // No `expires`: an entry stored before #415, so the renewer must LEARN it.
      const reg = await asPeer.post('/api/cluster/register', {
        data: { name: 'renew-self', url: SELF_PEER, token: m.token },
      });
      expect(reg.status()).toBe(200);

      const learn = await (await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: SELF_PEER } })).json();
      expect(learn.results).toEqual([expect.objectContaining({ name: 'renew-self', action: 'learn', ok: true, expires: m.expires })]);
      expect(JSON.stringify(learn)).not.toContain(m.token); // never a token on the wire
      let held = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))[SELF_PEER];
      expect(held).toMatchObject({ token: m.token, expires: m.expires, name: 'renew-self' });

      // The cluster proxy never forwards the token routes, in any spelling: through it the
      // holder is THIS server, and a renewal would hand its fresh token to the asker.
      for (const p of ['api/cluster/token/renew', 'api/Cluster/Token/Renew', 'api/cluster/token',
        'api/cluster/token%23', 'api/cluster/to%09ken/renew', 'api/x/%2e%2e/cluster/token/renew']) {
        const via = await ctx.fetch(`/cluster/${encodeURIComponent(SELF_PEER)}/${p}`, { method: p.endsWith('enew') ? 'POST' : 'GET', data: {} });
        expect(via.status()).toBe(403);
      }

      // A stored expiry of ten days: /api/cluster/sessions flags it ...
      const soon = Date.now() + 10 * DAY;
      await asPeer.post('/api/cluster/register', {
        data: { name: 'renew-self', url: SELF_PEER, token: m.token, expires: soon },
      });
      await new Promise(r => setTimeout(r, 1600)); // the merged list is cached for 1.5 s
      let peer = (await (await ctx.get('/api/cluster/sessions')).json()).servers.find(s => s.url === SELF_PEER);
      expect(peer).toMatchObject({ needsAuth: false, tokenExpires: soon, tokenDaysLeft: 9, tokenExpiring: true });

      // ... but the stored copy is never trusted: the run asks the peer, which says 90 days.
      const relearn = await (await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: SELF_PEER } })).json();
      expect(relearn.results[0]).toMatchObject({ action: 'learn', ok: true, expires: m.expires });
      expect(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))[SELF_PEER]).toMatchObject({ token: m.token, expires: m.expires });

      const renew = await (await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: SELF_PEER, force: true } })).json();
      expect(renew.results[0]).toMatchObject({ action: 'renew', ok: true });
      held = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))[SELF_PEER];
      expect(held.token).not.toBe(m.token);
      expect(held.expires).toBeGreaterThan(Date.now() + 89 * DAY);
      expect(held.name).toBe('renew-self');
      const fresh = await bearer(held.token);
      expect((await fresh.get('/api/version')).status()).toBe(200);
      await fresh.dispose();

      peer = (await (await ctx.get('/api/cluster/sessions')).json()).servers.find(s => s.url === SELF_PEER);
      expect(peer).toMatchObject({ needsAuth: false, tokenDaysLeft: 89, tokenExpiring: false });

      // Not due (89 days left): an unforced run leaves it; a forced one renews.
      const idle = await (await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: SELF_PEER } })).json();
      expect(idle.results[0]).toMatchObject({ action: 'none', ok: true });
      const forced = await (await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: SELF_PEER, force: true } })).json();
      expect(forced.results[0]).toMatchObject({ action: 'renew', ok: true });
      expect(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))[SELF_PEER].token).not.toBe(held.token);
    } finally {
      await ctx.delete(`/api/cluster/auth/${encodeURIComponent(SELF_PEER)}`);
      await ctx.put('/api/config', { data: { cluster: Array.isArray(cfgBefore.cluster) ? cfgBefore.cluster : [] } });
      await ctx.dispose();
      for (const c of opened) await c.dispose();
    }
  });

  test('the forced run refuses a url that is not a configured peer', async () => {
    const ctx = await authCtx();
    try {
      const r = await ctx.post('/api/cluster/peer-tokens/renew', { data: { url: 'https://evil.example' } });
      expect(r.status()).toBe(400);
    } finally { await ctx.dispose(); }
  });

  test('register refuses a malformed expires', async () => {
    const ctx = await authCtx();
    try {
      const m = await mint(ctx, 'reg-bad-exp');
      const b = await bearer(m.token);
      const r = await b.post('/api/cluster/register', {
        data: { name: 'x', url: 'http://127.0.0.1:17698', token: m.token, expires: 'soon' },
      });
      expect(r.status()).toBe(400);
      await b.dispose();
    } finally { await ctx.dispose(); }
  });
});
