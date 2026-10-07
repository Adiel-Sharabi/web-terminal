// @ts-check
// #298 — the sessions dashboard in app.html. Drives the real page against the suite's
// server: a session's brief becomes a card, a session owing an answer is in the
// "Needs you" strip, a pin round-trips, Back closes the view, a card opens its session,
// and nothing a session or an agent wrote can inject markup.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, loginPage, readHookToken } = require('./test-helpers');

async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });
  const r = await c.post(`/api/session/${id}/hook`, { data: { hook_event_name: event, event, ...body } });
  expect(r.status()).toBe(200);
  await c.dispose();
}
async function report(id, body) {
  const c = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-WT-Hook-Token': readHookToken() } });
  const r = await c.post(`/api/session/${id}/report`, { data: body });
  expect(r.status()).toBe(200);
  await c.dispose();
}

test.describe('#298 sessions dashboard (app.html)', () => {
  /** @type {import('@playwright/test').APIRequestContext} */
  let api;
  const made = [];
  async function newSession(name) {
    const r = await api.post('/api/sessions', { data: { name } });
    const id = (await r.json()).id;
    made.push(id);
    return id;
  }

  test.beforeEach(async () => { api = await authCtx(); });
  test.afterEach(async () => {
    for (const id of made.splice(0)) await api.delete(`/api/sessions/${id}`).catch(() => {});
    await api.dispose();
  });

  test('cards show work items with state, now, the prompt and staleness; no page errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tag = `dash-${Date.now()}`;
    const a = await newSession(`${tag}-a`);
    await hook(a, 'UserPromptSubmit', { prompt: 'mark the dictation item ready' });
    await hook(a, 'PreToolUse', { tool_name: 'Bash', tool_input: { description: 'Run the dictation tests' } });
    await report(a, { items: [{ ref: '#291', title: 'Dictate into the compose bar', state: 'ready-for-test' }], headline: 'Dictation' });
    await hook(a, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh issue close 4242' } });

    await loginPage(page);
    await page.goto(`${BASE}/app`);
    await page.click('#dashBtn');
    const card = page.locator('.db-card', { hasText: `${tag}-a` });
    await expect(card).toBeVisible();
    await expect(card.locator('.db-items li')).toContainText('#291');
    await expect(card.locator('.db-state')).toHaveText('ready for test');
    await expect(card).toContainText('Run the dictation tests');
    await expect(card).toContainText('mark the dictation item ready');
    await expect(card.locator('.db-stale')).toContainText('#4242');
    expect(await page.evaluate(() => location.hash)).toBe('#dashboard');
    expect(errors).toEqual([]);
  });

  test('a session owing a permission is in the Needs-you strip', async ({ page }) => {
    const tag = `needs-${Date.now()}`;
    const id = await newSession(tag);
    await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    await hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).status).toBe('waiting');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await expect(page.locator('.db-needs')).toContainText(tag);
    await expect(page.locator('.db-card', { hasText: tag }).locator('.db-status')).toHaveText('Needs you');
  });

  test('pin a work item, then unpin it', async ({ page }) => {
    const tag = `pin-${Date.now()}`;
    await newSession(tag);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const card = page.locator('.db-card', { hasText: tag });
    await card.locator('[data-action=pin-open]').click();
    await page.fill('.db-pinform input.ref', '#777');
    await page.fill('.db-pinform input.title', 'Pinned item');
    await page.selectOption('.db-pinform select', 'blocked');
    await page.click('.db-pinform [data-action=pin-save]');
    await expect(card.locator('.db-items li')).toContainText('Pinned item');
    await expect(card.locator('.db-state')).toHaveText('blocked');
    await card.locator('.db-unpin').click();
    await expect(card.locator('.db-items')).toHaveCount(0);
  });

  test('pinning another item does not freeze the agent\'s state into an existing pin', async ({ page }) => {
    // #306 review: the client used to send back the card's MERGED values, so an
    // existing pin captured the agent's state and kept it after the agent moved on.
    const tag = `repin-${Date.now()}`;
    const id = await newSession(tag);
    await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    await report(id, { items: [{ ref: '#5', title: 'Five', state: 'in-progress' }] });
    expect((await api.patch(`/api/sessions/${id}/brief`, { data: { pinned: [{ ref: '#5', title: '' }] } })).status()).toBe(200);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const card = page.locator('.db-card', { hasText: tag });
    await card.locator('[data-action=pin-open]').click();
    await page.fill('.db-pinform input.ref', '#6');
    await page.click('.db-pinform [data-action=pin-save]');
    await expect(card.locator('.db-items li')).toHaveCount(2);
    await report(id, { items: [{ ref: '#5', title: 'Five', state: 'done' }] });
    await expect.poll(async () => {
      const s = (await (await api.get('/api/sessions')).json()).find((x) => x.id === id);
      return s.brief.items.find((i) => i.ref === '#5').state;
    }).toBe('done');
  });

  test('Back closes the dashboard; a card opens its session', async ({ page }) => {
    const tag = `nav-${Date.now()}`;
    const id = await newSession(tag);
    await loginPage(page);
    await page.goto(`${BASE}/app`);
    await page.click('#dashBtn');
    await expect(page.locator('#dashboard')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#dashboard')).toBeHidden();
    await page.click('#dashBtn');
    await page.locator('.db-card', { hasText: tag }).click();
    await expect(page.locator('#dashboard')).toBeHidden();
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/app/${id}`);
  });

  test('a session switch WHILE the dashboard is open keeps one history entry: Back still closes it', async ({ page }) => {
    // The race the timing of the test above can hide: init's first switchSession landing
    // after the dashboard opened. Driven deterministically here.
    const other = await newSession(`race-${Date.now()}`);
    await loginPage(page);
    await page.goto(`${BASE}/app`);
    await page.click('#dashBtn');
    await expect(page.locator('#dashboard')).toBeVisible();
    await page.evaluate((id) => switchSession(id, null), other); // eslint-disable-line no-undef
    expect(await page.evaluate(() => location.hash)).toBe('#dashboard');
    await page.goBack();
    await expect(page.locator('#dashboard')).toBeHidden();
  });

  test('nothing a session or an agent wrote becomes markup', async ({ page }) => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const id = await newSession(`x${evil}`);
    await hook(id, 'UserPromptSubmit', { prompt: evil });
    await report(id, { items: [{ ref: `#1${evil}`.slice(0, 60), title: evil, state: 'done', note: evil }], headline: evil });
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await expect(page.locator('.db-card', { hasText: 'onerror' }).first()).toBeVisible();
    expect(await page.locator('#dashboard img').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});
