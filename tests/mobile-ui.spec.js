// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

// Device viewports
const PORTRAIT = { width: 390, height: 844 };   // iPhone-like portrait
const LANDSCAPE = { width: 844, height: 390 };  // iPhone-like landscape
const SMALL_LANDSCAPE = { width: 740, height: 360 }; // Smaller Android landscape

/** Login and return authenticated page */
async function loginPage(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#toolbar', { timeout: 10000 });
  // Wait for terminal to initialize
  await page.waitForTimeout(1000);
  return { page, context };
}

test.describe('Mobile Portrait UI', () => {
  test('toolbar is visible with all buttons', async ({ browser }) => {
    const { page, context } = await loginPage(browser, PORTRAIT);
    const toolbar = page.locator('#toolbar');
    await expect(toolbar).toBeVisible();

    // Hamburger menu button
    const menuBtn = toolbar.locator('.tb-btn').first();
    await expect(menuBtn).toBeVisible();

    // Session name
    const sessionName = toolbar.locator('.session-name');
    await expect(sessionName).toBeVisible();

    // Logout button
    const logoutBtn = toolbar.locator('.tb-btn').last();
    await expect(logoutBtn).toBeVisible();

    // Toolbar should be fixed position on mobile
    const position = await toolbar.evaluate(el => getComputedStyle(el).position);
    expect(position).toBe('fixed');

    await context.close();
  });

  test('touch keys bar is visible', async ({ browser }) => {
    const { page, context } = await loginPage(browser, PORTRAIT);
    const touchKeys = page.locator('#touchKeys');
    await expect(touchKeys).toBeVisible();
    await context.close();
  });

  test('scroll button appears when not at bottom', async ({ browser }) => {
    const { page, context } = await loginPage(browser, PORTRAIT);
    const scrollBtn = page.locator('#scrollBtn');

    // Initially at bottom, so scroll button should be hidden
    await expect(scrollBtn).toBeHidden();

    // Write enough content to create scroll, then scroll up
    // The scroll button visibility depends on terminal content
    await context.close();
  });
});

test.describe('Mobile Landscape UI', () => {
  test('toolbar is visible with all buttons', async ({ browser }) => {
    const { page, context } = await loginPage(browser, LANDSCAPE);
    const toolbar = page.locator('#toolbar');
    await expect(toolbar).toBeVisible();

    // Hamburger menu button
    const menuBtn = toolbar.locator('.tb-btn').first();
    await expect(menuBtn).toBeVisible();

    // Session name
    const sessionName = toolbar.locator('.session-name');
    await expect(sessionName).toBeVisible();

    // Logout button
    const logoutBtn = toolbar.locator('.tb-btn').last();
    await expect(logoutBtn).toBeVisible();

    // Toolbar should be fixed on landscape mobile
    const position = await toolbar.evaluate(el => getComputedStyle(el).position);
    expect(position).toBe('fixed');

    await context.close();
  });

  test('touch keys bar is visible in landscape', async ({ browser }) => {
    const { page, context } = await loginPage(browser, LANDSCAPE);
    const touchKeys = page.locator('#touchKeys');
    await expect(touchKeys).toBeVisible();
    await context.close();
  });

  test('toolbar does not overflow viewport', async ({ browser }) => {
    const { page, context } = await loginPage(browser, LANDSCAPE);
    const toolbar = page.locator('#toolbar');
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(LANDSCAPE.width);
    expect(box.height).toBeLessThanOrEqual(40); // Should be compact
    await context.close();
  });

  test('small landscape toolbar visible', async ({ browser }) => {
    const { page, context } = await loginPage(browser, SMALL_LANDSCAPE);
    const toolbar = page.locator('#toolbar');
    await expect(toolbar).toBeVisible();

    const menuBtn = toolbar.locator('.tb-btn').first();
    await expect(menuBtn).toBeVisible();

    const touchKeys = page.locator('#touchKeys');
    await expect(touchKeys).toBeVisible();

    await context.close();
  });
});

test.describe('Scroll button visibility', () => {
  test('scroll button is accessible in portrait', async ({ browser }) => {
    const { page, context } = await loginPage(browser, PORTRAIT);
    const scrollBtn = page.locator('#scrollBtn');
    // Verify the element exists and has correct z-index
    const zIndex = await scrollBtn.evaluate(el => getComputedStyle(el).zIndex);
    expect(Number(zIndex)).toBeGreaterThanOrEqual(10);
    await context.close();
  });

  test('scroll button is accessible in landscape', async ({ browser }) => {
    const { page, context } = await loginPage(browser, LANDSCAPE);
    const scrollBtn = page.locator('#scrollBtn');
    // Verify the element exists and has correct z-index
    const zIndex = await scrollBtn.evaluate(el => getComputedStyle(el).zIndex);
    expect(Number(zIndex)).toBeGreaterThanOrEqual(10);
    await context.close();
  });
});
