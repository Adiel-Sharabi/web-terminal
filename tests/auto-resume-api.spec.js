// @ts-check
// Issue #137 — the 5h wait period on the wire and its per-session cancel.
//
// The UI half of auto-resume lives HERE rather than in the worker on purpose: the
// derivation (lib/usage-limit.js) and the opt-out are server-side, which is what
// lets the badge and the cancel ship on a hot reload while the worker keeps
// owning the timer. Same shape as notifyLevel/favorite before it.

const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

async function autoResumeOf(ctx, id) {
  return (await ctx.get(`/api/sessions/${id}/auto-resume`)).json();
}
async function sessionRow(ctx, id) {
  const list = await (await ctx.get('/api/sessions')).json();
  return (list.sessions || list).find((s) => s.id === id);
}

test.describe('#137 — auto-resume opt-out API', () => {
  test('a session is opted IN by default, and the list says so', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR default' } })).json()).id;
    try {
      // #137 flipped the default. Absence of a stored preference must read as ON,
      // which is why the prefs file stores opt-OUTs only.
      expect((await autoResumeOf(ctx, id)).enabled).toBe(true);

      const row = await sessionRow(ctx, id);
      expect(row.usageLimit).toBeTruthy();
      expect(row.usageLimit.enabled).toBe(true);
      // A brand-new shell has no metrics, so it is not capped and renders nothing.
      expect(row.usageLimit.waiting).toBe(false);
      expect(row.usageLimit.armed).toBe(false);
      expect(row.usageLimit.resumeAt).toBeNull();
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('turning it off persists, rides the session list, and turning it back on restores', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR toggle' } })).json()).id;
    try {
      const off = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: false } });
      expect(off.status()).toBe(200);
      expect((await off.json()).enabled).toBe(false);

      expect((await autoResumeOf(ctx, id)).enabled).toBe(false);
      expect((await sessionRow(ctx, id)).usageLimit.enabled).toBe(false);

      const on = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: true } });
      expect((await on.json()).enabled).toBe(true);
      expect((await sessionRow(ctx, id)).usageLimit.enabled).toBe(true);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('rejects a non-boolean and a non-UUID id rather than storing junk', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR validate' } })).json()).id;
    try {
      const bad = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: 'yes' } });
      expect(bad.status()).toBe(400);
      // A bogus id must never become a persisted key in the prefs file — same guard
      // as /favorite, and for the same reason.
      const bogus = await ctx.patch('/api/sessions/not-a-uuid/auto-resume', { data: { enabled: false } });
      expect(bogus.status()).toBe(404);
      expect((await autoResumeOf(ctx, id)).enabled).toBe(true); // unchanged
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('the routes are behind auth', async ({ request }) => {
    // Unauthenticated: every other session route refuses, and so must these — the
    // PATCH writes server-side state and the GET discloses a session id.
    const g = await request.get(`${BASE}/api/sessions/00000000-0000-4000-8000-000000000000/auto-resume`);
    expect([401, 403]).toContain(g.status());
    const p = await request.patch(`${BASE}/api/sessions/00000000-0000-4000-8000-000000000000/auto-resume`, {
      data: { enabled: false },
    });
    expect([401, 403]).toContain(p.status());
  });
});

test.describe('#137 — the wait-period badge in the sidebar', () => {
  test('an uncapped session shows no wait badge and no capped row state', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR nobadge' } })).json()).id;
    try {
      await page.reload();
      await page.waitForSelector(`.sb-item[data-session-id="${id}"]`, { timeout: 15000 });
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row.locator('.sb-wait')).toHaveCount(0);
      await expect(row).not.toHaveClass(/capped/);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('waitBadge renders the resume CLOCK TIME and flips label when switched off', async ({ page }) => {
    await loginPage(page);
    // Drive the pure renderer with a shaped row: the badge must read the server's
    // derived `usageLimit` and never recompute the threshold itself. Asserting on the
    // rendered text is what catches a badge that promises a resume nothing will do.
    const out = await page.evaluate(() => {
      const at = new Date();
      at.setHours(14, 32, 0, 0);
      const on = window.waitBadge({ usageLimit: { waiting: true, armed: true, enabled: true, resumeAt: at.getTime(), resetAt: at.getTime() } });
      const off = window.waitBadge({ usageLimit: { waiting: true, armed: false, enabled: false, resumeAt: at.getTime(), resetAt: at.getTime() } });
      const unarmed = window.waitBadge({ usageLimit: { waiting: true, armed: false, enabled: true, resumeAt: null, resetAt: null } });
      const none = window.waitBadge({ usageLimit: { waiting: false, armed: false, enabled: true, resumeAt: null, resetAt: null } });
      const missing = window.waitBadge({});
      const expected = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { on, off, unarmed, none, missing, expected };
    });
    expect(out.on).toContain('resumes');
    expect(out.on).toContain(out.expected);       // the time it will actually fire
    expect(out.off).toContain('on hold');
    expect(out.off).not.toContain('resumes');     // nothing is scheduled — don't say it is
    // Capped but with no reset time yet (the cap prompt seen before any resets_at):
    // still shown as held, but it must NOT promise a resume no timer can schedule.
    expect(out.unarmed).toContain('on hold');
    expect(out.unarmed).not.toContain('resumes');
    expect(out.none).toBe('');                    // not capped => no chip at all
    expect(out.missing).toBe('');                 // a server too old to send the field
  });
});
