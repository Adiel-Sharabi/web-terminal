// @ts-check
// Per-session push (ntfy): pure gating/message logic + the notify-level REST API.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');
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

  test('shouldPush: clear bypasses the level gate (a dismissal, not an alert)', () => {
    // G3: a 'clear' resolves/auto-dismisses a prior alert, so it must be
    // delivered regardless of the session's level — even 'off' (there may be a
    // stale notification on the device to dismiss).
    for (const lv of ['off', 'important', 'all', 'bogus', undefined]) {
      expect(np.shouldPush('clear', lv)).toBe(true);
    }
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

  test('buildNtfyMessage: clear is a low-priority resolution marker', () => {
    // G3: a 'clear' is a silent dismissal, not an alert. The ntfy transport
    // can't recall a delivered push (server treats clear as a no-op there), but
    // the shape is defined + tested so a future transport can render it.
    const m = np.buildNtfyMessage('clear', { sessionName: 'DroneLocator', serverName: 'Office' });
    expect(m.title).toBe('Office: DroneLocator');
    expect(m.priority).toBe(1); // min priority — never buzzes the phone
    expect(m.tags).toContain('white_check_mark');
  });

  test('detail (Claude\'s last message) is appended as a second block', () => {
    const last = 'Fixed the drone timeout and all 23 tests pass. Want me to commit?';
    // idle: generic line, then Claude's actual last words.
    const idle = np.buildNtfyMessage('idle', { sessionName: 'S', serverName: 'Home', detail: last });
    expect(idle.message).toBe(`Claude is done, waiting for input\n\n${last}`);
    // approval keeps its reason and appends the detail.
    const appr = np.buildNtfyMessage('approval', { sessionName: 'S', reason: 'Claude needs your approval', detail: last });
    expect(appr.message).toBe(`Claude needs your approval\n\n${last}`);
    // No detail → body is unchanged (backward compatible).
    expect(np.buildNtfyMessage('idle', { sessionName: 'S' }).message).toBe('Claude is done, waiting for input');
    // Empty-string detail is treated as "no detail".
    expect(np.buildNtfyMessage('idle', { sessionName: 'S', detail: '' }).message).toBe('Claude is done, waiting for input');
  });

  test('splitNotifyMsg extracts name + reason from the worker message', () => {
    expect(np.splitNotifyMsg('"DroneLocator" — Claude needs your approval'))
      .toEqual({ name: 'DroneLocator', reason: 'Claude needs your approval' });
    // hyphen variant + a plain string fallback
    expect(np.splitNotifyMsg('"Web Terminal" - done').name).toBe('Web Terminal');
    expect(np.splitNotifyMsg('no quotes here')).toEqual({ name: '', reason: 'no quotes here' });
  });
});

test.describe('attention record pure logic', () => {
  test('makeAttention stamps cleared:false + normalizes reason/name', () => {
    const a = np.makeAttention('approval', { reason: 'needs approval', name: 'Drone', at: 111 });
    expect(a).toEqual({ kind: 'approval', reason: 'needs approval', name: 'Drone', at: 111, cleared: false });
    // Missing reason/name normalize to '' (never undefined on the wire).
    const b = np.makeAttention('apierror', { at: 222 });
    expect(b).toEqual({ kind: 'apierror', reason: '', name: '', at: 222, cleared: false });
    // at defaults to a real timestamp when not injected.
    expect(typeof np.makeAttention('idle').at).toBe('number');
  });

  test('buildAttentionResponse: empty state → all event fields null, but ids/message present', () => {
    const r = np.buildAttentionResponse({ id: 'sess-1', serverName: 'Home', lastAttention: null, lastMessage: '' });
    expect(r).toEqual({
      id: 'sess-1', serverName: 'Home',
      kind: null, reason: null, name: null, at: null, cleared: null,
      lastMessage: '',
    });
    // Absent lastMessage coerces to '' so the companion never gets undefined.
    expect(np.buildAttentionResponse({ id: 'x', serverName: 'Y' }).lastMessage).toBe('');
  });

  test('buildAttentionResponse: a recorded (uncleared) attention surfaces its fields', () => {
    const att = np.makeAttention('approval', { reason: 'needs approval', name: 'Drone', at: 999 });
    const r = np.buildAttentionResponse({ id: 'sess-2', serverName: 'Office', lastAttention: att, lastMessage: 'hi there' });
    expect(r).toEqual({
      id: 'sess-2', serverName: 'Office',
      kind: 'approval', reason: 'needs approval', name: 'Drone', at: 999, cleared: false,
      lastMessage: 'hi there',
    });
  });

  test('buildAttentionResponse: cleared flag is reflected (and coerced to a real boolean)', () => {
    const att = { ...np.makeAttention('apierror', { at: 5 }), cleared: true };
    expect(np.buildAttentionResponse({ id: 'i', serverName: 's', lastAttention: att }).cleared).toBe(true);
  });

  test('statusClearsApproval: only an off-waiting change clears an uncleared approval (G3a)', () => {
    const approval = np.makeAttention('approval', { at: 1 });
    // Positive: the user answered → status moved off 'waiting'.
    expect(np.statusClearsApproval('working', approval)).toBe(true);
    expect(np.statusClearsApproval('idle', approval)).toBe(true);
    // Still waiting → not resolved.
    expect(np.statusClearsApproval('waiting', approval)).toBe(false);
    // No/blank status → nothing to conclude.
    expect(np.statusClearsApproval('', approval)).toBe(false);
    expect(np.statusClearsApproval(undefined, approval)).toBe(false);
    // Already cleared → don't clear again (prevents duplicate 'clear' pushes).
    expect(np.statusClearsApproval('working', { ...approval, cleared: true })).toBe(false);
    // Wrong kind / no record → not an approval resolution.
    expect(np.statusClearsApproval('working', np.makeAttention('apierror', { at: 1 }))).toBe(false);
    expect(np.statusClearsApproval('working', null)).toBe(false);
  });

  test('apiRecoveryClearsError: clears only an uncleared apierror (G3b)', () => {
    const apierr = np.makeAttention('apierror', { at: 1 });
    expect(np.apiRecoveryClearsError(apierr)).toBe(true);
    // Already cleared, wrong kind, or no record → no clear.
    expect(np.apiRecoveryClearsError({ ...apierr, cleared: true })).toBe(false);
    expect(np.apiRecoveryClearsError(np.makeAttention('approval', { at: 1 }))).toBe(false);
    expect(np.apiRecoveryClearsError(null)).toBe(false);
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

test.describe('notify-level picker UI', () => {
  test('the bell opens a picker; choosing a level marks that session', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Bell Pick' } })).json()).id;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      // Open the picker — the default level (important) is marked active.
      await row.locator('.sb-bell').click();
      const menu = page.locator('#nlMenu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('.nl-opt')).toHaveCount(3);
      await expect(menu.locator('.nl-opt.active')).toHaveAttribute('data-level', 'important');

      // Choose "All" → menu closes, level persists server-side.
      await menu.locator('.nl-opt[data-level="all"]').click();
      await expect(page.locator('#nlMenu')).toHaveCount(0);
      await expect.poll(async () =>
        (await (await ctx.get(`/api/sessions/${created}/notify-level`)).json()).level
      ).toBe('all');

      // Reopen — "All" is now the marked one.
      await row.locator('.sb-bell').click();
      await expect(page.locator('#nlMenu .nl-opt.active')).toHaveAttribute('data-level', 'all');
    } finally {
      try { await ctx.patch(`/api/sessions/${created}/notify-level`, { data: { level: 'important' } }); } catch {}
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });
});
