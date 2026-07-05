// @ts-check
// Integration tests for the FCM device registry (G1) + the FCM transport (G2)
// against the spawned test server. The test env runs with WT_PUSH_PROVIDER='both'
// and WT_FCM_TEST='1', so FCM sends are captured in an in-memory sink instead of
// hitting the network (drained via GET /api/push/test-sink).
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, noAuthCtx, readHookToken } = require('./test-helpers');

function hookCtx() {
  return pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });
}
// A long, unique token so first-12 truncation is unambiguous and per-test.
function mkToken(tag) {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}-${'z'.repeat(160)}`;
}
async function drainSink(ctx) {
  const r = await ctx.get('/api/push/test-sink');
  if (r.status() !== 200) return [];
  return (await r.json()).items || [];
}

test.describe('push device registry (G1)', () => {
  test('all three routes require authentication', async () => {
    const ctx = await noAuthCtx();
    expect((await ctx.get('/api/push/devices')).status()).toBe(401);
    expect((await ctx.post('/api/push/devices', { data: { fcmToken: 'x' } })).status()).toBe(401);
    expect((await ctx.delete('/api/push/devices/x')).status()).toBe(401);
    await ctx.dispose();
  });

  test('rejects empty / oversized fcmToken with 400', async () => {
    const ctx = await authCtx();
    expect((await ctx.post('/api/push/devices', { data: {} })).status()).toBe(400);
    expect((await ctx.post('/api/push/devices', { data: { fcmToken: '   ' } })).status()).toBe(400);
    expect((await ctx.post('/api/push/devices', { data: { fcmToken: 'a'.repeat(4097) } })).status()).toBe(400);
    await ctx.dispose();
  });

  test('upsert: same token twice → one entry with updated deviceName; GET truncates; delete + 404', async () => {
    const ctx = await authCtx();
    const token = mkToken('integ');
    const trunc = token.slice(0, 12) + '…';
    try {
      let r = await ctx.post('/api/push/devices', { data: { fcmToken: token, deviceName: 'Pixel', platform: 'android' } });
      expect(r.status()).toBe(200);
      // Second registration of the SAME token updates the name, not a new row.
      r = await ctx.post('/api/push/devices', { data: { fcmToken: token, deviceName: 'Pixel 8', platform: 'android' } });
      expect(r.status()).toBe(200);

      const list = await (await ctx.get('/api/push/devices')).json();
      const mine = list.filter(d => d.token === trunc);
      expect(mine.length).toBe(1);
      expect(mine[0].deviceName).toBe('Pixel 8');
      expect(mine[0].platform).toBe('android');
      // The full token is NEVER echoed back — only the truncated display form.
      expect(list.some(d => d.token === token)).toBe(false);
      expect(mine[0].token).toBe(trunc);

      // Delete → 200; deleting again → 404 (absent).
      expect((await ctx.delete('/api/push/devices/' + encodeURIComponent(token))).status()).toBe(200);
      expect((await ctx.delete('/api/push/devices/' + encodeURIComponent(token))).status()).toBe(404);
    } finally {
      try { await ctx.delete('/api/push/devices/' + encodeURIComponent(token)); } catch {}
      await ctx.dispose();
    }
  });

  test('platform defaults to android; unknown platform coerced', async () => {
    const ctx = await authCtx();
    const token = mkToken('plat');
    const trunc = token.slice(0, 12) + '…';
    try {
      await ctx.post('/api/push/devices', { data: { fcmToken: token, platform: 'windows' } });
      const list = await (await ctx.get('/api/push/devices')).json();
      const mine = list.find(d => d.token === trunc);
      expect(mine).toBeTruthy();
      expect(mine.platform).toBe('android');
    } finally {
      try { await ctx.delete('/api/push/devices/' + encodeURIComponent(token)); } catch {}
      await ctx.dispose();
    }
  });
});

test.describe('FCM transport (G2) via the test sink', () => {
  test('/api/version advertises push-devices + fcm (sink active)', async () => {
    const ctx = await authCtx();
    const caps = (await (await ctx.get('/api/version')).json()).capabilities;
    expect(caps).toContain('push-devices');
    expect(caps).toContain('fcm'); // WT_FCM_TEST makes fcmConfigured() true
    await ctx.dispose();
  });

  test('a forced approval push fans out ONE content-free FCM message per device', async () => {
    const ctx = await authCtx();
    const token = mkToken('fcm-approval');
    try {
      await ctx.post('/api/push/devices', { data: { fcmToken: token, deviceName: 'S25' } });
      await drainSink(ctx); // clear anything stale first

      const r = await ctx.post('/api/notify-test', { data: { name: 'Probe' } });
      expect(r.status()).toBe(200);

      const items = await drainSink(ctx);
      const mine = items.filter(i => i.token === token && i.data.sessionId === 'notify-test');
      expect(mine.length).toBe(1);
      const m = mine[0];
      // Content-free data payload — exactly these five keys, all strings.
      expect(Object.keys(m.data).sort()).toEqual(['deepLink', 'kind', 'serverName', 'sessionId', 'ts']);
      for (const v of Object.values(m.data)) expect(typeof v).toBe('string');
      expect(m.data.kind).toBe('approval');
      expect(m.data.sessionId).toBe('notify-test');
      expect(m.data.serverName).toBeTruthy();
      expect(m.data.ts).toMatch(/^\d+$/);
      // No leaked content: the session name / reason must NOT be in the payload.
      expect(JSON.stringify(m.data)).not.toContain('Probe');
      expect(JSON.stringify(m.data)).not.toContain('approval ✅');
      // Correct android block for an approval.
      expect(m.android.priority).toBe('high');
      expect(m.android.collapse_key).toBe('session-notify-test');
      expect(m.android.ttl).toBe('300s');
    } finally {
      try { await ctx.delete('/api/push/devices/' + encodeURIComponent(token)); } catch {}
      await ctx.dispose();
    }
  });

  test('the G3 clear flow emits a kind:clear FCM message with the session collapse_key', async () => {
    const ctx = await authCtx();
    const raw = await hookCtx();
    const token = mkToken('fcm-clear');
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'FCM Clear' } })).json()).id;
    try {
      await ctx.post('/api/push/devices', { data: { fcmToken: token, deviceName: 'S25' } });
      await drainSink(ctx);

      // Permission prose → synthesized PermissionRequest → status 'waiting' → approval.
      await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'Notification', message: 'Claude needs your permission to run a command' },
      });
      await expect.poll(async () =>
        (await (await ctx.get(`/api/sessions/${created}/attention`)).json()).kind
      ).toBe('approval');

      // Answering → UserPromptSubmit → status 'working' → G3 clear fires.
      await raw.post('/api/hook', {
        headers: { 'X-WT-Session-ID': created },
        data: { hook_event_name: 'UserPromptSubmit', prompt: 'yes go ahead' },
      });
      await expect.poll(async () =>
        (await (await ctx.get(`/api/sessions/${created}/attention`)).json()).cleared
      ).toBe(true);

      // The sink should contain a 'clear' for our token, collapse-keyed to the session.
      let clearMsg = null;
      await expect.poll(async () => {
        const items = await drainSink(ctx);
        const hit = items.find(i => i.token === token && i.data.kind === 'clear' && i.data.sessionId === created);
        if (hit) clearMsg = hit;
        return !!hit;
      }, { timeout: 8000 }).toBe(true);
      expect(clearMsg.android.collapse_key).toBe(`session-${created}`);
      expect(clearMsg.android.ttl).toBe('60s');
      expect(clearMsg.android.priority).toBe('high');
    } finally {
      try { await ctx.delete('/api/push/devices/' + encodeURIComponent(token)); } catch {}
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
      await raw.dispose();
    }
  });
});
