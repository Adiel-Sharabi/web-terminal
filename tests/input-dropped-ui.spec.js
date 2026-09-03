// @ts-check
// #193 defect 3, client half — the server's 64KB WS input cap now echoes a bare
// `{"inputDropped":true,"bytes":N}` frame back on the SAME socket (server.js
// `handleMessage`, pinned server-side by `tests/ws-input-dropped.spec.js`). This spec
// pins the CLIENT half: the #composeNotice bar (already built for #179's
// submitUnconfirmed) reveals a distinct, byte-count-bearing message, and the dismiss
// button still hides it.
//
// app.html's two BACKGROUNDED-connection onmessage handlers used to IGNORE this frame
// outright (mirroring sessionTaken/requestResize/heartbeat) so the raw JSON never landed
// in a backgrounded session's cached scrollback. #209 showed that ignoring and
// discarding are not the same thing: its notice arrives ~37s after the input was typed,
// by which time you have very likely switched away, so the one refusal that most needs
// to be seen was the one thrown away. They now STASH it on the session's cache entry and
// it is drained on return — pinned by the last test in this file, which does the switch
// through app.html's own `switchSession` rather than `page.goto` (a hard navigation
// would throw away the very `sessionCache` being tested).
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

  // #204 — the SAME frame, from the cluster proxy's reconnect buffer, means something
  // else entirely: the link to the peer is down and there was no room left to hold what
  // you typed. That lands on a SINGLE KEYSTROKE, so the wording above would read "That
  // input was too large to send (5 bytes)" — the class of confidently wrong message this
  // repo treats as worse than no message at all.
  //
  // The server side is pinned by tests/cluster-proxy-drop.spec.js (the notice is sent,
  // once per outage, carrying `reason`). This is the half that was missing: that
  // app.html RENDERS the right one of the two. A typo in the `reason === 'buffer-full'`
  // comparison regresses silently to the wrong wording with everything else still green.
  test('a buffer-full drop says what actually happened, not "too large"', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'ID Buffer' } })).json()).id;

    let resolveRoute;
    const routeReady = new Promise((resolve) => { resolveRoute = resolve; });
    await page.routeWebSocket((url) => url.pathname === `/ws/${id}`, (wsRoute) => {
      wsRoute.connectToServer();
      resolveRoute(wsRoute);
    });

    try {
      await openSession(page, id, 'ID Buffer');
      const wsRoute = await routeReady;

      await expect(page.locator('#composeNotice')).toBeHidden();

      // Five bytes — a size for which "too large" would be absurd on its face.
      wsRoute.send(JSON.stringify({ inputDropped: true, bytes: 5, reason: 'buffer-full' }));

      await expect(page.locator('#composeNotice')).toBeVisible();
      const text = page.locator('#composeNoticeText');
      await expect(text).toContainText('5 bytes');
      await expect(text).toContainText('connection to that server is down');
      // The load-bearing assertion: NOT the other wording. It is safe as a negative
      // here because it is read off an element already asserted VISIBLE with the right
      // byte count — the notice demonstrably rendered, so this is about which sentence
      // it rendered, never about whether the frame arrived yet.
      await expect(text).not.toContainText('too large');

      expect(pageErrors, `console errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  // #209 — the THIRD meaning on this channel, and the one that arrives LATE. The proxy
  // gives up after ~37s of backoff and discards everything it was holding; nothing was
  // ever refused, so this is the user's only signal that a prompt is gone.
  //
  // A frame with no `writes` — what a server predating #209 sends — must still read
  // correctly, which is why the count is spliced in rather than being part of the
  // sentence.
  test('a peer-unreachable drop says the server never came back, with or without a count',
      async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'ID Peer' } })).json()).id;

    let resolveRoute;
    const routeReady = new Promise((resolve) => { resolveRoute = resolve; });
    await page.routeWebSocket((url) => url.pathname === `/ws/${id}`, (wsRoute) => {
      wsRoute.connectToServer();
      resolveRoute(wsRoute);
    });

    try {
      await openSession(page, id, 'ID Peer');
      const wsRoute = await routeReady;
      const text = page.locator('#composeNoticeText');

      wsRoute.send(JSON.stringify({
        inputDropped: true, bytes: 340, writes: 12, reason: 'peer-unreachable',
      }));
      await expect(page.locator('#composeNotice')).toBeVisible();
      await expect(text).toContainText('12 writes, 340 bytes');
      await expect(text).toContainText('never came back');
      // Neither of the other two sentences: nothing was too large and there was room
      // the whole time. Safe as negatives — the notice is already asserted VISIBLE with
      // the right figures, so this is about WHICH sentence rendered, never about
      // whether the frame had arrived.
      await expect(text).not.toContainText('too large');
      await expect(text).not.toContainText('no room left');

      await page.locator('#composeNoticeDismiss').click();
      await expect(page.locator('#composeNotice')).toBeHidden();

      // An older server sends bytes alone. The sentence must not degrade to
      // "undefined writes".
      wsRoute.send(JSON.stringify({ inputDropped: true, bytes: 41, reason: 'peer-unreachable' }));
      await expect(page.locator('#composeNotice')).toBeVisible();
      await expect(text).toContainText('41 bytes');
      await expect(text).toContainText('never came back');
      await expect(text).not.toContainText('undefined');
      await expect(text).not.toContainText('NaN');

      expect(pageErrors, `console errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  // #209, found in review — A BACKGROUND SOCKET IS STILL A SOCKET THE SERVER REPORTS ON.
  //
  // Both background `onmessage` handlers listed `inputDropped` in their IGNORE set (the
  // gap this file's own header recorded as unpinned), which was survivable while every
  // refusal fired AS YOU TYPED: you are still looking at that session when it lands. The
  // give-up notice is not like that. It arrives ~37 seconds after the input was typed —
  // ample time to have given up on a laggy session and switched away — so on the one
  // notice that most needs to be seen, the browser dropped it on the floor.
  //
  // THE SWITCH MUST GO THROUGH app.html's OWN switchSession. `page.goto` is a hard
  // navigation and throws away the very `sessionCache` this is about, which is exactly
  // why the header above said this path was hard to pin. Calling the function is enough:
  // it is a top-level declaration in a classic script, so it is already global.
  test('a notice raised on a BACKGROUNDED session is kept and shown on return',
      async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await loginPage(page);
    const ctx = await authCtx();
    const a = (await (await ctx.post('/api/sessions', { data: { name: 'ID Bg A' } })).json()).id;
    const b = (await (await ctx.post('/api/sessions', { data: { name: 'ID Bg B' } })).json()).id;

    let resolveRoute;
    const routeReady = new Promise((resolve) => { resolveRoute = resolve; });
    await page.routeWebSocket((url) => url.pathname === `/ws/${a}`, (wsRoute) => {
      wsRoute.connectToServer();
      resolveRoute(wsRoute);
    });

    try {
      await openSession(page, a, 'ID Bg A');
      const wsRoute = await routeReady;
      // Set explicitly rather than trusting the config the suite happens to run with:
      // demoting a socket instead of closing it is the precondition of this whole path.
      await page.evaluate(() => { keepSessionsOpen = true; });

      await page.evaluate((id) => switchSession(id, null), b);
      await expect(page.locator('#sessionName')).toContainText('ID Bg B');

      wsRoute.send(JSON.stringify({
        inputDropped: true, bytes: 340, writes: 12, reason: 'peer-unreachable',
      }));

      // THE ANCHOR THAT MAKES THE NEGATIVE BELOW MEAN SOMETHING. Waiting a beat and
      // asserting "the notice is hidden" would pass just as well if the frame had not
      // been read yet — this repo's recorded vacuous-negative shape. Polling the stash
      // proves the frame ARRIVED and was kept, so the hidden notice is a decision
      // rather than a race.
      await expect
        .poll(() => page.evaluate((id) => !!(sessionCache.get(id) || {}).inputDropped, a),
          { timeout: 10000, message: 'the backgrounded session never stashed the notice' })
        .toBe(true);
      await expect(page.locator('#composeNotice'),
        'a notice belongs to the session it was raised on, not the one on screen')
        .toBeHidden();

      await page.evaluate((id) => switchSession(id, null), a);
      await expect(page.locator('#sessionName')).toContainText('ID Bg A');
      await expect(page.locator('#composeNotice')).toBeVisible();
      await expect(page.locator('#composeNoticeText')).toContainText('12 writes, 340 bytes');
      await expect(page.locator('#composeNoticeText')).toContainText('never came back');

      // One-shot: a fact about one outage, not a state to re-announce on every visit.
      expect(await page.evaluate((id) => (sessionCache.get(id) || {}).inputDropped, a))
        .toBeFalsy();

      expect(pageErrors, `console errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
    } finally {
      try { await ctx.delete(`/api/sessions/${a}`); } catch {}
      try { await ctx.delete(`/api/sessions/${b}`); } catch {}
      await ctx.dispose();
    }
  });
});
