// @ts-check
// Tests for the compose-input bar.
//
// On mobile the terminal's raw per-keystroke passthrough is replaced by a
// compose bar: the user types into a <textarea>, then Send flushes the whole
// buffer. A '/'-prefixed line is the exception — it streams to the terminal
// live (prefix-diff) so Claude's own slash menu narrows as you type.
// A toggle in the #touchKeys row switches to raw passthrough for TUIs.
//
// #55 §1 — the Enter contract is chosen by PLATFORM, never by lens:
//
//   desktop   Enter submits     Ctrl+Enter newline    Send submits
//   mobile    Enter NEWLINES    (n/a)                 Send submits
//
// A soft keyboard's Enter is how a person breaks a line, and it is the key Android's IME
// commits as literal "\n" TEXT rather than as a key event — so Send is the only submit that
// survives there. Note the bar's VISIBILITY is keyed on `isMobile` (which ORs in a viewport
// narrower than 600px), while what Enter MEANS is keyed on the platform — so a narrow
// DESKTOP window shows the bar and still submits on Enter. Both are exercised below.
//
// These tests drive the real DOM (the compose <textarea>, the Send button,
// the touch-toolbar buttons) and verify what actually reaches the session
// WebSocket via a hooked WebSocket.send.
const { test, expect, devices } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

const pixel5 = devices['Pixel 5'];

/** Init script: capture session-data WS frames and start with the sidebar
 *  closed. The app auto-opens the sidebar on load; on mobile it is a
 *  full-width drawer that overlays the compose bar, so leaving it open blocks
 *  taps on compose UI. Real users close the drawer after picking a session.
 *  Unlike the swiftkey hook this KEEPS ESC-prefixed frames, because
 *  bracketed-paste sends begin with ESC. */
function wsHookScript() {
  return () => {
    try { sessionStorage.setItem('sidebarOpen', '0'); } catch (e) {}
    window.__wtSends = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const url = (this.url || '').replace(/\?.*$/, '');
        if (typeof data === 'string'
            && !data.startsWith('{')
            && data !== 'ping'
            && /\/ws\/[^/]+$/.test(url)) {
          window.__wtSends.push(data);
        }
      } catch (e) {}
      return origSend.call(this, data);
    };
  };
}

async function waitForAppReady(page, timeoutMs = 15000) {
  await page.waitForSelector('.xterm-screen', { state: 'visible', timeout: timeoutMs });
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: timeoutMs });
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s && (s.textContent || '').toLowerCase().includes('connected');
  }, { timeout: timeoutMs }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__wtSends = []; });
}

async function resetSends(page) {
  await page.evaluate(() => { window.__wtSends = []; });
}

async function drainSends(page, waitMs = 350) {
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const out = [...window.__wtSends];
    window.__wtSends = [];
    return out;
  });
}

