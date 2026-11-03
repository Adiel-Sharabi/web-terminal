// @ts-check
// #415 - cluster peer tokens must never silently expire. Pure specs with a FAKE CLOCK:
// lib/peer-tokens.js (renewal, grace, warning) and lib/cluster-relink.js (the way back for
// a link that already broke), driven against a simulated cluster whose machines answer
// with the same rules the real server routes call.
//
// On 2026-11-03 every Office/XPS/office-tests link answered 401 on the same day: all
// tokens had been minted in one sitting 90 days earlier and nothing renewed them.
const { test, expect } = require('@playwright/test');
const pt = require('../lib/peer-tokens');
const { relink } = require('../lib/cluster-relink');

const DAY = pt.DAY_MS;
const T0 = Date.UTC(2026, 7, 4); // the day the expired tokens were minted
let seq = 0;
const gen = () => (++seq).toString(16).padStart(64, '0');

test.describe('peer side: mint, renew, grace', () => {
  test('a minted token lives 90 days, then the store refuses it', () => {
    const store = {};
    const tok = pt.mintToken(store, 'cluster:Home', T0, gen);
    expect(store[tok]).toEqual({ label: 'cluster:Home', created: T0, expires: T0 + 90 * DAY });
    expect(pt.isExpired(store[tok], T0 + 90 * DAY)).toBe(false);
    expect(pt.isExpired(store[tok], T0 + 90 * DAY + 1)).toBe(true);
    // a legacy entry with no expiry never expires
    expect(pt.isExpired({ label: 'old' }, T0 + 1000 * DAY)).toBe(false);
  });

  test('renew: fresh token, same label; the old one works for the grace period ONLY', () => {
    const store = {};
    const old = pt.mintToken(store, 'cluster:XPS', T0, gen);
    const now = T0 + 70 * DAY;
    const r = pt.renewToken(store, old, now, gen);
    expect(r.ok).toBe(true);
    expect(r.token).not.toBe(old);
    expect(r.expires).toBe(now + 90 * DAY);
    expect(store[r.token].label).toBe('cluster:XPS');
    // grace: still valid until now + RENEW_GRACE_MS, refused after
    expect(pt.isExpired(store[old], now + pt.RENEW_GRACE_MS)).toBe(false);
    expect(pt.isExpired(store[old], now + pt.RENEW_GRACE_MS + 1)).toBe(true);
    expect(pt.RENEW_GRACE_MS).toBeGreaterThan(pt.RENEW_INTERVAL_MS); // a lost answer is retried in time
  });

  test('renew again with the superseded token (lost answer) works; it never EXTENDS the grace', () => {
    const store = {};
    const old = pt.mintToken(store, 'cluster:XPS', T0, gen);
    const now = T0 + 70 * DAY;
    pt.renewToken(store, old, now, gen);
    const again = pt.renewToken(store, old, now + 6 * 3600 * 1000, gen);
    expect(again.ok).toBe(true);
    expect(store[old].expires).toBe(now + pt.RENEW_GRACE_MS); // not pushed out by the retry
  });

  test('an expired or unknown token cannot be renewed', () => {
    const store = {};
    const old = pt.mintToken(store, 'cluster:XPS', T0, gen);
    expect(pt.renewToken(store, old, T0 + 91 * DAY, gen).ok).toBe(false);
    expect(pt.renewToken(store, 'f'.repeat(64), T0, gen).ok).toBe(false);
  });

  test('a token about to expire keeps its own earlier end, not a day of grace', () => {
    const store = {};
    const old = pt.mintToken(store, 'x', T0, gen);
    const now = T0 + 90 * DAY - 3600 * 1000; // one hour left
    pt.renewToken(store, old, now, gen);
    expect(store[old].expires).toBe(T0 + 90 * DAY);
  });

  test('a renewal drops every expired entry, so superseded tokens do not pile up', () => {
    const store = {};
    const a = pt.mintToken(store, 'a', T0, gen);
    const b = pt.mintToken(store, 'b', T0, gen);
    const now = T0 + 70 * DAY;
    const r1 = pt.renewToken(store, a, now, gen); // a: superseded, in grace
    expect(Object.keys(store)).toEqual(expect.arrayContaining([a, b, r1.token]));
    pt.renewToken(store, b, now + 8 * DAY, gen); // a's grace is over by now
    expect(store[a]).toBeUndefined();
    expect(store[r1.token]).toBeDefined();
  });

  test('isTokenRoute: the cluster proxy must refuse every spelling Express would route', () => {
    for (const p of ['/api/cluster/token', '/api/cluster/token/renew', '/api/Cluster/Token/Renew',
      '/api//cluster//token/renew', '/api/cluster/token/', '/api/cluster/token/renew?x=1']) {
      expect(pt.isTokenRoute(p)).toBe(true);
    }
    for (const p of ['/api/cluster/tokens', '/api/cluster/client-token', '/api/cluster/sessions', '/api/sessions']) {
      expect(pt.isTokenRoute(p)).toBe(false);
    }
  });

  test('isProxiedTokenRoute judges the path clusterFetch SENDS, not the one Express decoded', () => {
    const B = 'https://peer.example';
    // each of these is what params[0] holds AFTER Express decoded it; new URL() turns every
    // one into /api/cluster/token[/renew] on the way out (review of #415)
    const TAB = String.fromCodePoint(9), LF = String.fromCodePoint(10), BSL = String.fromCodePoint(92);
    for (const p of ['/api/x/../cluster/token/renew', '/api/cluster/token#', `/api/cluster/to${TAB}ken/renew`,
      `/api/cluster/to${LF}ken`, `/api/cluster${BSL}token/renew`, '/api/./cluster/token', '/api/cluster/%74oken',
      '/api/cluster/token%2Frenew', '/api/Cluster/TOKEN/']) {
      expect(pt.isProxiedTokenRoute(B, p), p).toBe(true);
    }
    for (const p of ['/api/cluster/sessions', '/api/cluster/client-token', '/api/sessions', '/api/cluster/tokens']) {
      expect(pt.isProxiedTokenRoute(B, p), p).toBe(false);
    }
    expect(pt.isProxiedTokenRoute('not a url', '/api/sessions')).toBe(true); // fail closed
  });

  test('tokenInfo reports never-expiring as null, not as absent', () => {
    expect(pt.tokenInfo({ label: 'a', created: 1, expires: 5 })).toEqual({ label: 'a', created: 1, expires: 5 });
    expect(pt.tokenInfo({ label: 'a' })).toEqual({ label: 'a', created: null, expires: null });
  });
});

