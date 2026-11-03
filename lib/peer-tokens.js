'use strict';
// --- Cluster peer tokens: lifetime, renewal, grace and the expiry warning (#415) ----
//
// Every token a server mints (`createApiToken` in server.js) lives TOKEN_LIFETIME_MS.
// Peers are normally authenticated in one sitting, so before #415 the whole cluster
// dropped on the same day, 90 days later, and only an interactive password per peer
// brought it back (2026-11-03: every Office/XPS/office-tests link answered 401).
//
// The fix has two halves, and this module owns the rules of both:
//
//  * PEER SIDE (the server that MINTED the token). `renewToken` exchanges a still-valid
//    token for a fresh one with the same label. The old one is not revoked on the spot:
//    it keeps working for RENEW_GRACE_MS, so a caller that crashes between receiving the
//    new token and saving it can renew again with the old one, and requests already in
//    flight with it do not fail. After the grace the store drops it (`isExpired`).
//
//  * CALLER SIDE (the server HOLDING the token in cluster-tokens.json). `renewPeerTokens`
//    renews every peer token with less than RENEW_BEFORE_MS left. An entry stored before
//    The expiry is RE-LEARNED from the peer on every run (`GET /api/cluster/token`), never
//    trusted from the stored copy: a renewal whose answer was lost (the peer saved it, the
//    caller never heard) shows up as a started grace and is renewed again while the old
//    token still works. An entry stored before #415 has no `expires` at all.
//    `peerTokenStatus` is what `/api/cluster/sessions` reports per peer, with a flag once
//    less than WARN_BEFORE_MS is left - visible two weeks before anything breaks.
//
// Pure apart from the injected `load`/`save`/`request`/`now`, for the reason every rule in
// `lib/` is: server.js exports nothing, so a rule left inline is reachable by no test.

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_LIFETIME_MS = 90 * DAY_MS;
/// Renew when less than this is left. A caller that runs every RENEW_INTERVAL_MS gets
/// ~120 attempts inside the window, so a peer that is down for a week still renews.
const RENEW_BEFORE_MS = 30 * DAY_MS;
/// `/api/cluster/sessions` flags a peer token with less than this left.
const WARN_BEFORE_MS = 14 * DAY_MS;
/// How long a renewed (superseded) token keeps working. Far longer than RENEW_INTERVAL_MS,
/// so a renewal whose answer was lost is retried with the old token before it dies - even
/// when the caller is a laptop asleep over a long weekend.
const RENEW_GRACE_MS = 7 * DAY_MS;
const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;

/// A peer-supplied token must look like one of ours (hex) before it is stored and sent
/// back as a header; anything else is refused, never sanitised.
const TOKEN_SHAPE = /^[0-9a-f]{32,256}$/;

function newTokenString() { return crypto.randomBytes(32).toString('hex'); }

// --- Peer side: the store of tokens THIS server minted (api-tokens.json) -------------

/// An entry with no `expires` never expires (tokens minted before expiry existed).
function isExpired(entry, now) {
  return !!(entry && typeof entry.expires === 'number' && now > entry.expires);
}

/// Add a fresh token to `store` (mutated). Returns the token string.
function mintToken(store, label, now, gen = newTokenString) {
  const token = gen();
  store[token] = { label: label || 'cluster', created: now, expires: now + TOKEN_LIFETIME_MS };
  return token;
}

/// Exchange `oldToken` for a fresh one (store mutated). The fresh token keeps the label,
/// so the tokens list still says whose it is; the old one is cut to the grace period
/// (never extended - renewing a token that expires in an hour does not buy it a day).
/// Renewing an already-superseded token is allowed while it still works: that is the
/// retry after a lost answer, and it must not fail. Every expired entry is dropped on
/// the way, so superseded tokens nobody presents again do not pile up in the store.
function renewToken(store, oldToken, now, gen = newTokenString) {
  const entry = store[oldToken];
  if (!entry || isExpired(entry, now)) return { ok: false };
  for (const t of Object.keys(store)) if (isExpired(store[t], now)) delete store[t];
  const token = mintToken(store, entry.label, now, gen);
  store[token].renewed = now;
  const graceEnd = now + RENEW_GRACE_MS;
  if (typeof entry.expires !== 'number' || entry.expires > graceEnd) entry.expires = graceEnd;
  entry.superseded = now;
  return { ok: true, token, expires: store[token].expires };
}

/// The token routes are answered for the holder only; the cluster proxy must never forward
/// them (it would be renewing ITS OWN token on behalf of whoever asked). Normalised the way
/// Express matches: case-insensitive, repeated slashes, a trailing slash.
function isTokenRoute(p) {
  const n = String(p || '').split('?')[0].toLowerCase().replace(/\/+/g, '/');
  return /^\/api\/cluster\/token(\/|$)/.test(n);
}

/// The cluster proxy's question: does `base + path` reach a token route on the peer? Asked
/// of the path clusterFetch will SEND - `new URL()` resolves dot segments, drops a '#'
/// fragment and strips tabs/newlines AFTER Express has decoded params[0] - in both its
/// raw and its percent-decoded form. Unparseable is refused too (fail closed).
function isProxiedTokenRoute(base, p) {
  let sent;
  try { sent = new URL(String(base) + String(p)).pathname; } catch { return true; }
  if (isTokenRoute(sent)) return true;
  try { return isTokenRoute(decodeURIComponent(sent)); } catch { return true; }
}

