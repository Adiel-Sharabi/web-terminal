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

    // PERMIT A LOCATION, NOT A SHAPE — twice over, because the first two versions of this
    // gate each permitted a shape and each had a hole. Found in review, both times.
    //
    // (a) A line-scoped allowlist passed anything SHARING a line with something
    //     permitted, and this file is written in dense one-liners:
    //       `if (cached) sendPtyInput(a); else entry.ws.send(b);`
    //     So the permitted calls are STRIPPED and the residue must contain no `.send(`.
    //
    // (b) Allowing the funnel's own write by its TEXT was worse, and in the highest-
    //     traffic place in the file. `ws.send(data)` is exactly what xterm's own handler
    //     would say — `term.onData(data => …)` binds that identifier — so replacing
    //     `sendInput(data)` with `ws.send(data)` in that handler read as "the funnel"
    //     and the gate stayed green. Removing the `try/catch` made it worse still: the
    //     funnel's write is now a bare `ws.send(data);`, textually IDENTICAL to that
    //     bypass, so no pattern over the line can tell them apart. The funnel is
    //     therefore excluded by WHERE IT IS — the span of `sendPtyInput`'s own body.
    //
    // The control-frame permission likewise names the frames — `resize` and `mode` —
    // instead of permitting `JSON.stringify` generally, because
    // `ws.send(JSON.stringify({paste: text}))` is user input wearing a control frame's
    // clothes and would otherwise pass.
    // Located, but NOT asserted yet — the assertions live below the scan on purpose. A
    // file with no funnel at all (master, before this change) must fail by naming its
    // ungated send sites, which is the informative red; failing first on "the funnel is
    // missing" would hide them. Both bounds degrade safely to "exclude nothing" when the
    // funnel is absent, so the scan is correct either way.
    const declIdx = lines.findIndex((l) => /^\s*function sendPtyInput\(/.test(l));
    const closer = declIdx < 0 ? null : lines[declIdx].match(/^\s*/)[0] + '}';
    const endIdx = closer === null
      ? -1
      : lines.findIndex((l, i) => i > declIdx && l.trimEnd() === closer);

    lines.forEach((line, i) => {
      if (!/\.send\(/.test(line)) return;
      if (i > declIdx && i < endIdx) return;   // inside the funnel: this IS the one write
      const residue = line
        .replace(/\w+\.send\(JSON\.stringify\(\{\s*(?:resize|mode)\b/g, '')   // control frames, named
        .replace(/\w+\.send\('\{"heartbeat":1\}'\)/g, '')                     // liveness, not input
        .replace(/\bnws\.send\('ping'\)/g, '');                               // the /ws/notify socket
      if (/\.send\(/.test(residue)) offenders.push(`app.html:${i + 1}  ${line.trim()}`);
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
    //
    // Matched WITHOUT its parameter list: pinning the signature would make deleting an
    // unused parameter a two-file change that fails here first, which is a test dictating
    // a shape rather than guarding a behaviour.
    expect(declIdx, 'the funnel must exist for its body to be excluded by location')
      .toBeGreaterThan(-1);
    expect(endIdx, "the funnel's body must be delimitable, or the exclusion is unbounded")
      .toBeGreaterThan(declIdx);
    // Six is derived, not picked: the definition, plus the five call sites — the four
    // that used to write straight to `ws.send` (image path, mobile toolbar key,
    // long-press Paste, arrow repeat) and `sendInput`'s coalescing flush. A legitimate
    // new caller only pushes it up; losing one is what this catches.
    expect(src.match(/sendPtyInput\(/g).length,
      'the definition plus its five call sites — fewer means something stopped routing through it')
      .toBeGreaterThanOrEqual(6);
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
