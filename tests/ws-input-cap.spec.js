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
// The verdict for delivery is taken from a FILE the shell wrote, never from the echo: a
// terminal echoes what it was sent as it is typed, so "the text is on screen" cannot
// distinguish a frame that arrived whole from one that arrived truncated.
//
// And the delivery test deliberately turns the terminal's echo OFF and reads with `cat`
// rather than typing at the shell's own line editor. That is a measured cost, not a
// style choice: echo through ConPTY runs at ~120ms/KB and readline re-renders the whole
// line as it grows, so a 70KB frame took ~8s on a fast desktop and blew a 90s deadline
// on the CI runner. Off, and read by `cat`, the same 256KB is verified in 1.7s.
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

      // Park the PTY on a plain reader with the terminal's own echo OFF. Both halves are
      // measured, not stylistic. With echo ON, ConPTY costs ~120ms per KB, and the
      // shell's own line editor RE-RENDERS the growing line on top of that: a 70KB frame
      // took ~8s on a fast desktop and blew a 90s deadline on the CI runner, where the
      // bytes were arriving correctly and simply too slowly to assert on. Off, and read
      // by `cat`, the same delivery is verified in under two seconds.
      //
      // The `echo` in front of `cat` is the readiness signal. A fixed sleep here raced a
      // still-booting login shell and the payload landed on the PROMPT instead
      // (`bash: zzzz...: command not found`) — a green cap test that proved nothing.
      //
      // CAT"ON" is split by a pair of quotes so the marker cannot appear in the ECHO of the
      // command being typed, only in its OUTPUT. Spelled contiguously, the guard passes the
      // instant the line is keyed — before `cat` is running — which is this file's own
      // "never take the verdict from the echo" rule violated by its own scaffolding.
      s.ws.send('stty -echo; echo WT201:CAT"ON"; cat > cap.txt\r');
      const catBy = Date.now() + 30000;
      while (Date.now() < catBy && !s.output().includes('WT201:CATON')) await sleep(100);
      expect(s.output(), 'the reader never started, so nothing below is about the cap').toContain('WT201:CATON');
      await sleep(500);
      s.clear();

      // 874 CR-terminated 80-character lines, exactly. Over the old cap, inside the new
      // one, and no single line longer than a canonical-mode reader's own buffer.
      const PAD = 69920;
      const payload = padTo(PAD);
      expect(payload.length).toBe(PAD);
      expect(payload.length).toBeGreaterThan(OLD_CAP);
      expect(payload.length).toBeLessThanOrEqual(WS_INPUT_MAX);

      s.ws.send(payload);

      // Red before the fix: the old cap answers this one frame with
      // {inputDropped:true,bytes:69920} and never writes a byte to the PTY.
      await sleep(1500);
      expect(s.notices(), 'a legal frame must not be refused').toEqual([]);

      // EOF closes the reader; then the shell counts what actually landed ON DISK. The
      // verdict is never taken from the echo — a terminal echoes what it was sent as it
      // is typed, so "the text is on screen" cannot tell a frame that arrived whole from
      // one that arrived truncated. Counting only the payload characters makes the
      // expected number independent of whether the line discipline delivered CR, LF or
      // CRLF; the 874 line terminators are consumed as terminators either way.
      s.ws.send('\x04');
      await sleep(600);
      s.ws.send("stty echo; echo \"WT201:$(tr -d '\\r\\n' < cap.txt | wc -c | tr -d ' '):$(tr '\\r' '\\n' < cap.txt | wc -l | tr -d ' '):END\"\r");

      // 69046 payload characters AND all 874 line terminators. The second number is
      // not decoration: `tr -d` strips CRs, so an arrival missing ONLY its trailing CR
      // would report 69046 and pass — and "arrived minus its submit CR" is this
      // codebase's signature typed-but-not-submitted bug (#55), made reachable here
      // because `splitTrailingCr` writes that CR separately. Measured off a real
      // ConPTY: Z=69046 BYTES=69920 NL=874, i.e. one byte per terminator, so the frame
      // length is accounted for exactly. A line discipline that expanded CR to CRLF
      // would report 1748 and go red - loudly and diagnosably, which is the point.
      const want = `WT201:${(PAD / 80) * 79}:874:END`;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !s.output().includes(want)) await sleep(250);
      expect(s.output().length, 'no output at all - the PTY never ran the line').toBeGreaterThan(0);
      expect(s.output(), `last bytes seen: ${JSON.stringify(s.output().slice(-300))}`).toContain(want);
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
      // megabyte, with the terminal's own echo off (see the header: ~120ms/KB). The
      // reader writes to a FILE rather than /dev/null so the frames' fate is
      // observable - a notice alone cannot tell "refused" from "refused and also
      // forwarded anyway", and that regression would pass every other assertion here.
      s.ws.send('stty -echo; echo WT201:CAP"ON"; cat > cap2.txt\r');
      const capBy = Date.now() + 30000;
      while (Date.now() < capBy && !s.output().includes('WT201:CAPON')) await sleep(100);
      expect(s.output(), 'the reader never started').toContain('WT201:CAPON');
      await sleep(500);
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

      // AND THE REFUSED FRAME REACHED NO PTY. `cat` has seen only the at-cap frame, so
      // the file holds exactly its payload characters: 3276 complete 80-char lines plus
      // a 64-character remainder = 258,868. Had the over-cap frame been forwarded as
      // well it would read 517,737.
      // A LONE ^D here only FLUSHES: in canonical mode end-of-file is delivered on an
      // EMPTY line, and 262,144 is not a multiple of 80, so the at-cap frame leaves a
      // 64-character remainder pending. Without the CR first, `cat` never closes and
      // the verdict command below is written INTO cap2.txt instead of being run - which
      // is exactly how this test failed the first time it was written, and it failed
      // RED rather than green, which is the property that matters. The CR adds a line
      // terminator, never a payload character, so the expected count is unchanged.
      s.ws.send('\r');
      await sleep(400);
      s.ws.send('\x04');
      await sleep(600);
      s.ws.send("stty echo; echo \"WT201B:$(tr -d '\\r\\n' < cap2.txt | wc -c | tr -d ' '):END\"\r");
      const want2 = 'WT201B:258868:END';
      const by2 = Date.now() + 60000;
      while (Date.now() < by2 && !s.output().includes(want2)) await sleep(250);
      expect(s.output(), `last bytes seen: ${JSON.stringify(s.output().slice(-300))}`).toContain(want2);
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

      // BOTH edges, because only pinning the upper one would let a later "tidy-up"
      // pull maxPayload down towards the app cap and still pass. That is the change
      // the comment in server.js argues against: below ~786,432 bytes it would start
      // CLOSING sockets over frames the app can still report honestly, turning a
      // recoverable refusal into a dropped session.
      s.ws.send('y'.repeat(WS_MAX_PAYLOAD));
      await sleep(3000);
      const at = s.notices();
      expect(at.length, `notices: ${JSON.stringify(at)}`).toBe(1);
      expect(at[0].bytes).toBe(WS_MAX_PAYLOAD);
      expect(s.ws.readyState, 'a frame AT maxPayload is the app\'s to refuse, not the transport\'s')
        .toBe(WebSocket.OPEN);

      s.clear();
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
