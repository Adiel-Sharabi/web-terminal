// lib/cluster-token.js
//
// Short-lived, HMAC-signed tokens used for "direct terminal" mode (issue #20).
// The office server mints a token when it lists a session that lives on a
// cluster peer flagged `directConnect: true`. The browser then connects its
// WebSocket straight to that peer (skipping the office proxy hop) by
// presenting `?dt=<token>` in the WS URL.
//
// Security model
// --------------
// - HMAC-SHA256. Key is the peer's bearer token — a 32-byte random value
//   already shared between office (has it in cluster-tokens.json) and the
//   peer (has it in api-tokens.json). No new secret distribution needed.
// - Payload is JSON: { sid, user, exp }. `exp` is unix-ms; we default to 60s.
// - Token format: base64url(payload_json) + "." + base64url(hmac_sha256(payload_b64)).
//   JWT-ish but without a header — we always use HS256 + JSON and verify by
//   trying every candidate key.
// - Binds to `sid`: a valid token for session A can't be replayed on session B.
// - Binds to `user`: the far server authenticates the WS as this user.
// - `timingSafeEqual` for the signature compare.
//
// This file is pure — no fs, no network, no process. Unit-testable in isolation.

'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  if (typeof str !== 'string') return null;
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try { return Buffer.from(base64, 'base64'); } catch (e) { return null; }
}

/**
 * Mint a direct-mode token.
 * @param {string} secret - HMAC key (typically the peer's bearer token string).
 * @param {{ sid: string, user: string, ttlMs?: number, now?: number }} opts
 * @returns {string} token
 */
function mintDirectToken(secret, opts) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('mintDirectToken: secret must be a non-empty string');
  }
  if (!opts || typeof opts.sid !== 'string' || typeof opts.user !== 'string') {
    throw new Error('mintDirectToken: { sid, user } are required strings');
  }
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const payload = { sid: opts.sid, user: opts.user, exp: now + ttl };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a direct-mode token against a list of candidate keys.
 *
 * Iterates every candidate (they're short — a server's api-tokens map) and
 * returns the first that verifies. We don't distinguish "wrong key" from
 * "tampered signature" to the caller, only valid/invalid.
 *
 * @param {string} token
 * @param {string[]} candidateSecrets
 * @param {{ now?: number }} [opts]
 * @returns {{ valid: boolean, payload: object|null, expired: boolean, reason: string|null }}
 */
function verifyDirectToken(token, candidateSecrets, opts) {
  const now = opts && typeof opts.now === 'number' ? opts.now : Date.now();
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, payload: null, expired: false, reason: 'missing-token' };
  }
  const dot = token.indexOf('.');
  if (dot === -1 || dot === 0 || dot === token.length - 1) {
    return { valid: false, payload: null, expired: false, reason: 'malformed' };
  }
  const payloadB64 = token.substring(0, dot);
  const sigB64 = token.substring(dot + 1);

  const payloadBuf = b64urlDecode(payloadB64);
  const sigBuf = b64urlDecode(sigB64);
  if (!payloadBuf || !sigBuf) {
    return { valid: false, payload: null, expired: false, reason: 'malformed' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch (e) {
    return { valid: false, payload: null, expired: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' ||
      typeof payload.sid !== 'string' ||
      typeof payload.user !== 'string' ||
      typeof payload.exp !== 'number') {
    return { valid: false, payload: null, expired: false, reason: 'malformed' };
  }

  if (!Array.isArray(candidateSecrets) || candidateSecrets.length === 0) {
    return { valid: false, payload: null, expired: false, reason: 'no-keys' };
  }

  let matchedKey = false;
  for (const secret of candidateSecrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    if (expected.length !== sigBuf.length) continue;
    let ok = false;
    try { ok = crypto.timingSafeEqual(expected, sigBuf); } catch (e) { ok = false; }
    if (ok) { matchedKey = true; break; }
  }

  if (!matchedKey) {
    return { valid: false, payload: null, expired: false, reason: 'bad-signature' };
  }

  if (payload.exp <= now) {
    return { valid: false, payload, expired: true, reason: 'expired' };
  }

  return { valid: true, payload, expired: false, reason: null };
}

module.exports = {
  mintDirectToken,
  verifyDirectToken,
  DEFAULT_TTL_MS,
  // exported for tests
  _b64urlEncode: b64urlEncode,
  _b64urlDecode: b64urlDecode,
};