test.describe('caller side: when to renew, and the warning', () => {
  test('renewalAction: learn unknown, renew under 30 days, leave the rest', () => {
    const now = T0;
    expect(pt.renewalAction({ token: 'a' }, now)).toBe('learn');
    expect(pt.renewalAction({ token: 'a', expires: now + 31 * DAY }, now)).toBe(null);
    expect(pt.renewalAction({ token: 'a', expires: now + 30 * DAY - 1 }, now)).toBe('renew');
    expect(pt.renewalAction({ token: 'a', expires: now - DAY }, now)).toBe('renew');
    expect(pt.renewalAction({ token: 'a', expires: null }, now)).toBe(null); // peer said: never
    expect(pt.renewalAction({ token: 'a', expires: now + 80 * DAY }, now, { force: true })).toBe('renew');
    expect(pt.renewalAction({}, now)).toBe(null);
    expect(pt.renewalAction(undefined, now)).toBe(null);
  });

  test('peerTokenStatus: days left, flagged under 14 days (visible two weeks ahead)', () => {
    const now = T0;
    expect(pt.peerTokenStatus({ token: 'a', expires: now + 14 * DAY }, now))
      .toEqual({ tokenExpires: now + 14 * DAY, tokenDaysLeft: 14, tokenExpiring: false });
    expect(pt.peerTokenStatus({ token: 'a', expires: now + 14 * DAY - 1 }, now))
      .toEqual({ tokenExpires: now + 14 * DAY - 1, tokenDaysLeft: 13, tokenExpiring: true });
    expect(pt.peerTokenStatus({ token: 'a', expires: now - DAY }, now).tokenDaysLeft).toBe(-1);
    expect(pt.peerTokenStatus({ token: 'a' }, now)).toEqual({ tokenExpires: null, tokenDaysLeft: null, tokenExpiring: false });
    expect(pt.peerTokenStatus(undefined, now)).toEqual({ tokenExpires: null, tokenDaysLeft: null, tokenExpiring: false });
  });
});

