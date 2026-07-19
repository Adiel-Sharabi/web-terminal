// @ts-check
// #70 Phase 1, web client: the read-aloud button.
//
// The client is deliberately thin — it asks the server for an already-filtered
// utterance and speaks it. So what needs pinning here is not the filtering (that
// is speech.spec.js) but the CONTRACT with the page: the button exists, it calls
// the right endpoint for the active session, it speaks exactly the text the
// server returned, and an empty utterance produces silence rather than a fallback.
//
// window.speechSynthesis is stubbed: real synthesis is an OS service with no
// observable result in a headless browser, and the thing worth asserting is what
// we hand it, not whether the OS made a sound.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

// Replace speechSynthesis before app.html runs, so its SPEAK_SUPPORTED probe sees
// the stub and records every utterance for assertion.
//
// MUST use defineProperty, not assignment: `window.speechSynthesis` is a
// getter-only own property, so `window.speechSynthesis = {...}` fails SILENTLY in
// sloppy mode and leaves the real OS-backed object in place — which produces a
// test that appears to pass while asserting nothing (headless synthesis records
// no utterance and makes no sound).
async function stubSpeech(page) {
  await page.addInitScript(() => {
    const spoken = [];
    window.__spoken = spoken;
    let speaking = false;
    const stub = {
      get speaking() { return speaking; },
      pending: false,
      speak(u) { speaking = true; spoken.push(u.text); setTimeout(() => { speaking = false; if (u.onend) u.onend(); }, 10); },
      cancel() { speaking = false; },
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => stub });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true, writable: true,
      value: function (text) { this.text = text; },
    });
  });
}

test.describe('Read-aloud button (#70)', () => {
  test('the button is visible when the browser supports speech', async ({ page }) => {
    await stubSpeech(page);
    await loginPage(page);
    await page.goto(BASE + '/');
    await expect(page.locator('#speakBtn')).toBeVisible();
  });

  test('the button stays hidden when the browser has no speech synthesis', async ({ page }) => {
    // A button that silently does nothing is worse than no button.
    await page.addInitScript(() => {
      // @ts-ignore
      delete window.speechSynthesis;
      // @ts-ignore
      delete window.SpeechSynthesisUtterance;
    });
    await loginPage(page);
    await page.goto(BASE + '/');
    await expect(page.locator('#speakBtn')).toBeHidden();
  });

  test('speaks exactly the text the server returned', async ({ page }) => {
    await stubSpeech(page);
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Speak One' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      // Serve a known utterance so the assertion is about plumbing, not parsing.
      await page.route('**/api/sessions/*/speech', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'The build passed.', ts: null, agent: 'claude' }) }));
      await page.goto(BASE + '/');
      await page.locator(`.sb-item[data-session-id="${id}"]`).click();
      await page.locator('#speakBtn').click();
      await expect.poll(() => page.evaluate(() => window.__spoken)).toEqual(['The build passed.']);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('an empty utterance speaks NOTHING and does not fall back', async ({ page }) => {
    // The whole point of the server filter: a code-only answer must be silence.
    await stubSpeech(page);
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Speak Empty' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.route('**/api/sessions/*/speech', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '', ts: null, agent: 'claude' }) }));
      await page.goto(BASE + '/');
      await page.locator(`.sb-item[data-session-id="${id}"]`).click();
      await page.locator('#speakBtn').click();
      // Give it room to have wrongly spoken something.
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.__spoken)).toEqual([]);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });

  test('pressing again while speaking cancels instead of queueing', async ({ page }) => {
    await stubSpeech(page);
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'Speak Stop' } })).json()).id;
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    try {
      await page.route('**/api/sessions/*/speech', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'A long answer.', ts: null, agent: 'claude' }) }));
      await page.goto(BASE + '/');
      await page.locator(`.sb-item[data-session-id="${id}"]`).click();
      // Hold the utterance open so the second press lands mid-speech: record it,
      // but never let `speaking` fall back to false.
      await page.evaluate(() => {
        const held = {
          get speaking() { return window.__spoken.length > 0; },
          pending: false,
          speak(u) { window.__spoken.push(u.text); },
          cancel() {},
        };
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => held });
      });
      await page.locator('#speakBtn').click();
      await expect.poll(() => page.evaluate(() => window.__spoken.length)).toBe(1);
      await page.locator('#speakBtn').click();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.__spoken.length)).toBe(1); // cancelled, not spoken twice
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });
});
