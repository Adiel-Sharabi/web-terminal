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

  test('a session owing a permission leads the reason view, and is in the strip by server', async ({ page }) => {
    const tag = `needs-${Date.now()}`;
    const id = await newSession(tag);
    await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    await hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).status).toBe('waiting');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    // #313: the reason replaces the status word, and "Needs you" is the first section.
    const sec = page.locator('.db-sec-you');
    await expect(sec.locator('[data-card]', { hasText: tag }).locator('.rs-chip.you')).toHaveText(/You: approve a tool/);
    await page.click('#dbSeg [data-group=server]');
    await expect(page.locator('.db-needs')).toContainText(tag);
  });

  test('pin a work item, then unpin it', async ({ page }) => {
    const tag = `pin-${Date.now()}`;
    await newSession(tag);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    // A never-reported session is a one-line row; its Pin opens it into a full card.
    await page.locator('.db-row', { hasText: tag }).locator('[data-action=pin-open]').click();
    const card = page.locator('.db-card', { hasText: tag });
    await page.fill('.db-pinform input.ref', '#777');
    await page.fill('.db-pinform input.title', 'Pinned item');
    await page.selectOption('.db-pinform select', 'blocked');
    await page.click('.db-pinform [data-action=pin-save]');
    await expect(card.locator('.db-items li')).toContainText('Pinned item');
    await expect(card.locator('.db-state')).toHaveText('blocked');
    await card.locator('.db-unpin').click();
    await expect(page.locator('.db-row', { hasText: tag })).toBeVisible();
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
    await page.locator('#dbBody [data-action=open]', { hasText: tag }).first().click();
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

  test('favourites lead the dashboard and are not repeated below', async ({ page }) => {
    const tag = `fav-${Date.now()}`;
    const id = await newSession(tag);
    expect((await api.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true } })).status()).toBe(200);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await expect(page.locator('.db-favs [data-card]', { hasText: tag })).toHaveCount(1);
    await expect(page.locator('#dbBody [data-action=open]', { hasText: tag })).toHaveCount(1);
    await api.patch(`/api/sessions/${id}/favorite`, { data: { favorite: false } });
  });

  test('hide from the menu, undo, hide again, then unhide from the Hidden tab', async ({ page }) => {
    const tag = `hide-${Date.now()}`;
    const id = await newSession(tag);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const entry = () => page.locator('#dbBody [data-action=open]', { hasText: tag });
    await entry().locator('[data-action=menu]').click();
    await page.click('#dbBody .db-menu [data-action=hide]');
    await expect(entry()).toHaveCount(0);
    await expect(page.locator('#dbToast')).toContainText(`Hidden "${tag}"`);
    await page.click('#dbToast button');
    await expect(entry()).toHaveCount(1);
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).brief.hidden).toBe(false);
    await entry().locator('[data-action=menu]').click();
    await page.click('#dbBody .db-menu [data-action=hide]');
    await expect(entry()).toHaveCount(0);
    await page.click('#dbTabs [data-tab=hidden]');
    await page.locator('.db-row', { hasText: tag }).locator('[data-action=unhide]').click();
    await expect(page.locator('.db-row', { hasText: tag })).toHaveCount(0);
    await page.click('#dbTabs [data-tab=active]');
    await expect(entry()).toHaveCount(1);
  });

  test('the filter narrows the cards; the grouping is remembered across a reload', async ({ page }) => {
    const tag = `flt-${Date.now()}`;
    await newSession(`${tag}-alpha`);
    await newSession(`${tag}-beta`);
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await page.fill('#dbSearch', `${tag}-alp`);
    await expect(page.locator('#dbBody [data-action=open]', { hasText: `${tag}-alpha` })).toHaveCount(1);
    await expect(page.locator('#dbBody [data-action=open]', { hasText: `${tag}-beta` })).toHaveCount(0);
    await page.click('#dbSeg [data-group=server]');
    await page.selectOption('#dbSort', 'name');
    await page.reload();
    await expect(page.locator('#dbSeg [data-group=server]')).toHaveClass(/on/);
    await expect(page.locator('#dbSort')).toHaveValue('name');
  });

  test('every card carries its machine colour, declared by the server', async ({ page }) => {
    const tag = `clr-${Date.now()}`;
    await newSession(tag);
    const color = (await (await api.get('/api/version')).json()).serverColor;
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const entry = page.locator('#dbBody [data-action=open]', { hasText: tag });
    expect(await entry.getAttribute('style')).toContain(`--srv:${color}`);
    await expect(entry.locator('.sb-server-badge')).toHaveAttribute('style', new RegExp(`--srv:${color}`));
  });

  test('a reported wait shows as the reason and groups the card; done collapses', async ({ page }) => {
    const tag = `rsn-${Date.now()}`;
    const a = await newSession(`${tag}-ext`);
    const b = await newSession(`${tag}-done`);
    for (const [id, wait] of [[a, { on: 'external', what: 'vendor licence' }], [b, { on: 'done', what: 'pushed' }]]) {
      await hook(id, 'UserPromptSubmit', { prompt: 'go' });
      await report(id, { headline: 'h', wait });
      await hook(id, 'Stop', {});
    }
    await expect.poll(async () => (await (await api.get('/api/sessions')).json())
      .filter((s) => [a, b].includes(s.id)).map((s) => s.reason && s.reason.kind).sort().join(','), { timeout: 10_000 })
      .toBe('done,external');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await expect(page.locator('.db-card', { hasText: `${tag}-ext` }).locator('.rs-chip.external')).toHaveText(/Blocked: vendor licence/);
    // Done is collapsed by default: the section header shows, the session does not.
    await expect(page.locator('#dbBody [data-action=open]', { hasText: `${tag}-done` })).toHaveCount(0);
    await page.click('#dbBody [data-action=section][data-section=done]');
    await expect(page.locator('.db-row.done', { hasText: `${tag}-done` })).toBeVisible();
  });

  test('"Not waiting" clears a wrong reported wait from the card menu (#320)', async ({ page }) => {
    const tag = `nw-${Date.now()}`;
    const id = await newSession(tag);
    await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    await report(id, { headline: 'h', wait: { on: 'you', what: 'say go when free' } });
    await hook(id, 'Stop', {});
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).reason?.kind).toBe('you');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const card = page.locator('#dbBody [data-action=open]', { hasText: tag }).first();
    await expect(card.locator('.rs-chip.you')).toBeVisible();
    await card.locator('[data-action=menu]').click();
    await page.click('#dbBody .db-menu [data-action=clear-wait]');
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).reason).toBeNull();
    // ...and never on a MECHANICAL reason: a running turn is a fact, not a report.
    const busy = await newSession(`${tag}-busy`);
    await hook(busy, 'UserPromptSubmit', { prompt: 'go' });
    await hook(busy, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
    const busyCard = page.locator('#dbBody [data-action=open]', { hasText: `${tag}-busy` }).first();
    await expect(busyCard).toBeVisible();
    await busyCard.locator('[data-action=menu]').click();
    await expect(page.locator('#dbBody .db-menu')).toBeVisible();
    await expect(page.locator('#dbBody .db-menu [data-action=clear-wait]')).toHaveCount(0);
    await expect(page.locator('#dbBody [data-action=open]', { hasText: tag }).first().locator('.rs-chip.you')).toHaveCount(0);
  });

  test('a HIDDEN session in the Needs-you strip can be cleared right there (#324)', async ({ page }) => {
    const tag = `nwh-${Date.now()}`;
    const id = await newSession(tag);
    await hook(id, 'UserPromptSubmit', { prompt: 'go' });
    await report(id, { headline: 'h', wait: { on: 'you', what: 'say go when free' } });
    await hook(id, 'Stop', {});
    expect((await api.patch(`/api/sessions/${id}/brief`, { data: { hidden: true } })).status()).toBe(200);
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).reason?.kind).toBe('you');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const entry = page.locator('#dbBody .db-needs button[data-action=open]', { hasText: tag });
    await expect(entry).toBeVisible();
    await page.locator(`#dbBody .db-needs [data-action=clear-wait][aria-label="Not waiting: ${tag}"]`).click();
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === id).reason).toBeNull();
    await expect(entry).toHaveCount(0);
    // ...never for a LIVE prompt: a hidden session owing a permission is a fact, not a report.
    const live = await newSession(`${tag}-live`);
    await hook(live, 'UserPromptSubmit', { prompt: 'go' });
    await hook(live, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect((await api.patch(`/api/sessions/${live}/brief`, { data: { hidden: true } })).status()).toBe(200);
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === live).reason?.source).toBe('status');
    const liveEntry = page.locator('#dbBody .db-needs-pair', { hasText: `${tag}-live` });
    await expect(liveEntry).toBeVisible({ timeout: 15_000 });
    await expect(liveEntry.locator('[data-action=clear-wait]')).toHaveCount(0);
  });

  test('session list: the title filter narrows the rows; "not waiting" clears only a reported wait (#327)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tag = `sl-${Date.now()}`;
    const rep = await newSession(`${tag}-alpha reported`);
    const live = await newSession(`${tag}-beta live`);
    await hook(rep, 'UserPromptSubmit', { prompt: 'go' });
    await report(rep, { headline: 'h', wait: { on: 'you', what: 'say go when free' } });
    await hook(rep, 'Stop', {});
    await hook(live, 'UserPromptSubmit', { prompt: 'go' });
    await hook(live, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === rep).reason?.kind).toBe('you');
    await loginPage(page);
    await page.goto(BASE + '/');
    const repRow = page.locator(`.sb-item[data-session-id="${rep}"]`);
    const liveRow = page.locator(`.sb-item[data-session-id="${live}"]`);
    await expect(repRow).toBeVisible({ timeout: 10_000 });
    await expect(liveRow).toBeVisible();
    await expect(liveRow.locator('.sb-clearwait')).toHaveCount(0);

    await page.fill('#sbFilter', `${tag}-BETA`);
    await expect(repRow).toBeHidden();
    await expect(liveRow).toBeVisible();
    await page.fill('#sbFilter', `${tag}-nothing-like-it`);
    await expect(page.locator('#sbNoMatch')).toBeVisible();
    await page.fill('#sbFilter', '');
    await expect(repRow).toBeVisible();
    await expect(page.locator('#sbNoMatch')).toBeHidden();

    // A match inside a COLLAPSED group still shows: the query looks inside it.
    await page.locator('.sb-server[data-server-key="__local__"]').click();
    await expect(repRow).toBeHidden();
    await page.fill('#sbFilter', `${tag}-alpha`);
    await expect(repRow).toBeVisible();
    await expect(page.locator('#sbNoMatch')).toBeHidden();
    await page.fill('#sbFilter', '');
    await expect(repRow).toBeHidden();
    await page.locator('.sb-server[data-server-key="__local__"]').click();
    await expect(repRow).toBeVisible();

    await repRow.locator('.sb-clearwait').click();
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === rep).reason).toBeNull();
    await expect(page.locator(`.sb-item[data-session-id="${rep}"] .sb-clearwait`)).toHaveCount(0, { timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test('a summary chip is a filter: tap to show only those, tap again for all (#318)', async ({ page }) => {
    const tag = `chip-${Date.now()}`;
    const needy = await newSession(`${tag}-needy`);
    await newSession(`${tag}-quiet`);
    await hook(needy, 'UserPromptSubmit', { prompt: 'go' });
    await hook(needy, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await expect.poll(async () => (await (await api.get('/api/sessions')).json()).find((s) => s.id === needy).status).toBe('waiting');
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const entry = (name) => page.locator('#dbBody [data-action=open]', { hasText: name });
    await expect(entry(`${tag}-quiet`)).toHaveCount(1);
    await page.click('#dbChips [data-filter=you]');
    await expect(page.locator('#dbChips [data-filter=you]')).toHaveAttribute('aria-pressed', 'true');
    await expect(entry(`${tag}-quiet`)).toHaveCount(0);
    await expect(entry(`${tag}-needy`).first()).toBeVisible();
    await page.click('#dbChips [data-filter=you]');
    await expect(entry(`${tag}-quiet`)).toHaveCount(1);
  });

  test('a published artifact is a link on the card that opens itself, not the session (#329)', async ({ page }) => {
    const tag = `art-${Date.now()}`;
    const a = await newSession(`${tag}-a`);
    const url = 'https://claude.ai/artifact/UiTest329abcdef';
    await hook(a, 'PostToolUse', { tool_name: 'Artifact', tool_input: { file_path: 'o.html' },
      tool_response: { url, title: `Overview ${tag}`, version: '1-2', updated: false } });
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    const card = page.locator('.db-card, .db-row', { hasText: `${tag}-a` }).first();
    const link = card.locator('a.db-art');
    await expect(link).toHaveText(new RegExp(`Overview ${tag}`));
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // clicking it does not open the session: the dashboard stays up
    await page.context().route('https://claude.ai/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
    const popup = page.waitForEvent('popup');
    await link.click();
    await (await popup).close();
    expect(await page.evaluate(() => location.hash)).toBe('#dashboard');
    // and the dashboard's text filter finds a session by what it published
    await page.fill('#dbSearch', `overview ${tag}`);
    await expect(card).toBeVisible();
    // a closed session keeps its link on the closed strip
    await api.delete(`/api/sessions/${a}`);
    // the closed record is written as the session exits, a moment after the DELETE returns
    await expect.poll(async () => ((await (await api.get('/api/dashboard/closed')).json()).closed || [])
      .some((c) => c.id === a), { timeout: 10000 }).toBe(true);
    await page.reload();
    await expect(page.locator('.db-closed-item', { hasText: `${tag}-a` }).locator('a.db-art')).toHaveAttribute('href', url);
  });

  test('nothing a session or an agent wrote becomes markup', async ({ page }) => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const id = await newSession(`x${evil}`);
    await hook(id, 'UserPromptSubmit', { prompt: evil });
    await report(id, { items: [{ ref: `#1${evil}`.slice(0, 60), title: evil, state: 'done', note: evil }], headline: evil, wait: { on: 'external', what: evil } });
    await hook(id, 'PostToolUse', { tool_name: 'Artifact', tool_input: {},
      tool_response: { url: 'https://claude.ai/artifact/EvilTitle329x', title: evil, version: '1' } });
    await hook(id, 'Stop', {});
    await loginPage(page);
    await page.goto(`${BASE}/app#dashboard`);
    await expect(page.locator('.db-card', { hasText: 'onerror' }).first()).toBeVisible();
    expect(await page.locator('#dashboard img').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});
