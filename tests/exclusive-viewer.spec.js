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
// attachSession is async, so the count lags the WS handshake by a beat.
//
// #224: this used to carry the caveat "web pages also open their own background
// keep-alive sockets, so the shared count is 'at least my viewers', not an exact 2".
// That caveat is gone because the cause is gone: these tests now create their own
// session and host their viewers on a page that opens no session socket of its own
// (see `viewerPage`), so the count is EXACTLY the viewers the test opened and the
// assertions below can be equalities instead of lower bounds.
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

// #21: toggle the opt-in single-owner takeover.
//
// This used to read "PUT /api/config replaces the whole file (only password is
// preserved), so round-trip the full config." Since #242 the PUT MERGES over what is on
// disk, so the round-trip is no longer what keeps this from erasing `cluster` and the
// rest - the server is. It is kept because it is still the honest shape for "change one
// setting", and because it is what a settings client does; it is now belt-and-braces
// rather than load-bearing.
//
// #224: READ IT BACK. `liveConfig()` re-reads config.json from disk on a 5s TTL, so
// anything else writing that file in this checkout can flip server behaviour under a
// test already in flight. The write itself is not lazy (`writeConfig` sets
// `_liveConfigCache` synchronously), so a read-back that disagrees means something
// else won the file — which is worth failing on loudly rather than discovering as a
// takeover that never happened.
async function setExclusiveViewer(request, value) {
  const cur = await (await request.get(`${BASE}/api/config`)).json();
  cur.exclusiveViewer = value;
  const res = await request.put(`${BASE}/api/config`, { data: cur });
  expect(res.ok()).toBeTruthy();
  const after = await (await request.get(`${BASE}/api/config`)).json();
  expect(after.exclusiveViewer, 'exclusiveViewer did not take — something else wrote config.json').toBe(value);
}

// Record EVERY WebSocket the page opens, so an assertion can be about WHICH viewers
// are attached rather than only HOW MANY. `waitForClientCount(c => c === 1)` cannot
// tell "viewer 2, alone" from "viewer 2 was kicked and a stranger took its place" —
// both are a count of 1 — and that ambiguity is exactly what made #224 hard to read.
async function instrumentSockets(page) {
  await page.addInitScript(() => {
    window.__wsLog = [];
    const Native = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      const rec = { url: String(url), mode: null, closeCode: null };
      window.__wsLog.push(rec);
      ws.addEventListener('close', (e) => { rec.closeCode = e.code; });
      const origSend = ws.send.bind(ws);
      ws.send = (d) => {
        if (typeof d === 'string' && d.startsWith('{"mode"')) rec.mode = d;
        return origSend(d);
      };
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = Native[k];
    window.WebSocket = Wrapped;
  });
}

/** Every socket this page has opened to [sessionId], in order. */
function socketsFor(page, sessionId) {
  return page.evaluate(
    (id) => window.__wsLog.filter(r => r.url.includes('/ws/' + id)),
    sessionId,
  );
}

