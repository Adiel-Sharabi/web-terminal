// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { username: 'testuser', password: 'testpass:colon' };
const AUTH_HEADER = 'Basic ' + Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64');

/** Create a request context with auth */
async function authCtx() {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: AUTH_HEADER },
  });
}

/** Create a request context without auth */
async function noAuthCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

// ============================================================
// 1. Authentication
// ============================================================

test.describe('Authentication', () => {
  test('returns 401 without credentials', async () => {
    // Use fetch directly to avoid Playwright's credential caching
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      http.get(BASE + '/', (res) => resolve(res.statusCode)).on('error', reject);
    });
    expect(status).toBe(401);
  });

  test('returns 401 with wrong credentials', async () => {
    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: 'Basic ' + Buffer.from('wrong:wrong').toString('base64') },
    });
    const res = await ctx.get('/');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('returns 200 with correct credentials', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/');
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });

  test('handles password containing colon correctly', async () => {
    // Our test password is "testpass:colon" — contains a colon
    const ctx = await authCtx();
    const res = await ctx.get('/api/hostname');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.hostname).toBeTruthy();
    await ctx.dispose();
  });
});

// ============================================================
// 2. WebSocket Authentication
// ============================================================

test.describe('WebSocket Authentication', () => {
  test('WebSocket /ws/notify rejects without auth (HTTP 401)', async () => {
    // A plain GET to a WS endpoint without auth should get 401
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      http.get(BASE + '/ws/notify', (res) => resolve(res.statusCode)).on('error', reject);
    });
    expect(status).toBe(401);
  });

  test('WebSocket /ws/:id rejects without auth (HTTP 401)', async () => {
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      http.get(BASE + '/ws/fake-session', (res) => resolve(res.statusCode)).on('error', reject);
    });
    expect(status).toBe(401);
  });

  test('WebSocket works with auth (via page context)', async ({ page }) => {
    // Navigate to lobby first to establish Basic Auth credentials in browser
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');

    // Get a session ID from the API
    const sessions = await page.evaluate(async () => {
      const res = await fetch('/api/sessions');
      return res.json();
    });
    expect(sessions.length).toBeGreaterThan(0);
    const sid = sessions[0].id;

    // Now open WebSocket — browser will send cached auth
    const wsResult = await page.evaluate(async (sessionId) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/${sessionId}`);
        ws.onopen = () => {
          setTimeout(() => { ws.close(); resolve({ connected: true }); }, 1000);
        };
        ws.onclose = (e) => {
          if (e.code === 1008) resolve({ connected: false, code: e.code });
        };
        ws.onerror = () => {};
        setTimeout(() => resolve({ connected: false, timeout: true }), 8000);
      });
    }, sid);
    expect(wsResult.connected).toBe(true);
  });
});

// ============================================================
// 3. Session CRUD
// ============================================================

test.describe('Session CRUD', () => {
  test('list sessions (default session exists)', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/sessions');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    await ctx.dispose();
  });

  test('create session', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/sessions', {
      data: { name: 'Test Session', cwd: process.env.TEMP || 'C:\\Windows\\Temp' },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.name).toBe('Test Session');
    // Clean up
    await ctx.delete('/api/sessions/' + data.id);
    await ctx.dispose();
  });

  test('session ID is UUID format (not predictable)', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/sessions', { data: { name: 'UUID Test' } });
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await ctx.delete('/api/sessions/' + data.id);
    await ctx.dispose();
  });

  test('rename session', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'Before Rename' } });
    const { id } = await createRes.json();

    const patchRes = await ctx.patch('/api/sessions/' + id, { data: { name: 'After Rename' } });
    expect(patchRes.status()).toBe(200);
    const patched = await patchRes.json();
    expect(patched.name).toBe('After Rename');

    const listRes = await ctx.get('/api/sessions');
    const list = await listRes.json();
    expect(list.find(s => s.id === id).name).toBe('After Rename');

    await ctx.delete('/api/sessions/' + id);
    await ctx.dispose();
  });

  test('kill session', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'To Kill' } });
    const { id } = await createRes.json();

    const delRes = await ctx.delete('/api/sessions/' + id);
    expect(delRes.status()).toBe(200);

    const listRes = await ctx.get('/api/sessions');
    const list = await listRes.json();
    expect(list.find(s => s.id === id)).toBeUndefined();
    await ctx.dispose();
  });

  test('kill nonexistent session returns 404', async () => {
    const ctx = await authCtx();
    const res = await ctx.delete('/api/sessions/nonexistent-id');
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });
});

// ============================================================
// 4. Config API Security
// ============================================================

test.describe('Config API Security', () => {
  test('GET /api/config does NOT return real password', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/config');
    expect(res.status()).toBe(200);
    const cfg = await res.json();
    expect(cfg.password).toBe('***');
    await ctx.dispose();
  });

  test('PUT /api/config strips unknown keys', async () => {
    const ctx = await authCtx();
    await ctx.put('/api/config', {
      data: { port: 17681, user: 'testuser', password: '***', evil: 'payload' },
    });

    // Read back — evil key should not exist
    const res = await ctx.get('/api/config');
    const cfg = await res.json();
    expect(cfg.evil).toBeUndefined();
    await ctx.dispose();
  });

  test('PUT /api/config with masked password preserves auth', async () => {
    const ctx = await authCtx();
    await ctx.put('/api/config', { data: { port: 17681, password: '***' } });

    // Auth should still work
    const res = await ctx.get('/api/config');
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });
});

// ============================================================
// 5. Hostname API
// ============================================================

test.describe('Hostname API', () => {
  test('returns hostname string', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/hostname');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(typeof data.hostname).toBe('string');
    expect(data.hostname.length).toBeGreaterThan(0);
    await ctx.dispose();
  });
});

// ============================================================
// 6. XSS Prevention
// ============================================================

test.describe('XSS Prevention', () => {
  test('XSS in session name is rendered as text, not HTML', async ({ page }) => {
    const ctx = await authCtx();
    const xssPayload = '<img src=x onerror=alert(1)>';

    const createRes = await ctx.post('/api/sessions', { data: { name: xssPayload } });
    const { id } = await createRes.json();

    await page.goto(BASE + '/');
    await page.waitForSelector('.session-card');

    // No img element should be injected
    const imgCount = await page.locator('.session-card img').count();
    expect(imgCount).toBe(0);

    // Text should appear literally
    const h3 = page.locator('.session-card h3').filter({ hasText: '<img' });
    await expect(h3).toHaveCount(1);
    const text = await h3.textContent();
    expect(text).toContain(xssPayload);

    await ctx.delete('/api/sessions/' + id);
    await ctx.dispose();
  });

  test('XSS in auto-command is rendered as text', async ({ page }) => {
    const ctx = await authCtx();
    const xssPayload = '"><script>alert(1)</script>';

    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'XSS Cmd Test', autoCommand: xssPayload },
    });
    const { id } = await createRes.json();

    await page.goto(BASE + '/');
    await page.waitForSelector('.session-card');

    const scriptCount = await page.locator('.session-card script').count();
    expect(scriptCount).toBe(0);

    const cmdDiv = page.locator('.auto-cmd').filter({ hasText: 'alert' });
    await expect(cmdDiv).toHaveCount(1);

    await ctx.delete('/api/sessions/' + id);
    await ctx.dispose();
  });
});

// ============================================================
// 7. Lobby UI
// ============================================================

test.describe('Lobby UI', () => {
  test('lobby shows hostname in title', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title).toContain('Web Terminal');
    const h1Text = await page.locator('#title').textContent();
    expect(h1Text).toContain('Web Terminal');
  });

  test('lobby shows session cards', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.waitForSelector('.session-card');
    const cards = await page.locator('.session-card').count();
    expect(cards).toBeGreaterThan(0);
  });
});
