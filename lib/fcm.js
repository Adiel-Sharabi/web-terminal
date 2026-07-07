'use strict';
// Pure + injectable helpers for the FCM HTTP v1 transport. No ambient I/O here —
// server.js owns the service-account file read, the device registry, and when to
// fire. Kept pure (given fetchImpl + a clock) so message shape, JWT signing, and
// token-cache behavior are unit-testable without network, timers, or real keys.
//
// Design (see COMPANION-APP-DESIGN.md, "Push Pipeline (FCM)"):
//   - Data-only messages (no `notification` block) — the app renders its own.
//   - Content-free payload: exactly {kind, serverName, sessionId, ts, deepLink},
//     all STRINGS (FCM requires string values in `data`). No sessionName, no
//     reason, no Claude content — that stays on the tailnet behind /attention.
//   - collapse_key = session-<id> so a later push (incl. a "clear") supersedes an
//     earlier one for the same session; "clear" is the auto-dismiss mechanism.

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
// Refresh the access token this long before it actually expires.
const TOKEN_SKEW_MS = 5 * 60 * 1000;
// After a failed token exchange, don't hammer the endpoint — back off this long
// before retrying (a bad key or an outage shouldn't retry on every single send).
const TOKEN_EXCHANGE_BACKOFF_MS = 60 * 1000;
// Hard ceiling on each network call so a hung connection can't wedge a send.
const FETCH_TIMEOUT_MS = 10 * 1000;
// AbortSignal.timeout exists on Node 17.3+; guard so older/odd runtimes degrade
// to no timeout rather than throwing.
function fetchTimeoutSignal() {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

// Per-kind TTL (seconds) and delivery priority. ALL kinds are sent high-priority
// so the data message wakes the phone through Android Doze — otherwise a
// normal-priority push is deferred/dropped and never arrives (#25: a session on
// notify level 'all' got no "finished"/idle push because idle was normal
// priority). Note delivery priority is INDEPENDENT of how the notification is
// displayed: idle still renders on the low-importance, silent channel
// (notification_service.dart). idle keeps a long TTL (it's not urgent) and
// fires only after a session settles, so it stays off the high-priority quota
// in practice.
const FCM_TTL_SECONDS = { approval: 300, apierror: 600, idle: 3600, clear: 60 };
const HIGH_PRIORITY_KINDS = new Set(['approval', 'apierror', 'clear', 'idle']);

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function str(v) {
  return v == null ? '' : String(v);
}

// Build the FCM v1 request body for one device token. Returns { message: {...} },
// which is exactly what messages:send expects as its JSON body.
function buildFcmMessage(kind, { serverName, sessionId, ts, deepLink, token } = {}) {
  const priority = HIGH_PRIORITY_KINDS.has(kind) ? 'high' : 'normal';
  const ttl = FCM_TTL_SECONDS[kind] !== undefined ? FCM_TTL_SECONDS[kind] : 3600;
  return {
    message: {
      token,
      // Content-free by design; every value is a string (FCM requirement).
      data: {
        kind: str(kind),
        serverName: str(serverName),
        sessionId: str(sessionId),
        ts: str(ts),
        deepLink: str(deepLink),
      },
      android: {
        priority,
        collapse_key: `session-${str(sessionId)}`,
        ttl: `${ttl}s`,
      },
    },
  };
}

// Build a signed RS256 service-account JWT for exchanging at the Google token
// endpoint. Pure given its inputs (nowMs injected). exp = iat + 3600.
function buildJwt({ clientEmail, privateKey, nowMs, scope = FCM_SCOPE, aud = TOKEN_URL }) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: clientEmail, scope, aud, iat, exp };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

// Pull a machine-readable error code out of an FCM v1 error body. The specific
// `errorCode` (e.g. UNREGISTERED) lives in error.details[] under the FcmError
// @type; INVALID_ARGUMENT and friends surface as error.status. Callers prune
// dead tokens on UNREGISTERED / INVALID_ARGUMENT.
function parseFcmError(body) {
  const err = body && body.error;
  if (!err) return { message: 'unknown FCM error', errorCode: null };
  let errorCode = null;
  const details = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    if (d && typeof d.errorCode === 'string') { errorCode = d.errorCode; break; }
  }
  if (!errorCode && typeof err.status === 'string') errorCode = err.status;
  return { message: err.message || err.status || 'FCM error', errorCode };
}

