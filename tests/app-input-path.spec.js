// @ts-check
// #206 — app.html has ONE path for user input to reach a session socket, and it refuses
// a write the wire would answer by hanging up.
//
// WHY A LOCAL REFUSAL AT ALL. `ws` answers an oversize frame by CLOSING the socket
// (1009) before any application handler runs, so the server cannot send its
// `inputDropped` notice for it: the write is lost, anything already dequeued behind it
// goes too, and the user sees a reconnect blip with no explanation. #204 closed that band
// for the companion by refusing at the APP cap instead — a refusal by the app keeps the
// socket and the session, a refusal by the TRANSPORT costs the connection — and left this
// client open, because it was described as having no single place to put the check.
//
// THE PREMISE WAS HALF WRONG, WHICH IS WHY THE FIRST TEST HERE IS STRUCTURAL. `sendInput`
// had been the coalescing path for typing and for the compose bar all along; exactly four
// sites wrote past it. So the fix is a funnel, not a new mechanism — and a funnel's whole
// value is that nothing goes round it. That property is not observable from any single
// behavioural test (a new `ws.send` added next year would leave every other test in this
// repo green), so it is asserted against the source.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE, authCtx, loginPage } = require('./test-helpers');

const APP_HTML = path.join(__dirname, '..', 'app.html');

// server.js `WS_INPUT_MAX`, in UTF-16 code units. Written as a VALUE rather than read out
// of app.html: a test that took the number from the code under test would agree with any
// number that code happened to hold, including a broken one. The three copies are kept
// equal by scripts/check-shared-constants.js, which is the gate that makes this safe.
const WS_INPUT_MAX = 256 * 1024;

test.describe('#206 app.html routes every user input through one gated path', () => {
  test('no send site bypasses sendPtyInput — the funnel is the whole fix', () => {
    const src = fs.readFileSync(APP_HTML, 'utf8');
    const lines = src.split(/\r?\n/);
    const offenders = [];

    lines.forEach((line, i) => {
      if (!/\.send\(/.test(line)) return;
      // The funnel itself, and the four kinds of frame that are NOT user input.
      const allowed =
        /\bs\.send\(data\)/.test(line) ||                       // sendPtyInput's own write
        /sendPtyInput\(/.test(line) ||                          // a caller, not a bypass
        /\.send\(JSON\.stringify\(/.test(line) ||               // resize / mode control frames
        /\.send\('\{"heartbeat":1\}'\)/.test(line) ||           // liveness, not input
        /nws\.send\('ping'\)/.test(line);                       // the /ws/notify socket
      if (!allowed) offenders.push(`app.html:${i + 1}  ${line.trim()}`);
    });

    expect(
      offenders,
      'every write of USER INPUT to a session socket must go through sendPtyInput, or it '
        + 'is ungated and can reach WS_MAX_PAYLOAD — where the transport answers by '
        + 'closing the socket and no notice can be sent. Control frames (resize, mode, '
        + 'heartbeat, the notify ping) are not input and are allowed above.',
    ).toEqual([]);

    // The funnel must also still EXIST — an empty offender list is equally true of a file
    // with no sends at all, which is the vacuous way this assertion could pass.
    expect(src).toContain('function sendPtyInput(data, sock)');
    expect(src.match(/sendPtyInput\(/g).length,
      'the funnel plus its callers — a count of one would mean nothing routes through it')
      .toBeGreaterThan(4);
  });

  test('a write over the cap is refused locally, reported, and never reaches the wire', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'IP Cap' } })).json()).id;

    // Forward both directions explicitly so the page→server frames can be COUNTED. A
    // notice on its own cannot tell "refused" from "refused and forwarded anyway", and
    // that regression would pass every other assertion here.
    const sent = [];
    await page.routeWebSocket((url) => url.pathname === `/ws/${id}`, (wsRoute) => {
      const server = wsRoute.connectToServer();
      wsRoute.onMessage((m) => { sent.push(m); server.send(m); });
      server.onMessage((m) => { wsRoute.send(m); });
    });

    try {
      await page.goto(BASE + '/app/' + id);
      await expect(page.locator('#sessionName')).toContainText('IP Cap', { timeout: 10000 });
      await expect(page.locator('#composeNotice')).toBeHidden();

      // AT the cap first, as the positive anchor. The server compares
      // `msg.length > WS_INPUT_MAX`, so exactly the cap is legal there; refusing it here
      // would be the same silent loss in the other direction, and it is a size a real
      // paste can land on. It also proves the send path works at all, without which the
      // "nothing reached the wire" below would be vacuous.
      const atCapSent = await page.evaluate(
        (n) => sendPtyInput('y'.repeat(n)), WS_INPUT_MAX);
      expect(atCapSent, 'exactly at the cap is accepted by the server, so it must be sent')
        .toBe(true);
      await expect.poll(() => sent.filter((m) => typeof m === 'string' && m.startsWith('yyy')).length,
        { timeout: 10000 }).toBe(1);
      await expect(page.locator('#composeNotice'),
        'a legal write must not raise a notice').toBeHidden();

      const before = sent.length;
      const overCapSent = await page.evaluate(
        (n) => sendPtyInput('z'.repeat(n + 1)), WS_INPUT_MAX);
      expect(overCapSent, 'one over the cap is refused').toBe(false);

      await expect(page.locator('#composeNotice')).toBeVisible();
      await expect(page.locator('#composeNoticeText')).toContainText(String(WS_INPUT_MAX + 1));
      await expect(page.locator('#composeNoticeText')).toContainText('too large');

      // AND IT REACHED NO SOCKET. Checked after the notice is already visible, so the
      // page has demonstrably processed the call — this is about what was sent, never
      // about whether the call had run yet.
      expect(sent.filter((m) => typeof m === 'string' && m.startsWith('zzz')),
        'the refused write must not be handed to the wire — past WS_MAX_PAYLOAD the '
          + 'transport answers by closing the socket, which is the thing a local '
          + 'refusal exists to make unreachable').toEqual([]);
      // Nothing INPUT-shaped was sent in its place either. Not a count: revealing the
      // notice calls doResize(), which legitimately emits a `{"resize":...}` control
      // frame, so `sent.length` grows by one on a correct refusal. Control frames are
      // not input — that distinction is the funnel's whole premise, so the assertion
      // states it rather than counting past it.
      expect(
        sent.slice(before).filter((m) => typeof m !== 'string' || !m.startsWith('{')),
        'a refusal may emit control frames (the notice resizes the terminal) but no input',
      ).toEqual([]);

      expect(pageErrors, `console errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch { /* already gone */ }
      await ctx.dispose();
    }
  });
});
