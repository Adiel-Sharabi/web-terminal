// @ts-check
// #218 — `/s/:id` no longer serves a second, worse terminal client. It REDIRECTS.
//
// `terminal.html` was the third page that wrote user input to a session socket, and the
// only one that neither gated at the app cap (#204 closed the companion, #206 closed
// app.html) nor rendered the server's own `inputDropped` frame — it had no notice UI to
// render one in, and its handler read `if (e.data.startsWith('{"inputDropped"')) return;`.
// #200 was right to stop printing raw JSON into the terminal, but "do not print it"
// became "throw it away". So on that page a >256KB paste was refused by the server and
// reported to NOBODY, and a >4MiB paste closed the socket with nobody told why.
//
// Redirecting rather than gating: a notice UI on a page nothing links to is work that
// makes a second diverging copy of the input path MORE worth keeping.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx } = require('./test-helpers');

test.describe('#218 /s/:id redirects to the gated client', () => {
  test('an existing session redirects to /app/:id', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Legacy Redirect' } })).json()).id;
    try {
      const res = await ctx.get(`/s/${id}`, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      // 302, not 301: a permanent redirect is cached by browsers indefinitely, which
      // would turn reverting this into a support problem rather than a one-line change.
      expect(res.headers().location).toBe(`/app/${id}`);
    } finally {
      try { await ctx.delete(`/api/sessions/${id}`); } catch { /* already gone */ }
      await ctx.dispose();
    }
  });

  test('an id this server does not know redirects too, instead of bouncing to /', async () => {
    // THE POINT OF THE CHANGE, not an edge case. The old route asked the LOCAL worker for
    // the session and sent the user to `/` when it said no — and a session living on a
    // cluster PEER is exactly what that looks like from here, because `getSession` is
    // answered from the worker's own in-memory map with no cluster awareness. app.html
    // resolves the id against /api/cluster/sessions itself, so handing it through is
    // strictly better than deciding locally that the id does not exist.
    const ctx = await authCtx();
    try {
      const res = await ctx.get('/s/does-not-exist-here', { maxRedirects: 0 });
      expect(res.status(), 'a peer-hosted id must not be refused by the local worker')
        .toBe(302);
      expect(res.headers().location).toBe('/app/does-not-exist-here');
    } finally {
      await ctx.dispose();
    }
  });

  test('the id is encoded, so it cannot escape the path or inject a header', async () => {
    const ctx = await authCtx();
    try {
      // A raw `/` would make the Location a different route; a raw CR or LF would end
      // the header early. Both are refused by ENCODING rather than by validation, so
      // there is no accept-list to keep in step with whatever express happens to route.
      const res = await ctx.get('/s/' + encodeURIComponent('../admin/x'), { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      const loc = res.headers().location;
      expect(loc.startsWith('/app/'), `Location escaped the path: ${loc}`).toBe(true);
      expect(loc).not.toContain('/admin');
      expect(loc).not.toMatch(/[\r\n]/);
    } finally {
      await ctx.dispose();
    }
  });

  test('no route serves terminal.html any more — the file is unreachable, not merely legacy', () => {
    // THE STRUCTURAL HALF, and the reason `scripts/check-shared-constants.js` still
    // names THREE copies of `WS_INPUT_MAX` rather than four. terminal.html keeps its
    // four ungated `ws.send` calls and its dropped `inputDropped` frame; what makes that
    // safe is that nothing serves the page. No behavioural test can see a route added
    // next year — it would leave every other test in this repo green — so this asserts
    // against the source, the same argument as tests/app-input-path.spec.js's funnel scan.
    //
    // A TRAILING line comment is stripped, not just a whole comment LINE — and the
    // difference is not hypothetical: `SERVER_VERSION` is code and an inline changelog
    // on the SAME line, and that changelog explains this very change, so a whole-line
    // match reported `server.js:35` on the first run.
    //
    // The rule deliberately does NOT also match the serving verbs against the raw line.
    // That would forbid the file from documenting its own hazard — writing
    // `sendFile('terminal.html')` into an explanatory comment would trip a gate about
    // routing — which is #138's lesson (a detector's own phrase must not be a landmine
    // in our source) pointing the other way.
    //
    // Blind spot, stated rather than glossed: a `//` inside a string earlier on the same
    // line would truncate it and could hide a reference. Contrived, and the three
    // behavioural tests above already fail if `/s/:id` itself serves the page again —
    // what this catches is a NEW route, which no behavioural test would see.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const offenders = [];
    src.split(/\r?\n/).forEach((line, i) => {
      if (!/terminal\.html/.test(line)) return;
      const code = line.replace(/\/\/.*$/, '');
      if (/terminal\.html/.test(code)) offenders.push(`server.js:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
    expect(
      offenders,
      'terminal.html is the third input client, and it neither gates at WS_INPUT_MAX nor '
        + 'can render an inputDropped notice (#218). It is safe only while nothing serves '
        + 'it: routing it again reopens a band where a >256KB paste is refused and '
        + 'reported to nobody and a >4MiB paste closes the socket unexplained. Gate it '
        + 'first — which means building it a notice — or serve /app/:id instead.',
    ).toEqual([]);
  });
});
