// @ts-check
// #204 Gap 2 — when the cluster proxy's reconnect buffer refuses a write, TELL THE
// BROWSER.
//
// The proxy (`app.ws('/cluster/:serverUrl/ws/:id')` in server.js) holds what the browser
// types while its link to the remote peer is down and replays it on reconnect. A write
// that does not fit was dropped with nothing sent back — which is the one thing #193 says
// a dropped input must never be, and it had no excuse: the REMOTE link is what is down,
// `localWs` is open the whole time.
//
// WHY THIS IS AN INTEGRATION TEST AND NOT ONLY A UNIT ONE. The rule (`lib/reconnect-
// buffer.js` `decide`) is pure and covered in reconnect-buffer.spec.js: what it decides,
// and that it decides "report" exactly once per outage. What no unit test can show is
// that the notice actually reaches the socket the browser is holding, in the frame shape
// both clients already parse (`app.html` and the companion each read `{"inputDropped"`
// off this same socket). That is the half that was missing, so that is the half worth
// driving end to end.
//
// HOW THE REMOTE IS MADE TO BE DOWN. The proxy needs a cluster token for the peer URL it
// is asked to reach, so this spec writes one — pointing at a port nothing listens on.
// `connectRemote()` then fails immediately, `remoteWs` stays null, and every frame the
// browser sends takes the buffering branch from the very first one. It NEVER comes back
// up, which is deliberate: a remote that reconnected would flush the buffer and clear the
// latch mid-test.
//
// The token file it writes is `cluster-tokens.test.json`, redirected by
// `WT_CLUSTER_TOKENS_FILE` in playwright.config.js. The real `cluster-tokens.json` holds
// a live bearer token for every peer in the cluster and is never opened by a test run —
// see that config block for why a backup/restore would not have been good enough.
const { test, expect, request: pwRequest } = require('@playwright/test');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

// Nothing listens here. Chosen well away from 17681 (the suite) and 7681 (production) so
// a stray listener cannot quietly turn this into a test of the connected path.
const DEAD_PEER = 'http://127.0.0.1:17699';

const TOKENS_FILE = process.env.WT_CLUSTER_TOKENS_FILE
  || path.join(__dirname, '..', 'cluster-tokens.test.json');

// server.js's `MAX_BUFFER_SIZE`. The count bound is used rather than the byte one on
// purpose: both refusals run the same branch, and hitting the byte bound honestly would
// mean pushing ~4 MiB through a WebSocket on a shared CI runner to exercise one `if`.
const MAX_BUFFER_SIZE = 100;

async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return { cookie: setCookie.split(';')[0] };
}

/**
 * Open the proxy socket, retrying while the server still refuses it.
 *
 * `loadClusterTokens()` caches for `LIVE_CONFIG_TTL` (5s), so a token written to disk a
 * moment ago may not be visible yet and the route answers `close(1008)`. Waiting out a
 * fixed 5s would be both slower and a bet — this repo has three recorded cases of a
 * fixed timeout betting against a loaded runner and losing. Retry on the CONDITION
 * instead: a 1008 means "not yet", anything else means the route accepted us.
 */
async function openProxyWs(cookie, sessionId, deadlineMs = 15000) {
  const url = `${BASE.replace('http', 'ws')}/cluster/${encodeURIComponent(DEAD_PEER)}/ws/${sessionId}`;
  const until = Date.now() + deadlineMs;
  let lastCode = null;
  while (Date.now() < until) {
    const attempt = await new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: { Cookie: cookie }, perMessageDeflate: false });
      const frames = [];
      let settled = false;
      ws.on('message', (d) => frames.push(d.toString()));
      ws.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, code, ws, frames });
      });
      ws.on('error', () => {});
      ws.on('open', () => {
        // express-ws completes the handshake BEFORE the route runs, so an auth or
        // token failure arrives as an immediate close. Give it a beat to show up.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: true, ws, frames });
        }, 400);
      });
    });
    if (attempt.ok) return attempt;
    lastCode = attempt.code;
    try { attempt.ws.close(); } catch { /* already closed */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`proxy socket never accepted (last close code ${lastCode})`);
}

const droppedFrames = (frames) => frames.filter((f) => f.startsWith('{"inputDropped"'));

