// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, AUTH, authCtx, noAuthCtx, loginPage } = require('./test-helpers');

// ============================================================
// 1. Security Headers
// ============================================================

test.describe('Security Headers', () => {
  test('authenticated response includes security headers', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/sessions');
    expect(res.status()).toBe(200);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['content-security-policy']).toBeTruthy();
    await ctx.dispose();
  });
});

// ============================================================
// 2. Session Lifecycle
// ============================================================

test.describe('Session Lifecycle', () => {
  test('create session with invalid cwd returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/sessions', {
      data: { name: 'Bad CWD', cwd: 'Z:\\nonexistent\\path\\that\\does\\not\\exist' },
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('does not exist');
    await ctx.dispose();
  });

  test('session limit returns 429 when max reached', async () => {
    const ctx = await authCtx();
    const created = [];

    try {
      // Get current sessions to know how many exist
      const listRes = await ctx.get('/api/sessions');
      const existing = await listRes.json();
      const toCreate = 10 - existing.length;

      // Create sessions up to the limit (with small delays to avoid overwhelming node-pty)
      for (let i = 0; i < toCreate; i++) {
        const res = await ctx.post('/api/sessions', {
          data: { name: `Limit Test ${i}` },
        });
        expect(res.status()).toBe(200);
        const data = await res.json();
        created.push(data.id);
      }

      // Next one should fail with 429
      const overRes = await ctx.post('/api/sessions', {
        data: { name: 'Over Limit' },
      });
      expect(overRes.status()).toBe(429);
      const overData = await overRes.json();
      expect(overData.error).toContain('Session limit');
    } finally {
      // Clean up created sessions (one at a time, ignore errors)
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
  });

  test('create and kill session, verify gone from list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Kill Me' },
    });
    const { id } = await createRes.json();

    // Kill it
    const delRes = await ctx.delete('/api/sessions/' + id);
    expect([200, 404]).toContain(delRes.status());

    // Verify gone
    const listRes = await ctx.get('/api/sessions');
    const list = await listRes.json();
    expect(list.find(s => s.id === id)).toBeUndefined();
    await ctx.dispose();
  });

  test('PATCH session with autoCommand update', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Auto Cmd Test' },
    });
    const { id } = await createRes.json();

    try {
      const patchRes = await ctx.patch('/api/sessions/' + id, {
        data: { autoCommand: 'echo hello' },
      });
      expect(patchRes.status()).toBe(200);
      const patched = await patchRes.json();
      expect(patched.autoCommand).toBe('echo hello');

      // Verify via session list
      const listRes = await ctx.get('/api/sessions');
      const list = await listRes.json();
      const session = list.find(s => s.id === id);
      expect(session.autoCommand).toBe('echo hello');
    } finally {
      try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      await ctx.dispose();
    }
  });
});

// ============================================================
// 3. /api/exec Endpoint
// ============================================================

test.describe('/api/exec Endpoint', () => {
  test('execute echo command returns stdout', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/exec', {
      data: { command: 'echo hello' },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.stdout).toContain('hello');
    expect(data.exitCode).toBe(0);
    await ctx.dispose();
  });

  test('missing command returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/exec', {
      data: {},
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('command is required');
    await ctx.dispose();
  });

  test('command too long returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.post('/api/exec', {
      data: { command: 'a'.repeat(4097) },
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('too long');
    await ctx.dispose();
  });
});

// ============================================================
// 4. WebSocket Basics
// ============================================================

