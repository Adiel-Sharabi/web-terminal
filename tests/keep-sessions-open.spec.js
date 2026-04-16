const { test, expect } = require('@playwright/test');
const { BASE, AUTH, authCtx } = require('./test-helpers');

// Helper: enable/disable keepSessionsOpen via API
async function setKeepSessionsOpen(ctx, value) {
  const cfgRes = await ctx.get(`${BASE}/api/config`);
  const cfg = await cfgRes.json();
  cfg.keepSessionsOpen = value;
  const res = await ctx.put(`${BASE}/api/config`, {
    data: cfg,
  });
  return res.json();
}

// Helper: get session list
async function getSessions(ctx) {
  const res = await ctx.get(`${BASE}/api/sessions`);
  return res.json();
}

// Helper: open an authenticated WebSocket via page.evaluate
function connectWsWithMode(page, sessionId, mode, browserId) {
  return page.evaluate(({ id, mode, browserId }) => {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/${id}`);
      window._testWsList = window._testWsList || {};
      window._testWsList[id + '_' + mode] = ws;
      window._testMsgs = window._testMsgs || {};
      window._testMsgs[id + '_' + mode] = [];
      ws.onmessage = e => {
        if (typeof e.data === 'string') window._testMsgs[id + '_' + mode].push(e.data);
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ mode, browserId }));
        resolve('open');
      };
      ws.onerror = () => reject('ws error');
      ws.onclose = (e) => {
        window._testMsgs[id + '_' + mode].push(`__CLOSE__:${e.code}`);
      };
    });
  }, { id: sessionId, mode, browserId });
}

// Helper: login and get auth cookie, then navigate to a page that won't open WebSockets
async function loginPage(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

// Helper: login and get a page with auth cookies but no active app WebSockets.
// Uses a bare page that only has auth cookies — no app.html loaded.
async function loginPageClean(page) {
  // Login via API to get cookies, then navigate to a bare page
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
  // Now we have auth cookies. Navigate to a URL that returns plain text
  // (the hostname API endpoint returns JSON, no HTML/JS to execute)
  await page.goto(`${BASE}/api/hostname`);
  await page.waitForTimeout(200);
}

test.describe('Keep Sessions Open', () => {
  let ctx;

  test.beforeAll(async () => {
    ctx = await authCtx();
  });

  test.afterAll(async () => {
    // Restore keepSessionsOpen to false
    try { await setKeepSessionsOpen(ctx, false); } catch (e) {}
    await ctx.dispose();
  });

  test('config toggle: can set and read keepSessionsOpen', async () => {
    // Enable
    const enableResult = await setKeepSessionsOpen(ctx, true);
    expect(enableResult.ok).toBe(true);
    const cfg1 = await (await ctx.get(`${BASE}/api/config`)).json();
    expect(cfg1.keepSessionsOpen).toBe(true);

    // Disable
    const disableResult = await setKeepSessionsOpen(ctx, false);
    expect(disableResult.ok).toBe(true);
    const cfg2 = await (await ctx.get(`${BASE}/api/config`)).json();
    expect(cfg2.keepSessionsOpen).toBe(false);
  });

  test('background WS receives output without kicking active viewer', async ({ browser }) => {
    await setKeepSessionsOpen(ctx, true);
    const sessions = await getSessions(ctx);
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0].id;
    const testBrowserId = 'test-browser-' + Date.now();

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginPageClean(pageA);

    // Connect active viewer
    await connectWsWithMode(pageA, sessionId, 'active', testBrowserId);
    await pageA.waitForTimeout(500);

    // Connect background viewer (same browser)
    await connectWsWithMode(pageA, sessionId, 'background', testBrowserId);
    await pageA.waitForTimeout(500);

    // Active viewer should NOT be kicked
    const activeMsgs = await pageA.evaluate(({ id }) => window._testMsgs[id + '_active'], { id: sessionId });
    const hasSessionTaken = activeMsgs.some(m => m.includes('"sessionTaken"'));
    expect(hasSessionTaken).toBe(false);

    // Active WS should still be open
    const activeState = await pageA.evaluate(({ id }) => window._testWsList[id + '_active'].readyState, { id: sessionId });
    expect(activeState).toBe(1); // WebSocket.OPEN

    // Background WS should also be open
    const bgState = await pageA.evaluate(({ id }) => window._testWsList[id + '_background'].readyState, { id: sessionId });
    expect(bgState).toBe(1); // WebSocket.OPEN

    await ctxA.close();
    await setKeepSessionsOpen(ctx, false);
  });

  test('different browserId kicks active viewer', async ({ browser }) => {
    await setKeepSessionsOpen(ctx, true);
    const sessions = await getSessions(ctx);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    await loginPageClean(page1);
    await loginPageClean(page2);

    // Viewer 1 connects as active with browserId X
    await connectWsWithMode(page1, sessionId, 'active', 'browser-X');
    await page1.waitForTimeout(500);

    // Viewer 2 connects as active with browserId Y — should kick viewer 1
    await connectWsWithMode(page2, sessionId, 'active', 'browser-Y');
    await page2.waitForTimeout(500);

    // Viewer 1 should have been kicked
    const msgs1 = await page1.evaluate(({ id }) => window._testMsgs[id + '_active'], { id: sessionId });
    const hasSessionTaken = msgs1.some(m => m.includes('"sessionTaken"'));
    const hasClose4001 = msgs1.some(m => m === '__CLOSE__:4001');
    expect(hasSessionTaken).toBe(true);
    expect(hasClose4001).toBe(true);

    // Viewer 2 should still be connected
    const ws2State = await page2.evaluate(({ id }) => window._testWsList[id + '_active'].readyState, { id: sessionId });
    expect(ws2State).toBe(1); // OPEN

    await ctx1.close();
    await ctx2.close();
    await setKeepSessionsOpen(ctx, false);
  });

  test('background listener cannot send PTY input', async ({ browser }) => {
    await setKeepSessionsOpen(ctx, true);
    const sessions = await getSessions(ctx);
    const sessionId = sessions[0].id;
    const testBrowserId = 'test-bg-input-' + Date.now();

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginPageClean(pageA);

    // Connect as background
    await connectWsWithMode(pageA, sessionId, 'background', testBrowserId);
    await pageA.waitForTimeout(500);

    // Send input from background WS — should be blocked by server
    const uniqueMarker = 'BG_INPUT_TEST_' + Date.now();
    await pageA.evaluate(({ id, marker }) => {
      const ws = window._testWsList[id + '_background'];
      if (ws && ws.readyState === 1) ws.send('echo ' + marker + '\n');
    }, { id: sessionId, marker: uniqueMarker });
    await pageA.waitForTimeout(1000);

    // Check that the marker was NOT echoed back in the background WS messages
    const bgMsgs = await pageA.evaluate(({ id }) => window._testMsgs[id + '_background'], { id: sessionId });
    const markerFound = bgMsgs.some(m => m.includes(uniqueMarker));
    expect(markerFound).toBe(false);

    await ctxA.close();
    await setKeepSessionsOpen(ctx, false);
  });

  test('feature off rejects background connections with close code 4002', async ({ browser }) => {
    // Make sure feature is OFF
    await setKeepSessionsOpen(ctx, false);
    const sessions = await getSessions(ctx);
    const sessionId = sessions[0].id;

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginPageClean(pageA);

    // Try to connect as background — should be rejected
    await connectWsWithMode(pageA, sessionId, 'background', 'test-rejected');
    await pageA.waitForTimeout(1000);

    const bgMsgs = await pageA.evaluate(({ id }) => window._testMsgs[id + '_background'], { id: sessionId });
    const hasClose4002 = bgMsgs.some(m => m === '__CLOSE__:4002');
    expect(hasClose4002).toBe(true);

    await ctxA.close();
  });

  test('feature off: legacy exclusive kick still works', async ({ browser }) => {
    // Make sure feature is OFF
    await setKeepSessionsOpen(ctx, false);
    const sessions = await getSessions(ctx);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    await loginPageClean(page1);
    await loginPageClean(page2);

    // First viewer connects (legacy, no mode message)
    await page1.evaluate((id) => {
      return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/${id}`);
        window._legacyWs1 = ws;
        window._legacyMsgs1 = [];
        ws.onmessage = e => {
          if (typeof e.data === 'string') window._legacyMsgs1.push(e.data);
        };
        ws.onopen = () => resolve('open');
        ws.onerror = () => reject('ws error');
        ws.onclose = (e) => window._legacyMsgs1.push(`__CLOSE__:${e.code}`);
      });
    }, sessionId);
    await page1.waitForTimeout(500);

    // Second viewer connects (legacy) — should kick first
    await page2.evaluate((id) => {
      return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws/${id}`);
        window._legacyWs2 = ws;
        ws.onopen = () => resolve('open');
        ws.onerror = () => reject('ws error');
      });
    }, sessionId);
    await page2.waitForTimeout(500);

    // First viewer should have been kicked
    const msgs1 = await page1.evaluate(() => window._legacyMsgs1);
    expect(msgs1.some(m => m.includes('"sessionTaken"'))).toBe(true);
    expect(msgs1.some(m => m === '__CLOSE__:4001')).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });
});
