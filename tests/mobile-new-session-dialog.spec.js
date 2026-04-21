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
  await loginPage(page);
  await page.goto(BASE + '/app');
  // Force the sidebar open and the form visible, regardless of init()'s state.
  // Also make sure no saved sidebar width dwarfs the mobile default.
  await page.evaluate(() => {
    try { localStorage.removeItem('sidebarWidth'); } catch {}
    const sb = document.getElementById('sidebar');
    if (sb) {
      sb.style.removeProperty('--sb-width');
      sb.style.removeProperty('width');
      sb.classList.add('open');
    }
    const form = document.getElementById('newSessionForm');
    if (form) form.classList.add('show');
  });
  // Let the transition settle.
  await page.waitForTimeout(250);
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
