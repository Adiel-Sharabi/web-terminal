'use strict';
// --- Re-link every broken machine->peer link of the cluster, from ONE machine (#415) --
//
// Renewal (lib/peer-tokens.js) keeps a token alive while its link works. This is the way
// back for a link that is ALREADY broken - an expired or revoked token, or none stored -
// without typing any peer's password. It needs one machine, the one it runs on (X), with
// a working link to a machine that can reach each end of the broken link.
//
// For a broken link A -> B (A's /api/cluster/sessions says B needsAuth):
//   1. MINT a fresh token ON B: `POST B/api/cluster/client-token` - straight to B when X
//      can reach it, else through any machine Y that still holds a working token for B
//      (the same endpoint's proxy branch, `{url: B}`, which spends Y's trust in B).
//   2. INSTALL it ON A: `POST A/api/cluster/register {name, url, token, expires}`, the
//      endpoint a peer already uses to hand over a token. A's renewer keeps it alive.
//
// Routes from X: X itself (its local API), a peer X's own view says is healthy (direct,
// with X's stored token), and one hop further through such a peer's cluster proxy
// (`/cluster/<url>/api/...`). Repairs widen the routes, so it runs in rounds until no
// link is broken or a round repairs nothing. A dry run (apply false) only reports.
//
// No token is ever returned or logged. Pure apart from the injected `request`, `sleep`
// and `selfTokens`, so tests drive it against a simulated cluster.

const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const join = (base, p) => base.replace(/\/+$/, '') + p;

/**
 * @param {object} o
 * @param {{name: string, url: string, base: string, token: string}} o.self - this machine:
 *        its publicUrl (how peers know it), the local base URL and a local API token.
 * @param {() => object} o.selfTokens - this machine's cluster-tokens.json, read fresh.
 * @param {(base: string, token: string, method: string, path: string, body?: object) =>
 *        Promise<{status: number, body: string}>} o.request
 * @param {boolean} [o.apply] - false: report only.
 * @param {(ms: number) => Promise<void>} [o.sleep] - between rounds (peers cache their
 *        merged session list for 1.5 s).
 */
