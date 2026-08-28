// @ts-check
// The smoke test this suite did not have, and paid for.
//
// A one-line change to `app.html` — `window.f = () => f()`, exposing a function for a
// test — silently killed the whole app. `app.html` is ONE CLASSIC SCRIPT, so a top-level
// `function f(){}` IS `window.f`; the wrapper overwrote the global it then called, the
// first invocation blew the stack, and script evaluation stopped where it stood. The
// sidebar never rendered, the header read "(no session)", and every click timed out.
//
// It cost **73 failing specs in CI** to say that, in 36 minutes, through a wall of
// "element(s) not found" and "Test timeout of 30000ms exceeded" — none of which names
// the cause. This file names it in seconds: if the page throws while loading, that
// error IS the failure message.
//
// So it asserts almost nothing about behaviour on purpose. It asserts that the app is
// ALIVE, which every other UI spec silently assumes.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('app.html loads', () => {
  test('no uncaught page error, and the shell actually renders', async ({ page }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await loginPage(page);
    await page.goto(BASE + '/');

    // The sidebar is rendered by JS after a fetch, so its container appearing is the
    // cheapest proof that script evaluation got past every top-level statement.
    await expect(page.locator('#sidebar')).toBeAttached({ timeout: 10000 });
    await page.waitForTimeout(1500);   // let the first poll land and render

    expect(pageErrors, `app.html threw while loading:\n${pageErrors.join('\n')}`).toEqual([]);

    // Every element the UI specs reach for must exist. A stack overflow part-way through
    // the script leaves the static HTML present but the app dead, so the DOM check alone
    // is not enough — these are the ones JS wires up or fills in.
    const alive = await page.evaluate(() => ({
      composeNotice: !!document.getElementById('composeNotice'),
      noticeHidden: document.getElementById('composeNotice')?.hidden,
      // Exposed by top-level declarations; missing means evaluation stopped early.
      hide: typeof window.hideSubmitUnconfirmed,
      show: typeof window.showSubmitUnconfirmed,
      setLastSubmission: typeof window.__wtSetLastSubmission,
    }));
    expect(alive.composeNotice).toBe(true);
    expect(alive.noticeHidden).toBe(true);
    expect(alive.hide).toBe('function');
    expect(alive.show).toBe('function');
    expect(alive.setLastSubmission).toBe('function');
  });

  test('opening a session does not throw either', async ({ page }) => {
    // switchSession is where the recursion actually detonated, and it only runs once a
    // session is opened — so loading `/` alone would not have caught it.
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    const { authCtx } = require('./test-helpers');
    const ctx = await authCtx();
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'app-loads' } })).json()).id;
      await loginPage(page);
      await page.goto(`${BASE}/app/${id}`);
      await expect(page.locator('#sessionName')).toContainText('app-loads', { timeout: 15000 });
      expect(pageErrors, `switchSession threw:\n${pageErrors.join('\n')}`).toEqual([]);
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });
});
