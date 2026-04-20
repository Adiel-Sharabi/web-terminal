// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

function readHookToken() {
  try { return fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim(); } catch { return ''; }
}

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
    extraHTTPHeaders: {
      Cookie: setCookie.split(';')[0],
      'X-WT-Hook-Token': readHookToken(),
    },
  });
}

// ============================================================
// Stale Session Status — "looks working but isn't"
// ============================================================

test.describe('Stale session status detection', () => {
  let ctx;
  let sessionId;

  test.beforeEach(async () => {
    ctx = await authCtx();
    // Create a fresh session
    const res = await ctx.post('/api/sessions', {
      data: { name: `StaleTest-${Date.now()}` },
    });
    const body = await res.json();
    sessionId = body.id;
    expect(sessionId).toBeTruthy();
  });

  test.afterEach(async () => {
    if (sessionId) {
      await ctx.delete(`/api/sessions/${sessionId}`);
    }
    await ctx.dispose();
  });

  test('new session starts with status "active"', async () => {
    const res = await ctx.get('/api/sessions');
    const sessions = await res.json();
    const s = sessions.find(s => s.id === sessionId);
    expect(s.status).toBe('active');
  });

  test('hook sets status to "working"', async () => {
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('working');
  });

  test('hook sets status to "idle" on Stop', async () => {
    // First set to working
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    // Then Stop
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Stop' },
    });
    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('idle');
  });

  test('status stays "working" forever without Stop hook (the bug)', async () => {
    // Set to working
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });

    // Simulate time passing — patch lastActivity to 10 minutes ago via
    // a dedicated test endpoint, or just verify the status doesn't self-correct.
    // We'll check after a brief delay that status is STILL working.
    await new Promise(r => setTimeout(r, 500));

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);

    // THIS IS THE BUG: status is stuck at "working" with no way to detect staleness
    // After the fix, the API should include a staleness indicator when lastActivity
    // is old relative to the "working" status.
    expect(s.status).toBe('working'); // confirms the bug exists

    // The real test: the API should flag stale sessions.
    // A session that's "working" but hasn't had activity in >5 minutes is stale.
    // We can't wait 5 real minutes, so we test the mechanism via the test helper.
  });

  test('API reports stale flag for sessions stuck in "working" too long', async () => {
    // Set to working
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    expect((await hookRes.json()).status).toBe('working');

    // Artificially age the session's lastActivity
    const ageRes = await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10 },
    });
    const ageBody = await ageRes.json();
    expect(ageBody.ok).toBeTruthy();
    // Verify age was actually applied (lastActivity should be ~10 min ago)
    expect(Date.now() - ageBody.lastActivity).toBeGreaterThan(9 * 60 * 1000);

    // Now fetch sessions — stale detection should auto-correct to idle
    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('idle');
  });

  test('stale detection does NOT downgrade genuinely active sessions', async () => {
    // Set to working with recent activity (just now)
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });

    // Don't age it — activity is fresh
    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('working');
  });

  test('"idle" sessions are NOT affected by stale detection even if old', async () => {
    // Set to idle
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Stop' },
    });

    // Age it
    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 60 },
    });

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    // Idle is a stable state — should stay idle, not change to something else
    expect(s.status).toBe('idle');
  });

  test('"waiting" sessions stuck too long are also marked stale', async () => {
    // Set to waiting
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PermissionRequest' },
    });
    expect(hookRes.ok()).toBeTruthy();
    const hookBody = await hookRes.json();
    expect(hookBody.status).toBe('waiting');

    // Age it — a permission request pending for 10 min is also suspicious
    const ageRes = await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10 },
    });
    expect(ageRes.ok()).toBeTruthy();

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('idle');
  });

  test('cluster/sessions also reflects stale correction for local sessions', async () => {
    // Set to working then age
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    expect((await hookRes.json()).status).toBe('working');

    const ageRes = await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10 },
    });
    const ageBody = await ageRes.json();
    expect(ageBody.ok).toBeTruthy();
    expect(Date.now() - ageBody.lastActivity).toBeGreaterThan(9 * 60 * 1000);

    // Now test via cluster endpoint (which also calls correctStaleStatus for local sessions)
    const res = await ctx.get('/api/cluster/sessions');
    const data = await res.json();
    const s = data.sessions.find(s => s.id === sessionId);
    expect(s).toBeTruthy();
    expect(s.status).toBe('idle');
  });
});
