// @ts-check
// Faithful reproduction of "can't scroll up while Claude streams" on mobile.
// Unlike mobile-scroll-pin.spec.js (which fakes scrollTop + dispatches synthetic
// scroll events), this drives the REAL xterm DOM renderer: write real rows so the
// viewport is genuinely scrollable, scroll up, then stream more rows and SAMPLE
// the viewport's scrollTop trajectory every frame to see if it snaps back down.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };
const PORTRAIT = { width: 390, height: 844 };

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
  await page.waitForTimeout(600);
  return { page, context };
}

test.describe('REPRO: scroll up while streaming (real renderer)', () => {
  test('diagnostic — is the viewport really scrollable with DOM-rendered rows?', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    const probe = await page.evaluate(async () => {
      const term = window.term;
      for (let i = 0; i < 400; i++) term.write('line ' + i + ' xxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n');
      await new Promise(r => setTimeout(r, 300));
      const vp = document.querySelector('#terminal .xterm-viewport');
      const buf = term.buffer.active;
      return {
        scrollHeight: vp.scrollHeight,
        clientHeight: vp.clientHeight,
        scrollable: vp.scrollHeight - vp.clientHeight,
        scrollTop: vp.scrollTop,
        baseY: buf.baseY,
        viewportY: buf.viewportY,
        rows: term.rows,
      };
    });
    console.log('PROBE ' + JSON.stringify(probe));
    await context.close();
    // No hard assertion — this is a diagnostic to learn the headless layout.
    expect(probe.rows).toBeGreaterThan(0);
  });

  test('stream while scrolled up — sample scrollTop trajectory', async ({ browser }) => {
    const { page, context } = await mobilePage(browser);
    const result = await page.evaluate(async () => {
      const term = window.term;
      const vp = document.querySelector('#terminal .xterm-viewport');

      // 1) Lay down real scrollback.
      for (let i = 0; i < 400; i++) term.write('hist ' + i + ' ----------------------------\r\n');
      await new Promise(r => setTimeout(r, 250));
      const max0 = vp.scrollHeight - vp.clientHeight;
      if (max0 < 100) return { error: 'not-scrollable', max0 };

      // 2) Simulate a real finger drag UP: finger down, viewport scrolls to a
      //    mid position, real scroll event, then lift. This is the genuine path:
      //    setting vp.scrollTop drives xterm's own Viewport listener -> ydisp ->
      //    term.onScroll (sets autoScroll) AND our pin handler (sets pinned).
      const target = Math.round(max0 * 0.4);
      vp.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      // global gesture-window listeners key off these too:
      document.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      vp.scrollTop = target;
      vp.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
      vp.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
      await new Promise(r => setTimeout(r, 20));
      vp.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
      document.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));

      const afterScrollUp = {
        scrollTop: vp.scrollTop,
        autoScroll: window.__readAutoScroll(),
        pinned: window.__readScrollPin(),
        max: vp.scrollHeight - vp.clientHeight,
      };

      // Spy on term.scrollToBottom: while the user is scrolled up, onLineFeed
      // must NOT call it. Any calls here are the 60Hz snap war that makes a real
      // device jumpy (even though headless reverts it invisibly).
      let scrollToBottomCalls = 0;
      const origStB = term.scrollToBottom.bind(term);
      term.scrollToBottom = function () { scrollToBottomCalls++; return origStB(); };

      // 3) Stream output for ~900ms while sampling scrollTop every frame.
      let streaming = true;
      let n = 0;
      const streamTimer = setInterval(() => {
        if (!streaming) return;
        term.write('stream ' + (n++) + ' ##############################\r\n');
      }, 16);

      const samples = [];
      const start = performance.now();
      await new Promise((resolve) => {
        function sample() {
          const max = vp.scrollHeight - vp.clientHeight;
          samples.push({ t: Math.round(performance.now() - start), top: vp.scrollTop, max });
          if (performance.now() - start > 900) return resolve();
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      streaming = false;
      clearInterval(streamTimer);

      // 4) Analyse: how close did scrollTop get to the (growing) bottom?
      // A "snap to bottom" = scrollTop within 80px of max on that frame.
      let snapped = 0;
      let maxTop = 0, maxGapBelowBottom = Infinity;
      for (const s of samples) {
        if (s.top >= s.max - 80) snapped++;
        maxTop = Math.max(maxTop, s.top);
        maxGapBelowBottom = Math.min(maxGapBelowBottom, s.max - s.top);
      }
      return {
        afterScrollUp,
        finalMax: vp.scrollHeight - vp.clientHeight,
        finalAutoScroll: window.__readAutoScroll(),
        finalPinned: window.__readScrollPin(),
        scrollToBottomCalls,
        sampleCount: samples.length,
        snappedFrames: snapped,
        snappedPct: Math.round((snapped / samples.length) * 100),
        maxTop,
        minGapBelowBottom: maxGapBelowBottom,
        firstSamples: samples.slice(0, 6),
        lastSamples: samples.slice(-6),
      };
    });
    console.log('STREAM ' + JSON.stringify(result, null, 2));
    await context.close();

    expect(result.error).toBeUndefined();
    // 1) Scrolling up must kill auto-follow SYNCHRONOUSLY (the root-cause fix),
    //    not on some later async xterm onScroll frame.
    expect(result.afterScrollUp.autoScroll).toBe(false);
    expect(result.afterScrollUp.pinned).toBeGreaterThanOrEqual(0);
    // 2) The snap war is gone: onLineFeed never auto-scrolls to the bottom while
    //    the reader is pinned up the page. (Allow 1 transient before the
    //    synchronous flip lands, in case of init timing.)
    expect(result.scrollToBottomCalls).toBeLessThanOrEqual(1);
    // 3) The view actually stays put through the whole stream.
    expect(result.snappedPct).toBeLessThan(10);
    expect(result.finalPinned).toBeGreaterThanOrEqual(0);
  });
});
