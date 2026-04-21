// @ts-check
// Issue #27: in landscape on a phone, the top touch-key row was hidden (the
// mobile layout was gated by max-width only). Also a backslash key was missing
// even though Windows paths use it.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Issue #27: touch keys visible in landscape + backslash present', () => {
  test('backslash button exists in the touch-keys row', async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/app');
    // Desktop viewport is fine here — we just need the element to exist in the DOM.
    const backslash = page.locator('#touchKeys button[data-key="\\\\"]');
    await expect(backslash).toHaveCount(1);
    const text = await backslash.textContent();
    expect(text).toBe('\\');
  });

  test('touch-keys row is visible in portrait phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 });
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(200);
    const display = await page.locator('#touchKeys').evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('flex');
  });

  test('touch-keys row is visible in landscape phone viewport', async ({ page }) => {
    // Typical landscape phone: width > 600 (so the old max-width breakpoint
    // wouldn't trigger) but height <= 500.
    await page.setViewportSize({ width: 851, height: 393 });
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(200);
    const display = await page.locator('#touchKeys').evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('flex');
  });

  test('touch-keys row is hidden on a normal desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(200);
    const display = await page.locator('#touchKeys').evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('none');
  });
});
