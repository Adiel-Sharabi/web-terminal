// @ts-check
// #179 — "that prompt never reached the agent": when the worker sees a submit CR go
// out with no sign the agent ever acted on it, it pushes a one-shot `submitUnconfirmed`
// frame over /ws/notify. app.html answers with a #composeNotice bar plus, when the box
// is still empty, the words the user typed back where they can retype/resend them.
//
// This spec pins the CLIENT half only: the DOM the notice renders into, the
// non-destructive restore rule (the whole point of the feature — a late notice about a
// PREVIOUS prompt must never eat text the user is already retyping), and the id-based
// routing guard in the /ws/notify onmessage handler. The worker-side detection itself
// (the real 8s "nothing happened" window) is out of scope here and belongs to a
// worker-level spec — a UI spec must not sit through that timeout to prove this.
//
// Driven with the `window.showSubmitUnconfirmed()` / `window.__wtSetLastSubmission()`
// test hooks app.html exposes for exactly this purpose (real notices are one-shot and
// server-initiated, so there is no other deterministic way to reach this UI).
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

/** Navigate straight to a session and wait for the header to confirm we're attached
 *  to IT — `sessionId` is set synchronously inside switchSession() before #sessionName
 *  is painted, so this is a safe proxy for "the module-local sessionId now equals id".
 *
 *  #221 — AND THE DRAWER MUST BE CLOSED FIRST, or a click here is a coin toss. At this
 *  file's phone width `#sidebar.open` is `width: 100vw` with `transition: width .2s`,
 *  and `init()` opens it on load whenever `sessionStorage.sidebarOpen !== '0'` — which
 *  is ALWAYS, because every Playwright context starts with an empty sessionStorage.
 *  Navigating straight to `/app/:id` never closes it again (`closeSidebarIfUnpinned`
 *  runs on the session-TAP path, not on URL resolution), so the settled state is a
 *  full-screen drawer over the notice this spec clicks.
 *
 *  Measured: the sidebar is 225px wide at the anchor and 390px from ~100ms on, and
 *  `elementFromPoint` over #composeNoticeDismiss returns the button during the
 *  transition and `#sidebarBody` after it. So the dismiss test PASSED ONLY BY WINNING
 *  A 200ms ANIMATION RACE — green on an idle box, and a 30s
 *  `#sidebarBody … intercepts pointer events` timeout right after a full suite.
 *
 *  Fixed the way `mobile-new-session-dialog.spec.js` already does it: seed the flag
 *  BEFORE the page loads so `init()` never opens the drawer at all. Forcing it shut
 *  afterwards would race that same toggle. The closed drawer is also the state a user
 *  looking at a session is actually in.
 *
 *  It is asserted, not assumed — a silently-ignored seed would put the coin toss back
 *  with nothing to notice it.
 *
 *  THE GUARD IS A SELECTOR, NOT A REGEX, and that is a scar. It was first written as
 *  `.not.toHaveClass(/\bopen\b/)` and committed carrying two RAW U+0008 BACKSPACE
 *  bytes where the escape belonged, so the compiled regex was /<BS>open<BS>/ — which
 *  matches no class attribute that can exist. The negated assertion therefore passed
 *  unconditionally, against a fully-open drawer, while these very lines claimed it
 *  could not. It survived a diff (which rendered it `/open/`), an editor (which
 *  rendered it correctly), a green suite, green CI and two readers.
 *
 *  `#sidebar.open` + `toHaveCount(0)` says the same thing with nothing to normalise:
 *  ASCII-only, still a retrying web-first assertion, and it cannot be silently
 *  corrupted. `tests/control-bytes.spec.js` is the gate that stops the next one. */
async function openSession(page, id, name) {
  await page.addInitScript(() => {
    try { sessionStorage.setItem('sidebarOpen', '0'); } catch { /* private mode */ }
  });
  await page.goto(BASE + '/app/' + id);
  await expect(page.locator('#sessionName')).toContainText(name, { timeout: 10000 });
  await expect(page.locator('#sidebar.open'),
    'the phone-width drawer is 100vw and covers everything this spec clicks (#221)')
    .toHaveCount(0);
}

