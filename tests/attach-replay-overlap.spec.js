// @ts-check
// The SERVER-side invariant the companion's attach-time overlap cut rests on (#176).
//
// `ai-terminal/lib/util/attach_overlap.dart` de-duplicates the socket's opening
// replay against what the HTTP replay already put on screen, by finding the END of
// the rendered text INSIDE that frame. That works only because the two strings —
// which the server builds by two different routes — agree over the replay's tail:
//
//   * the attach replay (`server.js`) TRUNCATES the raw buffer, then sanitises it;
//   * `GET /scrollback` sanitises the WHOLE buffer, then slices it.
//
// `sanitizeReplay` is length-changing and stateful (it tracks alt-screen from the
// start of whatever string it is given), so the two are NOT equal in general — and
// measured, they are not: with escape-heavy output they diverge near the replay's
// HEAD, because the truncated copy starts mid-stream and never sees the earlier
// `ESC[?1049h`, so it strips an erase the whole-buffer pass keeps.
//
// What holds — and what the Dart rule depends on — is that they agree over the
// TAIL. Measured 2026-08-27: a common suffix run of 30947 of 31517 units on
// escape-heavy content, and all 32768 of 32768 on plain text. This pins that with
// a wide margin over `kAttachAnchorBytes` (4096).
//
// If someone reorders either sanitise pass, the Dart cut silently stops finding
// its anchor and #176 comes back as a duplicate — so it is gated HERE, on the
// server, where the change would be made.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { BASE, AUTH, authCtx, emptyCwd } = require('./test-helpers');

const SCROLLBACK_RANGE_MAX = 524288;
const REPLAY_LIMIT = 32768;      // server.js getScrollbackReplayLimit() default
const ANCHOR_BYTES = 4096;       // ai-terminal kAttachAnchorBytes
const BP = '\x1b[?2004h';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape-heavy on purpose: plain text makes sanitizeReplay a no-op and would
// "prove" an agreement that says nothing about the case agent TUIs actually
// produce. DSR/DA are stripped everywhere; ED only OUTSIDE alt-screen, which is
// the state the truncated pass gets wrong.
const GEN = `
const E = String.fromCharCode(27);
for (let i = 0; i < 6000; i++) {
  let s = 'AMARK-' + i + '-' + 'y'.repeat(20);
  if (i % 7 === 0) s += E + '[6n';
  if (i % 11 === 0) s += E + '[c';
  if (i % 5 === 0) s += E + '[2J';
  if (i % 97 === 0) s += E + '[?1049h';
  if (i % 97 === 40) s += E + '[?1049l';
  console.log(s);
}
`;

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

/** The socket's opening burst: everything until the stream goes quiet. */
function openingReplay(id, cookie, quietMs = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
    let buf = '';
    let timer = null;
    const done = () => { try { ws.close(); } catch {} resolve(buf); };
    const bump = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
    ws.on('open', bump);
    ws.on('message', (d) => { buf += d.toString('utf8'); bump(); });
    ws.on('error', reject);
    setTimeout(() => { try { ws.close(); } catch {} resolve(buf); }, 20000);
  });
}

test('#176: the attach replay agrees with /scrollback over its TAIL', async () => {
  const ctx = await authCtx();
  const cwd = emptyCwd('attach-overlap');
  fs.writeFileSync(path.join(cwd, 'gen.js'), GEN, 'utf8');
  let id;
  try {
    id = (await (await ctx.post('/api/sessions', {
      data: { name: 'attach-overlap', cwd, autoCommand: 'node gen.js' },
    })).json()).id;

    let total = 0;
    for (let i = 0; i < 40 && total < 150000; i++) {
      await settle(500);
      const j = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=${SCROLLBACK_RANGE_MAX}`)).json();
      total = j.total || 0;
    }
    test.skip(total < 150000, `session only produced ${total} units of scrollback`);
    await settle(2000); // let it finish so the buffer stops moving under the comparison

    const httpBuf = (await (await ctx.get(
      `/api/sessions/${id}/scrollback?offset=0&limit=${SCROLLBACK_RANGE_MAX}`)).json()).data || '';
    const sockRaw = await openingReplay(id, await rawCookie());
    const sock = sockRaw.startsWith(BP) ? sockRaw.slice(BP.length) : sockRaw;

    expect(sock.length).toBeGreaterThan(0);
    // The replay is bounded by scrollbackReplayLimit (plus the mode prefix, which
    // is terminal STATE and not part of the scrollback — the Dart cut preserves it
    // for exactly that reason).
    expect(sock.length).toBeLessThanOrEqual(REPLAY_LIMIT);

    // THE INVARIANT: walking back from the end, the two agree for far longer than
    // the anchor the cut uses. This is what makes the anchor findable.
    let common = 0;
    while (common < sock.length && common < httpBuf.length
           && sock[sock.length - 1 - common] === httpBuf[httpBuf.length - 1 - common]) common++;
    expect(
      common,
      `common suffix run between the socket replay and /scrollback `
      + `(${common} of ${sock.length}); the Dart cut anchors on ${ANCHOR_BYTES}`,
    ).toBeGreaterThanOrEqual(ANCHOR_BYTES * 2);

    // ...and stated the way the Dart rule uses it: the last ANCHOR_BYTES of the
    // HTTP buffer are findable inside the socket frame. That IS the cut.
    const anchor = httpBuf.slice(-ANCHOR_BYTES);
    expect(sock.indexOf(anchor), 'the rendered tail must be findable in the replay').toBeGreaterThanOrEqual(0);
  } finally {
    if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    await ctx.dispose();
  }
});