// One simulated peer: a token store answering the two routes the renewer calls, with the
// same rules server.js's routes apply.
function fakePeer(clock, { old = false } = {}) {
  const store = {};
  const calls = [];
  const valid = (t) => !!store[t] && !pt.isExpired(store[t], clock.now);
  return {
    store, calls,
    valid,
    async request(url, method, path, token) {
      calls.push(`${method} ${path}`);
      if (old) return { status: 404, body: 'Cannot ' + method };
      if (!valid(token)) return { status: 401, body: '{"error":"Unauthorized"}' };
      if (method === 'GET' && path === '/api/cluster/token') return { status: 200, body: JSON.stringify(pt.tokenInfo(store[token])) };
      if (method === 'POST' && path === '/api/cluster/token/renew') {
        const r = pt.renewToken(store, token, clock.now, gen);
        return { status: 200, body: JSON.stringify({ ok: true, token: r.token, expires: r.expires }) };
      }
      return { status: 404, body: '' };
    },
  };
}

test.describe('renewPeerTokens against a fake peer and a fake clock', () => {
  const PEER = { name: 'XPS', url: 'https://xps.example' };

  function holder(entry) {
    let file = { [PEER.url]: entry };
    return { load: () => JSON.parse(JSON.stringify(file)), save: (o) => { file = JSON.parse(JSON.stringify(o)); }, get: () => file };
  }

  test('ACCEPTANCE: a token used every 6 h for a year never reaches its expiry', async () => {
    const clock = { now: T0 };
    const peer = fakePeer(clock);
    const tok = pt.mintToken(peer.store, 'cluster:Home', T0, gen);
    const h = holder({ token: tok, name: 'XPS', authenticated: T0 }); // pre-#415 entry: no expires
    let renewals = 0;
    for (let t = T0; t < T0 + 365 * DAY; t += pt.RENEW_INTERVAL_MS) {
      clock.now = t;
      const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: peer.request, now: () => clock.now });
      expect(r.ok).toBe(true);
      if (/renew/.test(r.action)) renewals++;
      // the token held RIGHT NOW always authenticates, and never has under 30 days left
      expect(peer.valid(h.get()[PEER.url].token)).toBe(true);
      expect(h.get()[PEER.url].expires - clock.now).toBeGreaterThanOrEqual(pt.RENEW_BEFORE_MS - pt.RENEW_INTERVAL_MS);
    }
    expect(renewals).toBe(6); // ~every 60 days: at day 60, 120, ... - not on every run
    // every other token that still works is a superseded one inside its grace, and no more
    const held = h.get()[PEER.url].token;
    const others = Object.keys(peer.store).filter(t => t !== held && peer.valid(t));
    for (const t of others) expect(peer.store[t].expires).toBeLessThanOrEqual(peer.store[t].superseded + pt.RENEW_GRACE_MS);
    expect(others.length).toBeLessThanOrEqual(1);
    // the entry keeps what it had (name, authenticated) next to the new fields
    expect(h.get()[PEER.url]).toMatchObject({ name: 'XPS', authenticated: T0 });
  });

  test('a pre-#415 entry learns its expiry first and renews only when due', async () => {
    const clock = { now: T0 + 10 * DAY };
    const peer = fakePeer(clock);
    const tok = pt.mintToken(peer.store, 'cluster:Home', T0, gen);
    const h = holder({ token: tok, name: 'XPS' });
    const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: peer.request, now: () => clock.now });
    expect(r).toMatchObject({ action: 'learn', ok: true, expires: T0 + 90 * DAY });
    expect(h.get()[PEER.url]).toMatchObject({ token: tok, expires: T0 + 90 * DAY });
    expect(peer.calls).toEqual(['GET /api/cluster/token']);

    clock.now = T0 + 75 * DAY; // 15 days left: learn already done, so a plain renew
    const h2 = holder({ token: tok, name: 'XPS' });
    const [r2] = await pt.renewPeerTokens({ peers: [PEER], load: h2.load, save: h2.save, request: peer.request, now: () => clock.now });
    expect(r2.action).toBe('learn+renew');
    expect(h2.get()[PEER.url].token).not.toBe(tok);
    expect(h2.get()[PEER.url].expires).toBe(clock.now + 90 * DAY);
  });

  test('an older peer (404) or a dead token (401) leaves the entry untouched and says why', async () => {
    const clock = { now: T0 + 80 * DAY };
    const oldPeer = fakePeer(clock, { old: true });
    const h = holder({ token: 'a'.repeat(64), name: 'XPS', expires: T0 + 90 * DAY });
    const before = JSON.stringify(h.get());
    const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: oldPeer.request, now: () => clock.now });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(r.error).toMatch(/older server/);
    expect(JSON.stringify(h.get())).toBe(before);

    const peer = fakePeer(clock); // knows nothing of the token
    const [r2] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: peer.request, now: () => clock.now });
    expect(r2).toMatchObject({ ok: false, status: 401 });
    expect(r2.error).toMatch(/cluster-relink/);
    expect(JSON.stringify(h.get())).toBe(before);
  });

  test('a relink that replaced the entry meanwhile wins over the renewal', async () => {
    const clock = { now: T0 + 80 * DAY };
    const peer = fakePeer(clock);
    const tok = pt.mintToken(peer.store, 'cluster:Home', T0, gen);
    const h = holder({ token: tok, name: 'XPS', expires: T0 + 90 * DAY });
    const request = async (...a) => {
      const res = await peer.request(...a);
      const f = h.load(); f[PEER.url] = { token: 'b'.repeat(64), name: 'XPS' }; h.save(f); // relinked mid-flight
      return res;
    };
    const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request, now: () => clock.now });
    expect(r).toMatchObject({ ok: false, error: 'entry changed meanwhile' });
    expect(h.get()[PEER.url].token).toBe('b'.repeat(64));
  });

  test('a peer answer that is not a token is refused, never stored', async () => {
    const clock = { now: T0 + 80 * DAY };
    const h = holder({ token: 'a'.repeat(64), name: 'XPS', expires: T0 + 90 * DAY });
    const request = async () => ({ status: 200, body: JSON.stringify({ token: 'x\r\nInjected: 1', expires: 5 }) });
    const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request, now: () => clock.now });
    expect(r.ok).toBe(false);
    expect(h.get()[PEER.url].token).toBe('a'.repeat(64));
  });

  // The peer SAVED the renewal, the caller never heard: the stored expiry still says 80
  // days, but the held token now only has its grace. Re-learning the expiry every run is
  // what finds that out; trusting the stored copy let the link die (review of #415).
  for (const [what, start, force] of [['a forced renewal, 80 days left', 10 * DAY, true], ['a due renewal, 10 days left', 80 * DAY, false]]) {
    test(`a lost answer to ${what}: the next run sees the grace and renews with the old token`, async () => {
      const clock = { now: T0 + start };
      const peer = fakePeer(clock);
      const tok = pt.mintToken(peer.store, 'cluster:Home', T0, gen);
      const h = holder({ token: tok, name: 'XPS', expires: T0 + 90 * DAY });
      const lossy = async (url, method, path, token) => {
        const res = await peer.request(url, method, path, token);
        if (method === 'POST') throw new Error('Timeout');
        return res;
      };
      const [r] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: lossy, now: () => clock.now, force });
      expect(r.ok).toBe(false);
      expect(h.get()[PEER.url].token).toBe(tok);
      clock.now += 2 * DAY; // the caller was away for two days (a laptop asleep)
      const [r2] = await pt.renewPeerTokens({ peers: [PEER], load: h.load, save: h.save, request: peer.request, now: () => clock.now });
      expect(r2).toMatchObject({ action: 'learn+renew', ok: true });
      clock.now += 30 * DAY; // long after any grace: the link still works
      expect(peer.valid(h.get()[PEER.url].token)).toBe(true);
    });
  }
});

