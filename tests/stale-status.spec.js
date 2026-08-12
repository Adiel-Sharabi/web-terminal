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

    // Re-age on each poll rather than once. A freshly spawned shell emits its
    // prompt a beat after creation, and that PTY chunk legitimately refreshes
    // lastActivity — which correctStaleStatus reads as "not silent" and declines
    // to correct, exactly as #37 intends. Ageing once therefore races the prompt.
    // Re-stale, then read: the precondition under test is "both clocks stale".
    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, { data: { ageMinutes: 10 } });
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(s => s.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
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

    // Re-age per poll — the shell's own prompt output races a single ageing and
    // legitimately keeps the session non-silent (see the note on the test above).
    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, {
        data: { ageMinutes: 10 }, // both clocks
      });
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(s => s.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
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

    // Re-age on every poll rather than once. A freshly spawned shell emits its
    // prompt a beat after creation, and that PTY chunk legitimately refreshes
    // lastActivity — which correctStaleStatus reads as "not silent" and declines
    // to correct, exactly as #37 intends. Ageing once therefore races the prompt:
    // it passed alone and failed under full-suite load. Re-stale, then read.
    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, {
        data: { ageMinutes: 13 * 60 }, // past WAITING_ABANDONED_TIMEOUT_MS (12h)
      });
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(s => s.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
  });

  // ============================================================
  // #79 — the other half of "blocked on the user", which does not wear the
  // 'waiting' status. Companion 1.26.0 made the pending question visible in the
  // chat lens; these pin the colour, which was the deeper bug.
  // ============================================================

  const ASK_HOOK = {
    event: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        header: 'Approach',
        question: 'Which approach should I take?',
        options: [{ label: 'Rewrite' }, { label: 'Patch' }],
      }],
    },
  };

  test('#79: a session blocked on a pending question is NEVER stale-flipped to idle', async () => {
    // An AskUserQuestion leaves the session silent — no further hook, no PTY
    // output — until the user answers, so the 5-minute rule used to fire and the
    // dot went calm GREEN on precisely the session that owed an answer. 'waiting'
    // was never the real predicate; "blocked on the user" is.
    //
    // This assertion read 'working' until #112. It was pinning the DEFECT: the
    // question arrives as a PreToolUse, so the worker marked the blocked session
    // busy, and `waitingFor` — which requires status 'waiting' — could never
    // return 'question' in this path at all. The status now carries the fact, so
    // the exemption below is reached the ordinary way rather than by a second
    // predicate OR-ed in beside it.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    expect((await hookRes.json()).status).toBe('waiting');

    // Re-age immediately before each read rather than once. A freshly spawned
    // shell emits its prompt a beat after creation and that PTY chunk refreshes
    // lastActivity, which correctStaleStatus reads as "not silent" — so a single
    // ageing can leave the session 'working' for the wrong reason and pass without
    // the fix. Several tight re-age-then-read rounds make both clocks genuinely
    // stale at the moment of the read.
    for (let i = 0; i < 5; i++) {
      await ctx.post(`/api/test/age-session/${sessionId}`, { data: { ageMinutes: 10 } });
      const s = (await (await ctx.get('/api/sessions')).json()).find(x => x.id === sessionId);
      // What this pins is unchanged and is the point of the test: the 5-minute
      // rule must not touch it. Only the status it holds while blocked moved,
      // 'working' -> 'waiting' (#112).
      expect(s.status).toBe('waiting');
    }
  });

  test('#79: answering the question restores the ordinary 5-minute rule', async () => {
    // The flag must not pin the session non-idle for the rest of its life. Once
    // the question resolves, silence means what it normally means again.
    await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    const answered = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PostToolUse', tool_name: 'AskUserQuestion' },
    });
    expect((await answered.json()).status).toBe('working');

    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, { data: { ageMinutes: 10 } });
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(s => s.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
  });

  test('#98: an idle Notification while a question is on screen does NOT idle the dot', async () => {
    // Reported on Office-Tests 2026-08-04: "there was a question but it looks idle".
    // Claude raises an idle Notification after ~60s of waiting for input — which is
    // exactly what a pending AskUserQuestion produces — and the worker folds
    // Notification into the same case as Stop, so it called armIdle and painted the
    // calm green dot on the session that owed an answer. #79 pinned the STALE rule's
    // exemption; this pins the explicit path, which never reaches that rule at all.
    const ask = await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    expect((await ask.json()).status).toBe('waiting'); // 'working' before #112

    const notified = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Notification', message: 'Claude is waiting for your input' },
    });
    expect((await notified.json()).status).not.toBe('idle');

    // And it must still be non-idle a beat later — armIdle is debounced, so an
    // assertion on the immediate reply alone would pass even if the idle were merely
    // scheduled rather than suppressed.
    await new Promise(r => setTimeout(r, 1500));
    const s = (await (await ctx.get('/api/sessions')).json()).find(x => x.id === sessionId);
    expect(s.status).not.toBe('idle');
  });

  test('#112: a pending question reads as WAITING, and names itself as a question', async () => {
    // Reported 2026-08-12 with a screenshot: the sidebar row showed an orange dot
    // and "Working 43%" on a session that had a question on screen.
    //
    // Third polarity of one bug. #79 fixed the calm GREEN, #98 fixed the explicit
    // idle — both are about a session wrongly looking DONE. This is the session
    // wrongly looking BUSY, and no earlier fix touched it: the question arrives as
    // a PreToolUse and PreToolUse means 'working'.
    //
    // The second assertion is the one that shows how deep it went. `waitingFor`
    // returns 'question' only when the status is 'waiting', so with the old
    // 'working' its QUESTION branch was UNREACHABLE in this path — the chat lens's
    // #79 banner could never name a question, and the pure rule's unit tests
    // passed the whole time because they supply the status directly.
    const ask = await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    expect((await ask.json()).status).toBe('waiting');

    const listed = (await (await ctx.get('/api/sessions')).json())
      .find(x => x.id === sessionId);
    expect(listed.status).toBe('waiting');
    expect(listed.waitingFor).toBe('question');

    // Answering releases it — the status must not stick on 'waiting' for the rest
    // of the session's life, which would trade one wrong dot for another.
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PostToolUse', tool_name: 'AskUserQuestion' },
    });
    const after = (await (await ctx.get('/api/sessions')).json())
      .find(x => x.id === sessionId);
    expect(after.status).not.toBe('waiting');
    expect(after.waitingFor).toBeFalsy();
  });

  test('#112: an ordinary tool call still reads as working', async () => {
    // The guard against over-correcting: only a PENDING QUESTION may turn a
    // PreToolUse into 'waiting'. A normal tool call is genuinely busy, and marking
    // it 'waiting' would put a red "needs you" dot on every working session.
    const res = await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PreToolUse', tool_name: 'Bash' },
    });
    expect((await res.json()).status).toBe('working');
  });

  test('#98: once the question is answered, an idle Notification idles normally', async () => {
    // The guard must not pin the session non-idle for the rest of its life — the
    // flag is cleared by the events that genuinely resolve a question.
    await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'PostToolUse', tool_name: 'AskUserQuestion' },
    });

    await ctx.post(`/api/session/${sessionId}/hook`, {
      data: { event: 'Notification', message: 'Claude is waiting for your input' },
    });
    await expect.poll(async () => {
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(x => x.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
  });

  test('#79: a pending question still self-corrects at the long abandonment backstop', async () => {
    // Self-bounding, exactly as 'waiting' is: an agent that died mid-question and
    // never fired a resolving hook must not pin the session forever — but only at
    // a horizon no real answer delay reaches.
    const hookRes = await ctx.post(`/api/session/${sessionId}/hook`, { data: ASK_HOOK });
    expect((await hookRes.json()).status).toBe('waiting'); // 'working' before #112

    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, {
        data: { ageMinutes: 13 * 60 }, // past WAITING_ABANDONED_TIMEOUT_MS (12h)
      });
      const res = await ctx.get('/api/sessions');
      return (await res.json()).find(s => s.id === sessionId).status;
    }, { timeout: 10000 }).toBe('idle');
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

    // Now test via cluster endpoint (which also calls correctStaleStatus for local
    // sessions). Re-age per poll — same prompt race as the tests above.
    await expect.poll(async () => {
      await ctx.post(`/api/test/age-session/${sessionId}`, { data: { ageMinutes: 10 } });
      const res = await ctx.get('/api/cluster/sessions');
      const data = await res.json();
      const s = data.sessions.find(s => s.id === sessionId);
      return s ? s.status : null;
    }, { timeout: 10000 }).toBe('idle');
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
