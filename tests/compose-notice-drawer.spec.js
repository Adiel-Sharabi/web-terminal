// @ts-check
// #222 — a notice raised while the phone drawer is open is painted UNDER it.
//
// `#composeNotice` is the ONLY channel for a refused or discarded write — #179's
// unconfirmed submit, #206's too-large refusal, #204's `buffer-full`, and #209's
// `peer-unreachable`, which arrives about 37 SECONDS after you typed. At phone width
// `#sidebar.open` is `position:fixed; z-index:50; width:100vw` while the notice is a
// body-level flex child in normal flow with no z-index, so an open drawer covers it —
// and `init()` opens the drawer on load whenever `sessionStorage.sidebarOpen !== '0'`,
// which is every fresh context. #209's timing is what makes that real: you type, see
// nothing happen, reach for the session list, and the notice lands behind it.
//
// MEASURED FIRST, because the fix depends on which defect this is: the notice is never
// auto-hidden, and closing the drawer reveals it intact and makes its dismiss button
// clickable. So it is delivered SILENTLY, not lost — a smaller claim than "invisible",
// and the fix only has to supply the missing signal.
//
// The signal is a dot on the hamburger, which the toolbar's `z-index:100` already puts
// above the drawer. Not the notice raised above the drawer: its own sentence says the
// words are back in the compose box and to check the terminal, and the drawer hides
// both, so a floating bar would point at things that are not on screen while its
// dismiss deleted the only trace. Not auto-closing the drawer either — a list
// collapsing on its own 37s after you typed reads as a bug, not as an alert.
//
// EVERY ASSERTION HERE IS ON THE SETTLED STATE. #221 was a test that passed only by
// beating this same drawer's `transition: width 0.2s`; a spec about the drawer covering
// something must never be able to pass by racing it.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

/** Wait until the drawer's `transition: width 0.2s` has FINISHED.
 *
 *  The `.open` class flips synchronously while the width takes 200ms to follow, so the
 *  class is not a proxy for the layout — the first cut of this spec toggled the drawer
 *  shut, asserted `#sidebar.open` was gone, and still measured `sidebarBody` over the
 *  dismiss button because the drawer was 300-odd pixels wide at that instant. Settled
 *  is measured off the box itself, not off a stopwatch and not off the class. */
async function settleSidebar(page) {
  await expect.poll(async () => {
    const a = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
    await page.waitForTimeout(120);
    const b = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
    return a === b;
  }, { timeout: 5000, message: 'the sidebar never stopped animating' }).toBe(true);
}

/** Open a session and let the drawer settle. */
async function openSessionSettled(page, id, name, expectOpen) {
  await page.goto(BASE + '/app/' + id);
  await expect(page.locator('#sessionName')).toContainText(name, { timeout: 10000 });
  if (expectOpen) await expect(page.locator('#sidebar.open')).toHaveCount(1);
  await settleSidebar(page);
}

const reveal = (page, id) => page.evaluate(({ id }) => {
  document.getElementById('composeInput').value = '';
  window.__wtSetLastSubmission({ id, text: 'lost words', at: Date.now() });
  window.showSubmitUnconfirmed();
}, { id });

/** What is actually on top of the dismiss button, in the settled state. */
const overDismiss = (page) => page.evaluate(() => {
  const r = document.getElementById('composeNoticeDismiss').getBoundingClientRect();
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return el ? (el.id || el.tagName) : null;
});