/// What `GET /api/cluster/token` tells the holder about its own token.
function tokenInfo(entry) {
  return {
    label: entry.label || null,
    created: typeof entry.created === 'number' ? entry.created : null,
    // null = never expires. Absent would read as "unknown" on the caller and be re-asked.
    expires: typeof entry.expires === 'number' ? entry.expires : null,
  };
}

// --- Caller side: the tokens THIS server holds for its peers (cluster-tokens.json) ---

/// Whole days left, rounded down; negative once expired; null when unknown or never.
function daysLeft(expires, now) {
  return typeof expires === 'number' ? Math.floor((expires - now) / DAY_MS) : null;
}

/// The token fields of one peer's entry in `/api/cluster/sessions` servers[].
function peerTokenStatus(entry, now) {
  const expires = entry && typeof entry.expires === 'number' ? entry.expires : null;
  return {
    tokenExpires: expires,
    tokenDaysLeft: daysLeft(expires, now),
    tokenExpiring: expires !== null && expires - now < WARN_BEFORE_MS,
  };
}

/// What the renewer does with one cluster-tokens entry: 'learn' (expiry not known yet -
/// stored before #415), 'renew', or null. `expires: null` is the peer saying "never".
function renewalAction(entry, now, { force = false } = {}) {
  if (!entry || typeof entry.token !== 'string' || !entry.token) return null;
  if (force) return 'renew';
  if (entry.expires === undefined) return 'learn';
  if (typeof entry.expires !== 'number') return null;
  return entry.expires - now < RENEW_BEFORE_MS ? 'renew' : null;
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

/// Why a peer answer was not usable, worded for the log line that reports it.
function refusal(status, what) {
  if (status === 401) return 'peer rejected the token - relink it (scripts/cluster-relink.js)';
  if (status === 404) return `peer cannot ${what} (older server)`;
  return `peer could not ${what}`;
}

/// Renew (or learn the expiry of) the token held for each of `peers`.
///   peers   [{ name, url }] - the configured peers, this server already removed
///   load()  -> cluster-tokens object, read FRESH (another writer may have changed it)
///   save(o) -> persist it
///   request(url, method, path, token) -> Promise<{ status, body }>
/// Returns one result per peer; never a token. A result is written only while the entry
/// still holds the token the request was made with - a relink that replaced it meanwhile
/// wins, and the fresh token is left to expire unused on the peer.
async function renewPeerTokens({ peers, load, save, request, now = Date.now, force = false }) {
  const results = [];
  const update = (url, used, patch) => {
    const tokens = load();
    const e = tokens[url];
    if (!e || e.token !== used) return false;
    tokens[url] = Object.assign({}, e, patch);
    save(tokens);
    return true;
  };
  for (const peer of peers) {
    const out = { name: peer.name, url: peer.url, action: 'none', ok: true };
    results.push(out);
    const entry = load()[peer.url];
    if (!renewalAction(entry, now(), { force: true })) continue; // no token held
    const used = entry.token;
    try {
      // Ask the peer first, every run: the stored expiry can be stale (see the header).
      const r = await request(peer.url, 'GET', '/api/cluster/token', used);
      const info = r.status === 200 ? parseJson(r.body) : null;
      let known = entry;
      if (info && (typeof info.expires === 'number' || info.expires === null)) {
        if (info.expires !== entry.expires) {
          if (!update(peer.url, used, { expires: info.expires })) { Object.assign(out, { action: 'learn', ok: false, error: 'entry changed meanwhile' }); continue; }
          out.action = 'learn';
        }
        known = Object.assign({}, entry, { expires: info.expires });
      } else if (r.status === 401 || !force) {
        // 401: the token is dead - renewing with it cannot work. Otherwise (an older peer,
        // a bad answer) only a forced run goes on to try the renewal anyway.
        Object.assign(out, { action: 'learn', ok: false, status: r.status, error: refusal(r.status, 'report token expiry') });
        continue;
      }
      if (typeof known.expires === 'number' || known.expires === null) out.expires = known.expires;
      if (!renewalAction(known, now(), { force })) continue;
      out.action = out.action === 'learn' ? 'learn+renew' : 'renew';
      const rn = await request(peer.url, 'POST', '/api/cluster/token/renew', used);
      const data = rn.status === 200 ? parseJson(rn.body) : null;
      if (!data || typeof data.token !== 'string' || !TOKEN_SHAPE.test(data.token) || typeof data.expires !== 'number') {
        Object.assign(out, { ok: false, status: rn.status, error: refusal(rn.status, 'renew') });
        continue;
      }
      if (!update(peer.url, used, { token: data.token, expires: data.expires, renewed: now() })) {
        Object.assign(out, { ok: false, error: 'entry changed meanwhile' });
        continue;
      }
      out.expires = data.expires;
    } catch (e) {
      Object.assign(out, { ok: false, error: (e && e.message) || String(e) });
    }
  }
  return results;
}

module.exports = {
  DAY_MS, TOKEN_LIFETIME_MS, RENEW_BEFORE_MS, WARN_BEFORE_MS, RENEW_GRACE_MS, RENEW_INTERVAL_MS, TOKEN_SHAPE,
  isExpired, mintToken, renewToken, tokenInfo, isTokenRoute, isProxiedTokenRoute,
  daysLeft, peerTokenStatus, renewalAction, renewPeerTokens,
};
