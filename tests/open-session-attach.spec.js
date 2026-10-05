// @ts-check
// #277 — test-helpers' `openSession` must not return before the session's socket is
// ATTACHED, because every spec that uses it then acts on that socket: pushes a synthetic
// server frame into it, or switches away expecting app.html's `switchSession` to DEMOTE it
// (which it does only to an OPEN socket — a CONNECTING one is closed, and a frame later
// sent into its route is discarded by Playwright without an error).
//
// The four specs that used it each carried a pasted copy that returned on `#sessionName`.
// That header is painted from a `/api/sessions` fetch, which races the `/ws/<id>` upgrade,
// so under full-suite load it could fill in while the socket was still CONNECTING — and a
// different test failed each run.
//
// A SLOW UPGRADE IS FORCED HERE rather than hoped for: the route holds the page's socket
// in CONNECTING for a fixed spell before connecting it to the server. The pasted helper
// returns inside that spell (readyState 0, nothing painted) and this test goes red against
// it; the shared one waits for the PTY's own bytes to arrive over the socket.
const { test, expect } = require('@playwright/test');
const { authCtx, loginPage, openSession } = require('./test-helpers');

const UPGRADE_DELAY_MS = 3000;

test('openSession returns only once the socket is OPEN and the PTY has spoken over it', async ({ page }) => {
  await loginPage(page);
  const ctx = await authCtx();
  const id = (await (await ctx.post('/api/sessions', { data: { name: 'OS Slow Upgrade' } })).json()).id;

  let connectedAt = 0;
  await page.routeWebSocket((url) => url.pathname === `/ws/${id}`, async (wsRoute) => {
    await new Promise((r) => setTimeout(r, UPGRADE_DELAY_MS));
    connectedAt = Date.now();
    wsRoute.connectToServer();
  });

  try {
    await openSession(page, id, 'OS Slow Upgrade');

    // The route really did run, so the socket really was held: without this a green run
    // could mean the delay never applied.
    expect(connectedAt, 'the route never connected the socket').toBeGreaterThan(0);
    const state = await page.evaluate(() => ({
      readyState: ws ? ws.readyState : null,
      sid: sessionId,
    }));
    expect(state).toEqual({ readyState: 1, sid: id });
  } finally {
    try { await ctx.delete(`/api/sessions/${id}`); } catch {}
    await ctx.dispose();
  }
});
