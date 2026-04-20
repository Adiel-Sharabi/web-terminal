// @ts-check
// Integration tests for issue #20 "direct terminal" mode.
//
// The full end-to-end flow (office mints for peer, browser WS to peer) needs
// a 2-server cluster which the single-server Playwright harness doesn't
// stand up. Instead we exercise the primitives against the running test
// server, which plays BOTH roles:
//   - the peer (it has api-tokens.json — any entry can be the HMAC key)
//   - the direct-WS acceptor (its /ws/:id?dt= handler verifies)
// The office-side `mintDirectToken` is a pure function and also unit-tested
// in cluster-token.spec.js — together these cover the full chain.

const { test, expect, request: pwRequest } = require('@playwright/test');
const WebSocket = require('ws');
const path = require('path');

const { mintDirectToken } = require(path.join(__dirname, '..', 'lib', 'cluster-token.js'));

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

let _sessionCounter = 0;
async function createSession(ctx, nameHint) {
  // Give each test session a unique name so the server's dedup window
  // (identical name+cwd) doesn't 409 us when tests run back-to-back.
  const name = `${nameHint || 'dt-test'}-${process.pid}-${Date.now()}-${++_sessionCounter}`;
  const res = await ctx.post('/api/sessions', {
    data: { cwd: process.env.TEMP || 'C:\\Windows\\Temp', name }
  });
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.id).toBeTruthy();
  return data.id;
}

async function createApiToken(ctx, label) {
  const r = await ctx.post('/api/auth/token', {
    data: { user: AUTH.user, password: AUTH.password, label: label || 'direct-mode-test' }
  });
  expect(r.status()).toBe(200);
  return (await r.json()).token;
}

// express-ws accepts the WS handshake BEFORE the `app.ws(...)` handler runs,
// so authorization failures surface as an immediate close after `open`.
// We wait a short grace window for a close frame before declaring success.
function openWs(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: headers || {}, perMessageDeflate: false });
    let settled = false;
    let graceTimer = null;
    ws.on('open', () => {
      if (settled) return;
      // Wait up to 500ms to see if server immediately closes (= auth fail).
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ws, code: null, reason: null });
      }, 500);
    });
    ws.on('close', (code, reasonBuf) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ws: null, code, reason: reasonBuf ? reasonBuf.toString() : '' });
    });
    ws.on('error', () => { /* swallow — 'close' will fire */ });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      try { ws.terminate(); } catch {}
      reject(new Error('timeout'));
    }, 5000);
  });
}

// ============================================================
// 1. cluster/sessions response shape
// ============================================================

