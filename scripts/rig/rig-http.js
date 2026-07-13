'use strict';
// HTTP for the rig verifiers.
//
// Two machine-level quirks are worked around here, both measured, not guessed:
//
// 1. NOT global fetch. undici cannot reach 127.0.0.1 on this box at all — every request
//    dies with `connect ETIMEDOUT 127.0.0.1:7999`, while a raw http.request to the same
//    port answers in 3ms. node:http it is.
//
// 2. The FIRST TCP connect of a fresh process to loopback intermittently TIMES OUT, and
//    every connection after it answers in 2-6ms. Probed once a second for 15s: the pre-flight
//    connect timed out, then 15/15 succeeded. So a connection is retried rather than trusted,
//    and a keep-alive agent keeps the working socket instead of paying that dice-roll per
//    call. (Same signature as the Playwright suite's first-test-of-the-run failure.)
//    A verifier that cannot connect proves nothing — so it must not fail on a cold socket.

const http = require('http');

const PORT = parseInt(process.env.WT_RIG_PORT || '7999', 10);
const HOST = '127.0.0.1';
const USER = process.env.WT_RIG_USER || 'admin';
const PASS = process.env.WT_RIG_PASS || 'rig';

const WS_BASE = `ws://${HOST}:${PORT}`;

// Reuse the socket once one is up — see note 2.
const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

const RETRYABLE = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(method, path, { cookie, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: HOST, port: PORT, path, method, headers, agent, timeout: 8000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timeout: ${method} ${path}`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One request, retried through a cold/blackholed socket. Returns { status, headers, body }. */
async function request(method, path, opts = {}) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await once(method, path, opts);
    } catch (e) {
      if (!RETRYABLE.has(e.code)) throw e;
      last = e;
      await sleep(250);
    }
  }
  throw last;
}

/** Log in and return the session cookie the other calls need. */
async function login() {
  const body = new URLSearchParams({ user: USER, password: PASS }).toString();
  const res = await request('POST', '/login', { body, contentType: 'application/x-www-form-urlencoded' });
  const set = res.headers['set-cookie'];
  if (!set || !set.length) throw new Error(`rig login failed (HTTP ${res.status}) — is the rig up? (node scripts/rig/rig.js up)`);
  return String(set[0]).split(';')[0];
}

/** A JSON API call. Throws on a non-2xx so a verifier fails loudly, never silently. */
async function api(cookie, method, path, payload) {
  const res = await request(method, path, {
    cookie,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  return res.body ? JSON.parse(res.body) : null;
}

module.exports = { PORT, HOST, WS_BASE, USER, PASS, request, login, api };
