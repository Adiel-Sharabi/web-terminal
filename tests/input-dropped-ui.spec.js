// @ts-check
// #193 defect 3, client half — the server's 64KB WS input cap now echoes a bare
// `{"inputDropped":true,"bytes":N}` frame back on the SAME socket (server.js
// `handleMessage`, pinned server-side by `tests/ws-input-dropped.spec.js`). This spec
// pins the CLIENT half: the #composeNotice bar (already built for #179's
// submitUnconfirmed) reveals a distinct, byte-count-bearing message, and the dismiss
// button still hides it.
//
// app.html also ignores this frame on its two BACKGROUNDED-connection onmessage
// handlers (mirroring how sessionTaken/requestResize/heartbeat are already ignored
// there) so the raw JSON never lands in a backgrounded session's cached scrollback —
// left unpinned here because exercising that path faithfully needs a real in-page
// session switch (a sidebar click through app.html's own JS), not `page.goto`, which is
// a hard navigation that throws away the very `sessionCache` being tested.
//
// Driven via `page.routeWebSocket` against the real `/ws/:id` connection (the same
// technique `submit-unconfirmed-ui.spec.js` uses for `/ws/notify`), since a real notice
// is server-initiated with no other deterministic trigger.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

async function openSession(page, id, name) {
  await page.goto(BASE + '/app/' + id);
  await expect(page.locator('#sessionName')).toContainText(name, { timeout: 10000 });
}

test.describe('#193 inputDropped notice (web client)', () => {
  test('an inputDropped frame reveals the notice with the byte count', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'ID Notice' } })).json()).id;

    let resolveRoute;
    const routeReady = new Promise((resolve) => { resolveRoute = resolve; });
    await page.routeWebSocket((url) => url.pathname === `/ws/${id}`, (wsRoute) => {
      wsRoute.connectToServer();
      resolveRoute(wsRoute);
    });

    try {
      await openSession(page, id, 'ID Notice');
      const wsRoute = await routeReady;

      await expect(page.locator('#composeNotice')).toBeHidden();

      wsRoute.send(JSON.stringify({ inputDropped: true, bytes: 70123 }));

      await expect(page.locator('#composeNotice')).toBeVisible();
      await expect(page.locator('#composeNoticeText')).toContainText('70123');
      await expect(page.locator('#composeNoticeText')).toContainText('too large');

      await page.locator('#composeNoticeDismiss').click();
      await expect(page.locator('#composeNotice')).toBeHidden();

      expect(pageErrors, `console errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });
});
