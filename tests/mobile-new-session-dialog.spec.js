// @ts-check
// Issue #22: new-session dialog is not mobile-friendly.
// On mobile, the "Create Session" and "Cancel" buttons shared one flex row where
// Create Session was width:100% and Cancel was pushed off-screen. Also the inputs
// used 12px font which iOS zooms into on focus, making the dialog jumpy.
//
// Strategy: we don't rely on click emulation to open the sidebar/form because the
// app's init() script has auto-session-restore behavior that can re-navigate and
// toggle the sidebar unpredictably under headless chromium. Instead we force the
// DOM into the state we want and verify the layout.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.use({ viewport: { width: 393, height: 851 } });

async function openSidebarAndForm(page) {
  // Pre-page-load: tell init() the sidebar is already user-closed so it
  // skips its end-of-init toggleSidebar() call, which otherwise races with
  // our forced-open state below and (on mobile) leaves the sidebar at
  // width:0 — making the form measure wrong (scrollWidth>>clientWidth).
  await page.addInitScript(() => {
    try { sessionStorage.setItem('sidebarOpen', '0'); } catch {}
    try { localStorage.removeItem('sidebarWidth'); } catch {}
  });
  await loginPage(page);
  await page.goto(BASE + '/app');
  // Wait for init() to finish (clusterServers is the last thing it sets
  // before its skipped toggleSidebar). We assert on it explicitly so the
  // test can't run measurements while init is still mutating the DOM.
  await page.waitForFunction(
    () => typeof clusterServers !== 'undefined' && Array.isArray(clusterServers),
    null,
    { timeout: 10000 }
  );
  // Force the sidebar open and the form visible — now init is done so it
  // won't undo this.
  await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    if (sb) {
      sb.style.removeProperty('--sb-width');
      sb.style.removeProperty('width');
      sb.classList.add('open');
    }
    const form = document.getElementById('newSessionForm');
    if (form) form.classList.add('show');
  });
  // Brief settle for layout.
  await page.waitForTimeout(100);
}

test.describe('Issue #22: mobile new-session dialog', () => {
  test('Cancel button stays fully inside the sidebar', async ({ page }) => {
    await openSidebarAndForm(page);
    const sidebar = page.locator('#sidebar');
    const cancelBtn = page.locator('#newSessionForm button:has-text("Cancel")');
    await expect(cancelBtn).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    const cancelBox = await cancelBtn.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(cancelBox).not.toBeNull();
    if (!sidebarBox || !cancelBox) return;
    const cancelRight = cancelBox.x + cancelBox.width;
    const sidebarRight = sidebarBox.x + sidebarBox.width;
    expect(cancelRight).toBeLessThanOrEqual(sidebarRight + 1);
  });

  test('inputs use >=16px font to avoid iOS zoom on focus', async ({ page }) => {
    await openSidebarAndForm(page);
    const fontSize = await page.locator('#newName').evaluate(el =>
      parseFloat(getComputedStyle(el).fontSize)
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test('form fits: no horizontal overflow inside the sidebar', async ({ page }) => {
    await openSidebarAndForm(page);
    const overflow = await page.evaluate(() => {
      const form = document.getElementById('newSessionForm');
      if (!form) return -1;
      return form.scrollWidth - form.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('Create Session button is a comfortable touch target', async ({ page }) => {
    await openSidebarAndForm(page);
    const btn = page.locator('#newSessionForm button:has-text("Create Session")');
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.height).toBeGreaterThanOrEqual(40);
  });
});