// Create a client bound to one service account. Handles the OAuth2 token
// exchange (cached until ~5 min before expiry) and the messages:send POST.
// fetchImpl + now are injectable for tests; default to the platform globals.
function createFcmClient({ serviceAccount, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const sa = serviceAccount || {};
  const projectId = sa.project_id;
  const clientEmail = sa.client_email;
  const privateKey = sa.private_key;
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  let cached = null;        // { accessToken, expiresAtMs }
  let backoffUntilMs = 0;   // negative cache: don't re-attempt exchange before this

  async function getAccessToken() {
    const nowMs = now();
    if (cached && nowMs < cached.expiresAtMs - TOKEN_SKEW_MS) return cached.accessToken;
    // Negative cache: a recent exchange failure suppresses retries for a window so
    // a bad key / outage doesn't fire a token POST on every single send.
    if (nowMs < backoffUntilMs) throw new Error('token exchange backing off after recent failure');
    const jwt = buildJwt({ clientEmail, privateKey, nowMs });
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: jwt }).toString(),
        signal: fetchTimeoutSignal(),
      });
    } catch (e) {
      backoffUntilMs = nowMs + TOKEN_EXCHANGE_BACKOFF_MS; // network/timeout failure
      throw e;
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    if (!res || res.status < 200 || res.status >= 300 || !body || !body.access_token) {
      backoffUntilMs = nowMs + TOKEN_EXCHANGE_BACKOFF_MS; // bad-response failure
      const detail = (body && (body.error_description || body.error)) || `HTTP ${res && res.status}`;
      throw new Error(`token exchange failed: ${detail}`);
    }
    cached = { accessToken: body.access_token, expiresAtMs: nowMs + (body.expires_in || 3600) * 1000 };
    return cached.accessToken;
  }

  // Send one message body (as returned by buildFcmMessage). Never throws for a
  // delivery-level failure — returns { ok, status, error, errorCode } so the
  // caller can prune dead tokens. Only truly exceptional paths reject.
  async function send(message) {
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      return { ok: false, status: 0, error: e.message, errorCode: null };
    }
    const res = await fetchImpl(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(message),
      signal: fetchTimeoutSignal(),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, error: null, errorCode: null };
    }
    let errBody = null;
    try { errBody = await res.json(); } catch { /* non-JSON error body */ }
    const { message: errMsg, errorCode } = parseFcmError(errBody);
    return { ok: false, status: res.status, error: errMsg, errorCode };
  }

  return { send };
}

// --- Pure registry + provider decision logic ------------------------------
// Extracted from server.js so the branching/validation is unit-testable without
// the server (owner's dual-gate directive). server.js keeps only the I/O.

// Resolve which transport(s) to use. Precedence: explicit env override >
// config.push.provider > 'ntfy' (back-compat default). Unknown/typo'd values are
// ignored (fall through) so a bad value can never silently disable ntfy.
function resolvePushProvider({ env, configProvider } = {}) {
  const valid = (v) => v === 'ntfy' || v === 'fcm' || v === 'both';
  if (valid(env)) return env;
  if (valid(configProvider)) return configProvider;
  return 'ntfy';
}
function providerSendsNtfy(provider) { return provider === 'ntfy' || provider === 'both'; }
function providerSendsFcm(provider) { return provider === 'fcm' || provider === 'both'; }

// Validate + normalize a device-registration body. Pure: returns
// { ok:false, error } or { ok:true, device:{token, deviceName, platform} }
// (registeredAt is stamped by the store, not here). Token trimmed + capped at
// 4096; deviceName control-chars AND HTML-significant chars (< > " ' &) stripped
// + capped at 100; platform whitelisted with an 'android' default.
const PLATFORMS = ['android', 'ios', 'other'];
function normalizeDeviceRegistration(body = {}) {
  const fcmToken = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
  if (!fcmToken) return { ok: false, error: 'fcmToken must be a non-empty string' };
  if (fcmToken.length > 4096) return { ok: false, error: 'fcmToken too long (max 4096)' };
  // Strip control chars, then < > " ' & — defense-in-depth so a device name can
  // never inject markup/attributes into a future UI that renders the registry.
  const deviceName = body.deviceName != null
    ? String(body.deviceName).slice(0, 100).replace(/[\x00-\x1f]/g, '').replace(/[<>"'&]/g, '')
    : '';
  const platform = PLATFORMS.includes(body.platform) ? body.platform : 'android';
  return { ok: true, device: { token: fcmToken, deviceName, platform } };
}

// Registry is capped so a runaway/hostile client can't grow it without bound. An
// upsert of an EXISTING token is always allowed (it doesn't add a row); a NEW
// token is refused once the registry is at the cap. Pure decision — unit-tested.
const MAX_DEVICES = 50;
function canRegisterDevice(deviceCount, isExisting, max = MAX_DEVICES) {
  return !!isExisting || deviceCount < max;
}

// Negative-cache gate for server.js's lazy service-account/client build. A failed
// service-account load (missing file, bad JSON, bad key) must NOT latch FCM dead
// until the next process restart — instead server.js records an "errored until"
// deadline and this predicate says whether the build may be re-attempted yet.
// Mirrors the token-exchange backoff (see TOKEN_EXCHANGE_BACKOFF_MS): after a
// failure, suppress retries for CLIENT_BUILD_BACKOFF_MS, then allow one again.
// Pure (clock injected by the caller) so the retry-after-backoff decision is
// exhaustively unit-testable. errUntilMs === 0 means "no prior failure".
const CLIENT_BUILD_BACKOFF_MS = 60 * 1000;
function shouldRetryClientBuild(errUntilMs, nowMs) {
  return !errUntilMs || nowMs >= errUntilMs;
}

// Display form of a token — never echo the full (semi-sensitive) value back.
function truncateToken(token) {
  const s = String(token || '');
  return s.length > 12 ? s.slice(0, 12) + '…' : s;
}

// A send whose FCM errorCode means the token is permanently dead → prune it.
const PRUNE_ERROR_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT']);
function shouldPruneOnError(errorCode) { return PRUNE_ERROR_CODES.has(errorCode); }

module.exports = {
  buildFcmMessage, buildJwt, createFcmClient, parseFcmError,
  resolvePushProvider, providerSendsNtfy, providerSendsFcm,
  normalizeDeviceRegistration, truncateToken, shouldPruneOnError,
  canRegisterDevice, shouldRetryClientBuild,
  FCM_TTL_SECONDS, TOKEN_URL, FCM_SCOPE, PLATFORMS, MAX_DEVICES,
  CLIENT_BUILD_BACKOFF_MS,
};