async function relink({ self, selfTokens, request, apply = false, sleep = (ms) => new Promise(r => setTimeout(r, ms)), maxRounds = 5 }) {
  const selfKey = norm(self.url);
  const names = new Map([[selfKey, self.name]]);
  const nameOf = (k) => names.get(k) || k;
  const actions = [];
  let links = [], unreachable = [];

  async function survey() {
    const routes = new Map([[selfKey, { base: self.base, token: self.token, via: 'local' }]]);
    const views = new Map();
    const tokens = selfTokens() || {};
    const healthy = (s) => s && s.url && !s.needsAuth && s.online;
    // Fetch views of routed machines until no new route appears.
    for (let changed = true; changed;) {
      changed = false;
      for (const [k, r] of routes) {
        if (views.has(k)) continue;
        let v = null;
        try {
          const res = await request(r.base, r.token, 'GET', '/api/cluster/sessions');
          const data = res.status === 200 ? parse(res.body) : null;
          if (data && Array.isArray(data.servers)) v = data.servers.filter(s => s && typeof s.url === 'string' && s.url);
        } catch { /* unreachable on this route */ }
        views.set(k, v);
        for (const s of v || []) if (!names.has(norm(s.url)) && s.name) names.set(norm(s.url), s.name);
        changed = true;
      }
      for (const s of views.get(selfKey) || []) {
        const k = norm(s.url), t = tokens[s.url];
        if (healthy(s) && t && t.token && !routes.has(k)) { routes.set(k, { base: s.url, token: t.token, via: 'direct' }); changed = true; }
      }
      for (const [k, r] of [...routes]) {
        if (r.via !== 'direct') continue;
        for (const s of views.get(k) || []) {
          const sk = norm(s.url);
          if (healthy(s) && !routes.has(sk)) {
            routes.set(sk, { base: join(r.base, '/cluster/' + encodeURIComponent(s.url)), token: r.token, via: `via ${nameOf(k)}` });
            changed = true;
          }
        }
      }
    }
    const ls = [];
    for (const [k, v] of views) {
      for (const s of v || []) {
        ls.push({
          from: nameOf(k), fromKey: k, to: s.name || nameOf(norm(s.url)), toKey: norm(s.url), toUrl: s.url,
          state: s.needsAuth ? 'broken' : (s.online ? 'ok' : 'offline'),
          daysLeft: typeof s.tokenDaysLeft === 'number' ? s.tokenDaysLeft : null,
          expiring: s.tokenExpiring === true,
        });
      }
    }
    const all = new Set([...names.keys()]);
    unreachable = [...all].filter(k => !views.get(k)).map(nameOf);
    return { routes, views, links: ls };
  }

  async function mint(link, routes, views) {
    const label = `relink:${link.from}`;
    const direct = routes.get(link.toKey);
    const tries = [];
    if (direct) tries.push({ r: direct, body: { label }, via: direct.via });
    for (const [k, v] of views) {
      if (k === link.toKey || !routes.has(k)) continue;
      const s = (v || []).find(x => norm(x.url) === link.toKey && !x.needsAuth && x.online);
      if (s) tries.push({ r: routes.get(k), body: { url: s.url, label }, via: `minted through ${nameOf(k)}` });
    }
    for (const t of tries) {
      try {
        const res = await request(t.r.base, t.r.token, 'POST', '/api/cluster/client-token', t.body);
        const d = res.status === 200 ? parse(res.body) : null;
        if (d && typeof d.token === 'string' && d.token) return { token: d.token, expires: typeof d.expires === 'number' ? d.expires : undefined, via: t.via };
      } catch { /* next path */ }
    }
    return null;
  }

  for (let round = 1; round <= maxRounds; round++) {
    const { routes, views, links: ls } = await survey();
    links = ls;
    const broken = ls.filter(l => l.state === 'broken');
    if (!broken.length) break;
    if (!apply) {
      for (const l of broken) {
        const canMint = routes.has(l.toKey) || [...views].some(([k, v]) => k !== l.toKey && routes.has(k) && (v || []).some(x => norm(x.url) === l.toKey && !x.needsAuth && x.online));
        actions.push({ from: l.from, to: l.to, action: routes.has(l.fromKey) && canMint ? 'would relink' : 'no working path' });
      }
      break;
    }
    let progress = false;
    // This machine's own links first: each one repaired is a new direct route next round.
    broken.sort((a, b) => (b.fromKey === selfKey) - (a.fromKey === selfKey));
    for (const l of broken) {
      const rA = routes.get(l.fromKey);
      if (!rA) { actions.push({ round, from: l.from, to: l.to, action: 'failed', detail: `no working path to ${l.from}` }); continue; }
      const m = await mint(l, routes, views);
      if (!m) { actions.push({ round, from: l.from, to: l.to, action: 'failed', detail: `could not mint a token on ${l.to}` }); continue; }
      let res;
      try {
        res = await request(rA.base, rA.token, 'POST', '/api/cluster/register',
          { name: l.to, url: l.toUrl, token: m.token, ...(m.expires !== undefined ? { expires: m.expires } : {}) });
      } catch (e) { res = { status: 0, body: String(e && e.message) }; }
      if (res.status === 200) { progress = true; actions.push({ round, from: l.from, to: l.to, action: 'relinked', detail: m.via }); }
      else actions.push({ round, from: l.from, to: l.to, action: 'failed', detail: `${l.from} refused the token (HTTP ${res.status})` });
    }
    if (!progress) break;
    await sleep(2000);
    if (round === maxRounds) links = (await survey()).links;
  }
  return {
    links: links.map(l => ({ from: l.from, to: l.to, state: l.state, daysLeft: l.daysLeft, expiring: l.expiring })),
    unreachable,
    actions,
    broken: links.filter(l => l.state === 'broken').length,
  };
}

module.exports = { relink, norm };
