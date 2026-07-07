// @ts-check
// Issue #24: opening/viewing or dismissing a session's attention on one device
// clears it everywhere. The server endpoint flips the recorded attention to
// cleared AND broadcasts a 'clear' frame on /ws/notify so other in-app viewers
// drop the chip (phones also get an FCM 'clear' — covered by fcm.spec.js).
const { test, expect } = require('@playwright/test');
const { authCtx } = require('./test-helpers');
const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

/** Log in over raw http and return the session cookie for a manual ws upgrade. */
function rawCookie() {
  return new Promise((resolve, reject) => {
    const body = `user=${encodeURIComponent(AUTH.user)}&password=${encodeURIComponent(AUTH.password)}`;
    const req = http.request(
      BASE + '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const sc = res.headers['set-cookie'];
        res.resume();
        if (!sc) return reject(new Error('no set-cookie on login'));
        resolve(sc.map((c) => c.split(';')[0]).join('; '));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test.describe('attention clear sync (#24)', () => {
  test('POST /api/sessions/:id/attention/clear requires auth', async () => {
    const status = await new Promise((resolve) => {
      const req = http.request(BASE + '/api/sessions/anything/attention/clear', { method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    expect(status).toBe(401);
  });

  test('clearing flips the recorded attention to cleared and broadcasts a clear frame', async () => {
    const ctx = await authCtx();
    const cookie = await rawCookie();

    // Live notify socket standing in for "another device".
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/notify', { headers: { Cookie: cookie } });
    const frames = [];
    ws.on('message', (d) => {
      try { frames.push(JSON.parse(d.toString())); } catch { /* ignore non-JSON */ }
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    try {
      // Seed a real (uncleared) attention record for the fixed 'notify-test' id.
      const seed = await ctx.post('/api/notify-test', { data: {} });
      expect(seed.status()).toBe(200);

      const before = await (await ctx.get('/api/sessions/notify-test/attention')).json();
      expect(before.kind).toBe('approval');
      expect(before.cleared).toBe(false);

      // Clear it (as if opened/dismissed on another device).
      const clr = await ctx.post('/api/sessions/notify-test/attention/clear', { data: {} });
      expect(clr.status()).toBe(200);
      expect((await clr.json()).ok).toBe(true);

      // The recorded attention now reads cleared — every device querying /attention agrees.
      const after = await (await ctx.get('/api/sessions/notify-test/attention')).json();
      expect(after.cleared).toBe(true);

      // And a 'clear' frame reached the live notify socket (other in-app viewers).
      await new Promise((r) => setTimeout(r, 250));
      const clearFrame = frames
        .map((f) => f.notification || f)
        .find((n) => n && n.type === 'clear' && n.sessionId === 'notify-test');
      expect(clearFrame, 'a clear frame should be broadcast on /ws/notify').toBeTruthy();
      expect(clearFrame.cleared).toBe(true);
    } finally {
      ws.close();
      await ctx.dispose();
    }
  });
});
