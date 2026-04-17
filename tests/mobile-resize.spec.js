// @ts-check
// Regression test for issue #7:
// On mobile, when switching to a session that was kept open in the background
// (keepSessionsOpen=true), the terminal renders at a narrow width because
// doResize() runs while the sidebar is still open and the legacy mobile
// delayed re-fit (present in the fresh-connect path) was missing from the
// cached-switch code path.
const { test, expect, request: pwRequest, devices } = require('@playwright/test');
const { BASE, AUTH } = require('./test-helpers');

// Pixel 5 emulation — 393x851, mobile user agent (so isMobile is true)
const pixel5 = devices['Pixel 5'];

async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

async function setKeepSessionsOpen(ctx, value) {
  const cfgRes = await ctx.get(`${BASE}/api/config`);
  const cfg = await cfgRes.json();
  cfg.keepSessionsOpen = value;
  const res = await ctx.put(`${BASE}/api/config`, { data: cfg });
  return res.json();
}

async function loginPage(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

test.describe('Mobile terminal resize on cached session switch (#7)', () => {
  let apiCtx;
  let sessionA;
  let sessionB;

  test.beforeAll(async () => {
    apiCtx = await authCtx();
    await setKeepSessionsOpen(apiCtx, true);

    // Create two fresh sessions for switching. Leave existing sessions alone
    // so other specs that assume a default session exists keep working.
    const resA = await apiCtx.post('/api/sessions', { data: { name: 'mobile-resize-A' } });
    expect(resA.status()).toBe(200);
    sessionA = (await resA.json()).id;
    const resB = await apiCtx.post('/api/sessions', { data: { name: 'mobile-resize-B' } });
    expect(resB.status()).toBe(200);
    sessionB = (await resB.json()).id;
  });

  test.afterAll(async () => {
    if (apiCtx) {
      try { await apiCtx.delete('/api/sessions/' + sessionA); } catch (e) {}
      try { await apiCtx.delete('/api/sessions/' + sessionB); } catch (e) {}
      try { await setKeepSessionsOpen(apiCtx, false); } catch (e) {}
      await apiCtx.dispose();
    }
  });

  test('mobile: cached session switch triggers a delayed re-fit that reaches the server', async ({ browser }) => {
    // Pixel 5 viewport + mobile user agent → isMobile === true in app.html
    const context = await browser.newContext({ ...pixel5 });
    const page = await context.newPage();

    await loginPage(page);

    // Navigate directly to session A; init() will also open the sidebar.
    await page.goto(`${BASE}/app/${sessionA}`);

    await page.waitForSelector('.xterm-screen', { state: 'visible', timeout: 15000 });
    await page.waitForFunction(
      () => typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN,
      { timeout: 10000 }
    );

    // Sanity: app sees us as mobile.
    expect(await page.evaluate(() => isMobile)).toBe(true);

    // Wait for lazy background connection for session B to land in the cache.
    await page.waitForFunction(
      (id) => typeof sessionCache !== 'undefined'
        && sessionCache.has(id)
        && sessionCache.get(id).connected === true
        && sessionCache.get(id).ws
        && sessionCache.get(id).ws.readyState === WebSocket.OPEN,
      sessionB,
      { timeout: 15000 }
    );

    // Make sure sidebar is open (it is by default via init). We need it open
    // before the switch so the terminal is rendered narrow at switch time.
    await page.evaluate(() => {
      const sb = document.getElementById('sidebar');
      if (!sb.classList.contains('open')) toggleSidebar();
    });
    await page.waitForTimeout(300); // let the open transition finish

    // Hook WebSocket.send on every ws to capture all resize messages sent to
    // the server.
    await page.evaluate(() => {
      window.__resizeMsgs = [];
      const OrigSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.startsWith('{"resize"')) {
          try {
            const j = JSON.parse(data);
            if (j.resize) window.__resizeMsgs.push({ ts: Date.now(), cols: j.resize.cols, rows: j.resize.rows });
          } catch (e) {}
        }
        return OrigSend.call(this, data);
      };
    });

    // Record cols while sidebar is open (narrow) — used as the "before" baseline.
    const colsWithSidebarOpen = await page.evaluate(() => term.cols);
    expect(colsWithSidebarOpen).toBeGreaterThan(0);

    // Clear any resize messages captured before the switch.
    await page.evaluate(() => { window.__resizeMsgs = []; });

    // Record the switch time, then switch to session B (cached path) and
    // close the sidebar (same sequence the UI click handler uses).
    const switchAt = await page.evaluate((id) => {
      const t0 = Date.now();
      switchSession(id, null);
      closeSidebarIfUnpinned();
      return t0;
    }, sessionB);

    // Wait long enough for the fix's delayed re-fit (1000ms after switch) to
    // run, plus a generous margin.
    await page.waitForTimeout(1500);

    const resizeMsgs = await page.evaluate(() => window.__resizeMsgs);
    console.log('colsWithSidebarOpen:', colsWithSidebarOpen);
    console.log('resizeMsgs (ts relative to switch):', resizeMsgs.map(m => ({ dt: m.ts - switchAt, cols: m.cols, rows: m.rows })));

    // The fix adds a `setTimeout(doResize, 1000)` on mobile after the cached
    // switch. That delayed fit sends a resize to the server with the full
    // post-sidebar-close width. Without the fix the cached-switch path emits
    // a single narrow resize (line 772) at t=0 and stops — the terminal
    // (and the PTY) stay stuck at the narrow cols until the user taps,
    // which is the visible bug in issue #7.
    //
    // Assertion: there is at least one resize message sent to the server
    // LATE (>= 500ms after the switch) whose cols value is wider than what
    // we had before the switch. This ONLY holds when the delayed re-fit is
    // in place.
    expect(resizeMsgs.length).toBeGreaterThan(0);
    const lateWide = resizeMsgs.filter(
      m => (m.ts - switchAt) >= 500 && m.cols > colsWithSidebarOpen
    );
    expect(lateWide.length).toBeGreaterThan(0);

    await context.close();
  });
});
