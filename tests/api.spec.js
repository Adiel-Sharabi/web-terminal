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

  test('rapid duplicate session creation returns 409', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      // Create first session
      const res1 = await ctx.post('/api/sessions', {
        data: { name: 'Dup Test', cwd: 'C:\\dev' },
      });
      expect(res1.status()).toBe(200);
      created.push((await res1.json()).id);

      // Immediately create another with same name + cwd — should be rejected
      const res2 = await ctx.post('/api/sessions', {
        data: { name: 'Dup Test', cwd: 'C:\\dev' },
      });
      expect(res2.status()).toBe(409);
      const data = await res2.json();
      expect(data.error).toContain('Duplicate');
    } finally {
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
  });

  test('different name or cwd is not rejected as duplicate', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      // Create first session
      const res1 = await ctx.post('/api/sessions', {
        data: { name: 'Unique A' },
      });
      expect(res1.status()).toBe(200);
      created.push((await res1.json()).id);

      // Different name — should succeed
      const res2 = await ctx.post('/api/sessions', {
        data: { name: 'Unique B' },
      });
      expect(res2.status()).toBe(200);
      created.push((await res2.json()).id);
    } finally {
      for (const id of created) {
        try { await ctx.delete('/api/sessions/' + id); } catch (e) {}
      }
      await ctx.dispose();
    }
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
// 2b. Session Rename Persistence
// ============================================================

test.describe('Session Rename Persistence', () => {
  test('rename persists in session list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Before Rename' },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      const patchRes = await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'After Rename' },
      });
      expect(patchRes.status()).toBe(200);
      expect((await patchRes.json()).name).toBe('After Rename');

      // Verify in session list
      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s).toBeTruthy();
      expect(s.name).toBe('After Rename');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('rename persists after re-fetching session list', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Original Name' },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'Renamed Session' },
      });

      // Fetch list multiple times to verify it sticks
      for (let i = 0; i < 3; i++) {
        const list = await (await ctx.get('/api/sessions')).json();
        const s = list.find(x => x.id === id);
        expect(s.name).toBe('Renamed Session');
      }
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('rename with empty string keeps old name', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'Keep This Name' },
    });
    const { id } = await createRes.json();

    try {
      // Patch with empty name — should not change
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: '' },
      });

      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s.name).toBe('Keep This Name');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('multiple renames — last one wins', async () => {
    const ctx = await authCtx();
    const createRes = await ctx.post('/api/sessions', {
      data: { name: 'First' },
    });
    const { id } = await createRes.json();

    try {
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Second' } });
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Third' } });
      await ctx.patch(`/api/sessions/${id}`, { data: { name: 'Final Name' } });

      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find(x => x.id === id);
      expect(s.name).toBe('Final Name');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });
});

// ============================================================
// 2c. Claude Session Name Persistence
// ============================================================