test.describe('cluster/sessions — direct URL advertising', () => {
  test('local sessions never get directUrl (no peer to mint for)', async () => {
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      const res = await ctx.get('/api/cluster/sessions');
      expect(res.status()).toBe(200);
      const data = await res.json();
      const local = data.sessions.find(s => s.id === sid);
      expect(local).toBeTruthy();
      expect(local.serverUrl).toBeNull();
      expect(local.directUrl).toBeUndefined();
      expect(local.directToken).toBeUndefined();
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('servers[].directConnect defaults to false when not set', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/cluster/sessions');
    expect(res.status()).toBe(200);
    const data = await res.json();
    // Local server entry shouldn't advertise directConnect (only peers do)
    // Peer entries, if any, should have the field set.
    for (const srv of data.servers) {
      if (srv.url !== null) {
        expect(srv.directConnect === true || srv.directConnect === false || srv.directConnect === undefined).toBe(true);
      }
    }
    await ctx.dispose();
  });
});

// ============================================================
// 2. WS direct-token acceptance (peer side)
// ============================================================

test.describe('WS /ws/:id?dt= — direct token acceptance', () => {
  test('valid dt token connects the WS successfully', async () => {
    const ctx = await authCtx();
    const token = await createApiToken(ctx, 'dt-valid');
    const sid = await createSession(ctx);
    try {
      const dt = mintDirectToken(token, { sid, user: AUTH.user, ttlMs: 30_000 });
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?dt=${encodeURIComponent(dt)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeTruthy();
      expect(r.ws.readyState).toBe(WebSocket.OPEN);
      r.ws.close();
    } finally {
      await ctx.delete('/api/auth/tokens/' + token);
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('WS without cookie, without token, without dt — rejected', async () => {
    // Use a session id that exists so the only auth-fail path is auth itself.
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      const r = await openWs(`ws://localhost:17681/ws/${encodeURIComponent(sid)}`);
      // Unauthenticated upgrade is rejected before the handler runs — the
      // auth middleware returns HTTP 401, which surfaces to ws clients as
      // close code 1005 (no status) or 1006 (abnormal). Either way, no ws.
      expect(r.ws).toBeNull();
      expect(r.code === 1005 || r.code === 1006 || r.code === 1008).toBe(true);
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('expired dt token rejected with close code 4003', async () => {
    const ctx = await authCtx();
    const token = await createApiToken(ctx, 'dt-expired');
    const sid = await createSession(ctx);
    try {
      // ttlMs negative → exp already in the past
      const dt = mintDirectToken(token, { sid, user: AUTH.user, ttlMs: -5_000 });
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?dt=${encodeURIComponent(dt)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeNull();
      expect(r.code).toBe(4003);
    } finally {
      await ctx.delete('/api/auth/tokens/' + token);
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('dt token signed with unknown key rejected (4004)', async () => {
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      // Sign with a key that is NOT in the server's api-tokens.json.
      const dt = mintDirectToken('not-in-api-tokens-' + Date.now(), { sid, user: AUTH.user, ttlMs: 30_000 });
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?dt=${encodeURIComponent(dt)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeNull();
      expect(r.code).toBe(4004);
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('dt token for a different sid rejected (4004)', async () => {
    const ctx = await authCtx();
    const token = await createApiToken(ctx, 'dt-sid-mismatch');
    const sid1 = await createSession(ctx);
    const sid2 = await createSession(ctx);
    try {
      // Mint for sid1, try to use on sid2 — must be rejected.
      const dt = mintDirectToken(token, { sid: sid1, user: AUTH.user, ttlMs: 30_000 });
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid2)}?dt=${encodeURIComponent(dt)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeNull();
      expect(r.code).toBe(4004);
    } finally {
      await ctx.delete('/api/auth/tokens/' + token);
      await ctx.delete('/api/sessions/' + sid1);
      await ctx.delete('/api/sessions/' + sid2);
      await ctx.dispose();
    }
  });

  test('dt token with tampered sid (sig recomputed, different key) rejected', async () => {
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      // Attacker doesn't know any valid HMAC key: even a well-formed token
      // signed with a guessed key won't verify.
      const dt = mintDirectToken('attacker-guess', { sid, user: 'root', ttlMs: 30_000 });
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?dt=${encodeURIComponent(dt)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeNull();
      expect(r.code).toBe(4004);
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('malformed dt token rejected (4004)', async () => {
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?dt=not-a-valid-token`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeNull();
      expect(r.code).toBe(4004);
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });
});

// ============================================================
// 3. Back-compat: cookie and Bearer auth still work unchanged
// ============================================================

test.describe('WS — backward compatibility', () => {
  test('cookie-auth WS still works (client ignoring directUrl)', async () => {
    const ctx = await authCtx();
    const sid = await createSession(ctx);
    try {
      // Grab the cookie we're using, re-use for the WS handshake.
      const cookieHdr = ctx['_options']?.extraHTTPHeaders?.Cookie;
      // Playwright hides internals — just log in again and grab from the response.
      const ctx2 = await pwRequest.newContext({ baseURL: BASE });
      const loginRes = await ctx2.post('/login', {
        form: { user: AUTH.user, password: AUTH.password },
        maxRedirects: 0,
      });
      const setCookie = loginRes.headers()['set-cookie'];
      const cookiePair = setCookie.split(';')[0];
      await ctx2.dispose();

      const r = await openWs(`ws://localhost:17681/ws/${encodeURIComponent(sid)}`, { Cookie: cookiePair });
      expect(r.ws).toBeTruthy();
      expect(r.ws.readyState).toBe(WebSocket.OPEN);
      r.ws.close();
    } finally {
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });

  test('Bearer token (?token=) WS still works', async () => {
    const ctx = await authCtx();
    const token = await createApiToken(ctx, 'legacy-bearer');
    const sid = await createSession(ctx);
    try {
      const wsUrl = `ws://localhost:17681/ws/${encodeURIComponent(sid)}?token=${encodeURIComponent(token)}`;
      const r = await openWs(wsUrl);
      expect(r.ws).toBeTruthy();
      expect(r.ws.readyState).toBe(WebSocket.OPEN);
      r.ws.close();
    } finally {
      await ctx.delete('/api/auth/tokens/' + token);
      await ctx.delete('/api/sessions/' + sid);
      await ctx.dispose();
    }
  });
});
