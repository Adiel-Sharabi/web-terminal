// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');

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

async function noAuthCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

// ============================================================
// 1. API Token Authentication
// ============================================================

test.describe('API Token Auth', () => {
  test('POST /api/auth/token with wrong credentials returns 401', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/auth/token', {
      data: { user: 'wrong', password: 'wrong' }
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('POST /api/auth/token with correct credentials returns token', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'test-token' }
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.token).toBeTruthy();
    expect(data.token.length).toBe(64); // 32 bytes hex

    // Clean up — delete the token
    await ctx.delete('/api/auth/tokens/' + data.token);
    await ctx.dispose();
  });

  test('Bearer token grants API access', async () => {
    // Get a token
    const ctx = await authCtx();
    const tokenRes = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'bearer-test' }
    });
    const { token } = await tokenRes.json();
    await ctx.dispose();

    // Use token without cookie
    const tokenCtx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'Authorization': `Bearer ${token}` }
    });
    const res = await tokenCtx.get('/api/sessions');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);

    // Clean up
    await tokenCtx.delete('/api/auth/tokens/' + token);
    await tokenCtx.dispose();
  });

  test('invalid Bearer token returns 401 for API routes', async () => {
    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'Authorization': 'Bearer invalidtoken123' }
    });
    const res = await ctx.get('/api/sessions');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('GET /api/auth/tokens lists tokens', async () => {
    const ctx = await authCtx();
    // Create a token
    const tokenRes = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'list-test' }
    });
    const { token } = await tokenRes.json();

    // List tokens
    const listRes = await ctx.get('/api/auth/tokens');
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);
    const found = list.find(t => t.tokenFull === token);
    expect(found).toBeTruthy();
    expect(found.label).toBe('list-test');

    // Clean up
    await ctx.delete('/api/auth/tokens/' + token);
    await ctx.dispose();
  });

  test('DELETE /api/auth/tokens revokes token', async () => {
    const ctx = await authCtx();
    const tokenRes = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'revoke-test' }
    });
    const { token } = await tokenRes.json();

    // Revoke
    const delRes = await ctx.delete('/api/auth/tokens/' + token);
    expect(delRes.status()).toBe(200);

    // Verify revoked
    const tokenCtx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'Authorization': `Bearer ${token}` }
    });
    const res = await tokenCtx.get('/api/sessions');
    expect(res.status()).toBe(401);
    await tokenCtx.dispose();
    await ctx.dispose();
  });
});

// ============================================================
// 2. Cluster API
// ============================================================

test.describe('Cluster API', () => {
  test('GET /api/cluster/servers returns array', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/cluster/servers');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    await ctx.dispose();
  });

  test('GET /api/cluster/sessions returns sessions and servers', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/cluster/sessions');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.sessions).toBeTruthy();
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.servers).toBeTruthy();
    expect(Array.isArray(data.servers)).toBe(true);
    // Local server should always be present
    const local = data.servers.find(s => s.url === null);
    expect(local).toBeTruthy();
    expect(local.online).toBe(true);
    await ctx.dispose();
  });

  test('POST /api/cluster/auth rejects unknown server URL', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/cluster/auth', {
      data: { url: 'https://unknown-server.example.com', user: 'a', password: 'b' }
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('not in cluster config');
    await ctx.dispose();
  });

  test('cluster proxy rejects unauthenticated remote server', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/cluster/' + encodeURIComponent('https://fake.example.com') + '/api/sessions');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});

// ============================================================
// 3. Unauthenticated cluster endpoints return 401
// ============================================================

test.describe('Cluster Auth Required', () => {
  test('cluster/sessions requires auth', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/cluster/sessions');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('cluster/servers requires auth', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/cluster/servers');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('auth/token endpoint works without cookie (validates credentials)', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'no-cookie-test' }
    });
    // This endpoint is before auth middleware — validates credentials itself
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.token).toBeTruthy();
    // Clean up via authenticated context
    const authC = await authCtx();
    await authC.delete('/api/auth/tokens/' + data.token);
    await authC.dispose();
    await ctx.dispose();
  });

  test('auth/token rejects wrong credentials without cookie', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/api/auth/token', {
      data: { user: 'wrong', password: 'wrong' }
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});
