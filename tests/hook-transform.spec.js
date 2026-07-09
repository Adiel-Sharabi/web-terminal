// @ts-check
// Tests for the server.js hook-event transform layer (processHookEvent).
//
// The transform sits between the HTTP hook endpoints and the worker. Its job
// is to filter and shape Claude's raw events so the worker only sees clean
// status transitions:
//   - Notification subtypes are demuxed by payload (permission → waiting,
//     idle → idle, other → dropped).
//   - Stop / idle Notification are debounced ~750ms so the user never sees a
//     flash of "stopped" between agentic turns.
//   - SubagentStop is dropped (parent agent is still working).
//
// All tests assume server.js was launched with
// WT_HOOK_STOP_DEBOUNCE_MS=200 so the debounce window is short enough for
// tests to finish quickly. The Playwright runner is configured to pass that
// through (see playwright.config.js).
const { test, expect, request: pwRequest } = require('@playwright/test');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };
// Tests assume the server was started with WT_HOOK_STOP_DEBOUNCE_MS=200.
// Polling slack is generous so a sluggy CI box doesn't flake.
const DEBOUNCE_MS = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 200;
const SLACK_MS = 400;

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

async function rawCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

async function createSession(ctx, name) {
  const res = await ctx.post('/api/sessions', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id;
}

async function getStatus(ctx, id) {
  const res = await ctx.get('/api/sessions');
  const list = await res.json();
  // /api/sessions returns the array directly (not { sessions: [...] })
  const arr = Array.isArray(list) ? list : (list.sessions || []);
  const s = arr.find(x => x.id === id);
  return s ? s.status : null;
}

async function sendHook(raw, id, body) {
  return raw.post(`/api/session/${id}/hook`, { data: body });
}

async function pollUntil(fn, predicate, timeoutMs) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise(r => setTimeout(r, 25));
  }
  return last;
}

test.describe('Hook transform: Notification demux', () => {
  test('permission_prompt notification → waiting (not idle)', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-Perm');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      const res = await sendHook(raw, id, {
        event: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      });
      expect(res.status()).toBe(200);

      const status = await pollUntil(() => getStatus(ctx, id), s => s === 'waiting', 2000);
      expect(status).toBe('waiting');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  test('unknown notification → dropped (status unchanged)', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-Unknown');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      const res = await sendHook(raw, id, {
        event: 'Notification',
        notification_type: 'auth_success',
        message: 'auth ok',
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.skipped).toBe('notification-other');

      // After full debounce window + slack the status MUST still be working —
      // the notification should not have flipped it to idle.
      await new Promise(r => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
      expect(await getStatus(ctx, id)).toBe('working');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  test('idle_prompt notification → eventually idle after debounce', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-Idle');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      const res = await sendHook(raw, id, {
        event: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      });
      const body = await res.json();
      expect(body.status).toBe('pending');
      expect(body.deferred).toBe('Notification');

      // Within debounce window: still working
      expect(await getStatus(ctx, id)).toBe('working');

      const final = await pollUntil(
        () => getStatus(ctx, id),
        s => s === 'idle',
        DEBOUNCE_MS + SLACK_MS,
      );
      expect(final).toBe('idle');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });
});

test.describe('Hook transform: Stop debounce', () => {
  test('Stop followed by PreToolUse within window cancels idle flip', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-Debounce');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      const stop = await sendHook(raw, id, { event: 'Stop' });
      const stopBody = await stop.json();
      expect(stopBody.status).toBe('pending');

      // Fire PreToolUse well within the debounce window
      await new Promise(r => setTimeout(r, Math.max(20, Math.floor(DEBOUNCE_MS / 4))));
      await sendHook(raw, id, { event: 'PreToolUse' });

      // After full window + slack: status should still be working — the Stop
      // was cancelled by the subsequent working event.
      await new Promise(r => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
      expect(await getStatus(ctx, id)).toBe('working');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });

  test('Stop with no follow-up flips to idle after debounce', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-StopAlone');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      await sendHook(raw, id, { event: 'Stop' });

      // Still working immediately after Stop
      expect(await getStatus(ctx, id)).toBe('working');

      const final = await pollUntil(
        () => getStatus(ctx, id),
        s => s === 'idle',
        DEBOUNCE_MS + SLACK_MS,
      );
      expect(final).toBe('idle');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });
});

test.describe('Hook transform: SubagentStop ignored', () => {
  test('SubagentStop does not change status', async () => {
    const ctx = await authCtx();
    const raw = await rawCtx();
    const id = await createSession(ctx, 'HookXform-Subagent');
    try {
      await sendHook(raw, id, { event: 'UserPromptSubmit' });
      await pollUntil(() => getStatus(ctx, id), s => s === 'working', 2000);

      const res = await sendHook(raw, id, { event: 'SubagentStop' });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.skipped).toBe('subagent-stop');

      await new Promise(r => setTimeout(r, DEBOUNCE_MS + SLACK_MS));
      expect(await getStatus(ctx, id)).toBe('working');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      await raw.dispose();
    }
  });
});
