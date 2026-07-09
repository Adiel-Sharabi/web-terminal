const { test, expect } = require('@playwright/test');
const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };
test('tracer: off by default, latches on, off-switch clears it; app boots', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
  const active = () => page.evaluate(() => !!window.__scrollTracerActive);
  const booted = () => page.evaluate(() => !!window.term);
  // off by default
  await page.goto(BASE + '/app'); await page.waitForTimeout(450);
  expect(await booted()).toBe(true); expect(await active()).toBe(false);
  // latch on via query, persists to localStorage
  await page.goto(BASE + '/app?scrolldbg=1'); await page.waitForTimeout(650);
  expect(await booted()).toBe(true); expect(await active()).toBe(true);
  // persists on a plain reload (no query) because localStorage latched it
  await page.goto(BASE + '/app'); await page.waitForTimeout(650);
  expect(await active()).toBe(true);
  // off-switch
  await page.goto(BASE + '/app?scrolldbg=0'); await page.waitForTimeout(450);
  expect(await active()).toBe(false);
  await ctx.close();
});
