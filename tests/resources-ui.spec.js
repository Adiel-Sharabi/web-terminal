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
