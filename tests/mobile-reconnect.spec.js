// @ts-check
// Mobile app-switch resilience: when the page returns to the foreground, the
// terminal reconnects immediately instead of waiting out the exponential
// backoff timer that was frozen while the browser/PWA was backgrounded.
// (Top-level `ws` / `reconnectAttempts` are classic-script globals, so
// page.evaluate can reach them by name.)
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

// Simulate a mobile app-switch: the page goes hidden, then visible again.
// (document.visibilityState is read-only, so we shadow it with an own getter.)
async function simulateAppSwitch(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function connectToSession(page, id) {
  await page.goto(BASE + '/');
  const row = page.locator(`.sb-item[data-session-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.locator('.sb-name').click();
  await expect(page.locator('#status')).toHaveText('connected', { timeout: 8000 });
}

test.describe('Terminal reconnect on returning to foreground', () => {
  test('visibilitychange reconnects immediately, bypassing a long backoff', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Reconnect Fast' } })).json()).id;
    await ctx.dispose();

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await connectToSession(page, created);
      const status = page.locator('#status');

      // Simulate a stuck/frozen long backoff: bump attempts so the next onclose
      // schedules a ~30s reconnect, then drop the socket (as a mobile OS would).
      await page.evaluate(() => { reconnectAttempts = 12; ws.close(); });
      await expect(status).toContainText('reconnecting in', { timeout: 5000 });

      // Returning to the foreground must reconnect right away — not in ~30s.
      await simulateAppSwitch(page);
      await expect(status).toHaveText('connected', { timeout: 6000 });
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });

  test('returning to an already-open socket keeps it, no disruptive reconnect', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Reconnect Stable' } })).json()).id;
    await ctx.dispose();

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await connectToSession(page, created);
      const status = page.locator('#status');

      const openBefore = await page.evaluate(() => ws && ws.readyState); // 1 = OPEN
      expect(openBefore).toBe(1);

      // Returning to a live socket should just keep it warm, not tear it down.
      await simulateAppSwitch(page);
      await page.waitForTimeout(500);

      expect(await page.evaluate(() => ws && ws.readyState)).toBe(1); // still OPEN
      await expect(status).toHaveText('connected');
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });
});
