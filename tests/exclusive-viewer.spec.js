const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:17681';

async function login(request) {
  return request.post(`${BASE}/login`, {
    form: { user: 'testuser', password: 'testpass:colon' },
    maxRedirects: 0,
  });
}

async function getSessions(request) {
  const resp = await request.get(`${BASE}/api/sessions`);
  return resp.json();
}

function connectWs(page, sessionId) {
  return page.evaluate((id) => {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/${id}`);
      window._testWs = ws;
      window._testMessages = [];
      ws.onmessage = e => {
        if (typeof e.data === 'string') window._testMessages.push(e.data);
      };
      ws.onopen = () => resolve('open');
      ws.onerror = () => reject('ws error');
      ws.onclose = (e) => {
        window._testMessages.push(`__CLOSE__:${e.code}`);
      };
    });
  }, sessionId);
}

test.describe('Exclusive Viewer', () => {
  test('second viewer kicks the first', async ({ browser, request }) => {
    await login(request);
    const sessions = await getSessions(request);
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0].id;

    // Open two browser contexts (simulating two devices)
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Login both
    await page1.goto(`${BASE}/login`);
    await page1.fill('input[name="user"]', 'testuser');
    await page1.fill('input[name="password"]', 'testpass:colon');
    await page1.click('button[type="submit"]');
    await page1.waitForURL('**/');

    await page2.goto(`${BASE}/login`);
    await page2.fill('input[name="user"]', 'testuser');
    await page2.fill('input[name="password"]', 'testpass:colon');
    await page2.click('button[type="submit"]');
    await page2.waitForURL('**/');

    // First viewer connects via WebSocket
    await connectWs(page1, sessionId);
    await page1.waitForTimeout(500);

    // Second viewer connects — should kick the first
    await connectWs(page2, sessionId);
    await page2.waitForTimeout(500);

    // First viewer should have received sessionTaken message and close code 4001
    const messages1 = await page1.evaluate(() => window._testMessages);
    const hasSessionTaken = messages1.some(m => m.includes('"sessionTaken"'));
    const hasClose4001 = messages1.some(m => m === '__CLOSE__:4001');

    expect(hasSessionTaken).toBe(true);
    expect(hasClose4001).toBe(true);

    // Second viewer should still be connected
    const ws2State = await page2.evaluate(() => window._testWs.readyState);
    expect(ws2State).toBe(1); // WebSocket.OPEN

    await ctx1.close();
    await ctx2.close();
  });

  test('kicked viewer does not auto-reconnect in app UI', async ({ browser, request }) => {
    await login(request);
    const sessions = await getSessions(request);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Viewer 1 opens the session via app UI
    await page1.goto(`${BASE}/login`);
    await page1.fill('input[name="user"]', 'testuser');
    await page1.fill('input[name="password"]', 'testpass:colon');
    await page1.click('button[type="submit"]');
    await page1.waitForURL('**/');
    // Click on the first session in sidebar
    await page1.click('.sb-item');
    await page1.waitForTimeout(1000);

    // Verify viewer 1 is connected (status shows connected)
    const status1Before = await page1.locator('#status').textContent();
    expect(status1Before).toContain('connected');

    // Viewer 2 opens the same session
    await page2.goto(`${BASE}/login`);
    await page2.fill('input[name="user"]', 'testuser');
    await page2.fill('input[name="password"]', 'testpass:colon');
    await page2.click('button[type="submit"]');
    await page2.waitForURL('**/');
    await page2.click('.sb-item');
    await page2.waitForTimeout(1000);

    // Viewer 1 should show "Session opened on ..." status
    const status1After = await page1.locator('#status').textContent();
    expect(status1After).toContain('Session opened on');

    // Viewer 1 should NOT show reconnect overlay (it was cleanly kicked, not disconnected)
    const overlay1 = await page1.locator('#reconnectOverlay').getAttribute('class');
    expect(overlay1 || '').not.toContain('show');

    // Viewer 2 should be connected
    const status2 = await page2.locator('#status').textContent();
    expect(status2).toContain('connected');

    await ctx1.close();
    await ctx2.close();
  });

  test('new viewer becomes sole client after takeover', async ({ browser, request }) => {
    await login(request);
    const sessions = await getSessions(request);
    const sessionId = sessions[0].id;

    // Desktop-sized viewer
    const ctx1 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    // Mobile-sized viewer
    const ctx2 = await browser.newContext({ viewport: { width: 400, height: 700 } });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Login and connect viewer 1 (desktop)
    await page1.goto(`${BASE}/login`);
    await page1.fill('input[name="user"]', 'testuser');
    await page1.fill('input[name="password"]', 'testpass:colon');
    await page1.click('button[type="submit"]');
    await page1.waitForURL('**/');
    await connectWs(page1, sessionId);
    await page1.waitForTimeout(300);

    // Verify 1 client
    let sessionsNow = await getSessions(request);
    expect(sessionsNow.find(s => s.id === sessionId).clients).toBe(1);

    // Login and connect viewer 2 (mobile) — kicks desktop
    await page2.goto(`${BASE}/login`);
    await page2.fill('input[name="user"]', 'testuser');
    await page2.fill('input[name="password"]', 'testpass:colon');
    await page2.click('button[type="submit"]');
    await page2.waitForURL('**/');
    await connectWs(page2, sessionId);
    await page2.waitForTimeout(1000);

    // Still only 1 client (the mobile one)
    sessionsNow = await getSessions(request);
    expect(sessionsNow.find(s => s.id === sessionId).clients).toBe(1);

    // First viewer was kicked
    const msgs1 = await page1.evaluate(() => window._testMessages);
    expect(msgs1.some(m => m.includes('"sessionTaken"'))).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });

  test('third viewer kicks the second (chained takeover)', async ({ browser, request }) => {
    await login(request);
    const sessions = await getSessions(request);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    // Login all three
    for (const page of [page1, page2, page3]) {
      await page.goto(`${BASE}/login`);
      await page.fill('input[name="user"]', 'testuser');
      await page.fill('input[name="password"]', 'testpass:colon');
      await page.click('button[type="submit"]');
      await page.waitForURL('**/');
    }

    // Viewer 1 connects
    await connectWs(page1, sessionId);
    await page1.waitForTimeout(300);

    // Viewer 2 connects — kicks 1
    await connectWs(page2, sessionId);
    await page2.waitForTimeout(300);

    // Verify viewer 1 was kicked
    const msgs1 = await page1.evaluate(() => window._testMessages);
    expect(msgs1.some(m => m.includes('"sessionTaken"'))).toBe(true);

    // Viewer 3 connects — kicks 2
    await connectWs(page3, sessionId);
    await page3.waitForTimeout(300);

    // Verify viewer 2 was kicked
    const msgs2 = await page2.evaluate(() => window._testMessages);
    expect(msgs2.some(m => m.includes('"sessionTaken"'))).toBe(true);

    // Viewer 3 should still be connected
    const ws3State = await page3.evaluate(() => window._testWs.readyState);
    expect(ws3State).toBe(1); // OPEN

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });
});
