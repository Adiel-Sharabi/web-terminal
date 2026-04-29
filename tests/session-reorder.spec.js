// @ts-check
// Drag-reorder feature: tests the new POST /api/sessions/order endpoint
// (worker reorder + persistence) and the localStorage-backed sidebar
// collapse UI.
const { test, expect } = require('@playwright/test');
const { BASE, AUTH, authCtx, loginPage } = require('./test-helpers');

test.describe('POST /api/sessions/order', () => {
  test('reorders sessions and persists in listSessions order', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      // Create three sessions with deterministic names.
      for (const name of ['Reorder A', 'Reorder B', 'Reorder C']) {
        const r = await ctx.post('/api/sessions', { data: { name } });
        expect(r.status()).toBe(200);
        const d = await r.json();
        created.push(d.id);
      }

      const [idA, idB, idC] = created;

      // Reverse the order: C, B, A.
      const reorderRes = await ctx.post('/api/sessions/order', {
        data: { orderedIds: [idC, idB, idA] },
      });
      expect(reorderRes.status()).toBe(200);
      const reorderBody = await reorderRes.json();
      expect(reorderBody.ok).toBe(true);

      // Listing should reflect the new order — the three created sessions
      // should appear in the C, B, A sequence relative to each other.
      const listRes = await ctx.get('/api/sessions');
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      const reorderedPositions = [idC, idB, idA].map(id => list.findIndex(s => s.id === id));
      expect(reorderedPositions[0]).toBeLessThan(reorderedPositions[1]);
      expect(reorderedPositions[1]).toBeLessThan(reorderedPositions[2]);
    } finally {
      for (const id of created) {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      }
      await ctx.dispose();
    }
  });

  test('rejects non-array orderedIds with 400', async () => {
    const ctx = await authCtx();
    try {
      const r = await ctx.post('/api/sessions/order', { data: { orderedIds: 'nope' } });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.error).toMatch(/array/i);
    } finally {
      await ctx.dispose();
    }
  });

  test('rejects orderedIds with non-string entries', async () => {
    const ctx = await authCtx();
    try {
      const r = await ctx.post('/api/sessions/order', { data: { orderedIds: [123, 'foo'] } });
      expect(r.status()).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test('rejects oversized orderedIds list', async () => {
    const ctx = await authCtx();
    try {
      const big = Array.from({ length: 1001 }, (_, i) => 'a'.repeat(40) + i);
      const r = await ctx.post('/api/sessions/order', { data: { orderedIds: big } });
      expect(r.status()).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test('unknown ids are silently dropped, live sessions not in list are kept', async () => {
    const ctx = await authCtx();
    const created = [];
    try {
      for (const name of ['Drop X', 'Drop Y']) {
        const r = await ctx.post('/api/sessions', { data: { name } });
        const d = await r.json();
        created.push(d.id);
      }
      const [idX, idY] = created;
      // Send a list containing only one real id and a bogus one. The other
      // real session should still exist in the listing afterwards (appended).
      const reorderRes = await ctx.post('/api/sessions/order', {
        data: { orderedIds: ['00000000-0000-0000-0000-000000000000', idY] },
      });
      expect(reorderRes.status()).toBe(200);
      const list = await (await ctx.get('/api/sessions')).json();
      const ids = list.map(s => s.id);
      expect(ids).toContain(idX);
      expect(ids).toContain(idY);
    } finally {
      for (const id of created) {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      }
      await ctx.dispose();
    }
  });

  test('unauthenticated request is rejected', async () => {
    const { request: pwRequest } = require('@playwright/test');
    const noAuth = await pwRequest.newContext({ baseURL: BASE });
    try {
      const r = await noAuth.post('/api/sessions/order', { data: { orderedIds: [] } });
      expect([302, 401, 403]).toContain(r.status());
    } finally {
      await noAuth.dispose();
    }
  });
});

test.describe('Sidebar UI: collapsible server group', () => {
  test('clicking a server header hides its session items and persists state', async ({ page }) => {
    await loginPage(page);
    // Make sure at least one session exists so the group has visible items.
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Collapse Test' } });
    const created = (await r.json()).id;
    await ctx.dispose();
    try {
      await page.goto(BASE + '/');
      await page.waitForSelector('.sb-server', { timeout: 5000 });
      await page.waitForSelector('.sb-item', { timeout: 5000 });

      const header = page.locator('.sb-server').first();
      const serverKey = await header.getAttribute('data-server-key');
      const itemSelector = `.sb-item[data-server-key="${serverKey}"]`;
      const beforeCount = await page.locator(itemSelector + ':visible').count();
      expect(beforeCount).toBeGreaterThan(0);

      // Click chevron region of the header (anywhere not on .srv-auth).
      await header.locator('.srv-chev').click();
      await expect(header).toHaveClass(/collapsed/);
      await expect(page.locator(itemSelector + ':visible')).toHaveCount(0);

      // localStorage should reflect the collapsed state.
      const stored = await page.evaluate(() => localStorage.getItem('wt.sidebar.collapsed'));
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored);
      expect(parsed).toContain(serverKey);

      // Reload — collapsed state must persist.
      await page.reload();
      await page.waitForSelector('.sb-server', { timeout: 5000 });
      await expect(page.locator('.sb-server').first()).toHaveClass(/collapsed/);
      await expect(page.locator(itemSelector + ':visible')).toHaveCount(0);

      // Click again to expand.
      await page.locator('.sb-server').first().locator('.srv-chev').click();
      await expect(page.locator('.sb-server').first()).not.toHaveClass(/collapsed/);
      await expect(page.locator(itemSelector).first()).toBeVisible();
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });

  test('clicking the "+" action button does not toggle collapse', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.waitForSelector('.sb-server', { timeout: 5000 });
    const header = page.locator('.sb-server').first();
    // Dismiss any prompts the + button may open.
    page.on('dialog', d => d.dismiss().catch(() => {}));
    const wasCollapsed = await header.evaluate(el => el.classList.contains('collapsed'));
    const plus = header.locator('.srv-auth', { hasText: '+' });
    if (await plus.count() > 0) {
      await plus.first().click();
      const isCollapsed = await header.evaluate(el => el.classList.contains('collapsed'));
      expect(isCollapsed).toBe(wasCollapsed);
    }
  });

  test('session rows have draggable=true for reorder', async ({ page }) => {
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Drag Marker' } });
    const created = (await r.json()).id;
    await ctx.dispose();
    try {
      await loginPage(page);
      await page.goto(BASE + '/');
      const item = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(item).toHaveAttribute('draggable', 'true');
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });
});