// --- relink: a simulated four-machine cluster -----------------------------------------
//
// Each machine has its own token store (what it minted) and cluster-tokens (what it
// holds), and answers the routes lib/cluster-relink.js calls exactly as server.js does:
// /api/cluster/sessions servers[] (needsAuth when the held token is missing or refused),
// /api/cluster/client-token (mint, or proxy with {url}), /api/cluster/register, and the
// /cluster/<url>/api/* proxy. The clock is fake, so "expired" is the real rule.
function fakeCluster(clock, names) {
  const url = (n) => `https://${n.toLowerCase()}.example`;
  const M = {};
  for (const n of names) M[url(n)] = { name: n, url: url(n), store: {}, held: {}, online: true };
  const valid = (m, t) => !!m.store[t] && !pt.isExpired(m.store[t], clock.now);
  const log = [];
  async function handle(m, token, method, p, body) {
    if (!m.online) throw new Error('ECONNREFUSED');
    if (!valid(m, token)) return { status: 401, body: '{"error":"Unauthorized"}' };
    const pm = /^\/cluster\/([^/]+)(\/api\/.*)$/.exec(p);
    if (pm) { // the proxy: forward with the token m holds for that peer
      const target = M[decodeURIComponent(pm[1])];
      const held = m.held[decodeURIComponent(pm[1])];
      if (!held) return { status: 401, body: '{"error":"Not authenticated to remote server"}' };
      return handle(target, held.token, method, pm[2], body);
    }
    if (method === 'GET' && p === '/api/cluster/sessions') {
      const servers = [{ name: m.name, url: null, online: true, needsAuth: false }];
      for (const peer of Object.values(M)) {
        if (peer === m) continue;
        const h = m.held[peer.url];
        const st = pt.peerTokenStatus(h, clock.now);
        if (!h) servers.push({ name: peer.name, url: peer.url, online: false, needsAuth: true, ...st });
        else if (!peer.online) servers.push({ name: peer.name, url: peer.url, online: false, needsAuth: false, ...st });
        else servers.push({ name: peer.name, url: peer.url, online: true, needsAuth: !valid(peer, h.token), ...st });
      }
      return { status: 200, body: JSON.stringify({ sessions: [], servers }) };
    }
    if (method === 'POST' && p === '/api/cluster/client-token') {
      if (!body.url) {
        const t = pt.mintToken(m.store, `client:${body.label}`, clock.now, gen);
        log.push(`mint on ${m.name} (${body.label})`);
        return { status: 200, body: JSON.stringify({ ok: true, token: t, expires: m.store[t].expires }) };
      }
      const held = m.held[body.url];
      if (!held) return { status: 409, body: '{}' };
      const r = await handle(M[body.url], held.token, 'POST', '/api/cluster/client-token', { label: body.label });
      return r.status === 200 ? r : { status: 502, body: '{}' };
    }
    if (method === 'POST' && p === '/api/cluster/register') {
      m.held[body.url] = { token: body.token, name: body.name, authenticated: clock.now, ...(body.expires ? { expires: body.expires } : {}) };
      log.push(`install on ${m.name} -> ${body.name}`);
      return { status: 200, body: '{"ok":true}' };
    }
    return { status: 404, body: '' };
  }
  // full mesh, every token minted at T0
  for (const a of Object.values(M)) for (const b of Object.values(M)) {
    if (a === b) continue;
    const t = pt.mintToken(b.store, `cluster:${a.name}`, T0, gen);
    a.held[b.url] = { token: t, name: b.name, expires: b.store[t].expires };
  }
  const self = (n) => {
    const m = M[url(n)];
    const local = pt.mintToken(m.store, 'local', T0, () => 'e'.repeat(63) + n.length);
    m.store[local].expires = null; // the local admin token does not lapse in the scenario
    return { name: m.name, url: m.url, base: 'local:' + m.url, token: local };
  };
  async function request(base, token, method, p, body) {
    if (base.startsWith('local:')) return handle(M[base.slice(6)], token, method, p, body);
    const pm = /^(https:\/\/[^/]+)(\/cluster\/[^/]+)?$/.exec(base);
    return handle(M[pm[1]], token, method, (pm[2] || '') + p, body);
  }
  const linkState = (a, b) => {
    const h = M[url(a)].held[url(b)];
    return !!h && valid(M[url(b)], h.token);
  };
  return { M, url, self, request, log, linkState };
}