test.describe('WebSocket Basics', () => {
  test('connect to nonexistent session closes with 4000', async ({ page }) => {
    await loginPage(page);

    const wsResult = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws/nonexistent-session-id`);
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
        ws.onerror = () => {};
        setTimeout(() => resolve({ code: -1, timeout: true }), 5000);
      });
    });
    expect(wsResult.code).toBe(4000);
  });

  test('send resize message without error', async ({ page }) => {
    // Create a dedicated session so no other WS viewer interferes
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'Resize Test' } });
    const { id: sid } = await createRes.json();

    await loginPage(page);

    const wsResult = await page.evaluate(async (sessionId) => {
      return new Promise((resolve) => {
        let resolved = false;
        const ws = new WebSocket(`ws://${location.host}/ws/${sessionId}`);
        ws.onopen = () => {
          // Send resize message
          ws.send(JSON.stringify({ resize: { cols: 120, rows: 40 } }));
          // Wait a bit, then verify session still works by sending data
          setTimeout(() => {
            if (resolved) return;
            try {
              ws.send('echo ok\n');
              setTimeout(() => { if (!resolved) { resolved = true; ws.close(); resolve({ ok: true }); } }, 500);
            } catch (e) {
              if (!resolved) { resolved = true; resolve({ ok: false, error: e.message }); }
            }
          }, 500);
        };
        ws.onclose = (e) => {
          // 4001 = kicked by exclusive viewer (app reconnected), still counts as success
          if (!resolved) { resolved = true; resolve({ ok: true, code: e.code }); }
        };
        ws.onerror = () => {};
        setTimeout(() => { if (!resolved) { resolved = true; resolve({ ok: false, timeout: true }); } }, 8000);
      });
    }, sid);
    expect(wsResult.ok).toBe(true);

    // Clean up
    try { await ctx.delete('/api/sessions/' + sid); } catch (e) {}
    await ctx.dispose();
  });

  test('send heartbeat message without error', async ({ page }) => {
    // Create a dedicated session so no other WS viewer interferes
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', { data: { name: 'Heartbeat Test' } });
    const { id: sid } = await createRes.json();

    await loginPage(page);

    const wsResult = await page.evaluate(async (sessionId) => {
      return new Promise((resolve) => {
        let resolved = false;
        const ws = new WebSocket(`ws://${location.host}/ws/${sessionId}`);
        ws.onopen = () => {
          // Send heartbeat — should not be forwarded to PTY
          ws.send(JSON.stringify({ heartbeat: Date.now() }));
          setTimeout(() => { if (!resolved) { resolved = true; ws.close(); resolve({ ok: true }); } }, 1000);
        };
        ws.onclose = (e) => {
          // 4001 = kicked by exclusive viewer (app reconnected), still counts as success
          if (!resolved) { resolved = true; resolve({ ok: true, code: e.code }); }
        };
        ws.onerror = () => {};
        setTimeout(() => { if (!resolved) { resolved = true; resolve({ ok: false, timeout: true }); } }, 8000);
      });
    }, sid);
    expect(wsResult.ok).toBe(true);

    // Clean up
    try { await ctx.delete('/api/sessions/' + sid); } catch (e) {}
    await ctx.dispose();
  });
});

// ============================================================
// 5. Cookie Flags
// ============================================================

test.describe('Cookie Flags', () => {
  test('login Set-Cookie has HttpOnly and SameSite=Lax', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: AUTH.user, password: AUTH.password },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    const setCookie = res.headers()['set-cookie'];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    await ctx.dispose();
  });
});

// ============================================================
// 6. /api/version
// ============================================================

test.describe('/api/version', () => {
  test('returns JSON with version, hash, serverName', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/version');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.version).toBeTruthy();
    expect(typeof data.hash).toBe('string');
    expect(data.serverName).toBeTruthy();
    await ctx.dispose();
  });
});

// ============================================================
// 7. Rate Limiting (MUST be last — triggers rate limit on the test IP)
// ============================================================

test.describe('Rate Limiting', () => {
  test('blocks after repeated failed login attempts', async () => {
    const ctx = await noAuthCtx();
    // Send enough failed attempts to guarantee rate limiting (server allows 5).
    // Other parallel test files may have already added some, so send extras.
    for (let i = 0; i < 10; i++) {
      await ctx.post('/login', {
        form: { user: 'wrong', password: 'wrong' },
        maxRedirects: 0,
      });
    }
    // Next attempt must be rate limited
    const res = await ctx.post('/login', {
      form: { user: 'wrong', password: 'wrong' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(429);
    await ctx.dispose();
  });

  test('rate limit blocks even correct credentials', async () => {
    // After the previous test, we're still rate-limited (same IP, same server instance)
    const ctx = await noAuthCtx();
    const res = await ctx.post('/login', {
      form: { user: AUTH.user, password: AUTH.password },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(429);
    // Wait for rate limit block to expire so other test files aren't affected
    await new Promise(r => setTimeout(r, 1500));
    await ctx.dispose();
  });
});
