// @ts-check
// Web side of #24 / #2: opening a session in the browser must acknowledge its
// alert everywhere — app.html's switchSession calls the attention/clear endpoint
// (which fans out an FCM 'clear' that dismisses the phone push). And an inbound
// 'clear' frame must never render a browser toast (a latent #24 bug: the clear
// frame used to fall through showNotification and pop an "undefined" toast).
//
// app.html is not module-wrapped (inline onclick handlers call its functions),
// so its top-level functions/consts are reachable by bare name in page.evaluate.
const { test, expect } = require('@playwright/test');
const { loginPage } = require('./test-helpers');

test.describe('web attention-clear on open (#24 / #2)', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['notifications']);
    // Record every browser Notification the page constructs, and report the
    // permission as granted so showNotification's render branch is exercised.
    await context.addInitScript(() => {
      // @ts-ignore
      window.__notifs = [];
      class FakeNotification {
        constructor(title, opts) {
          // @ts-ignore
          window.__notifs.push({ title, body: opts && opts.body });
          this.onclick = null;
          this.onclose = null;
        }
        close() { if (this.onclose) { try { this.onclose(); } catch (e) {} } }
        static requestPermission() { return Promise.resolve('granted'); }
      }
      // @ts-ignore
      FakeNotification.permission = 'granted';
      Object.defineProperty(window, 'Notification', {
        configurable: true, writable: true, value: FakeNotification,
      });
    });
  });

  test('an alert frame flags attention; opening fires the clear POST and de-flags', async ({ page }) => {
    await loginPage(page);

    // A real inbound approval frame (as the notify socket would deliver).
    await page.evaluate(() => showNotification(
      { type: 'approval_needed', sessionId: 'webtest-1', session: 'My Sess', message: 'needs approval' }));
    expect(await page.evaluate(() => attentionSessions.has('webtest-1'))).toBe(true);
    expect(await page.evaluate(() => sessionHasAlert('webtest-1'))).toBe(true);

    // Opening the session must POST the cross-device clear AND drop the flag.
    const [req] = await Promise.all([
      page.waitForRequest((r) =>
        r.url().includes('/api/sessions/webtest-1/attention/clear') && r.method() === 'POST'),
      page.evaluate(() => maybeClearAttention('webtest-1', null)),
    ]);
    expect(req).toBeTruthy();
    expect(await page.evaluate(() => attentionSessions.has('webtest-1'))).toBe(false);
  });

  test('switchSession fires the clear POST when the target has a live alert', async ({ page }) => {
    await loginPage(page);
    await page.evaluate(() => showNotification(
      { type: 'input_needed', sessionId: 'webtest-sw', session: 'S', message: 'input' }));

    const req = await Promise.all([
      page.waitForRequest((r) =>
        r.url().includes('/api/sessions/webtest-sw/attention/clear') && r.method() === 'POST'),
      // switchSession opens the session; it bails early on ws for an unknown id,
      // but maybeClearAttention runs first regardless.
      page.evaluate(() => { try { switchSession('webtest-sw', null); } catch (e) {} }),
    ]).then(([r]) => r);
    expect(req).toBeTruthy();
  });

  test("a plain switch (no alert) does NOT fire a clear POST", async ({ page }) => {
    await loginPage(page);
    let posted = false;
    page.on('request', (r) => {
      if (r.url().includes('/attention/clear') && r.method() === 'POST') posted = true;
    });
    // No alert recorded for this id and no sidebar dot → gate must be false.
    expect(await page.evaluate(() => sessionHasAlert('webtest-none'))).toBe(false);
    await page.evaluate(() => maybeClearAttention('webtest-none', null));
    await page.waitForTimeout(200);
    expect(posted).toBe(false);
  });

  test("a 'clear' frame never pops a toast and is not tracked (latent #24 bug)", async ({ page }) => {
    await loginPage(page);
    const before = await page.evaluate(() => window.__notifs.length);
    // Pre-fix this rendered a Notification with an undefined title/body.
    await page.evaluate(() => showNotification({ type: 'clear', sessionId: 'webtest-2' }));
    expect(await page.evaluate(() => window.__notifs.length)).toBe(before);
    expect(await page.evaluate(() => pendingAlerts.has('webtest-2'))).toBe(false);
    expect(await page.evaluate(() => attentionSessions.has('webtest-2'))).toBe(false);
  });

  test('handleAttentionCleared drops the alert state and closes the toast', async ({ page }) => {
    await loginPage(page);
    await page.evaluate(() => showNotification(
      { type: 'approval_needed', sessionId: 'webtest-3', session: 'S3', message: 'm' }));
    expect(await page.evaluate(() => attentionSessions.has('webtest-3'))).toBe(true);

    await page.evaluate(() => handleAttentionCleared('webtest-3'));
    expect(await page.evaluate(() => attentionSessions.has('webtest-3'))).toBe(false);
    expect(await page.evaluate(() => pendingAlerts.has('webtest-3'))).toBe(false);
  });
});
