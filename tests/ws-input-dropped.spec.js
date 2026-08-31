// @ts-check
// #193 defect 3 — the server's per-frame WS input cap (server.js `handleMessage`) refused
// oversized input with a server-side console.error only; the client got nothing back,
// so a dropped paste or long typed line looked exactly like the agent silently ignoring
// the user — undiagnosable from the chair, and the one failure class this repo has
// repeatedly paid for (#63, #147, #179).
//
// This pins the fix: the SAME socket whose write was refused gets a bare
// `{"inputDropped":true,"bytes":N}` JSON control frame back — the `sessionTaken`
// convention already used on `/ws/:id` (no session id needed on the frame: only the
// socket that produced the oversized write is attached to it), so the refusal is now
// provable instead of silent.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const { BASE, AUTH, authCtx, emptyCwd } = require('./test-helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// #201 re-pointed the payload. This spec used to send 70,000 chars, which was over the
// old 64KB cap; that size is now LEGAL and is asserted to reach the PTY by
// `ws-input-cap.spec.js`. The echo itself is unchanged — it must still fire above
// whatever the cap is, which is the whole point of #193 — so the assertion is kept and
// only the size moved. The exact boundary is pinned next door; this pins the notice.
test.describe('#193 the WS input cap is visible to the client', () => {
  test('an oversized frame gets an inputDropped notice back on the SAME socket', async () => {
    const ctx = await authCtx();
    const cookie = await rawCookie();
    const cwd = emptyCwd('ws-input-dropped');
    let id;
    let ws;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'ws-input-dropped', cwd } })).json()).id;
      ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ mode: 'active', browserId: 'ws-input-dropped' }));
      await sleep(250);

      const frames = [];
      ws.on('message', (data) => frames.push(data.toString('utf8')));

      const oversized = 'x'.repeat(300000); // > the 262144-code-unit cap (#201), < maxPayload
      ws.send(oversized);
      await sleep(500);

      const notice = frames
        .map((f) => { try { return JSON.parse(f); } catch { return null; } })
        .find((f) => f && f.inputDropped);
      expect(notice, `frames received: ${JSON.stringify(frames.slice(0, 5))}`).toBeTruthy();
      expect(notice.bytes).toBe(oversized.length);

      // The refusal must not kill the socket — a normal write right after still works.
      frames.length = 0;
      ws.send('echo still-alive\r');
      await sleep(500);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      try { ws?.close(); } catch {}
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });
});