test.describe('cluster relink against a simulated cluster (fake clock)', () => {
  const NAMES = ['Home', 'Office', 'XPS', 'Tests'];
  const sleep = async () => {};

  // 2026-11-03: Home re-logged by hand; every other link expired.
  function today() {
    const clock = { now: T0 + 91 * DAY };
    const c = fakeCluster(clock, NAMES);
    const home = c.M[c.url('Home')];
    for (const peer of Object.values(c.M)) {
      if (peer === home) continue;
      const t = pt.mintToken(peer.store, 'cluster:Home', clock.now, gen);
      home.held[peer.url] = { token: t, name: peer.name, expires: peer.store[t].expires };
      const back = pt.mintToken(home.store, `cluster:${peer.name}`, clock.now, gen);
      peer.held[home.url] = { token: back, name: 'Home', expires: home.store[back].expires };
    }
    return { clock, c };
  }
  const brokenPairs = (c) => {
    const out = [];
    for (const a of NAMES) for (const b of NAMES) if (a !== b && !c.linkState(a, b)) out.push(`${a}->${b}`);
    return out;
  };

  test('dry run reports the six broken links and changes nothing', async () => {
    const { c } = today();
    expect(brokenPairs(c)).toHaveLength(6);
    const out = await relink({ self: c.self('Home'), selfTokens: () => c.M[c.url('Home')].held, request: c.request, apply: false, sleep });
    expect(out.broken).toBe(6);
    expect(out.actions.filter(a => a.action === 'would relink')).toHaveLength(6);
    expect(c.log).toEqual([]);
    expect(brokenPairs(c)).toHaveLength(6);
  });

  test('from Home (links to all): every broken link is re-linked, none printed as a token', async () => {
    const { clock, c } = today();
    const out = await relink({ self: c.self('Home'), selfTokens: () => c.M[c.url('Home')].held, request: c.request, apply: true, sleep });
    expect(brokenPairs(c)).toEqual([]);
    expect(out.broken).toBe(0);
    expect(out.links).toHaveLength(12);
    expect(out.links.every(l => l.state === 'ok' && l.daysLeft === 90)).toBe(true);
    expect(out.actions.filter(a => a.action === 'relinked')).toHaveLength(6);
    // the result carries no token string anywhere
    const all = Object.values(c.M).flatMap(m => Object.keys(m.store));
    const text = JSON.stringify(out);
    expect(all.some(t => text.includes(t))).toBe(false);
    // and the new tokens carry their expiry, so the renewer has nothing to learn
    expect(c.M[c.url('Office')].held[c.url('XPS')].expires).toBe(clock.now + 90 * DAY);
  });

  test('from XPS (its only working link is to Home): repairs its own links first, then the rest', async () => {
    const { c } = today();
    const out = await relink({ self: c.self('XPS'), selfTokens: () => c.M[c.url('XPS')].held, request: c.request, apply: true, sleep });
    expect(brokenPairs(c)).toEqual([]);
    expect(out.broken).toBe(0);
    // XPS's own token for Office is dead, so the fresh one was minted on Office through Home
    const first = out.actions.find(a => a.from === 'XPS' && a.to === 'Office');
    expect(first).toMatchObject({ round: 1, action: 'relinked', detail: 'via Home' });
    expect(out.actions.findIndex(a => a.from === 'XPS')).toBe(0); // its own links first
  });

  test('an offline machine is reported, not repaired, and the rest still is', async () => {
    const { c } = today();
    c.M[c.url('Tests')].online = false;
    const out = await relink({ self: c.self('Home'), selfTokens: () => c.M[c.url('Home')].held, request: c.request, apply: true, sleep });
    expect(out.unreachable).toEqual(['Tests']);
    expect(c.linkState('Office', 'XPS')).toBe(true);
    expect(c.linkState('XPS', 'Office')).toBe(true);
    expect(out.links.filter(l => l.to === 'Tests').every(l => l.state === 'offline')).toBe(true);
    expect(out.broken).toBe(0);
  });

  test('a machine with no working link at all is left alone and named', async () => {
    const clock = { now: T0 + 91 * DAY }; // nobody re-logged: every link expired
    const c = fakeCluster(clock, NAMES);
    const out = await relink({ self: c.self('Home'), selfTokens: () => c.M[c.url('Home')].held, request: c.request, apply: true, sleep });
    // Home's own links are broken and no peer can mint for it: nothing to stand on
    expect(out.actions.every(a => a.action === 'failed')).toBe(true);
    expect(out.broken).toBe(3);
    expect(c.log.filter(l => l.startsWith('install'))).toEqual([]);
  });
});
