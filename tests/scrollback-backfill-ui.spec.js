// @ts-check
// #178 — the WEB client's scroll-up backfill, driven through the real page.
//
// `tests/scrollback-window.spec.js` pins the RULE. This pins the WIRING, which
// is where #178 actually lived: the rule was never wrong, `app.html` simply did
// not have one — it walked the buffer by arithmetic (`historyTotal -
// historyOffset - CHUNK`) over a coordinate space that is not stable.
//
// The assertion is the one the issue asked for — **detectable from the prepended
// text**: every line the generator prints carries a unique marker, so a backfill
// that re-fetches what is already on screen puts the SAME marker in the terminal
// buffer twice. Nothing about the mechanism needs to be inspected; the duplicate
// is the symptom the user reported.
//
// Red without the fix by construction: `historyOffset` started at 0 and was
// never seeded with the replay's size, so the very first backfill asked for
// `[total - 32768, total)` while `scrollbackReplayLimit` defaults to exactly
// 32768 — it re-prepended the whole visible screen. One scroll to the top was
// enough to duplicate.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE, authCtx, noAuthCtx, loginPage, emptyCwd } = require('./test-helpers');

const LINES = 4000;                 // ~150 KB — several backfill steps deep
const SCROLLBACK_RANGE_MAX = 524288;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A generator run through `node` rather than a shell loop: `DEFAULT_SHELL`
 * differs per machine and per config, and quoting a loop through an unknown
 * shell is exactly the kind of incidental flake that gets a spec written off.
 */
function writeGenerator(dir) {
  const p = path.join(dir, 'gen.js');
  fs.writeFileSync(
    p,
    `for (let i = 0; i < ${LINES}; i++) console.log('SBMARK-' + i + '-' + 'x'.repeat(20));\n`,
    'utf8',
  );
  return p;
}

/** Every marker currently in xterm's buffer, scrollback included, in order. */
async function bufferMarkers(page) {
  return page.evaluate(() => {
    const term = window.term;
    if (!term || !term.buffer || !term.buffer.active) return null;
    const buf = term.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const m = line.translateToString(true).match(/SBMARK-\d+/);
      if (m) out.push(m[0]);
    }
    return out;
  });
}

test.describe('#178 web scroll-up backfill', () => {
  test('the served rule is behind auth, and is the same file the spec pins', async () => {
    // A new route is a new surface. It sits after server.js's blanket auth
    // middleware, which is a property worth ASSERTING rather than assuming —
    // "it's only a rule file" is how an unauthenticated route gets added next to
    // it later.
    const anon = await noAuthCtx();
    const denied = await anon.get('/lib/scrollback-window.js', { maxRedirects: 0 });
    expect(denied.status()).toBe(302);                       // pages redirect to /login
    expect(denied.headers()['location']).toBe('/login');
    await anon.dispose();

    const ctx = await authCtx();
    const res = await ctx.get('/lib/scrollback-window.js');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('javascript');
    // No-cache: a stale copy of a paging rule desynchronises the client from the
    // server's byte space silently, which is the whole class of bug #178 is in.
    expect(res.headers()['cache-control']).toContain('no-store');
    const served = await res.text();
    const onDisk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scrollback-window.js'), 'utf8');
    // THE point of serving it: the browser runs the same bytes the unit spec
    // runs, so the rule cannot drift into a second copy.
    expect(served).toBe(onDisk);
    expect(served).toContain('globalThis.WTScrollback');     // reaches the page as a global
    await ctx.dispose();
  });

  test('scrolling back through a deep history shows each printed block exactly once', async ({ page }) => {
    const ctx = await authCtx();
    const cwd = emptyCwd('sb-backfill');
    writeGenerator(cwd);
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', {
        data: { name: 'sb-backfill', cwd, autoCommand: 'node gen.js' },
      })).json()).id;

      // Wait for the generator's output to land in the worker's scrollback.
      let total = 0;
      for (let i = 0; i < 40 && total < 100000; i++) {
        await settle(500);
        const j = await (await ctx.get(
          `/api/sessions/${id}/scrollback?offset=0&limit=${SCROLLBACK_RANGE_MAX}`,
        )).json();
        total = j.total || 0;
      }
      test.skip(total < 100000, `session only produced ${total} units of scrollback`);

      await loginPage(page);
      await page.goto(`${BASE}/app/${id}`);
      // The terminal is up and has the tail of the run on screen.
      await page.waitForFunction(() => {
        const t = window.term;
        return !!(t && t.buffer && t.buffer.active && t.buffer.active.length > 5);
      }, { timeout: 20000 });
      await settle(1500);

      const before = await bufferMarkers(page);
      expect(before, 'window.term must be reachable').not.toBeNull();
      expect(before.length, 'the run must be on screen to scroll back through').toBeGreaterThan(10);

      // Drive REAL wheel events: the backfill is gated on a genuine user gesture
      // (`markUserScrollGesture`), so a programmatic scrollTop = 0 would trigger
      // nothing and this test would pass against any implementation at all.
      const box = await page.locator('#terminal').boundingBox();
      expect(box, '#terminal must be laid out').not.toBeNull();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -400);
        // Debounce (250 ms) + fetch + the full term.reset()/write rewrite.
        await settle(1200);
      }

      const after = await bufferMarkers(page);
      expect(after).not.toBeNull();

      // THE ASSERTION: no marker twice. A re-fetched window shows up as the same
      // printed line occupying two rows of the buffer.
      const seen = new Map();
      for (const m of after) seen.set(m, (seen.get(m) || 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1);
      expect(
        dupes.slice(0, 8),
        `markers appearing more than once (of ${after.length} rows, ${seen.size} distinct)`,
      ).toEqual([]);

      // ...and the walk actually went somewhere, or "no duplicates" is vacuous.
      // Backfill prepends OLDER lines, so the lowest marker index must have
      // dropped below where the initial replay started.
      const lowest = (arr) => Math.min(...arr.map((m) => parseInt(m.slice(7), 10)));
      expect(lowest(after), 'the walk must have reached older content').toBeLessThan(lowest(before));
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });
});
