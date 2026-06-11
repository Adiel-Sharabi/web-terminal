// @ts-check
// Mobile UX regressions:
//  1. The long-press Copy/Paste/Select context menu is hidden on mobile —
//     it interfered with scrolling and felt unreliable.
//  2. While Claude streams output you must be able to scroll up and STAY up.
//     The pin must not release when xterm's renderer snaps scrollTop to the
//     bottom; it releases only when the user themselves scrolls to the bottom.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };
const PORTRAIT = { width: 390, height: 844 };

/** Login in a mobile (touch) browser context and land on /app. */
async function mobilePage(browser) {
  const context = await browser.newContext({
    viewport: PORTRAIT,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
  await page.goto(BASE + '/app');
  await page.waitForTimeout(500); // let term.open + pin IIFE settle
  return { page, context };
}

test.describe('Mobile long-press context menu is hidden', () => {
  test('holding on the terminal does NOT open the context menu', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('terminal');
      const t = new Touch({ identifier: 1, target: el, clientX: 120, clientY: 240 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true }));
    });
    // Past the 600ms long-press threshold.
    await page.waitForTimeout(800);
    await expect(page.locator('#ctxMenu')).toHaveCount(0);
    await context.close();
  });
});

test.describe('Mobile scroll pin holds while output streams', () => {
  // Make the xterm viewport genuinely scrollable independent of the canvas
  // renderer (which doesn't lay out reliably in headless chromium) by sizing
  // the scroll-area spacer. This lets the pin logic run against real scrollTop
  // / scrollHeight values.
  async function makeScrollable(page) {
    return page.evaluate(() => {
      const vp = document.querySelector('#terminal .xterm-viewport');
      if (!vp) return false;
      const sa = vp.querySelector('.xterm-scroll-area');
      if (sa) sa.style.height = (vp.clientHeight + 3000) + 'px';
      return (vp.scrollHeight - vp.clientHeight) > 100;
    });
  }

  test('user touch-scroll up pins; xterm snap-to-bottom does NOT release it', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    const scrollable = await makeScrollable(page);
    expect(scrollable).toBe(true);

    const res = await page.evaluate(async () => {
      const vp = document.querySelector('#terminal .xterm-viewport');
      const max = vp.scrollHeight - vp.clientHeight;
      // Precondition: a real touch-scroll up flips xterm's autoScroll off via
      // its own onScroll. Our synthetic DOM scrolls bypass xterm core, so set
      // it explicitly — otherwise a stray linefeed of shell output would route
      // through onLineFeed -> scrollToBottom -> __releaseScrollPin and release
      // the pin for an unrelated reason, masking what this test checks.
      window.__setAutoScroll(false);
      // User drags up: finger down, viewport scrolls up off the bottom.
      vp.dispatchEvent(new Event('touchstart'));
      vp.scrollTop = max - 500;
      vp.dispatchEvent(new Event('scroll'));
      const pinnedDuringTouch = window.__readScrollPin();
      vp.dispatchEvent(new Event('touchend'));
      // Wait out the 500ms momentum grace so the next scroll is treated as
      // programmatic (this is the moment the old code wrongly released).
      await new Promise(r => setTimeout(r, 650));
      // xterm's renderer snaps scrollTop to the bottom mid-stream.
      vp.scrollTop = max;
      vp.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 60));
      return {
        max,
        pinnedDuringTouch,
        pinAfterSnap: window.__readScrollPin(),
        scrollTopAfter: vp.scrollTop,
      };
    });

    // Pinned to where the user left off, and still pinned after the snap.
    expect(res.pinnedDuringTouch).toBeGreaterThanOrEqual(0);
    expect(res.pinAfterSnap).toBeGreaterThanOrEqual(0);
    // The programmatic snap to the bottom was reverted to the pinned position.
    expect(res.scrollTopAfter).toBeLessThan(res.max - 100);
    await context.close();
  });

  test('xterm snap-to-bottom DURING the momentum grace does NOT release the pin', async ({ browser }) => {
    // The gap the "holds" test above misses: it waits out the 500ms grace so the
    // snap is unambiguously programmatic. But while Claude streams, the snap
    // lands *inside* the grace window — finger lifted <500ms ago — which is when
    // the old code (gating release on inTouchScroll()) wrongly released the pin
    // and yanked a scrolled-up reader to the bottom on every chunk.
    const { page, context } = await mobilePage(browser);
    expect(await makeScrollable(page)).toBe(true);

    const res = await page.evaluate(async () => {
      const vp = document.querySelector('#terminal .xterm-viewport');
      const max = vp.scrollHeight - vp.clientHeight;
      window.__setAutoScroll(false);
      // User drags up and lifts their finger.
      vp.dispatchEvent(new Event('touchstart'));
      vp.scrollTop = max - 500;
      vp.dispatchEvent(new Event('scroll'));
      vp.dispatchEvent(new Event('touchend'));
      // Renderer snaps to the bottom 100ms later — still inside the 500ms grace.
      await new Promise(r => setTimeout(r, 100));
      vp.scrollTop = max;
      vp.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 60));
      return { max, pinAfterSnap: window.__readScrollPin(), scrollTopAfter: vp.scrollTop };
    });

    // Pin survived the in-grace snap and the viewport was restored upward.
    expect(res.pinAfterSnap).toBeGreaterThanOrEqual(0);
    expect(res.scrollTopAfter).toBeLessThan(res.max - 100);
    await context.close();
  });

  test('user scrolling all the way to the bottom releases the pin', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    expect(await makeScrollable(page)).toBe(true);

    const pin = await page.evaluate(async () => {
      const vp = document.querySelector('#terminal .xterm-viewport');
      const max = vp.scrollHeight - vp.clientHeight;
      window.__setAutoScroll(false);
      // Pin part-way up first.
      vp.dispatchEvent(new Event('touchstart'));
      vp.scrollTop = max - 500;
      vp.dispatchEvent(new Event('scroll'));
      // Then the user themselves drags back down to the bottom (still touching).
      vp.scrollTop = max;
      vp.dispatchEvent(new Event('scroll'));
      vp.dispatchEvent(new Event('touchend'));
      await new Promise(r => setTimeout(r, 30));
      return window.__readScrollPin();
    });
    // -1 == auto-follow resumes.
    expect(pin).toBe(-1);
    await context.close();
  });
});

test.describe('xterm auto-replies do not hijack scroll', () => {
  // Root cause of "can't scroll up while Claude is working": Claude's TUI
  // requests cursor-position / device-attribute reports constantly. xterm
  // answers them through onData -> sendInput, which used to force autoScroll
  // back on and release the pin, snapping a scrolled-up reader to the bottom.
  test('a cursor-position auto-reply leaves autoScroll OFF', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    const result = await page.evaluate(async () => {
      // Reader has scrolled up: autoScroll is off.
      window.__setAutoScroll(false);
      // Writing a DSR (Device Status Report) query makes xterm emit a
      // cursor-position reply via onData — exactly what Claude triggers.
      window.term.write('\x1b[6n');
      await new Promise(r => setTimeout(r, 80));
      return window.__readAutoScroll();
    });
    expect(result).toBe(false);
    await context.close();
  });

  test('genuine user input DOES follow output to the bottom', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    const result = await page.evaluate(async () => {
      window.__setAutoScroll(false);
      // Positive control: an explicit user-initiated send re-arms auto-follow.
      window.sendInput && window.sendInput('x', true);
      await new Promise(r => setTimeout(r, 20));
      return window.__readAutoScroll();
    });
    expect(result).toBe(true);
    await context.close();
  });
});