test.describe('#179 submit-unconfirmed notice (web client)', () => {
  // A PHONE-WIDTH VIEWPORT, and it is load-bearing rather than cosmetic. `composeMode`
  // is `isMobile && ...`, and `isMobile` ORs in `innerWidth < 600` (#55: visibility is
  // not the same question as platform). The restore is gated on the compose bar being
  // ON SCREEN — putting text into a hidden textarea while announcing "your text is
  // back" points the user at something they cannot see — so at a desktop width every
  // assertion below about restoring would pass vacuously, including the
  // non-destructive one, which is the whole point of the feature.
  test.use({ viewport: { width: 390, height: 844 } });

  test('the notice is hidden on load', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU Hidden' } })).json()).id;
    try {
      await openSession(page, id, 'SU Hidden');
      // A notice that defaulted to visible would sit on top of every fresh session,
      // not just one that actually had a submit go unconfirmed.
      //
      // ATTACHED first, then hidden. Found in review: `toBeHidden()` is also satisfied
      // by an element that does not exist, so this assertion alone was green against the
      // pre-fix app.html that had no #composeNotice at all.
      await expect(page.locator('#composeNotice')).toBeAttached();
      await expect(page.locator('#composeNotice')).toBeHidden();
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('with lastSubmission set and an EMPTY compose box, showSubmitUnconfirmed() reveals the notice and restores the text', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU Restore' } })).json()).id;
    try {
      await openSession(page, id, 'SU Restore');
      await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = '';
        window.__wtSetLastSubmission({ id, text: 'lost prompt text', at: Date.now() });
        window.showSubmitUnconfirmed();
      }, { id });

      await expect(page.locator('#composeNotice')).toBeVisible();
      // The entire point of #179: the words are not gone — they're back in the box
      // they came from, ready to retype/resend.
      await expect(page.locator('#composeInput')).toHaveValue('lost prompt text');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('THE NON-DESTRUCTIVE RULE: a NON-empty compose box is never overwritten by the restore', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU NonDestructive' } })).json()).id;
    try {
      await openSession(page, id, 'SU NonDestructive');
      await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = 'text the user is mid-typing';
        window.__wtSetLastSubmission({ id, text: 'a completely different lost prompt', at: Date.now() });
        window.showSubmitUnconfirmed();
      }, { id });

      await expect(page.locator('#composeNotice')).toBeVisible();
      // THE regression guard named in the issue: an unconditional
      // `composeInput.value = lastSubmission.text` would clobber whatever the user was
      // in the middle of retyping. This must go red the moment the restore stops being
      // conditioned on an empty box.
      await expect(page.locator('#composeInput')).toHaveValue('text the user is mid-typing');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('the notice wording distinguishes the restored case from the not-restored case', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU Wording' } })).json()).id;
    try {
      await openSession(page, id, 'SU Wording');

      const restoredText = await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = '';
        window.__wtSetLastSubmission({ id, text: 'x', at: Date.now() });
        window.showSubmitUnconfirmed();
        return document.getElementById('composeNoticeText').textContent;
      }, { id });

      await page.evaluate(() => window.hideSubmitUnconfirmed());

      const notRestoredText = await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = 'still typing, do not touch';
        window.__wtSetLastSubmission({ id, text: 'x', at: Date.now() });
        window.showSubmitUnconfirmed();
        return document.getElementById('composeNoticeText').textContent;
      }, { id });

      // Assert on a distinguishing SUBSTRING, not the whole sentence — the wording is
      // free to change, but the restored case must keep telling the user their text
      // came back, and the not-restored case must never falsely claim that.
      expect(restoredText).toContain('back');
      expect(notRestoredText).not.toContain('back');
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('the dismiss button hides the notice', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU Dismiss' } })).json()).id;
    try {
      await openSession(page, id, 'SU Dismiss');
      await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = '';
        window.__wtSetLastSubmission({ id, text: 'x', at: Date.now() });
        window.showSubmitUnconfirmed();
      }, { id });
      await expect(page.locator('#composeNotice')).toBeVisible();

      await page.locator('#composeNoticeDismiss').click();
      await expect(page.locator('#composeNotice')).toBeHidden();
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });

  test('/ws/notify routing guard: a submitUnconfirmed frame for a DIFFERENT session id never reveals the notice', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'SU Routing' } })).json()).id;
    const OTHER_ID = '00000000-1111-4222-8333-444444444444'; // not a real session on screen

    // Driven via the REAL onmessage handler in app.html, not the fallback. app.html's
    // `nws` is a function-local variable with no window handle, so the only way to
    // reach the actual routing guard — `msg.id === sessionId && lastSubmission.id ===
    // msg.id` — rather than merely showSubmitUnconfirmed() in isolation is to intercept
    // the page's real /ws/notify connection and push a synthetic frame into it, exactly
    // as if the server had broadcast it. page.routeWebSocket (Playwright >=1.48) does
    // this while still passing real traffic through via connectToServer(), so the
    // socket's ping heartbeat and any genuine notify frames keep working too.
    let resolveRoute;
    const routeReady = new Promise((resolve) => { resolveRoute = resolve; });
    await page.routeWebSocket((url) => url.pathname === '/ws/notify', (wsRoute) => {
      wsRoute.connectToServer();
      resolveRoute(wsRoute);
    });

    try {
      await openSession(page, id, 'SU Routing');
      const notifyRoute = await routeReady;

      await page.evaluate(({ id }) => {
        document.getElementById('composeInput').value = '';
        window.hideSubmitUnconfirmed();
        window.__wtSetLastSubmission({ id, text: 'should not surface', at: Date.now() });
      }, { id });

      // A frame naming a session that is not the one on screen — the guard must never
      // call showSubmitUnconfirmed() for it, regardless of what lastSubmission holds.
      notifyRoute.send(JSON.stringify({ type: 'submitUnconfirmed', id: OTHER_ID }));
      await page.waitForTimeout(500);
      await expect(page.locator('#composeNotice')).toBeHidden();

      // Sanity check the wiring itself: the SAME id does reveal it. Without this, the
      // assertion above would pass just as well against a route that silently dropped
      // every injected frame, proving nothing about the guard.
      notifyRoute.send(JSON.stringify({ type: 'submitUnconfirmed', id }));
      await expect(page.locator('#composeNotice')).toBeVisible({ timeout: 5000 });
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch {}
      await ctx.dispose();
    }
  });
});
