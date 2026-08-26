// @ts-check
// Web UI: the resources view (#152 levels 2 and 3) — web-terminal's own footprint on the
// server header, and a CPU/memory badge per session row.
//
// The single most important thing these tests pin is that the view is OFF by default and
// asks for NOTHING until it is switched on. The reading behind it costs a whole-machine
// process query on every server in the cluster, so a badge that quietly polled would turn
// an on-demand feature back into the disk/CPU storm the design exists to avoid.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

test.describe('Sidebar UI: resources view', () => {
  test('is off by default and requests nothing', async ({ page }) => {
    const calls = [];
    await loginPage(page);
    page.on('request', (r) => { if (r.url().includes('/api/resources')) calls.push(r.url()); });
    await page.goto(BASE + '/');
    await expect(page.locator('#loadBtn')).toBeVisible();
    // Long enough to outlast a poll tick, so "nothing yet" cannot pass by being early.
    await page.waitForTimeout(2500);
    expect(calls).toHaveLength(0);
    // The placeholders exist but carry no text — `:empty` hides them.
    const badges = page.locator('.sb-res');
    for (let i = 0; i < await badges.count(); i++) {
      await expect(badges.nth(i)).toBeEmpty();
    }
  });

  test('switching it on fills the session badge and the server footprint', async ({ page }) => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'UI Resources' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await loginPage(page);
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      await page.click('#loadBtn');
      const badge = row.locator('.sb-res');
      // Either a real reading or an explicit em dash — never blank once the view is on
      // and the server has answered, and never a fabricated 0%.
      await expect(badge).toHaveText(/%|—/, { timeout: 15000 });

      // web-terminal's own footprint rides the server header.
      const wt = page.locator('.srv-resources .u-wt').first();
      await expect(wt).toHaveText(/WT/, { timeout: 15000 });
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('the choice survives a reload, and switching it off stops the polling', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    await page.click('#loadBtn');
    await expect(page.locator('#loadBtn')).toHaveClass(/on/);

    await page.reload();
    await expect(page.locator('#loadBtn')).toHaveClass(/on/, { timeout: 5000 });

    // Off again: the badges empty out immediately rather than freezing on a stale number,
    // and no further request is made.
    const after = [];
    page.on('request', (r) => { if (r.url().includes('/api/resources')) after.push(r.url()); });
    await page.click('#loadBtn');
    await expect(page.locator('#loadBtn')).not.toHaveClass(/on/);
    const wt = page.locator('.srv-resources .u-wt').first();
    if (await wt.count()) await expect(wt).toBeEmpty();
    await page.waitForTimeout(2500);
    expect(after).toHaveLength(0);
  });

  // --- what a REVIEW found: two ways this rendered wrongly ---------------------------

  test('a session id carrying a quote cannot break out of its attribute', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    // Session ids and server URLs arrive from a PEER and are now interpolated into raw
    // attribute markup. esc() round-tripped through textContent -> innerHTML, which is
    // the HTML *text-node* serializer: it escapes & < > and leaves quotes alone — safe
    // in a text node, an injection point in an attribute.
    const out = await page.evaluate(() => {
      const hostile = 'x" onmouseover="alert(1)';
      const markup = `<span class="sb-res" data-res-id="${esc(hostile)}"></span>`;
      const d = document.createElement('div');
      d.innerHTML = markup;
      const el = d.firstElementChild;
      return {
        escaped: esc(hostile),
        // If the quote survived, the parser sees extra attributes on the element.
        attrs: el.getAttributeNames().sort(),
        roundTrip: el.getAttribute('data-res-id'),
      };
    });
    expect(out.escaped).not.toContain('"');
    expect(out.attrs).toEqual(['class', 'data-res-id']);
    // Escaping must not corrupt the value — the attribute still reads back verbatim.
    expect(out.roundTrip).toBe('x" onmouseover="alert(1)');
  });

  test('the footprint still has somewhere to render when the machine reading is missing', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    // Levels 1 and 2 are separate readings from separate places: the machine figure rides
    // the session poll and can be absent on a server that answers /api/resources
    // perfectly well. The level-2 slot lived INSIDE the level-1 markup, so on such a
    // server the footprint was fetched every six seconds and rendered nowhere at all.
    const out = await page.evaluate(() => {
      const withMachine = resourcesHtml({
        online: true, url: 'http://a', capabilities: ['resources', 'session-resources'],
        resources: { cpuPct: 12, memory: { usedPct: 40, usedBytes: 4e9, totalBytes: 1e10 }, windowMs: 5000 },
      });
      const noMachine = resourcesHtml({
        online: true, url: 'http://b', capabilities: ['session-resources'],
      });
      const neither = resourcesHtml({ online: true, url: 'http://c', capabilities: [] });
      const offline = resourcesHtml({
        online: false, url: 'http://d', capabilities: ['resources', 'session-resources'],
        resources: { cpuPct: 12, memory: { usedPct: 40, usedBytes: 4e9, totalBytes: 1e10 } },
      });
      return { withMachine, noMachine, neither, offline };
    });
    expect(out.withMachine).toContain('u-wt');
    expect(out.withMachine).toContain('CPU 12%');
    // The slot is there; the machine half is not invented.
    expect(out.noMachine).toContain('u-wt');
    expect(out.noMachine).toContain('wt-only');
    // No machine half is invented — the `u-agent` spans that carry CPU/MEM are absent.
    // (The container's tooltip still names them; only the readings must not appear.)
    expect(out.noMachine).not.toContain('u-agent');
    expect(out.noMachine).not.toContain('MEM');
    // A server that can answer neither renders nothing, exactly as before.
    expect(out.neither).toBe('');
    expect(out.offline).toBe('');
  });
});

