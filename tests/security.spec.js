// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

/** Create a request context with cookie auth */
async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  // Login to get session cookie
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  // Extract Set-Cookie from login response
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();

  // Create new context with the cookie
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

/** Create a request context without auth */
async function noAuthCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

/** Login via page (for browser-based tests) */
async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

// ============================================================
// 1. Authentication
// ============================================================

test.describe('Authentication', () => {
  test('redirects to /login without cookie', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe('/login');
    await ctx.dispose();
  });

  test('login page returns 200', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/login');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Web Terminal');
    await ctx.dispose();
  });

  test('login with wrong credentials returns 401', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: 'wrong', password: 'wrong' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('login with correct credentials sets cookie and redirects', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: AUTH.user, password: AUTH.password },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()['set-cookie']).toContain('wt_session=');
    expect(res.headers()['location']).toBe('/');
    await ctx.dispose();
  });

  test('logout clears cookie and redirects to /login', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/logout', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['set-cookie']).toContain('Max-Age=0');
    expect(res.headers()['location']).toBe('/login');
    await ctx.dispose();
  });

  test('authenticated request returns 200', async () => {
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
  test('WebSocket /ws/notify rejects without cookie', async () => {
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      http.get(BASE + '/ws/notify', (res) => resolve(res.statusCode)).on('error', reject);
    });
    // Without cookie, WS upgrade should fail (302 redirect or connection close)
    expect([302, 401]).toContain(status);
  });

  test('WebSocket works with auth (via page context)', async ({ page }) => {
    await loginPage(page);

    // Get a session ID from the API
    const sessions = await page.evaluate(async () => {
      const res = await fetch('/api/sessions');
      return res.json();
    });
    expect(sessions.length).toBeGreaterThan(0);
    const sid = sessions[0].id;

    // Now open WebSocket — browser will send cookie
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
    // Session may have already exited (node-pty race on Windows), accept both
    expect([200, 404]).toContain(delRes.status());

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

    await loginPage(page);
    // Open sidebar to see session list
    await page.click('.tb-btn');
    await page.waitForSelector('.sb-item');

    // No img element should be injected in sidebar
    const imgCount = await page.locator('.sb-item img').count();
    expect(imgCount).toBe(0);

    // Text should appear literally (at least one match)
    const nameEl = page.locator('.sb-name').filter({ hasText: '<img' });
    expect(await nameEl.count()).toBeGreaterThanOrEqual(1);
    const text = await nameEl.first().textContent();
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

    await loginPage(page);
    // Open sidebar
    await page.click('.tb-btn');
    await page.waitForSelector('.sb-item');

    const scriptCount = await page.locator('.sb-item script').count();
    expect(scriptCount).toBe(0);

    const detail = page.locator('.sb-detail').filter({ hasText: 'alert' });
    expect(await detail.count()).toBeGreaterThanOrEqual(1);

    await ctx.delete('/api/sessions/' + id);
    await ctx.dispose();
  });
});

// ============================================================
// 7. Lobby UI
// ============================================================

test.describe('App UI', () => {
  test('app shows hostname in toolbar', async ({ page }) => {
    await loginPage(page);
    await page.waitForLoadState('networkidle');
    const host = await page.locator('#hostName').textContent();
    expect(host.length).toBeGreaterThan(0);
  });

  test('app shows sessions in sidebar', async ({ page }) => {
    await loginPage(page);
    // Open sidebar
    await page.click('.tb-btn');
    await page.waitForSelector('.sb-item');
    const items = await page.locator('.sb-item').count();
    expect(items).toBeGreaterThan(0);
  });
});

// ============================================================
// 8b. /api/exec opt-in + rate limit + audit log (M3)
// ============================================================

test.describe('/api/exec opt-in (M3)', () => {
  test('returns 404 when enableRemoteExec is missing/false', async () => {
    // Default test config does not set enableRemoteExec; the route should not
    // be registered.
    const ctx = await authCtx();
    const res = await ctx.post('/api/exec', { data: { command: 'echo hi' } });
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });
});

