// @ts-check
// Favorites feature: a per-browser (localStorage) star toggle on each session
// row plus a pinned "Favorites" group at the top of the sidebar that spans all
// servers and badges each favorite with the server it lives on.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

test.describe('Sidebar UI: favorites', () => {
  test('starring a session pins it to the Favorites group with a server badge, and persists', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Target' } });
    const created = (await r.json()).id;
    await ctx.dispose();

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      // No favorites yet → no favorites group.
      await expect(page.locator('.sb-fav-header')).toHaveCount(0);

      // Star it.
      await row.locator('.sb-star').click();

      // Favorites group appears with a pinned copy carrying a server badge.
      await expect(page.locator('.sb-fav-header')).toHaveCount(1);
      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();
      const badge = favItem.locator('.sb-server-badge');
      await expect(badge).toBeVisible();
      expect((await badge.textContent() || '').trim().length).toBeGreaterThan(0);

      // localStorage records the favorite by session id.
      const stored = await page.evaluate(() => localStorage.getItem('wt.favorites'));
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored)).toContain(created);

      // Persists across reload.
      await page.reload();
      await expect(page.locator(`.sb-fav-item[data-fav-id="${created}"]`)).toBeVisible({ timeout: 5000 });
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });

  test('unfavoriting from the Favorites group removes the pin', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Toggle' } });
    const created = (await r.json()).id;
    await ctx.dispose();

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      await row.locator('.sb-star').click();
      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();

      // Click the filled star inside the favorites pin to remove it.
      await favItem.locator('.sb-star').click();
      await expect(page.locator(`.sb-fav-item[data-fav-id="${created}"]`)).toHaveCount(0);

      // With no favorites left, the group header is gone too.
      await expect(page.locator('.sb-fav-header')).toHaveCount(0);
      const stored = await page.evaluate(() => localStorage.getItem('wt.favorites'));
      expect(JSON.parse(stored || '[]')).not.toContain(created);
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });

  test('clicking a favorite row switches to that session', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Switch' } });
    const created = (await r.json()).id;
    await ctx.dispose();

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await row.locator('.sb-star').click();

      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();
      // Click the row body (not the star) — should activate the session.
      await favItem.locator('.sb-name').click();
      await expect(page.locator('#sessionName')).toContainText('Fav Switch', { timeout: 8000 });
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });
});
