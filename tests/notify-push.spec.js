// @ts-check
// Per-session push (ntfy): pure gating/message logic + the notify-level REST API.
const { test, expect } = require('@playwright/test');
const { authCtx } = require('./test-helpers');
const np = require('../lib/notify-push');

test.describe('notify-push pure logic', () => {
  test('shouldPush gating matrix', () => {
    // off: nothing
    for (const k of ['approval', 'apierror', 'idle']) expect(np.shouldPush(k, 'off')).toBe(false);
    // important (default): approval + apierror, NOT idle
    expect(np.shouldPush('approval', 'important')).toBe(true);
    expect(np.shouldPush('apierror', 'important')).toBe(true);
    expect(np.shouldPush('idle', 'important')).toBe(false);
    // all: everything
    for (const k of ['approval', 'apierror', 'idle']) expect(np.shouldPush(k, 'all')).toBe(true);
    // unknown level falls back to default (important)
    expect(np.shouldPush('idle', 'bogus')).toBe(false);
    expect(np.shouldPush('approval', undefined)).toBe(true);
  });

  test('buildNtfyMessage leads with server + session and carries reason/priority', () => {
    const m = np.buildNtfyMessage('approval', {
      sessionName: 'DroneLocator', serverName: 'Office',
      reason: 'Claude needs your approval', click: 'https://x/app/abc',
    });
    expect(m.title).toBe('Office: DroneLocator'); // which server + which session
    expect(m.message).toBe('Claude needs your approval');
    expect(m.priority).toBe(5);
    expect(m.tags).toContain('warning');
    expect(m.click).toBe('https://x/app/abc');

    expect(np.buildNtfyMessage('apierror', { sessionName: 'S', serverName: 'Home' }).priority).toBe(4);
    expect(np.buildNtfyMessage('idle', { sessionName: 'S', serverName: 'Home' }).priority).toBe(3);
    // no server name → just the session name
    expect(np.buildNtfyMessage('approval', { sessionName: 'Solo' }).title).toBe('Solo');
  });

  test('splitNotifyMsg extracts name + reason from the worker message', () => {
    expect(np.splitNotifyMsg('"DroneLocator" — Claude needs your approval'))
      .toEqual({ name: 'DroneLocator', reason: 'Claude needs your approval' });
    // hyphen variant + a plain string fallback
    expect(np.splitNotifyMsg('"Web Terminal" - done').name).toBe('Web Terminal');
    expect(np.splitNotifyMsg('no quotes here')).toEqual({ name: '', reason: 'no quotes here' });
  });
});

test.describe('notify-level REST API', () => {
  test('GET defaults to important; PATCH persists; invalid rejected; surfaces in /api/sessions', async () => {
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Notify Level' } })).json()).id;
    try {
      // Default level is "important".
      let r = await ctx.get(`/api/sessions/${created}/notify-level`);
      expect(r.status()).toBe(200);
      expect((await r.json()).level).toBe('important');

      // Set to "all".
      r = await ctx.patch(`/api/sessions/${created}/notify-level`, { data: { level: 'all' } });
      expect(r.status()).toBe(200);
      expect((await r.json()).level).toBe('all');
      expect((await (await ctx.get(`/api/sessions/${created}/notify-level`)).json()).level).toBe('all');

      // It surfaces on the session list so the sidebar can render the bell.
      const list = await (await ctx.get('/api/sessions')).json();
      expect(list.find(s => s.id === created).notifyLevel).toBe('all');

      // Invalid level is rejected.
      r = await ctx.patch(`/api/sessions/${created}/notify-level`, { data: { level: 'loud' } });
      expect(r.status()).toBe(400);

      // Back to off, then default.
      expect((await (await ctx.patch(`/api/sessions/${created}/notify-level`, { data: { level: 'off' } })).json()).level).toBe('off');
    } finally {
      try { await ctx.patch(`/api/sessions/${created}/notify-level`, { data: { level: 'important' } }); } catch {}
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  test('POST /api/notify-test responds and reports ntfy unconfigured in test env', async () => {
    const ctx = await authCtx();
    try {
      const r = await ctx.post('/api/notify-test', { data: { name: 'Probe' } });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.configured).toBe(false); // no ntfy config in the test server
    } finally {
      await ctx.dispose();
    }
  });
});
