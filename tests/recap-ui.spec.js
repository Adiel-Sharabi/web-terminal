// @ts-check
// The sidebar recap card: "I have many sessions and I lost track where I am."
//
// The card's CONTENT rules are server-side and covered by recap.spec.js /
// recap-api.spec.js. What can only be checked in a browser is the wiring, and the
// one behaviour that would make the feature actively annoying: clicking the icon
// must NOT switch session. The whole point is to look into a session without
// leaving the one you are in — a recap that navigates away has destroyed the
// context it was supposed to help you keep.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

test.describe('Sidebar recap card', () => {
  test('every session row offers a recap button', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Recap Row' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.locator('.sb-recap')).toHaveCount(1);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('clicking it opens the card WITHOUT switching session', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const a = (await (await ctx.post('/api/sessions', { data: { name: 'Recap Stay' } })).json()).id;
    const b = (await (await ctx.post('/api/sessions', { data: { name: 'Recap Other' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      // Land in session A, then peek at B.
      await page.locator(`.sb-item[data-session-id="${a}"] .sb-name`).click();
      await expect(page.locator('#sessionName')).toHaveText('Recap Stay', { timeout: 5000 });

      await page.locator(`.sb-item[data-session-id="${b}"] .sb-recap`).click();
      const card = page.locator('#rcCard');
      await expect(card).toBeVisible({ timeout: 5000 });
      // Names the session it describes, so a card can never be misread as the
      // current one's.
      await expect(card.locator('h4')).toContainText('Recap Other');

      // THE assertion: we peeked at B and are still in A.
      await expect(page.locator('#sessionName')).toHaveText('Recap Stay');
    } finally {
      await ctx.delete(`/api/sessions/${a}`);
      await ctx.delete(`/api/sessions/${b}`);
      await ctx.dispose();
    }
  });

  test('a shell session with no transcript still gets a card, not an error', async ({ page }) => {
    // The degrade path, end to end: name/cwd/status are enough to orient you, and
    // this is exactly the session where a 404 would look like a broken button.
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Recap Plain' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      await page.locator(`.sb-item[data-session-id="${id}"] .sb-recap`).click();
      const card = page.locator('#rcCard');
      await expect(card).toBeVisible({ timeout: 5000 });
      await expect(card.locator('h4')).toContainText('Recap Plain');
      await expect(card).not.toContainText('Could not read this session');
      await expect(card.locator('.rc-sub')).toBeVisible();
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('the card dismisses on an outside click', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Recap Dismiss' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      await page.locator(`.sb-item[data-session-id="${id}"] .sb-recap`).click();
      await expect(page.locator('#rcCard')).toBeVisible({ timeout: 5000 });
      // Click well away from the terminal's top-left. (5,5) lands exactly on the
      // BLINKING CURSOR of a fresh shell, and xterm swaps that element on every
      // blink — when the swap falls between mousedown and mouseup the browser
      // never synthesises a `click` at all, so the dismiss handler cannot run and
      // the card survives for a reason that has nothing to do with dismissal.
      // Measured: at (5,5) a document-level capture listener saw NO click and the
      // card stayed 3/3; away from the cursor it saw the click and the card closed.
      //
      // The point is derived from the element's own box rather than hard-coded.
      // A fixed (240,220) worked on a dev box and FAILED on the hosted Windows
      // runner, whose viewport is smaller — with `force: true` the click is not
      // clamped to the element, so it simply landed somewhere else and no dismiss
      // ever ran. The centre is always inside the terminal and always far from
      // the top-left cursor, whatever the viewport.
      const termBox = await page.locator('#terminal').boundingBox();
      await page.mouse.click(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
      await expect(page.locator('#rcCard')).toHaveCount(0);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });
});