async function newSession(ctx, label) {
  const res = await ctx.post('/api/sessions', { data: { name: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` } });
  const body = await res.json();
  return { id: body.id, name: body.name };
}

test.describe('#222 a notice buried by the phone drawer is signalled on the hamburger', () => {
  test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the drawer covers the notice, and the hamburger says so', async ({ page }) => {
      await loginPage(page);
      const ctx = await authCtx();
      const { id, name } = await newSession(ctx, 'ND Buried');
      try {
        await openSessionSettled(page, id, name, true);
        await reveal(page, id);
        await expect(page.locator('#composeNotice')).toBeVisible();

        // The notice really is buried — settled, not mid-transition. Without this the
        // badge assertion below could pass on a page where nothing was covered.
        expect(await page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width))).toBe(390);
        expect(await overDismiss(page)).toBe('sidebarBody');

        // ...and the signal is up, on a toolbar that sits above the drawer.
        await expect(page.locator('#sidebarToggleBtn.has-notice')).toHaveCount(1);
        await expect(page.locator('#sidebarToggleBtn')).toHaveAttribute('title', /close it to read/);

        // AND IT IS WHOLLY ON SCREEN. The dot is an `::after` hung off the button's
        // corner, the button is 28px inside a 32px toolbar pinned to `top: 0`, and the
        // first cut hung it 3px proud — so it started at y=-1.5 and the VIEWPORT clipped
        // its top. Nothing in the CSS says so (`#toolbar` is `overflow: visible`) and no
        // assertion about the CLASS can see it; it took a screenshot to notice. Measured
        // off the button, since a pseudo-element has no box of its own to query.
        const dot = await page.evaluate(() => {
          const btn = document.getElementById('sidebarToggleBtn');
          const r = btn.getBoundingClientRect();
          const cs = getComputedStyle(btn, '::after');
          const off = parseFloat(cs.top);            // negative: hung above the button
          const h = parseFloat(cs.height) + 2 * parseFloat(cs.borderTopWidth);
          return { top: r.top + off, bottom: r.top + off + h };
        });
        expect(dot.top, 'the notice dot is clipped by the top of the viewport').toBeGreaterThanOrEqual(0);
        expect(dot.bottom).toBeLessThanOrEqual(844);
      } finally {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
        await ctx.dispose();
      }
    });

    test('closing the drawer reveals the notice, clears the dot, and the dismiss LANDS', async ({ page }) => {
      await loginPage(page);
      const ctx = await authCtx();
      const { id, name } = await newSession(ctx, 'ND Reveal');
      try {
        await openSessionSettled(page, id, name, true);
        await reveal(page, id);
        await expect(page.locator('#sidebarToggleBtn.has-notice')).toHaveCount(1);

        await page.evaluate(() => toggleSidebar());
        await expect(page.locator('#sidebar.open')).toHaveCount(0);
        await settleSidebar(page);
        await expect(page.locator('#sidebarToggleBtn.has-notice')).toHaveCount(0);
        await expect(page.locator('#sidebarToggleBtn')).toHaveAttribute('title', 'Sessions panel');

        // The measured finding this whole design rests on: the notice was never lost.
        // It is still shown, and now reachable — in the SETTLED state, which is exactly
        // where #221's version of this click failed.
        await expect(page.locator('#composeNotice')).toBeVisible();
        expect(await overDismiss(page)).toBe('composeNoticeDismiss');
        await page.locator('#composeNoticeDismiss').click();
        await expect(page.locator('#composeNotice')).toBeHidden();
      } finally {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
        await ctx.dispose();
      }
    });

    test('a dismissed notice leaves no dot behind when the drawer is reopened', async ({ page }) => {
      await loginPage(page);
      const ctx = await authCtx();
      const { id, name } = await newSession(ctx, 'ND Stale');
      try {
        await openSessionSettled(page, id, name, true);
        await reveal(page, id);
        await page.evaluate(() => toggleSidebar());          // close: notice revealed
        await settleSidebar(page);
        await page.locator('#composeNoticeDismiss').click(); // and answered
        await expect(page.locator('#composeNotice')).toBeHidden();

        // Reopening must NOT re-raise a signal for something already dealt with — a dot
        // that outlives its notice teaches the user to ignore the dot.
        await page.evaluate(() => toggleSidebar());
        await expect(page.locator('#sidebar.open')).toHaveCount(1);
        await settleSidebar(page);
        await expect(page.locator('#sidebarToggleBtn.has-notice')).toHaveCount(0);
      } finally {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
        await ctx.dispose();
      }
    });
  });

  test.describe('desktop width', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('no dot: the sidebar is a column here and covers nothing', async ({ page }) => {
      await loginPage(page);
      const ctx = await authCtx();
      const { id, name } = await newSession(ctx, 'ND Desktop');
      try {
        await openSessionSettled(page, id, name, true);
        await page.evaluate(({ id }) => {
          window.__wtSetLastSubmission({ id, text: 'lost words', at: Date.now() });
          window.showSubmitUnconfirmed();
        }, { id });
        await expect(page.locator('#composeNotice')).toBeVisible();

        // The premise, asserted rather than assumed: `position: fixed` is what makes the
        // drawer an overlay, and it only applies inside the `max-width: 600px` block. If
        // that ever stops being true this test is measuring nothing, and it should say
        // so rather than quietly agree that there is no dot.
        expect(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).position)).not.toBe('fixed');
        await expect(page.locator('#sidebar.open')).toHaveCount(1);
        await expect(page.locator('#sidebarToggleBtn.has-notice')).toHaveCount(0);
        await expect(page.locator('#sidebarToggleBtn')).toHaveAttribute('title', 'Sessions panel');
      } finally {
        try { await ctx.delete(`/api/sessions/${id}`); } catch {}
        await ctx.dispose();
      }
    });
  });

  test('app.html still parses — no uncaught error on load', async ({ page }) => {
    // CLAUDE.md's own rule, and it is a scar: `window.f = () => f()` in this classic
    // script is infinite recursion (a top-level `function f(){}` IS already `window.f`),
    // which killed the whole page while a full local suite still reported 1346 passed.
    // A green suite is evidence, not proof — load the page and read `pageerror`.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForFunction(() => typeof clusterServers !== 'undefined', null, { timeout: 10000 });
    expect(await page.evaluate(() => typeof updateComposeNoticeBadge)).toBe('function');
    expect(errors).toEqual([]);
  });
});