/**
 * Close the socket and resolve once the CLOSE HANDSHAKE completes — which is what makes
 * the "and nothing more was reported" assertions below mean anything.
 *
 * This repo has three recorded cases of a fixed timeout betting against a loaded CI
 * runner, and its own note on them says the dangerous shape is the NEGATIVE assertion:
 * a positive one behind a timer goes flaky, but a negative one goes VACUOUS — "no second
 * notice arrived" and "the server had not read the frames yet" are indistinguishable, so
 * the test passes while proving nothing. Sleeping 500ms and asserting a count is exactly
 * that shape.
 *
 * A close frame travels the same ordered stream as the data frames before it, and both
 * ends process frames in order — so the server has consumed every earlier data frame
 * before it replies, and this client has emitted every earlier `message` before it sees
 * that reply. When this resolves, `frames` holds everything the server ever sent. No
 * clock involved.
 */
function closeAndDrain(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    try { ws.close(); } catch { resolve(); }
  });
}

test.describe('#204 the cluster proxy reports a buffer refusal to the browser', () => {
  let cookie;

  test.beforeAll(async () => {
    cookie = (await authCtx()).cookie;
    // Merge rather than overwrite: another spec may have authenticated a peer into this
    // same throwaway file, and clobbering it would make the two specs order-dependent.
    let tokens = {};
    try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { /* first spec to need it */ }
    tokens[DEAD_PEER] = { token: 'wt204-not-a-real-token', user: AUTH.user };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  });

  test.afterAll(() => {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      delete tokens[DEAD_PEER];
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch { /* the file is disposable; a missing one is already clean */ }
  });

  test('the first refusal sends ONE inputDropped; later ones in the same outage are silent', async () => {
    const { ws, frames } = await openProxyWs(cookie, 'wt204-' + Date.now());
    // A distinctive size, so the single notice can be identified rather than merely
    // counted — see the drained assertions at the end.
    const OVER = 'over-the-buffer\r';
    expect(Buffer.byteLength(OVER)).not.toBe(Buffer.byteLength('k0\r'));

    try {
      // Fill the buffer exactly. The remote never came up, so every one of these takes
      // the buffering branch — and all 100 FIT, so none of them may report anything.
      // Frames are delivered in order, so the server reaches the 101st with the buffer
      // already full; nothing here is timing-dependent.
      for (let i = 0; i < MAX_BUFFER_SIZE; i++) ws.send(`k${i}\r`);

      // 101st — refused, and this is the one the user hears about. A POSITIVE poll:
      // if the notice never comes, this fails rather than passing quietly.
      ws.send(OVER);
      await expect.poll(() => droppedFrames(frames).length, { timeout: 10000 }).toBe(1);

      const notice = JSON.parse(droppedFrames(frames)[0]);
      expect(notice.inputDropped).toBe(true);
      expect(notice.bytes, 'the notice carries the size of what was lost')
        .toBe(Buffer.byteLength(OVER));
      // The two refusals on this channel do not mean the same thing, and a buffer-full
      // drop can land on a single keystroke - so the size-based wording the direct path
      // uses would read "too large to send (5 bytes)" here. `reason` is what lets
      // app.html say the right one; it is sent ONLY by this path, so its absence keeps
      // the original meaning elsewhere.
      expect(notice.reason).toBe('buffer-full');

      // Everything after it is refused for the same reason, so it says nothing new.
      // Without the latch guard this is where an outage typed through would answer
      // every keystroke with its own banner.
      for (let i = 0; i < 20; i++) ws.send(`after${i}\r`);
    } finally {
      await closeAndDrain(ws);
    }

    // Drained, so these are facts about the WHOLE exchange rather than about how long
    // the test happened to wait. Together they pin all three claims at once:
    //   - exactly one notice          -> the 20 later refusals were silent (the latch)
    //   - and it is the OVER-sized one -> none of the 100 writes that FIT was reported
    //                                     (a `k<i>\r` notice would carry 3 or 4 bytes)
    expect(
      droppedFrames(frames).length,
      'one notice per outage — the latch is what makes that the right number',
    ).toBe(1);
    expect(JSON.parse(droppedFrames(frames)[0]).bytes).toBe(Buffer.byteLength(OVER));
  });

  // The latch that makes "once per outage" right is also the thing that could silence
  // the notice FOREVER. `bufferLatched` is cleared in one place — the remote `open`
  // handler, beside `buffered.length = 0` — and if that line were ever lost, the first
  // outage on a socket would be the last one ever reported on it, and every write after
  // it would be REFUSED for the lifetime of that proxy connection. Both halves silent,
  // and every other test in this file still green.
  //
  // So this drives a real recovery: the peer comes UP, the buffer flushes, the peer goes
  // down again, and a second outage must report again. The recovery is observed rather
  // than waited for — the proxy sends `{"requestResize":true}` on remote open and
  // nothing else does, so its arrival IS proof the flush ran.
  test('a flush clears the latch, so the NEXT outage reports again', async () => {
    test.setTimeout(60000); // two real reconnect cycles, each on the proxy's own backoff
    const { ws, frames } = await openProxyWs(cookie, 'wt204b-' + Date.now());
    const resizeAsks = () => frames.filter((f) => f.startsWith('{"requestResize"')).length;

    /** A peer that accepts anything, so the proxy's next reconnect attempt succeeds. */
    const stub = new WebSocket.Server({ port: 17699 });
    stub.on('connection', (peer) => { peer.on('message', () => {}); });
    let stubOpen = true;
    const stopStub = () => new Promise((resolve) => {
      if (!stubOpen) return resolve();
      stubOpen = false;
      for (const c of stub.clients) { try { c.terminate(); } catch { /* already gone */ } }
      stub.close(() => resolve());
    });

    try {
      // OUTAGE 1 — the peer only starts listening once this notice has landed, so the
      // buffer genuinely filled while the link was down.
      for (let i = 0; i < MAX_BUFFER_SIZE; i++) ws.send(`a${i}\r`);
      ws.send('first-overflow\r');
      await expect.poll(() => droppedFrames(frames).length, { timeout: 15000 }).toBe(1);

      // RECOVERY — the proxy reconnects on its own backoff and flushes.
      await expect.poll(() => resizeAsks(), { timeout: 25000 }).toBeGreaterThan(0);

      // OUTAGE 2 — same socket, same proxy, fresh outage.
      await stopStub();
      for (let i = 0; i < MAX_BUFFER_SIZE; i++) ws.send(`b${i}\r`);
      ws.send('second-overflow\r');
      await expect
        .poll(() => droppedFrames(frames).length, { timeout: 20000 })
        .toBe(2);
    } finally {
      await stopStub();
      await closeAndDrain(ws);
    }

    // Drained: exactly two, and the second is the second overflow rather than a repeat
    // of the first — which is what distinguishes "the latch cleared" from "a stray
    // duplicate of outage 1".
    const notices = droppedFrames(frames).map((f) => JSON.parse(f));
    expect(notices.length).toBe(2);
    expect(notices[1].bytes).toBe(Buffer.byteLength('second-overflow\r'));
    expect(notices[1].reason).toBe('buffer-full');
  });

  // #209 — THE OPPOSITE CASE, and until now the silent one. Above, the buffer is full
  // and says no; here every write is ACCEPTED and then the whole buffer is discarded
  // because the peer never came back. From the user's side that is worse: nothing was
  // ever refused, so there was no signal at all — just `1001 Remote unreachable` ~37s
  // after they typed into a session that looked merely laggy.
  //
  // BOTH HALVES ON ONE CLOCK. Two proxy sockets are opened and left to exhaust their
  // attempts in parallel: one that typed, which must be told, and one that typed
  // nothing, which must not be. Running them together is not only ~37s cheaper than two
  // tests — it makes the negative half mean something, because both sockets reach their
  // give-up from the same run rather than the silent one merely being observed for a
  // shorter time.
  test('when the peer never comes back, the discarded buffer is reported BEFORE the close', async () => {
    // The proxy gives up after MAX_RECONNECT_ATTEMPTS (10) on a 500ms/1s/2s/4s/5s-capped
    // backoff — 37.5s of waiting plus ten immediate ECONNREFUSEDs. Everything below is
    // polled on a condition, so this ceiling only has to be comfortably above that.
    test.setTimeout(150000);

    /** Watch a proxy socket, recording what it was told and what it had been told BY the close. */
    function watch(ws, frames) {
      const seen = { frames, closeCode: null, framesAtClose: null, closed: null };
      seen.closed = new Promise((resolve) => {
        ws.on('close', (code) => {
          seen.closeCode = code;
          // Frames arrive on the same ordered stream as the close that follows them, and
          // this client emits every earlier `message` before it sees that reply. So a
          // notice present in THIS snapshot provably crossed the wire ahead of the close
          // — which is the ordering claim, asserted rather than assumed.
          seen.framesAtClose = frames.slice();
          resolve();
        });
      });
      return seen;
    }

    const typed = await openProxyWs(cookie, 'wt209a-' + Date.now());
    const silent = await openProxyWs(cookie, 'wt209b-' + Date.now());
    const over = await openProxyWs(cookie, 'wt209c-' + Date.now());
    const typedSeen = watch(typed.ws, typed.frames);
    const silentSeen = watch(silent.ws, silent.frames);
    const overSeen = watch(over.ws, over.frames);

    // Well under MAX_BUFFER_SIZE, so every one of these FITS: `decide` admits it and
    // #204's notice must never fire. That is what makes the reason below the new one.
    const WRITES = ['make me a plan for\r', 'the migration\r', 'y\r'];
    const TOTAL = WRITES.reduce((n, w) => n + Buffer.byteLength(w), 0);
    for (const w of WRITES) typed.ws.send(w);

    // THE THIRD SOCKET TYPES PAST THE BUFFER, which is where "what was lost" stops
    // being "what was held". Once `decide` refuses, the buffer is pinned at
    // MAX_BUFFER_SIZE and every later write lands in no array at all — so a give-up
    // that reported `buffered.length` would tell somebody who typed 105 things that it
    // lost 100, with a precise figure. Found in review.
    const FILL = Array.from({ length: MAX_BUFFER_SIZE }, (_, i) => `c${i}\r`);
    const EXTRA = ['first-refused\r', 'e1\r', 'e2\r', 'e3\r', 'e4\r'];
    const OVER_ALL = [...FILL, ...EXTRA];
    const OVER_TOTAL = OVER_ALL.reduce((n, w) => n + Buffer.byteLength(w), 0);
    for (const w of OVER_ALL) over.ws.send(w);
    // Observed, not assumed: the 'buffer-full' notice has to have fired BEFORE the
    // give-up, or the two-notice assertion below would be about the wrong pair.
    await expect.poll(() => droppedFrames(over.frames).length, { timeout: 15000 }).toBe(1);

    await Promise.all([typedSeen.closed, silentSeen.closed, overSeen.closed]);

    // The socket that typed: told, once, with the whole loss named, before the close.
    const notices = droppedFrames(typedSeen.framesAtClose).map((f) => JSON.parse(f));
    expect(notices.length, 'one notice for the whole discarded buffer, sent before the close').toBe(1);
    expect(notices[0].reason, "not 'buffer-full' — there was room the entire time")
      .toBe('peer-unreachable');
    expect(notices[0].bytes, 'the total actually lost, not the last write').toBe(TOTAL);
    expect(notices[0].writes, 'how many separate things that was').toBe(WRITES.length);
    expect(typedSeen.closeCode).toBe(1001);
    // Nothing more after the close snapshot either — the clear-before-close is what
    // stops a remote close arriving in the gap from reporting the same loss twice.
    expect(droppedFrames(typedSeen.frames).length).toBe(1);

    // The socket that typed nothing: an empty buffer is not a loss, and a notice for it
    // would be the confidently-wrong kind this whole family of messages exists to avoid.
    expect(droppedFrames(silentSeen.frames).length, 'an empty buffer is not a loss').toBe(0);
    expect(silentSeen.closeCode).toBe(1001);

    // The socket that overflowed: TWO notices, and the second names everything — the
    // 100 the buffer held AND the 5 it refused after latching. The natural defence for
    // reporting only 100 ("the earlier notice covered the rest") does not hold: both
    // render into the same element, so the second REPLACES the first and the only
    // sentence left on screen is this one.
    const overNotices = droppedFrames(overSeen.framesAtClose).map((f) => JSON.parse(f));
    expect(overNotices.length, 'one per outage from `decide`, plus the give-up').toBe(2);
    expect(overNotices[0].reason).toBe('buffer-full');
    expect(overNotices[1].reason).toBe('peer-unreachable');
    expect(overNotices[1].writes, 'everything lost, not everything held')
      .toBe(OVER_ALL.length);
    expect(overNotices[1].bytes).toBe(OVER_TOTAL);
    expect(overSeen.closeCode).toBe(1001);
  });
});
