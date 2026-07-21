// @ts-check
// Web UI: the new-session agent picker and the per-agent sidebar chip. Both are driven
// by GET /api/agents (the server's provider registry), so a CLI agent added server-side
// must appear here with no client change — that is what these tests pin.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

// Pin a Claude conversation id onto a session — that id is what keys the metrics
// map, so a status push can reach the row. Mirrors metrics-claude.spec.js.
async function pinnedSession(ctx, tag, uuid) {
  const cwd = path.join(process.env.TEMP || os.tmpdir(), `wt-agentsui-${tag}-${process.pid}`);
  fs.mkdirSync(cwd, { recursive: true });
  const r = await ctx.post('/api/sessions', { data: { name: `ui-${tag}`, cwd, agent: 'claude' } });
  const id = (await r.json()).id;
  await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
  await new Promise((res) => setTimeout(res, 200)); // let the worker persist the uuid
  return id;
}

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

  // The model badge sits next to ctx% and answers "what am I actually talking to".
  // It is filled from `metrics.model` / `metrics.effort`, which the server fills
  // identically for every provider (Claude from its status-line payload, Codex from
  // its rollout) — so this reads one field and never branches on the agent.
  test('a session that reported a model shows it next to the ctx badge', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const uuid = '5b0de100-0000-0000-0000-0000000000a1';
    const id = await pinnedSession(ctx, 'model', uuid);

    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await ctx.post('/api/claude-status', {
        data: {
          session_id: uuid,
          model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
          effort: { level: 'xhigh' },
          context_window: { context_window_size: 200000, used_percentage: 42 },
        },
      });

      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.locator('.sb-model')).toHaveText('Opus 4.8 · xhigh');
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('a session with no reported model shows no model badge', async ({ page }) => {
    // Absent => no chip at all. An empty badge would be a permanent blank gap in
    // every plain-shell row.
    await loginPage(page);
    const ctx = await authCtx();
    const shellId = (await (await ctx.post('/api/sessions', { data: { name: 'UI NoModel' } })).json()).id;

    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${shellId}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.locator('.sb-model')).toHaveCount(0);
    } finally {
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