test.describe('/api/exec when enabled (M3)', () => {
  // Spawn an isolated server with WT_ENABLE_REMOTE_EXEC=1 on a separate port.
  const { spawn } = require('child_process');
  const http = require('http');
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const crypto = require('crypto');

  const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

  function makeTempDir() {
    const dir = path.join(os.tmpdir(), 'wt-exec-test-' + crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scrollback'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
  }

  function httpGetOk(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 500));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  let serverProc = null;
  let serverPort = 0;
  let serverDataDir = null;
  let auditFilePath = null;
  let bearerToken = null;

  test.beforeAll(async () => {
    serverPort = 17800 + Math.floor(Math.random() * 100);
    serverDataDir = makeTempDir();
    auditFilePath = path.join(serverDataDir, 'logs', 'exec-audit.log');

    // Seed an api token + enableRemoteExec into a dedicated config file under
    // the data dir. server.js reads config.test.json from its own cwd when
    // WT_TEST=1, so instead we run it with a fresh cwd pointing at the data
    // dir AND override via env. Since server.js looks up the config via
    // __dirname (the server's source dir), we use the env-var escape hatch
    // WT_ENABLE_REMOTE_EXEC=1 instead of writing a config.
    const pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\wt-exec-test-${crypto.randomUUID().slice(0, 8)}`
      : `/tmp/wt-exec-test-${crypto.randomUUID().slice(0, 8)}.sock`;

    const env = {
      ...process.env,
      WT_TEST: '1',
      WT_PORT: String(serverPort),
      WT_HOST: '127.0.0.1',
      WT_USER: 'testuser',
      WT_PASS: 'testpass:colon',
      WT_CWD: os.tmpdir(),
      WT_SPAWN_WORKER: '1',
      WT_WORKER_PIPE: pipe,
      WT_WORKER_DATA_DIR: serverDataDir,
      WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
      WT_RATE_LIMIT_BLOCK: '1000',
      WT_ENABLE_REMOTE_EXEC: '1',
      WT_EXEC_AUDIT_FILE: auditFilePath,
      WT_WORKER_QUIET: '1',
      WT_WORKER_NO_DEFAULT: '1',
    };

    serverProc = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: path.dirname(SERVER_SCRIPT),
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    let stderr = '';
    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Wait for healthy.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await httpGetOk(`http://127.0.0.1:${serverPort}/login`)) break;
      await new Promise(r => setTimeout(r, 200));
    }

    // Mint a bearer token via /api/auth/token (cleartext creds).
    const tokRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ user: 'testuser', password: 'testpass:colon', label: 'exec-test' });
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort, method: 'POST',
        path: '/api/auth/token',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.end(body);
    });
    if (tokRes.status !== 200) {
      throw new Error(`mint token failed: status=${tokRes.status} body=${tokRes.body}\nstderr=${stderr.slice(-1500)}`);
    }
    bearerToken = JSON.parse(tokRes.body).token;
  });

  test.afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) {
      try { serverProc.kill('SIGKILL'); } catch {}
    }
  });

  async function execCall(command) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ command });
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort, method: 'POST',
        path: '/api/exec',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${bearerToken}`,
        },
      }, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  test('audit log line written for each accepted call', async () => {
    // Read current audit size, make a call, verify a new line was appended.
    let before = 0;
    try { before = fs.statSync(auditFilePath).size; } catch {}

    const r = await execCall('echo audit-log-test');
    expect(r.status).toBe(200);
    // Give the append time to flush.
    await new Promise(res => setTimeout(res, 100));
    const after = fs.statSync(auditFilePath).size;
    expect(after).toBeGreaterThan(before);
    const tail = fs.readFileSync(auditFilePath, 'utf8').trim().split('\n').slice(-1)[0];
    const entry = JSON.parse(tail);
    expect(entry.ts).toBeTruthy();
    expect(entry.label).toBe('exec-test');
    expect(entry.cmdSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof entry.exitCode).toBe('number');
    expect(typeof entry.durationMs).toBe('number');
    // command body itself MUST NOT be logged
    expect(tail).not.toContain('audit-log-test');
  });

  test('first call succeeds; 31st within the minute returns 429 with Retry-After', async () => {
    test.setTimeout(60000);

    // The previous test used 1 call; we have 29 left before hitting the cap.
    // Run 29 more — all should succeed.
    for (let i = 0; i < 29; i++) {
      const r = await execCall('echo rate-limit-test-bulk');
      expect(r.status).toBe(200);
    }

    // 31st call within the same minute -> 429.
    const over = await execCall('echo rate-limit-test-over');
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeTruthy();
  });
});

// ============================================================
// 8c. Hook endpoint auth (H1): X-WT-Hook-Token required
// ============================================================

test.describe('Hook endpoint auth (H1)', () => {
  const fs = require('fs');
  const path = require('path');
  function readHookToken() {
    try { return fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim(); } catch { return ''; }
  }

  // H1 + localhost bypass: the token is enforced on the wire (non-loopback
  // callers), but localhost requests (127.0.0.1 / ::1) skip the token check.
  // Rationale: on Windows .hook-token is world-readable (no chmod equivalent),
  // so the token was never a real local-process boundary; requiring it just
  // forced a pty-worker restart — losing all Claude sessions — to inject the
  // env var. Tests below hit 127.0.0.1 so they exercise the bypass path; the
  // non-localhost deny path is documented in server.js:isLocalhostReq.
  test('hook request without X-WT-Hook-Token from localhost reaches handler (bypass)', async () => {
    const raw = await pwRequest.newContext({ baseURL: BASE });
    const res = await raw.post('/api/session/anything/hook', {
      data: { event: 'UserPromptSubmit' },
    });
    // Auth check passes → handler runs → session not found → 404
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook request with wrong X-WT-Hook-Token from localhost still reaches handler (bypass)', async () => {
    const raw = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'X-WT-Hook-Token': 'definitely-not-the-real-token' },
    });
    const res = await raw.post('/api/session/anything/hook', {
      data: { event: 'UserPromptSubmit' },
    });
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook request with correct token and valid session ID returns 200', async () => {
    // Create a real session via the auth API
    const ctx = await authCtx();
    const create = await ctx.post('/api/sessions', { data: { name: 'HookAuthTest' } });
    const { id } = await create.json();

    const raw = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() },
    });
    const res = await raw.post(`/api/session/${id}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    await ctx.delete(`/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });

  test('/api/hook (no :id) from localhost also bypasses token', async () => {
    const raw = await pwRequest.newContext({ baseURL: BASE });
    const res = await raw.post('/api/hook', {
      data: { event: 'UserPromptSubmit' },
      headers: { 'X-WT-Session-ID': 'whatever' },
    });
    // Auth passes → unknown session ID returns 200 with skipped reason
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await raw.dispose();
  });
});

// ============================================================
// 8. Session cookie expiry (M1)
// ============================================================

test.describe('Session cookie expiry', () => {
  test('expired cookie is rejected even with valid HMAC', async () => {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const secretFile = path.join(__dirname, '..', '.session-secret');
    const SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();

    // Build a cookie with a timestamp 91 days in the past and sign it with
    // the CURRENT secret. This proves the rejection is the expiry check,
    // not the HMAC.
    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    const payload = `testuser:${Date.now() - ninetyOneDays}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const token = `${Buffer.from(payload).toString('base64')}.${sig}`;

    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Cookie: `wt_session=${token}` },
    });

    // Protected page should redirect to /login (cookie rejected).
    const pageRes = await ctx.get('/', { maxRedirects: 0 });
    expect(pageRes.status()).toBe(302);
    expect(pageRes.headers()['location']).toBe('/login');

    // Protected API should return 401.
    const apiRes = await ctx.get('/api/sessions');
    expect(apiRes.status()).toBe(401);

    await ctx.dispose();
  });

  test('fresh cookie is accepted (control)', async () => {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const secretFile = path.join(__dirname, '..', '.session-secret');
    const SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();

    const payload = `testuser:${Date.now()}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const token = `${Buffer.from(payload).toString('base64')}.${sig}`;

    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Cookie: `wt_session=${token}` },
    });
    const res = await ctx.get('/api/sessions');
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });
});
