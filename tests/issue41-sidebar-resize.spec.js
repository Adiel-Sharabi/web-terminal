// @ts-check
// Issue #41: the desktop sidebar resize handle was broken and undiscoverable.
//   * SSOT split — drag set inline `sidebar.style.width` while restore-on-load
//     set the `--sb-width` custom property that the `#sidebar.open` rule reads.
//   * Toggle-break — the lingering inline width outranked the base `width:0`
//     rule, so closing the sidebar after a resize couldn't collapse it.
//   * Undiscoverable — the handle was a 6px transparent hover-only strip.
// These tests pin: (a) drag changes width + the terminal re-fits and width
// lives only in --sb-width, (b) the width persists across reload, (c) the
// close->open toggle still collapses/expands AFTER a resize (the regression),
// and (d) a persistent grip affordance exists. Desktop viewport only — the
// resizer is hidden on mobile widths.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

test.use({ viewport: { width: 1280, height: 800 } });

const TOGGLE = 'button[title="Sessions panel"]';

function widthOf(page) {
  return page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
}

async function openSidebar(page) {
  await loginPage(page);
  await page.goto(BASE + '/');
  // Sidebar opens by default on load; resizer is only shown while open.
  await expect(page.locator('#sidebar')).toHaveClass(/open/, { timeout: 5000 });
  await expect(page.locator('#sidebarResizer')).toBeVisible();
  // Wait for the open transition (width 0.2s) to settle before anyone measures
  // the handle's box — a mid-animation box makes mouse.down miss the handle.
  await expect.poll(() => widthOf(page)).toBeGreaterThan(200);
}

// Wait until the sidebar width stops changing (the open/close CSS transition is
// finished) so the handle's box is measured at its final resting position.
async function settleWidth(page) {
  let prev = -1;
  await expect.poll(async () => {
    const w = await widthOf(page);
    const stable = w > 200 && Math.abs(w - prev) < 0.5;
    prev = w;
    return stable;
  }, { timeout: 3000 }).toBe(true);
}

async function dragResizer(page, dx) {
  await settleWidth(page);
  const box = await page.locator('#sidebarResizer').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 12 });
  await page.mouse.up();
}

test.describe('Issue #41: desktop sidebar resize handle', () => {
  test('dragging widens the sidebar, re-fits the terminal, and keeps width only in --sb-width', async ({ page }) => {
    // A live session keeps the terminal visible so the re-fit is observable.
    const ctx = await authCtx();
    const created = (await (await ctx.post('/api/sessions', { data: { name: 'Resize Fit' } })).json()).id;
    await ctx.dispose();
    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await openSidebar(page);
      await expect.poll(() => page.evaluate(() => (window.term && window.term.cols) || 0)).toBeGreaterThan(0);

      const before = await widthOf(page);
      const colsBefore = await page.evaluate(() => window.term.cols);

      await dragResizer(page, 150);

      const after = await widthOf(page);
      expect(after).toBeGreaterThan(before + 100);

      // Width SSOT: it lives in --sb-width, and NO inline style.width lingers.
      const inlineWidth = await page.evaluate(() => document.getElementById('sidebar').style.width);
      expect(inlineWidth).toBe('');
      const sbVar = await page.evaluate(
        () => getComputedStyle(document.getElementById('sidebar')).getPropertyValue('--sb-width').trim());
      expect(sbVar).toMatch(/^\d+px$/);

      // Terminal re-fit: wider sidebar -> fewer terminal columns.
      await expect.poll(() => page.evaluate(() => window.term.cols)).toBeLessThan(colsBefore);
    } finally {
      const cleanup = await authCtx();
      try { await cleanup.delete(`/api/sessions/${created}`); } catch {}
      await cleanup.dispose();
    }
  });

  test('resized width persists across reload via --sb-width', async ({ page }) => {
    await openSidebar(page);
    await dragResizer(page, 130);
    const resized = await widthOf(page);
    expect(resized).toBeGreaterThan(300);

    await page.reload();
    await expect(page.locator('#sidebar')).toHaveClass(/open/, { timeout: 5000 });
    // Let the re-open transition settle at the restored width before comparing.
    await expect.poll(() => widthOf(page)).toBeGreaterThan(resized - 5);
    const afterReload = await widthOf(page);
    expect(Math.abs(afterReload - resized)).toBeLessThan(5);

    // Restored through --sb-width, not an inline width.
    const inlineWidth = await page.evaluate(() => document.getElementById('sidebar').style.width);
    expect(inlineWidth).toBe('');
  });

  test('close->open toggle still collapses and expands after a resize (regression)', async ({ page }) => {
    await openSidebar(page);
    await dragResizer(page, 150);
    const resized = await widthOf(page);
    expect(resized).toBeGreaterThan(300);

    // Close: the sidebar must collapse to ~0 — the lingering inline width used
    // to keep it stuck at the resized width (the reported bug).
    await page.locator(TOGGLE).click();
    await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
    await expect.poll(() => widthOf(page)).toBeLessThan(5);

    // Reopen: it must expand back to the resized width, not the base default.
    await page.locator(TOGGLE).click();
    await expect(page.locator('#sidebar')).toHaveClass(/open/);
    await expect.poll(() => widthOf(page)).toBeGreaterThan(resized - 5);
    const reopened = await widthOf(page);
    expect(reopened).toBeLessThanOrEqual(resized + 2);
  });

  test('resize handle exposes a persistent grip affordance (not hover-only)', async ({ page }) => {
    await openSidebar(page);
    // The grip is a generated ::before with a visible size and a non-transparent
    // fill even without hover, so the handle is discoverable.
    const grip = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('sidebarResizer'), '::before');
      return { content: cs.content, width: cs.width, height: cs.height, bg: cs.backgroundColor };
    });
    expect(grip.content).not.toBe('none');
    expect(parseFloat(grip.width)).toBeGreaterThan(0);
    expect(parseFloat(grip.height)).toBeGreaterThan(0);
    expect(grip.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(grip.bg).not.toBe('transparent');
  });
});