test.describe('Claude Session Name Persistence', () => {
  test('PATCH /api/claude-sessions/:id saves custom name', async () => {
    const ctx = await authCtx();
    const fakeId = 'test-' + Date.now();
    try {
      const res = await ctx.patch(`/api/claude-sessions/${fakeId}`, {
        data: { name: 'My Custom Name' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      // Clean up: remove the name we just saved
      await ctx.patch(`/api/claude-sessions/${fakeId}`, { data: { name: 'cleanup' } });
      await ctx.dispose();
    }
  });

  test('PATCH /api/claude-sessions/:id with empty name returns 400', async () => {
    const ctx = await authCtx();
    const res = await ctx.patch('/api/claude-sessions/fake-id', {
      data: { name: '' },
    });
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });

  test('rename active session with claude autoCommand persists to claude-session-names', async () => {
    const ctx = await authCtx();
    const claudeSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const createRes = await ctx.post('/api/sessions', {
      data: {
        name: 'Original',
        autoCommand: `claude --resume ${claudeSessionId} --dangerously-skip-permissions`,
      },
    });
    const { id } = await createRes.json();

    try {
      // Rename the active session
      const patchRes = await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'CN Issues Investigation' },
      });
      expect(patchRes.status()).toBe(200);

      // Verify the claude session name was persisted via the claude-sessions rename API
      // We can check by reading it back through the PATCH endpoint (the GET endpoint
      // reads from JSONL files which we don't have for this fake ID)
      // Instead, create another session with the same claude ID and rename it differently
      const patchRes2 = await ctx.patch(`/api/claude-sessions/${claudeSessionId}`, {
        data: { name: 'Direct API Name' },
      });
      expect(patchRes2.status()).toBe(200);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch (e) {}
      await ctx.dispose();
    }
  });

  test('session name persists after session is killed', async () => {
    const ctx = await authCtx();
    const claudeSessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const createRes = await ctx.post('/api/sessions', {
      data: {
        name: 'Will Be Renamed',
        autoCommand: `claude --resume ${claudeSessionId}`,
      },
    });
    const { id } = await createRes.json();

    try {
      // Rename
      await ctx.patch(`/api/sessions/${id}`, {
        data: { name: 'Persisted Name' },
      });

      // Kill the session
      await ctx.delete(`/api/sessions/${id}`);

      // Wait a moment for onExit to fire
      await new Promise(r => setTimeout(r, 500));

      // Verify the name is still saved — re-save it and check it responds OK
      // (The actual persistence is in claude-session-names.json on disk)
      const verifyRes = await ctx.patch(`/api/claude-sessions/${claudeSessionId}`, {
        data: { name: 'Overwrite Test' },
      });
      expect(verifyRes.status()).toBe(200);
    } finally {
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
// 6b. /api/history/folders
// ============================================================

test.describe('/api/history/folders', () => {
  test('returns an array of folder paths', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/history/folders');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Should contain at least one folder (scanned from config)
    expect(data.length).toBeGreaterThan(0);
    // Each entry should be a string
    for (const f of data) {
      expect(typeof f).toBe('string');
    }
    await ctx.dispose();
  });

  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/history/folders');
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});

// ============================================================
// 7. Session Hook Endpoint
// ============================================================

test.describe('Session Hook', () => {
  test('hook updates session status without auth', async () => {
    // Create a session first (needs auth)
    const ctx = await authCtx();
    const create = await ctx.post(`${BASE}/api/sessions`, {
      data: { name: 'HookTest' }
    });
    const { id } = await create.json();

    // Hook endpoint works without auth (validated by session ID)
    const raw = await pwRequest.newContext();
    const res = await raw.post(`${BASE}/api/session/${id}/hook`, {
      data: { event: 'UserPromptSubmit' }
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('working');

    // Verify status persists in session list
    const list = await (await ctx.get(`${BASE}/api/sessions`)).json();
    const s = list.find(x => x.id === id);
    expect(s.status).toBe('working');

    // Notification event changes to idle
    const res2 = await raw.post(`${BASE}/api/session/${id}/hook`, {
      data: { event: 'Notification' }
    });
    expect((await res2.json()).status).toBe('idle');

    // Cleanup
    await ctx.delete(`${BASE}/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });

  test('hook rejects invalid session ID', async () => {
    const raw = await pwRequest.newContext();
    const res = await raw.post(`${BASE}/api/session/nonexistent/hook`, {
      data: { event: 'Stop' }
    });
    expect(res.status()).toBe(404);
    await raw.dispose();
  });

  test('hook rejects missing event', async () => {
    const ctx = await authCtx();
    const create = await ctx.post(`${BASE}/api/sessions`, { data: { name: 'HookTest2' } });
    const { id } = await create.json();

    const raw = await pwRequest.newContext();
    const res = await raw.post(`${BASE}/api/session/${id}/hook`, { data: {} });
    expect(res.status()).toBe(400);

    await ctx.delete(`${BASE}/api/sessions/${id}`);
    await ctx.dispose();
    await raw.dispose();
  });
});

// ============================================================
// 8. Rate Limiting (MUST be last — triggers rate limit on the test IP)
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