test.describe('Mobile compose input bar', () => {
  let apiCtx;
  let sessionId;

  test.beforeAll(async () => {
    apiCtx = await authCtx();
    const res = await apiCtx.post('/api/sessions', { data: { name: 'compose-test' } });
    expect(res.status()).toBe(200);
    sessionId = (await res.json()).id;
  });

  test.afterAll(async () => {
    if (sessionId) { try { await apiCtx.delete(`/api/sessions/${sessionId}`); } catch {} }
    if (apiCtx) await apiCtx.dispose();
  });

  async function openMobile(browser) {
    const context = await browser.newContext({ ...pixel5 });
    await context.addInitScript(wsHookScript());
    const page = await context.newPage();
    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForAppReady(page);
    // Compose mode is the mobile default — the bar must be visible.
    await expect(page.locator('#composeBar')).toBeVisible();
    return { context, page };
  }

  async function openDesktop(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(wsHookScript());
    const page = await context.newPage();
    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForAppReady(page);
    return { context, page };
  }

  /** A DESKTOP browser (hardware keyboard) in a window narrow enough to show the compose
   *  bar — `isMobile` ORs in innerWidth < 600. This is the only configuration in which the
   *  web client offers a compose bar to a hardware keyboard, so it is where #55 §1's desktop
   *  row (Enter submits / Ctrl+Enter newlines) is actually reachable. */
  async function openNarrowDesktop(browser) {
    const context = await browser.newContext({ viewport: { width: 520, height: 900 } });
    await context.addInitScript(wsHookScript());
    const page = await context.newPage();
    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForAppReady(page);
    await expect(page.locator('#composeBar')).toBeVisible();
    return { context, page };
  }

  test('compose bar is visible on mobile, hidden on desktop', async ({ browser }) => {
    const m = await openMobile(browser);
    await expect(m.page.locator('#composeBar')).toBeVisible();
    await expect(m.page.locator('#composeInput')).toBeVisible();
    await m.context.close();

    const d = await openDesktop(browser);
    await expect(d.page.locator('#composeBar')).toBeHidden();
    await d.context.close();
  });

  test('typing into the buffer sends nothing until Send is tapped', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').fill('hello world');
    // Nothing should have hit the WS yet — the whole point of compose mode.
    const idle = await drainSends(page);
    expect(idle.join('')).toBe('');

    await page.locator('#composeSendBtn').tap();
    const sends = await drainSends(page);
    expect(sends.join('')).toBe('hello world\r');
    // Buffer cleared after send.
    await expect(page.locator('#composeInput')).toHaveValue('');
    await context.close();
  });

  test('#55 §1 mobile: Enter inserts a NEWLINE and sends nothing — Send is the only submit', async ({ browser }) => {
    // The soft keyboard's Enter is how you break a line. It is also the key Android's IME
    // commits as literal "\n" text rather than as a key event, so a submit bound to it is
    // unreliable by construction — Send is the contract.
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').fill('ls -la');
    await page.locator('#composeInput').press('Enter');

    expect((await drainSends(page)).join('')).toBe('');
    await expect(page.locator('#composeInput')).toHaveValue('ls -la\n');

    // ...and Send still submits it, with §4's trailing newline stripped: one line, so a
    // plain text+CR, NOT a bracketed paste.
    await page.locator('#composeSendBtn').tap();
    expect((await drainSends(page)).join('')).toBe('ls -la\r');
    await context.close();
  });

  test('#55 §1 desktop: Enter submits, Ctrl+Enter inserts a newline', async ({ browser }) => {
    // A desktop browser in a narrow window: the bar is shown (isMobile ORs in innerWidth <
    // 600) but the keyboard is hardware, so the desktop half of the contract applies.
    const { context, page } = await openNarrowDesktop(browser);
    await resetSends(page);

    await page.locator('#composeInput').fill('line1');
    await page.locator('#composeInput').press('Control+Enter');
    await page.locator('#composeInput').pressSequentially('line2');
    expect((await drainSends(page)).join('')).toBe('');           // newline sends nothing
    await expect(page.locator('#composeInput')).toHaveValue('line1\nline2');

    await page.locator('#composeInput').press('Enter');           // ...and Enter submits it
    const ESC = String.fromCharCode(0x1b);
    expect((await drainSends(page)).join('')).toBe(`${ESC}[200~line1\rline2${ESC}[201~\r`);
    await expect(page.locator('#composeInput')).toHaveValue('');
    await context.close();
  });

  test('#55 §4: a trailing newline is stripped — one line stays a plain text+CR', async ({ browser }) => {
    // Without the strip, a buffer ending in a newline still "contains \n" and would ship as
    // a bracketed paste carrying an extra empty line into the agent's prompt box.
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').fill('hello\n');
    await page.locator('#composeSendBtn').tap();
    expect((await drainSends(page)).join('')).toBe('hello\r');
    await context.close();
  });

  test('Shift+Enter inserts a newline and does not send', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').focus();
    await page.locator('#composeInput').pressSequentially('line1');
    await page.locator('#composeInput').press('Shift+Enter');
    await page.locator('#composeInput').pressSequentially('line2');
    const idle = await drainSends(page);
    expect(idle.join('')).toBe('');
    await expect(page.locator('#composeInput')).toHaveValue('line1\nline2');
    await context.close();
  });

  test('multi-line buffer is sent as a bracketed paste', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').fill('line1\nline2');
    await page.locator('#composeSendBtn').tap();
    const sends = await drainSends(page);
    const joined = sends.join('');
    expect(joined.startsWith('\x1b[200~')).toBe(true);
    expect(joined.endsWith('\x1b[201~\r')).toBe(true);
    // Newlines inside the buffer become CR.
    expect(joined).toBe('\x1b[200~line1\rline2\x1b[201~\r');
    await context.close();
  });

  test('bracketed-paste markers typed into the buffer are stripped', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    // A buffer that contains a literal end-marker must not be able to close
    // our wrapper early.
    await page.locator('#composeInput').fill('a\x1b[201~b\nc');
    await page.locator('#composeSendBtn').tap();
    const joined = (await drainSends(page)).join('');
    // Exactly one opening and one closing marker — the wrapper's own.
    expect(joined.match(/\x1b\[200~/g).length).toBe(1);
    expect(joined.match(/\x1b\[201~/g).length).toBe(1);
    expect(joined).toBe('\x1b[200~ab\rc\x1b[201~\r');
    await context.close();
  });

  test('a "/"-prefixed line streams to the terminal live, before Send', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').focus();
    await page.locator('#composeInput').pressSequentially('/he', { delay: 40 });
    // The chars must already be on the WS — this is what makes Claude's own
    // slash menu narrow as the user types.
    const streamed = await drainSends(page);
    expect(streamed.join('')).toBe('/he');
    await expect(page.locator('#composeInput')).toHaveClass(/live/);
    await context.close();
  });

  test('live line, desktop: Enter commits with a bare CR, no double-send of the body', async ({ browser }) => {
    const { context, page } = await openNarrowDesktop(browser);
    await resetSends(page);
    await page.locator('#composeInput').focus();
    await page.locator('#composeInput').pressSequentially('/help', { delay: 30 });
    await page.locator('#composeInput').press('Enter');
    const sends = await drainSends(page);
    // Body streamed once during typing, then a single CR — never "/help/help".
    expect(sends.join('')).toBe('/help\r');
    await expect(page.locator('#composeInput')).toHaveValue('');
    await context.close();
  });

  test('#55 §1 live line, mobile: Enter newlines and streams NO CR — it must not submit', async ({ browser }) => {
    // The live projection mirrors the buffer into the agent's ONE-LINE TUI prompt. A newline
    // there would have to be streamed as '\r' — the SUBMIT key — so Enter in a '/'-line used
    // to fire the command on mobile while Enter merely newlined in every other buffer. That
    // is the lens-dependent Enter §1 forbids. The newline is dropped from the projection.
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').focus();
    await page.locator('#composeInput').pressSequentially('/help', { delay: 30 });
    expect((await drainSends(page)).join('')).toBe('/help');

    await page.locator('#composeInput').press('Enter');
    expect((await drainSends(page)).join('')).toBe('');            // NOT a '\r'
    await expect(page.locator('#composeInput')).toHaveValue('/help\n');

    await page.locator('#composeSendBtn').tap();                   // Send is the submit
    expect((await drainSends(page)).join('')).toBe('\r');
    await context.close();
  });

  test('deleting back past "/" exits live mode and streams backspaces', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await resetSends(page);
    await page.locator('#composeInput').focus();
    await page.locator('#composeInput').pressSequentially('/x', { delay: 30 });
    await resetSends(page);
    await page.locator('#composeInput').press('Backspace');
    await page.locator('#composeInput').press('Backspace');
    const sends = await drainSends(page);
    // Two DEL bytes erase "/x" on the terminal.
    expect(sends.join('')).toBe('\x7f\x7f');
    await expect(page.locator('#composeInput')).not.toHaveClass(/live/);
    await context.close();
  });

  test('Send button is disabled on an empty buffer, enabled with text', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await expect(page.locator('#composeSendBtn')).toBeDisabled();
    await page.locator('#composeInput').fill('x');
    await expect(page.locator('#composeSendBtn')).toBeEnabled();
    await page.locator('#composeInput').fill('');
    await expect(page.locator('#composeSendBtn')).toBeDisabled();
    await context.close();
  });

  test('mode toggle to raw hides the compose bar; raw keystrokes reach the WS', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    // Empty buffer — no confirm dialog expected.
    await page.locator('#composeModeBtn').tap();
    await expect(page.locator('#composeBar')).toBeHidden();
    await resetSends(page);
    // In raw mode xterm's input path is live again.
    await page.evaluate(() => window.term.input('z', true));
    const sends = await drainSends(page);
    expect(sends.join('')).toContain('z');
    await context.close();
  });

  test('switching to raw with text in the buffer asks for confirmation', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await page.locator('#composeInput').fill('unsent text');

    // Cancel keeps compose mode and the buffer.
    page.once('dialog', d => d.dismiss());
    await page.locator('#composeModeBtn').tap();
    await expect(page.locator('#composeBar')).toBeVisible();
    await expect(page.locator('#composeInput')).toHaveValue('unsent text');

    // Accept discards the buffer and switches.
    page.once('dialog', d => d.accept());
    await page.locator('#composeModeBtn').tap();
    await expect(page.locator('#composeBar')).toBeHidden();
    await context.close();
  });

  test('compose/raw choice persists across reload', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await page.locator('#composeModeBtn').tap();        // -> raw
    await expect(page.locator('#composeBar')).toBeHidden();
    await page.reload();
    await waitForAppReady(page);
    await expect(page.locator('#composeBar')).toBeHidden(); // still raw after reload
    await context.close();
  });

  test('image attach button invokes the image picker', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    await page.evaluate(() => { window.__imgCalled = false; window.mobileImagePaste = () => { window.__imgCalled = true; }; });
    await page.locator('#composeAttachBtn').tap();
    expect(await page.evaluate(() => window.__imgCalled)).toBe(true);
    await context.close();
  });

  test('touch-toolbar Up arrow recalls send history when the buffer is empty', async ({ browser }) => {
    const { context, page } = await openMobile(browser);
    // Build two history entries. Send — on mobile Enter is a newline (#55 §1), not a submit.
    await page.locator('#composeInput').fill('first cmd');
    await page.locator('#composeSendBtn').tap();
    await page.locator('#composeInput').fill('second cmd');
    await page.locator('#composeSendBtn').tap();
    await page.waitForTimeout(150);

    await page.evaluate(() => document.getElementById('composeInput').focus());
    await page.locator('#touchKeys button[data-key="ArrowUp"]').tap();
    await expect(page.locator('#composeInput')).toHaveValue('second cmd');
    await page.locator('#touchKeys button[data-key="ArrowUp"]').tap();
    await expect(page.locator('#composeInput')).toHaveValue('first cmd');
    await page.locator('#touchKeys button[data-key="ArrowDown"]').tap();
    await expect(page.locator('#composeInput')).toHaveValue('second cmd');
    await context.close();
  });

  test('compose buffer is preserved per-session across a session switch', async ({ browser }) => {
    // Need a second session to switch to.
    const res = await apiCtx.post('/api/sessions', { data: { name: 'compose-test-2' } });
    const sid2 = (await res.json()).id;
    try {
      const { context, page } = await openMobile(browser);
      await page.locator('#composeInput').fill('draft for session one');
      // Switch to the other session, then back.
      await page.evaluate((id) => window.switchSession(id, null), sid2);
      await page.waitForTimeout(400);
      await expect(page.locator('#composeInput')).toHaveValue('');
      await page.evaluate((id) => window.switchSession(id, null), sessionId);
      await page.waitForTimeout(400);
      await expect(page.locator('#composeInput')).toHaveValue('draft for session one');
      await context.close();
    } finally {
      try { await apiCtx.delete(`/api/sessions/${sid2}`); } catch {}
    }
  });

  test('raw-mode IME dedup helpers remain available', async ({ browser }) => {
    // The heuristic dedup is unreachable in compose mode but must still load
    // (raw mode relies on it; its unit tests exercise the window hook).
    const { context, page } = await openMobile(browser);
    const ok = await page.evaluate(() =>
      !!window.__wtMobileDedup && typeof window.__wtMobileDedup.handleChunk === 'function');
    expect(ok).toBe(true);
    await context.close();
  });
});
