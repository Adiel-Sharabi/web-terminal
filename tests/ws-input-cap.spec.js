// @ts-check
// #201 — the WS input caps, and which of them actually bounds anything.
//
// The per-frame app cap in `handleMessage` was 65536 from commit a96e7ba (2026-03-23),
// an inherited default: no measurement, never revisited, and the tightest limit on the
// whole path. It also bounded no memory, which is the job it was added for — `ws`
// assembles the entire message before any application handler runs, so the check
// rejected a frame that had ALREADY been buffered in full. Meanwhile the transport was
// left at the library default of 100 MB.
//
// So #201 does two separate things and this spec pins them separately:
//
//   1. `WS_INPUT_MAX` is now 256KB, equal to the companion's `_inputBufferHardCap`, so
//      nothing the offline buffer can hold within its ceiling is refused at the wire.
//      (`scripts/check-shared-constants.js` is what stops the two drifting apart; this
//      spec is what proves the server half is live.)
//   2. `WS_MAX_PAYLOAD` (4 MiB) is set on the transport, which is the bound that
//      actually bounds — and it behaves DIFFERENTLY from the app cap: `ws` closes the
//      socket (1009) rather than letting the app report the refusal. That asymmetry is
//      why the two numbers are far apart rather than snug, and it is asserted here so a
//      later "tidy-up" that pulls maxPayload down onto the app cap has to argue with a
//      red test first.
//
// The verdict for delivery is taken from the SHELL, never from the echo: a terminal
// echoes what it was sent as it is typed, so "the text is on screen" cannot distinguish
// a frame that arrived whole from one that arrived truncated. `${#WT}` makes the shell
// itself report the length of what it received.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const { BASE, AUTH, authCtx, emptyCwd } = require('./test-helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors server.js. Deliberately literal rather than imported: requiring server.js
// from a spec would run it, and a test that reads its expectation out of the code it
// is testing cannot fail when that code changes.
const WS_INPUT_MAX = 256 * 1024;         // per frame, UTF-16 code units
const WS_MAX_PAYLOAD = 4 * 1024 * 1024;  // per message, UTF-8 bytes
const OLD_CAP = 65536;                   // what a96e7ba shipped

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

// Opens a real session and attaches a real socket to it, collecting the two things a
// cap can be observed through: JSON control frames (the `inputDropped` echo) and the
// raw output stream (what the PTY actually did with the bytes).
async function attach(ctx, label) {
  const cookie = await rawCookie();
  const cwd = emptyCwd(label);
  const id = (await (await ctx.post('/api/sessions', { data: { name: label, cwd } })).json()).id;
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('error', () => {}); // a transport-level refusal tears the socket down; not a test failure
  let out = '';
  const json = [];
  ws.on('message', (data) => {
    const s = data.toString('utf8');
    out += s;
    if (s.charCodeAt(0) === 0x7B) { try { json.push(JSON.parse(s)); } catch {} }
  });
  ws.send(JSON.stringify({ mode: 'active', browserId: label }));
  await sleep(400);
  return {
    id,
    ws,
    output: () => out,
    notices: () => json.filter((f) => f && f.inputDropped),
    clear: () => { out = ''; json.length = 0; },
  };
}

// Padding broken into CR-terminated lines, so a canonical-mode reader never faces a
// single line longer than its own buffer. Exact total length, which is the whole point.
function padTo(n) {
  const LINE = 80;
  const chunk = 'z'.repeat(LINE - 1) + '\r';
  const s = chunk.repeat(Math.floor(n / LINE));
  return s + 'z'.repeat(n - s.length);
}

test.describe('#201 the WS input caps', () => {
  test('a frame over the OLD 64KB cap reaches the PTY whole', async () => {
    test.setTimeout(120000);
    const ctx = await authCtx();
    let s;
    try {
      s = await attach(ctx, 'ws-cap-delivers');

      // The shell reports the length of what it received, so a truncated arrival is
      // distinguishable from a whole one. `${#WT}` is expanded by the shell, so the
      // expected string cannot be matched by the terminal's echo of the command.
      const PAD = 69960;
      const payload = 'WT=' + 'z'.repeat(PAD) + '; echo "WT201:${#WT}:END"\r';
      expect(payload.length).toBeGreaterThan(OLD_CAP);
      expect(payload.length).toBeLessThanOrEqual(WS_INPUT_MAX);

      s.ws.send(payload);

      // It must not be refused. This is the assertion that is red before the fix:
      // the old cap answers this frame with `{inputDropped:true,bytes:69989}`.
      await sleep(1500);
      expect(s.notices(), 'a legal frame must not be refused').toEqual([]);

      const want = `WT201:${PAD}:END`;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && !s.output().includes(want)) await sleep(250);
      expect(s.output().length, 'no output at all — the PTY never ran the line').toBeGreaterThan(0);
      expect(s.output()).toContain(want);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      try { s?.ws.close(); } catch {}
      if (s?.id) { try { await ctx.delete(`/api/sessions/${s.id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('the app cap is exactly WS_INPUT_MAX: at it passes, one over is refused', async () => {
    test.setTimeout(120000);
    const ctx = await authCtx();
    let s;
    try {
      s = await attach(ctx, 'ws-cap-boundary');

      // Park the PTY on a reader that neither executes nor re-draws a quarter of a
      // megabyte. If this does not take, the frames land in the shell's line editor
      // instead and the assertions below are unaffected — they are about what the
      // SERVER did with the frame, before any PTY write.
      s.ws.send('cat > /dev/null\r');
      await sleep(1000);
      s.clear();

      const atCap = padTo(WS_INPUT_MAX);
      expect(atCap.length).toBe(WS_INPUT_MAX);
      s.ws.send(atCap);
      await sleep(2000);
      expect(s.notices(), 'a frame exactly AT the cap is legal').toEqual([]);

      const overCap = padTo(WS_INPUT_MAX + 1);
      expect(overCap.length).toBe(WS_INPUT_MAX + 1);
      s.ws.send(overCap);
      await sleep(2000);
      const n = s.notices();
      expect(n.length, `notices: ${JSON.stringify(n)}`).toBe(1);
      expect(n[0].bytes).toBe(WS_INPUT_MAX + 1);
      expect(s.ws.readyState, 'a refusal must not kill the socket').toBe(WebSocket.OPEN);
    } finally {
      try { s?.ws.close(); } catch {}
      if (s?.id) { try { await ctx.delete(`/api/sessions/${s.id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('maxPayload is configured: past it the TRANSPORT closes with 1009, no app notice', async () => {
    test.setTimeout(120000);
    const ctx = await authCtx();
    let s;
    try {
      s = await attach(ctx, 'ws-cap-maxpayload');

      const closed = new Promise((resolve) => s.ws.once('close', (code) => resolve(code)));
      s.ws.send('y'.repeat(WS_MAX_PAYLOAD + 1));

      const code = await Promise.race([closed, sleep(30000).then(() => -1)]);
      // Without maxPayload set, `ws` accepts up to its 100 MB default: the socket stays
      // open and the app answers with an `inputDropped` notice instead. Both halves of
      // this go red on the unfixed server.
      expect(code, 'the transport must refuse a frame past maxPayload').toBe(1009);
      expect(s.notices(), 'the app must never have seen it').toEqual([]);
    } finally {
      try { s?.ws.close(); } catch {}
      if (s?.id) { try { await ctx.delete(`/api/sessions/${s.id}`); } catch {} }
      await ctx.dispose();
    }
  });
});
