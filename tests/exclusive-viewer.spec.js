const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:17681';

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

// Poll the server's client count for a session until [predicate] holds —
// attachSession is async, so the count lags the WS handshake by a beat. (Web
// pages also open their own background keep-alive sockets, so the shared count
// is "at least my viewers", not an exact 2.)
async function waitForClientCount(request, sessionId, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const s = (await getSessions(request)).find(x => x.id === sessionId);
    last = s ? s.clients : -1;
    if (predicate(last)) return last;
    await new Promise(r => setTimeout(r, 150));
  }
  return last;
}

// #21: toggle the opt-in single-owner takeover. PUT /api/config replaces the
// whole file (only password is preserved), so round-trip the full config.
async function setExclusiveViewer(request, value) {
  const cur = await (await request.get(`${BASE}/api/config`)).json();
  cur.exclusiveViewer = value;
  const res = await request.put(`${BASE}/api/config`, { data: cur });
  expect(res.ok()).toBeTruthy();
}

function connectWs(page, sessionId, browserId) {
  return page.evaluate(({ id, bid }) => {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/${id}`);
      window._testWs = ws;
      window._testMessages = [];
      ws.onmessage = e => {
        if (typeof e.data === 'string') window._testMessages.push(e.data);
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ mode: 'active', browserId: bid || ('test-' + Math.random().toString(36).slice(2)) }));
        resolve('open');
      };
      ws.onerror = () => reject('ws error');
      ws.onclose = (e) => {
        window._testMessages.push(`__CLOSE__:${e.code}`);
      };
    });
  }, { id: sessionId, bid: browserId });
}

async function loginPage(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="user"]', 'testuser');
  await page.fill('input[name="password"]', 'testpass:colon');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

// #21: the default is now SHARED multi-viewer — opening a session on a second
// device no longer force-disconnects the first. The old single-owner takeover
// is opt-in via `exclusiveViewer: true`.
test.describe('Session viewers (#21: shared by default)', () => {
  test('default: a second viewer does NOT kick the first (shared PTY)', async ({ browser, request }) => {
    await login(request);
    await setExclusiveViewer(request, false);
    const sessions = await getSessions(request);
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    try {
      await loginPage(page1);
      await loginPage(page2);

      await connectWs(page1, sessionId, 'device-A');
      // Wait for the SERVER to have registered viewer 1 before viewer 2 arrives.
      // `connectWs` resolves on `onopen`, and this file's own helper says why that
      // is not enough: "attachSession is async, so the count lags the WS handshake
      // by a beat". A fixed 400ms bet on that lag is not merely flaky HERE - it can
      // make this test pass while proving NOTHING, because "viewer 1 was not kicked"
      // and "viewer 2 arrived before there was anyone to kick" look identical from
      // the assertions below.
      expect(await waitForClientCount(request, sessionId, c => c >= 1, 15000))
          .toBeGreaterThanOrEqual(1);
      await connectWs(page2, sessionId, 'device-B');
      // And wait until the server has BOTH, so the negative assertion is about the
      // shared-viewer rule rather than about timing.
      expect(await waitForClientCount(request, sessionId, c => c >= 2, 15000))
          .toBeGreaterThanOrEqual(2);
      // The takeover decision is made during attach, so if a kick were coming it
      // has already been sent; this is only the socket's own travel time.
      await page1.waitForTimeout(300);

      // First viewer was NOT kicked: no sessionTaken, socket still open.
      const messages1 = await page1.evaluate(() => window._testMessages);
      expect(messages1.some(m => m.includes('"sessionTaken"'))).toBe(false);
      expect(messages1.some(m => m === '__CLOSE__:4001')).toBe(false);
      expect(await page1.evaluate(() => window._testWs.readyState)).toBe(1);

      // Both remain attached to the one PTY (plus any page keep-alive sockets).
      expect(await page2.evaluate(() => window._testWs.readyState)).toBe(1);
      expect(await waitForClientCount(request, sessionId, c => c >= 2))
          .toBeGreaterThanOrEqual(2);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('opt-in: exclusiveViewer=true restores the single-owner takeover', async ({ browser, request }) => {
    await login(request);
    const sessions = await getSessions(request);
    const sessionId = sessions[0].id;

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    try {
      await setExclusiveViewer(request, true);
      await loginPage(page1);
      await loginPage(page2);

      await connectWs(page1, sessionId, 'device-A');
      // Same registration race as the shared test above, and THIS is the side of it
      // that went red on a loaded CI runner (2026-09-01): viewer 2 connected before
      // the server had registered viewer 1, so there was nobody to kick, no
      // `sessionTaken` was ever sent, and the assertions below read a slow machine
      // as a broken feature.
      expect(await waitForClientCount(request, sessionId, c => c >= 1, 15000))
          .toBeGreaterThanOrEqual(1);
      await connectWs(page2, sessionId, 'device-B');

      // Wait for the takeover to REACH viewer 1, rather than for a stopwatch.
      await expect.poll(
        () => page1.evaluate(() => ({
          taken: window._testMessages.some(m => m.includes('"sessionTaken"')),
          closed: window._testMessages.some(m => m === '__CLOSE__:4001'),
        })),
        { timeout: 15000, message: 'viewer 1 was never told the session was taken' },
      ).toEqual({ taken: true, closed: true });

      // First viewer IS kicked (old behavior), second is sole viewer.
      const messages1 = await page1.evaluate(() => window._testMessages);
      expect(messages1.some(m => m.includes('"sessionTaken"'))).toBe(true);
      expect(messages1.some(m => m === '__CLOSE__:4001')).toBe(true);
      expect(await page2.evaluate(() => window._testWs.readyState)).toBe(1);
      expect(await waitForClientCount(request, sessionId, c => c === 1)).toBe(1);
    } finally {
      // Always restore the shared default so other tests aren't affected.
      await setExclusiveViewer(request, false);
      await ctx1.close();
      await ctx2.close();
    }
  });
});
