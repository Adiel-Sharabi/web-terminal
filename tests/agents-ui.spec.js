// @ts-check
// Web UI: the new-session agent picker and the per-agent sidebar chip. Both are driven
// by GET /api/agents (the server's provider registry), so a CLI agent added server-side
// must appear here with no client change — that is what these tests pin.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

test.describe('Sidebar UI: AI agents', () => {
  test('the new-session picker is populated from the server catalogue', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    const sel = page.locator('#newAgent');
    await expect(sel).toHaveCount(1);
    // Auto + one option per provider; values are the wire ids the server accepts.
    await expect(sel.locator('option')).toHaveCount(3);
    await expect(sel.locator('option[value=""]')).toHaveText(/auto/i);
    await expect(sel.locator('option[value="claude"]')).toHaveText('Claude Code');
    await expect(sel.locator('option[value="codex"]')).toHaveText('Codex');
  });

  test('a codex session is chipped; a plain shell session is not', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const codexId = (await (await ctx.post('/api/sessions', { data: { name: 'UI Codex', agent: 'codex' } })).json()).id;
    const shellId = (await (await ctx.post('/api/sessions', { data: { name: 'UI Shell' } })).json()).id;

    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const codexRow = page.locator(`.sb-item[data-session-id="${codexId}"]`);
      await expect(codexRow).toBeVisible({ timeout: 5000 });
      const chip = codexRow.locator('.sb-agent');
      await expect(chip).toHaveCount(1);
      await expect(chip).toHaveText('Codex');

      // A plain shell runs no agent — it must not be tinted as one.
      const shellRow = page.locator(`.sb-item[data-session-id="${shellId}"]`);
      await expect(shellRow).toBeVisible();
      await expect(shellRow.locator('.sb-agent')).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/sessions/${codexId}`);
      await ctx.delete(`/api/sessions/${shellId}`);
      await ctx.dispose();
    }
  });

  test('creating a session with the picker persists the chosen agent', async ({ page }) => {
    await loginPage(page);
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(BASE + '/');
    await page.locator('#newSessionForm').evaluate((el) => el.classList.add('show'));
    await page.fill('#newName', 'Picked Codex');
    await page.selectOption('#newAgent', 'codex');
    await page.click('#newSessionForm button[type="submit"]');

    const row = page.locator('.sb-item', { hasText: 'Picked Codex' });
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.locator('.sb-agent')).toHaveText('Codex');

    // Confirm the server persisted it, not just the DOM.
    const ctx = await authCtx();
    const list = await (await ctx.get('/api/sessions')).json();
    const arr = Array.isArray(list) ? list : (list.sessions || []);
    const created = arr.find((s) => s.name === 'Picked Codex');
    expect(created.agent).toBe('codex');
    await ctx.delete(`/api/sessions/${created.id}`);
    await ctx.dispose();
  });
});