// #224: an authenticated page that attaches to NOTHING.
//
// The old helper logged in through the form and waited for `**/` — which serves
// `app.html`, whose init() finds no session in the URL and calls
// `switchSession(allSessions[0].id)`. So merely logging a page in put a REAL active
// viewer on `sessions[0]`, with its own sessionStorage `browserId`, before the test
// opened a single socket of its own. Measured: `clients` on `sessions[0]` was already
// 1 after `loginPage(page1)` alone. Two such pages plus the two the test opens make
// FOUR mutually-kickable active viewers, on a session the test did not create.
//
// That matters under `exclusiveViewer: true`, where every active attach kicks every
// other browserId. app.html reconnects on close (150ms–1s) unless it parses the
// `{"sessionTaken"` frame first — and that block's own comment hedges that the close
// code "may not be 4001 in all browsers". Any app socket that takes its close without
// having parsed the frame comes back as the NEWEST viewer and kicks the test's winner,
// which is `readyState` 3 at the final assertion with every earlier one already green.
//
// `/lobby` is the fix: same origin, authenticated, and it opens no WebSocket at all
// (measured: `__wsLog` is empty after 2s on it, and `clients` on a freshly created
// session stays 0 with both pages sitting there). The cookie comes from the API
// context's storage state, so `app.html` is never loaded by this spec even in passing.
async function viewerPage(browser, storageState) {
  const ctx = await browser.newContext({ storageState });
  const page = await ctx.newPage();
  await instrumentSockets(page);
  await page.goto(`${BASE}/lobby`);
  return { ctx, page };
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

// #21: the default is now SHARED multi-viewer — opening a session on a second
// device no longer force-disconnects the first. The old single-owner takeover
// is opt-in via `exclusiveViewer: true`.
test.describe('Session viewers (#21: shared by default)', () => {
  // #224: THE SESSION IS CREATED HERE, not borrowed from `sessions[0]`.
  //
  // Both tests below assert about who is attached to a session; a test that asserts
  // single-ownership must own the thing it asserts about, or it is really asserting
  // about the whole server's state. Borrowing `sessions[0]` meant borrowing whatever
  // long-lived session the suite happened to list first — one that hundreds of
  // preceding specs may have opened pages against — which is why this file failed
  // three times in eight full-suite runs and passed every time it ran alone.
  let sessionId;
  let storageState;

  test.beforeEach(async ({ request }) => {
    await login(request);
    storageState = await request.storageState();
    // A UNIQUE name per test. `POST /api/sessions` answers 409 "Duplicate session"
    // for a repeat of the same name+folder inside a short window, so a fixed name
    // makes the SECOND test in this file fail in its beforeEach.
    const res = await request.post(`${BASE}/api/sessions`, {
      data: { name: `EV Owned ${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    expect(res.ok(), `create session failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    sessionId = (await res.json()).id;
    expect(sessionId).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    // Delete the session first, so a failed restore below cannot leak it.
    try { await request.delete(`${BASE}/api/sessions/${sessionId}`); } catch {}
    // Restore the shared default — an `exclusiveViewer` left true kicks viewers in
    // every spec that runs after this file, and those failures land nowhere near the
    // cause.
    //
    // DELIBERATELY NOT SWALLOWED. This used to be `try { ... } catch {}`, which caught
    // the read-back assertion inside `setExclusiveViewer` as well as any transport
    // error — so a restore that silently did not take left the flag ON for the rest of
    // the run with nothing recorded anywhere. That is the same class of defect as the
    // gate this file's PR is fixing: the failure surfaces somewhere else, wearing
    // someone else's name. Caught in review. If the restore cannot be made, this file
    // fails loudly and the run stops here rather than poisoning what follows.
    await setExclusiveViewer(request, false);
  });

  test('default: a second viewer does NOT kick the first (shared PTY)', async ({ browser, request }) => {
    await setExclusiveViewer(request, false);

    const v1 = await viewerPage(browser, storageState);
    const v2 = await viewerPage(browser, storageState);
    const { page: page1 } = v1;
    const { page: page2 } = v2;
    try {
      // The test OWNS this session, so nobody is attached to it yet. Asserted rather
      // than assumed: if this is ever non-zero the assertions below are about someone
      // else's viewers and their result means nothing.
      expect(await waitForClientCount(request, sessionId, c => c === 0)).toBe(0);

      await connectWs(page1, sessionId, 'device-A');
      // Wait for the SERVER to have registered viewer 1 before viewer 2 arrives.
      // `connectWs` resolves on `onopen`, and this file's own helper says why that
      // is not enough: "attachSession is async, so the count lags the WS handshake
      // by a beat". A fixed 400ms bet on that lag is not merely flaky HERE - it can
      // make this test pass while proving NOTHING, because "viewer 1 was not kicked"
      // and "viewer 2 arrived before there was anyone to kick" look identical from
      // the assertions below.
      expect(await waitForClientCount(request, sessionId, c => c === 1, 15000)).toBe(1);
      await connectWs(page2, sessionId, 'device-B');
      // And wait until the server has BOTH, so the negative assertion is about the
      // shared-viewer rule rather than about timing.
      expect(await waitForClientCount(request, sessionId, c => c === 2, 15000)).toBe(2);
      // The takeover decision is made during attach, so if a kick were coming it
      // has already been sent; this is only the socket's own travel time.
      await page1.waitForTimeout(300);

      // First viewer was NOT kicked: no sessionTaken, socket still open.
      const messages1 = await page1.evaluate(() => window._testMessages);
      expect(messages1.some(m => m.includes('"sessionTaken"'))).toBe(false);
      expect(messages1.some(m => m === '__CLOSE__:4001')).toBe(false);
      expect(await page1.evaluate(() => window._testWs.readyState)).toBe(1);

      // Both remain attached to the one PTY — EXACTLY two, no strangers.
      expect(await page2.evaluate(() => window._testWs.readyState)).toBe(1);
      expect(await waitForClientCount(request, sessionId, c => c === 2)).toBe(2);

      // ...and the two are OURS: one socket per page, neither reconnected.
      expect(await socketsFor(page1, sessionId)).toHaveLength(1);
      expect(await socketsFor(page2, sessionId)).toHaveLength(1);
    } finally {
      await v1.ctx.close();
      await v2.ctx.close();
    }
  });

  test('opt-in: exclusiveViewer=true restores the single-owner takeover', async ({ browser, request }) => {
    const v1 = await viewerPage(browser, storageState);
    const v2 = await viewerPage(browser, storageState);
    const { page: page1 } = v1;
    const { page: page2 } = v2;
    try {
      // Flip the flag only once both pages are parked on /lobby: under the takeover
      // rule an app.html page loading mid-test would kick somebody, and we want the
      // only attaches on the wire to be the two this test makes.
      await setExclusiveViewer(request, true);
      expect(await waitForClientCount(request, sessionId, c => c === 0)).toBe(0);

      await connectWs(page1, sessionId, 'device-A');
      // Same registration race as the shared test above, and THIS is the side of it
      // that went red on a loaded CI runner (2026-09-01): viewer 2 connected before
      // the server had registered viewer 1, so there was nobody to kick, no
      // `sessionTaken` was ever sent, and the assertions below read a slow machine
      // as a broken feature.
      expect(await waitForClientCount(request, sessionId, c => c === 1, 15000)).toBe(1);
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

      // #224: WHICH viewer survived, asserted before HOW MANY — because the count and
      // the readyState both answer "1 / CLOSED" whatever kicked viewer 2, and it was
      // the bare `Expected: 1, Received: 3` off the readyState line that made this
      // failure so hard to read three times over. Verified to have teeth: attaching a
      // third active viewer here turns exactly these assertions red.
      //
      // Viewer 2 opened exactly one socket and it was never closed. Had a later attach
      // kicked it, `closeCode` would be 4001 while the count below still read 1.
      const s2 = await socketsFor(page2, sessionId);
      expect(s2).toHaveLength(1);
      expect(s2[0].closeCode, 'viewer 2 — the winner — was itself kicked by a LATER attach (a fifth viewer)').toBeNull();
      expect(s2[0].mode).toContain('device-B');
      // Viewer 1 opened one socket and did NOT come back as a new viewer.
      expect(await socketsFor(page1, sessionId), 'viewer 1 reconnected after its kick').toHaveLength(1);

      expect(await page2.evaluate(() => window._testWs.readyState)).toBe(1);
      expect(await waitForClientCount(request, sessionId, c => c === 1)).toBe(1);
    } finally {
      await v1.ctx.close();
      await v2.ctx.close();
    }
  });
});
