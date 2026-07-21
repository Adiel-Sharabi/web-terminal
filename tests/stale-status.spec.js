// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:17681';
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
    // Then Stop — debounced through processHookEvent so we wait the window
    // before asserting. The debounce keeps "Stop between agentic turns" from
    // briefly flashing "stopped" in the UI; see server.js HOOK_STOP_DEBOUNCE_MS.
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Stop' },
    });
    const debounceMs = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 200;
    await new Promise(r => setTimeout(r, debounceMs + 400));
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
    // Set to idle — Stop is debounced in server.js, so wait the window before
    // continuing or the session will still be in the pre-Stop state.
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Stop' },
    });
    const debounceMs = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 200;
    await new Promise(r => setTimeout(r, debounceMs + 400));

    // Age it
    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 60 },
    });

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    // Idle is a stable state — should stay idle, not change to something else
    expect(s.status).toBe('idle');
  });

  // REMOVED: '"waiting" sessions stuck too long are also marked stale'. It asserted
  // that a 10-minute-old PermissionRequest flips to idle, on the rationale that it
  // was "also suspicious". That rationale is inverted and was the bug: a session in
  // 'waiting' is blocked ON THE USER, so elapsed silence measures how long they have
  // not answered — never whether the question resolved. Its legitimate concern (an
  // ABANDONED wait must not pin forever) is kept, at a horizon that cannot fire on a
  // live question: see the abandonment-backstop test below.

  test('#37: recent PTY output keeps a working session from stale-flip (build/bg process)', async () => {
    // A build or background process produces continuous PTY output but fires no
    // Claude hook. Age ONLY the hook clock (stale) while lastActivity stays
    // fresh — the session must NOT be flipped to idle.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    expect((await hookRes.json()).status).toBe('working');

    const ageRes = await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10, hookOnly: true },
    });
    expect(ageRes.ok()).toBeTruthy();

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    // Before the fix: correctStaleStatus keyed only on the hook clock → 'idle'.
    // After: fresh lastActivity keeps it 'working'.
    expect(s.status).toBe('working');
  });

  test('#37: a subagent-working session with fresh output stays working', async () => {
    // SubagentStart sets working; a long subagent refreshes no parent hook, but
    // the terminal keeps emitting output (spinner). Stale hook clock alone must
    // not flip it.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'SubagentStart' },
    });
    expect((await hookRes.json()).status).toBe('working');

    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10, hookOnly: true },
    });

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('working');
  });

  test('#37: a truly silent session (both clocks stale) still self-corrects to idle', async () => {
    // Self-bounding: no output AND no hook for >5 min → genuinely hung → idle.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit' },
    });
    expect((await hookRes.json()).status).toBe('working');

    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10 }, // both clocks
    });

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('idle');
  });

  test('a session WAITING on the user is NEVER stale-flipped to idle', async () => {
    // The staleness heuristic is INVERTED for 'waiting'. For 'working', silence
    // means the work probably died, so idle is a sane correction (#37 above).
    // For 'waiting' silence is the DEFINING condition: the session is blocked on
    // the user and emits nothing — no hook, no PTY output — until they answer.
    // Aging both clocks is therefore not evidence the wait ended; it is evidence
    // the user has not answered YET, which is exactly when the red pulsing dot
    // matters most. Observed on XPS: PermissionRequest at 08:50:18, stale
    // correction to idle at 08:55:20, question still live hours later.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PermissionRequest' },
    });
    expect((await hookRes.json()).status).toBe('waiting');

    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 10 }, // BOTH clocks — the normal state of a real wait
    });

    const res = await ctx.get('/api/sessions');
    const s = (await res.json()).find(s => s.id === sessionId);
    expect(s.status).toBe('waiting');
  });

  test('a waiting session still self-corrects at the long abandonment backstop', async () => {
    // The one case excluding 'waiting' would otherwise pin forever: the agent
    // died mid-question without ever firing a resolving hook. A backstop far
    // beyond any plausible answer delay catches that without touching a wait the
    // user simply has not got to yet.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PermissionRequest' },
    });
    expect((await hookRes.json()).status).toBe('waiting');

    await ctx.post(`/api/test/age-session/${sessionId}`, {
      data: { ageMinutes: 13 * 60 }, // past WAITING_ABANDONED_TIMEOUT_MS (12h)
    });

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

  // ============================================================
  // #38 — Claude context-window % on each session list row.
  // The list endpoints already attach `metrics` per session; these pin that
  // contract because the web sidebar + companion list read metrics.ctx
  // straight off the payload (never recompute it client-side).
  // ============================================================

  test('#38: /api/sessions attaches metrics.ctx after a claude-status post', async () => {
    // Pin a Claude UUID onto the session via the hook, then post a status-line
    // update keyed by that UUID and assert it surfaces per-session.
    const claudeUuid = '38383838-0000-0000-0000-000000000042';
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'UserPromptSubmit', session_id: claudeUuid },
    });
    expect(hookRes.ok()).toBeTruthy();
    await new Promise(r => setTimeout(r, 200)); // let the worker persist the UUID

    // The session must now carry the pinned Claude UUID (the metrics key).
    let s = (await (await ctx.get('/api/sessions')).json()).find(x => x.id === sessionId);
    expect(s.claudeSessionId).toBe(claudeUuid);

    // Status-line push (localhost-only) keyed by that UUID.
    const statusRes = await ctx.post('/api/claude-status', {
      data: { session_id: claudeUuid, ctx: 42 },
    });
    expect(statusRes.ok()).toBeTruthy();

    s = (await (await ctx.get('/api/sessions')).json()).find(x => x.id === sessionId);
    expect(s.metrics).toBeTruthy();
    expect(s.metrics.ctx).toBe(42);
  });

  test('#38: a session with no claude-status reports metrics === null', async () => {
    // Graceful absence: no status line was ever posted for this session, so the
    // frontends render no ctx badge (guard: metrics && metrics.ctx != null).
    const s = (await (await ctx.get('/api/sessions')).json()).find(x => x.id === sessionId);
    expect(s.metrics).toBeNull();
  });
});