// --- #165: the readout leads with HEADROOM ------------------------------------------
// "92%" said nothing while the box was unusable at 0.65 GB free. The number the choice
// is actually made on is how much room is left, so that is the number that leads; the
// percentage stays as context, and the colour is keyed on the absolute figure because a
// percentage has almost no dynamic range left above ~90%.
test.describe('Sidebar UI: headroom and pressure (#165)', () => {
  test('leads with free bytes, keeps the percentage secondary', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    const html = await page.evaluate(([m]) => resourcesHtml({
      online: true, url: 'http://a', capabilities: ['resources', 'session-resources'],
      resources: { cpuPct: 12, memory: m, windowMs: 5000 },
    }), [{ usedBytes: 20401094656, totalBytes: 34047594496, availBytes: 13646499840, usedPct: 60 }]);
    expect(html).toContain('12.7G free of 31.7G');
    // The percentage is still there — demoted, not deleted. It is the right reading below
    // ~90%, where it still has range.
    expect(html).toContain('60%');
    // And the old used/total pair is gone: two byte figures plus a percentage on a 9px
    // line is three numbers competing for one glance.
    expect(html).not.toContain('19.0G/31.7G');
  });

  test('a peer too old to report headroom falls back — it never shows "0.0G free"', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    const html = await page.evaluate(() => resourcesHtml({
      online: true, url: 'http://a', capabilities: ['resources', 'session-resources'],
      resources: { cpuPct: 12, memory: { usedBytes: 20401094656, totalBytes: 34047594496, availBytes: null, usedPct: 60 }, windowMs: 5000 },
    }));
    // No headroom READING is invented (the container tooltip may still name the field).
    expect(html).not.toContain('free of');
    expect(html).not.toContain('0.0G');
    // It still says what it DOES know, rather than blanking the whole row.
    expect(html).toContain('60%');
  });

  test('colour is keyed on the ABSOLUTE headroom, never on the percentage', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    const out = await page.evaluate(() => {
      const GB = 1024 * 1024 * 1024;
      const mk = (availGB, totalGB, pct) => resourcesHtml({
        online: true, url: 'http://a', capabilities: ['resources', 'session-resources'],
        resources: {
          cpuPct: 12, windowMs: 5000,
          memory: {
            usedBytes: (totalGB - availGB) * GB, totalBytes: totalGB * GB,
            availBytes: availGB * GB, usedPct: pct,
          },
        },
      });
      return {
        // The reported box: 98% used, 0.65 GB left. Unusable.
        dying: mk(0.65, 32, 98),
        // A big box at the SAME percentage with real room left. The percentage cannot
        // tell these apart; the headroom can.
        bigBoxSamePct: mk(12.7, 640, 98),
        amber: mk(3, 32, 91),
        fine: mk(12.7, 32, 60),
      };
    });
    expect(out.dying).toContain('u-hot');
    expect(out.bigBoxSamePct).not.toContain('u-hot');
    expect(out.bigBoxSamePct).not.toContain('u-warn');
    expect(out.amber).toContain('u-warn');
    expect(out.amber).not.toContain('u-hot');
    expect(out.fine).not.toContain('u-warn');
    expect(out.fine).not.toContain('u-hot');
  });

  test('the paging rate renders beside memory, and a null one renders nothing', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/');
    const out = await page.evaluate(() => {
      const report = (pageReadsPerSec) => ({
        sampling: { ok: true, windowMs: 1400, ts: 1 },
        machine: { cpuPct: 12, memory: { usedBytes: 1, totalBytes: 2, availBytes: 1, usedPct: 50, pageReadsPerSec } },
        webTerminal: { cpuPct: 1.2, rssBytes: 1503238553, procCount: 27, topName: 'node.exe' },
        sessions: {},
      });
      resourceView = true;
      resourceData.set('http://a', report(951));
      const busy = footprintText('http://a');
      resourceData.set('http://a', report(null));
      const unknown = footprintText('http://a');
      resourceData.set('http://a', report(0));
      const calm = footprintText('http://a');
      resourceView = false;
      resourceData.clear();
      return { busy: busy[0], busyTip: busy[1], unknown: unknown[0], calm: calm[0] };
    });
    expect(out.busy).toContain('paging 951/s');
    // A measured zero is a real answer and says so.
    expect(out.calm).toContain('paging 0/s');
    // An unmeasurable one says nothing at all rather than claiming the box is calm.
    expect(out.unknown).not.toContain('paging');
    // The label is the glance; the tooltip carries what it means.
    expect(out.busyTip).toContain('page reads');
  });
});
