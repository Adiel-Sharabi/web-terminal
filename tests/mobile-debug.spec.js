// @ts-check
const { test, expect, request: pwRequest, devices } = require('@playwright/test');

const BASE = 'http://localhost:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

// Pixel 5 device emulation
const pixel5 = devices['Pixel 5'];

/** Create an authenticated API request context */
async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

/** Login via page and return the cookie string */
async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

/** Wait for xterm.js terminal to be initialized and visible */
async function waitForTerminal(page, timeoutMs = 15000) {
  // Wait for the xterm terminal element to exist and have rows rendered
  await page.waitForSelector('.xterm-screen', { state: 'visible', timeout: timeoutMs });
  // Wait a bit more for xterm to fully initialize
  await page.waitForTimeout(500);
}

/** Wait for WebSocket connection to be established */
async function waitForWsConnected(page, timeoutMs = 10000) {
  await page.waitForFunction(() => {
    return typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN;
  }, { timeout: timeoutMs });
}

/**
 * Type text into the terminal by dispatching keyboard events to the xterm helper textarea.
 * This simulates how desktop keyboard input reaches xterm.js.
 */
async function typeInTerminal(page, text) {
  // Focus the terminal first
  await page.click('.xterm-screen');
  await page.waitForTimeout(200);
  // Type character by character with keyboard events
  for (const ch of text) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await page.waitForTimeout(50);
  }
}

/**
 * Simulate mobile IME composition input.
 * On Android, the browser fires compositionstart -> compositionupdate -> input -> compositionend
 * for each character. The xterm hidden textarea receives input events with data.
 */
async function mobileComposeText(page, text) {
  // Focus the terminal
  await page.click('.xterm-screen');
  await page.waitForTimeout(200);

  const textarea = page.locator('.xterm-helper-textarea');

  // Simulate IME composition for each character
  for (const ch of text) {
    // Dispatch compositionstart
    await textarea.dispatchEvent('compositionstart', { data: '' });
    // keydown with keyCode 229 (IME processing) — this is what Android sends
    await textarea.dispatchEvent('keydown', { key: ch, keyCode: 229, which: 229 });
    // Dispatch compositionupdate with the character
    await textarea.dispatchEvent('compositionupdate', { data: ch });
    // input event (this is what xterm.js primarily uses)
    await textarea.dispatchEvent('input', { data: ch, inputType: 'insertCompositionText', isComposing: true });
    // compositionend
    await textarea.dispatchEvent('compositionend', { data: ch });
    // Final input event after composition (some Android browsers send this)
    await textarea.dispatchEvent('input', { data: ch, inputType: 'insertText', isComposing: false });
    await page.waitForTimeout(50);
  }
}

/**
 * Alternative mobile typing: use keyboard.type which goes through the standard input path.
 * On mobile emulation this still triggers keydown events but may behave differently
 * due to the isMobile flag in the app.
 */
async function mobileTypeViaKeyboard(page, text) {
  await page.click('.xterm-screen');
  await page.waitForTimeout(200);
  await page.keyboard.type(text, { delay: 80 });
}

/**
 * Type using insertText command — bypasses keydown entirely,
 * goes directly through the input event path like a mobile keyboard would.
 */
async function mobileInsertText(page, text) {
  await page.click('.xterm-screen');
  await page.waitForTimeout(200);
  for (const ch of text) {
    await page.keyboard.insertText(ch);
    await page.waitForTimeout(50);
  }
}

// ============================================================
// Mobile Input Diagnostic Tests
// ============================================================

test.describe('Mobile Input Diagnostics', () => {
  let apiCtx;
  let sessionId;

  test.beforeAll(async () => {
    apiCtx = await authCtx();
    // Create a simple shell session (NOT claude)
    const res = await apiCtx.post('/api/sessions', {
      data: { name: 'mobile-test-session' },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    sessionId = data.id;
    expect(sessionId).toBeTruthy();
    console.log(`Created test session: ${sessionId}`);
  });

  test.afterAll(async () => {
    // Clean up - kill the test session
    if (sessionId) {
      try {
        await apiCtx.delete(`/api/sessions/${sessionId}`);
        console.log(`Deleted test session: ${sessionId}`);
      } catch (e) {
        console.warn('Failed to delete test session:', e.message);
      }
    }
    if (apiCtx) await apiCtx.dispose();
  });

  // ----------------------------------------------------------
  // Test 1: Desktop typing works (baseline)
  // ----------------------------------------------------------
  test('desktop typing works as baseline', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLogs = [];
    const consoleErrors = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);

    // Wait for shell prompt to appear
    await page.waitForTimeout(1500);

    // Type a simple echo command
    await typeInTerminal(page, 'echo DESKTOP_OK');
    await page.waitForTimeout(500);

    // Check if the text appears in the terminal
    const termContent = await page.evaluate(() => {
      const term = window.term || document.querySelector('.xterm-screen')?.textContent;
      if (window.term) {
        // Get the active buffer content
        const buf = window.term.buffer.active;
        let text = '';
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line) text += line.translateToString(true) + '\n';
        }
        return text;
      }
      return typeof term === 'string' ? term : '';
    });

    console.log('Desktop terminal content (last 500 chars):', termContent.slice(-500));
    expect(termContent).toContain('echo DESKTOP_OK');

    // Press Enter and verify echo output
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const afterEnter = await page.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });

    console.log('Desktop after Enter (last 500 chars):', afterEnter.slice(-500));
    expect(afterEnter).toContain('DESKTOP_OK');

    if (consoleErrors.length > 0) {
      console.log('Desktop console errors:', consoleErrors);
    }

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 2: Mobile typing with keyboard.type (Playwright default)
  // ----------------------------------------------------------
  test('mobile typing via keyboard.type', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();
    const consoleLogs = [];
    const consoleErrors = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    // Check if isMobile is detected
    const isMobile = await page.evaluate(() => {
      return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 600;
    });
    console.log(`isMobile detected: ${isMobile}`);
    expect(isMobile).toBe(true);

    // Instrument onData and ws.send to capture what happens
    await page.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [], wsMessages: [] };

      // Patch ws.send
      if (window.ws) {
        const origSend = window.ws.send.bind(window.ws);
        window.ws.send = function(data) {
          window._mobileDebug.wsSendCalls.push(data);
          return origSend(data);
        };
      }

      // Patch term.onData (add a second listener)
      if (window.term) {
        window.term.onData(data => {
          window._mobileDebug.onDataCalls.push(data);
        });
      }

      // Listen for ws messages
      if (window.ws) {
        const origOnMsg = window.ws.onmessage;
        window.ws.onmessage = function(e) {
          window._mobileDebug.wsMessages.push(typeof e.data === 'string' ? e.data.substring(0, 200) : '<binary>');
          if (origOnMsg) origOnMsg.call(this, e);
        };
      }
    });

    // First clear any previous echo command from the terminal
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Try typing with keyboard.type
    await mobileTypeViaKeyboard(page, 'echo MOBILE_TYPE');
    await page.waitForTimeout(1000);

    // Collect debug data
    const debug1 = await page.evaluate(() => window._mobileDebug);
    console.log('=== Mobile keyboard.type debug ===');
    console.log('onData calls:', JSON.stringify(debug1.onDataCalls));
    console.log('ws.send calls:', JSON.stringify(debug1.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'))));
    console.log('ws messages received:', debug1.wsMessages.length);

    // Check terminal content
    const termContent = await page.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Mobile terminal content (last 500 chars):', termContent.slice(-500));

    // The key diagnostic: did onData fire?
    const dataCallCount = debug1.onDataCalls.length;
    console.log(`onData fired ${dataCallCount} times for ${16} chars typed`);

    // Did ws.send get called with the typed text?
    const nonControlSends = debug1.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'));
    console.log(`ws.send called ${nonControlSends.length} times with non-control data`);

    if (consoleErrors.length > 0) {
      console.log('Mobile console errors:', consoleErrors);
    }

    // This assertion may fail — that's the diagnostic
    // If it fails, we know mobile keyboard.type doesn't work with the IME handler
    const hasText = termContent.includes('echo MOBILE_TYPE') || termContent.includes('MOBILE_TYPE');
    console.log(`Text appeared in terminal: ${hasText}`);

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 3: Mobile typing via insertText (bypasses keydown)
  // ----------------------------------------------------------
  test('mobile typing via insertText (bypasses keydown)', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();
    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    // Instrument
    await page.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [], keydownEvents: [] };

      // Track keydown events on the xterm textarea
      const textarea = document.querySelector('.xterm-helper-textarea');
      if (textarea) {
        textarea.addEventListener('keydown', (e) => {
          window._mobileDebug.keydownEvents.push({
            key: e.key, keyCode: e.keyCode, type: e.type,
            defaultPrevented: e.defaultPrevented
          });
        }, true); // capture phase
      }

      if (window.ws) {
        const origSend = window.ws.send.bind(window.ws);
        window.ws.send = function(data) {
          window._mobileDebug.wsSendCalls.push(data);
          return origSend(data);
        };
      }
      if (window.term) {
        window.term.onData(data => {
          window._mobileDebug.onDataCalls.push(data);
        });
      }
    });

    // Clear line
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Reset debug after Enter
    await page.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [], keydownEvents: [] };
    });

    // insertText bypasses keydown entirely — goes straight to input event
    await mobileInsertText(page, 'echo MOBILE_INSERT');
    await page.waitForTimeout(1000);

    const debug = await page.evaluate(() => window._mobileDebug);
    console.log('=== Mobile insertText debug ===');
    console.log('keydown events:', debug.keydownEvents.length, JSON.stringify(debug.keydownEvents.slice(0, 5)));
    console.log('onData calls:', JSON.stringify(debug.onDataCalls));
    console.log('ws.send calls:', JSON.stringify(debug.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'))));

    const termContent = await page.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Terminal content (last 500 chars):', termContent.slice(-500));

    const hasText = termContent.includes('MOBILE_INSERT');
    console.log(`insertText text appeared in terminal: ${hasText}`);

    // insertText should bypass the IME suppression entirely since no keydown is fired
    // If this also fails, the issue is deeper than the keydown handler
    expect(debug.onDataCalls.length).toBeGreaterThan(0);

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 4: Mobile typing with simulated IME composition events
  // ----------------------------------------------------------
  test('mobile typing with simulated IME composition', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`[page error] ${msg.text()}`);
    });

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    // Instrument
    await page.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [], keyHandlerReturns: [] };

      if (window.ws) {
        const origSend = window.ws.send.bind(window.ws);
        window.ws.send = function(data) {
          window._mobileDebug.wsSendCalls.push(data);
          return origSend(data);
        };
      }
      if (window.term) {
        window.term.onData(data => {
          window._mobileDebug.onDataCalls.push(data);
        });
      }
    });

    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [], keyHandlerReturns: [] };
    });

    // Simulate what Android IME does: compositionstart -> keydown(229) -> compositionupdate -> input -> compositionend
    await mobileComposeText(page, 'echo IME');
    await page.waitForTimeout(1000);

    const debug = await page.evaluate(() => window._mobileDebug);
    console.log('=== Mobile IME composition debug ===');
    console.log('onData calls:', JSON.stringify(debug.onDataCalls));
    console.log('ws.send calls:', JSON.stringify(debug.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'))));

    const termContent = await page.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Terminal content (last 500 chars):', termContent.slice(-500));

    const hasText = termContent.includes('echo IME');
    console.log(`IME composition text appeared in terminal: ${hasText}`);

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 5: Diagnose the IME suppression handler behavior
  // ----------------------------------------------------------
  test('diagnose IME keydown suppression on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    // Instrument the attachCustomKeyEventHandler to see what it returns
    // We can't patch the existing handler, but we can monitor the textarea events
    const diagnostics = await page.evaluate(() => {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 600;

      // Check what the custom key handler does for a typical 'a' keydown
      // The handler is: if (isMobile && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || e.keyCode === 229)) return false;
      // When isMobile=true and key='a', it returns false — blocking xterm.js from processing the keydown
      // The expectation is that the input event from the textarea will provide the character instead

      // Check if xterm.js's internal input event handler is working
      const textarea = document.querySelector('.xterm-helper-textarea');
      const hasTextarea = !!textarea;

      // Check textarea attributes — xterm sets these for IME handling
      let textareaAttrs = {};
      if (textarea) {
        textareaAttrs = {
          type: textarea.getAttribute('type'),
          autocapitalize: textarea.getAttribute('autocapitalize'),
          autocomplete: textarea.getAttribute('autocomplete'),
          autocorrect: textarea.getAttribute('autocorrect'),
          spellcheck: textarea.getAttribute('spellcheck'),
          inputMode: textarea.getAttribute('inputmode'),
          tabIndex: textarea.getAttribute('tabindex'),
          style: textarea.style.cssText.substring(0, 200),
        };
      }

      return {
        isMobile,
        userAgent: navigator.userAgent,
        hasTextarea,
        textareaAttrs,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        termCols: window.term ? window.term.cols : null,
        termRows: window.term ? window.term.rows : null,
      };
    });

    console.log('=== Mobile IME Handler Diagnostics ===');
    console.log('isMobile:', diagnostics.isMobile);
    console.log('User-Agent:', diagnostics.userAgent);
    console.log('Has xterm textarea:', diagnostics.hasTextarea);
    console.log('Textarea attributes:', JSON.stringify(diagnostics.textareaAttrs, null, 2));
    console.log('Window size:', `${diagnostics.windowWidth}x${diagnostics.windowHeight}`);
    console.log('Terminal size:', `${diagnostics.termCols}x${diagnostics.termRows}`);

    expect(diagnostics.isMobile).toBe(true);
    expect(diagnostics.hasTextarea).toBe(true);

    // Now test: when we type 'a' on mobile, does the keydown handler suppress it?
    // And does the input event still fire and reach onData?
    await page.evaluate(() => {
      window._keyTest = { keydowns: [], inputs: [], onDataFired: [] };

      const textarea = document.querySelector('.xterm-helper-textarea');
      textarea.addEventListener('keydown', e => {
        window._keyTest.keydowns.push({
          key: e.key, keyCode: e.keyCode, type: 'keydown',
          defaultPrevented: e.defaultPrevented, cancelBubble: e.cancelBubble
        });
      });
      textarea.addEventListener('input', e => {
        window._keyTest.inputs.push({
          data: e.data, inputType: e.inputType, isComposing: e.isComposing, type: 'input'
        });
      });
      textarea.addEventListener('beforeinput', e => {
        window._keyTest.inputs.push({
          data: e.data, inputType: e.inputType, isComposing: e.isComposing, type: 'beforeinput'
        });
      });

      window.term.onData(data => {
        window._keyTest.onDataFired.push(data);
      });
    });

    // Type a single character
    await page.click('.xterm-screen');
    await page.waitForTimeout(200);
    await page.keyboard.press('a');
    await page.waitForTimeout(500);

    const keyTest = await page.evaluate(() => window._keyTest);
    console.log('=== Single char "a" key event trace ===');
    console.log('keydown events:', JSON.stringify(keyTest.keydowns));
    console.log('input events:', JSON.stringify(keyTest.inputs));
    console.log('onData fired:', JSON.stringify(keyTest.onDataFired));

    // The key question: when the keydown handler returns false for mobile,
    // does xterm.js still process the character via the input event?
    // If onDataFired is empty, the IME suppression is blocking ALL input on mobile
    console.log(`VERDICT: keydown suppressed (return false) -> onData fired: ${keyTest.onDataFired.length > 0}`);

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 6: Desktop + Mobile simultaneous viewing
  // ----------------------------------------------------------
  test('desktop and mobile simultaneous viewing', async ({ browser }) => {
    // Desktop context
    const desktopCtx = await browser.newContext();
    const desktopPage = await desktopCtx.newPage();
    desktopPage.on('console', msg => {
      if (msg.type() === 'error') console.log(`[desktop error] ${msg.text()}`);
    });

    // Mobile context
    const mobileCtx = await browser.newContext({
      ...pixel5,
    });
    const mobilePage = await mobileCtx.newPage();
    mobilePage.on('console', msg => {
      if (msg.type() === 'error') console.log(`[mobile error] ${msg.text()}`);
    });

    // Login both
    await loginPage(desktopPage);
    await loginPage(mobilePage);

    // Open desktop first
    await desktopPage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(desktopPage);
    await waitForWsConnected(desktopPage);
    await desktopPage.waitForTimeout(1500);

    // Record desktop terminal size
    const desktopSize = await desktopPage.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
    }));
    console.log('Desktop terminal size:', desktopSize);

    // Open mobile as second viewer
    await mobilePage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(mobilePage);
    await waitForWsConnected(mobilePage);
    await mobilePage.waitForTimeout(1500);

    // Record mobile terminal size
    const mobileSize = await mobilePage.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
    }));
    console.log('Mobile terminal size:', mobileSize);

    // Check viewer count (should be 2)
    const viewerText = await desktopPage.evaluate(() =>
      document.getElementById('viewers')?.textContent || ''
    );
    console.log('Viewer count text:', viewerText);

    // Type on desktop — should still work with 2 viewers
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForTimeout(300);
    await typeInTerminal(desktopPage, 'echo DUAL_DESKTOP');
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForTimeout(1000);

    const desktopContent = await desktopPage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Desktop sees DUAL_DESKTOP:', desktopContent.includes('DUAL_DESKTOP'));

    // Check if mobile also received the output
    await mobilePage.waitForTimeout(500);
    const mobileContent = await mobilePage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Mobile sees DUAL_DESKTOP:', mobileContent.includes('DUAL_DESKTOP'));
    expect(mobileContent).toContain('DUAL_DESKTOP');

    // Now try typing from mobile while desktop is connected
    await mobilePage.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [] };
      if (window.ws) {
        const origSend = window.ws.send.bind(window.ws);
        window.ws.send = function(data) {
          window._mobileDebug.wsSendCalls.push(data);
          return origSend(data);
        };
      }
      if (window.term) {
        window.term.onData(data => {
          window._mobileDebug.onDataCalls.push(data);
        });
      }
    });

    await mobileInsertText(mobilePage, 'echo DUAL_MOBILE');
    await mobilePage.waitForTimeout(1000);

    const mobileDebug = await mobilePage.evaluate(() => window._mobileDebug);
    console.log('=== Mobile typing while desktop connected ===');
    console.log('onData calls:', JSON.stringify(mobileDebug.onDataCalls));
    console.log('ws.send calls:', JSON.stringify(mobileDebug.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'))));

    // Check if the text appeared on desktop (the other viewer)
    await desktopPage.waitForTimeout(1000);
    const desktopAfterMobile = await desktopPage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    const mobileTextOnDesktop = desktopAfterMobile.includes('DUAL_MOBILE');
    console.log(`Mobile typed text visible on desktop: ${mobileTextOnDesktop}`);

    await desktopCtx.close();
    await mobileCtx.close();
  });

  // ----------------------------------------------------------
  // Test 7: Mobile as sole viewer (desktop disconnects)
  // ----------------------------------------------------------
  test('mobile typing as sole viewer after desktop disconnects', async ({ browser }) => {
    // Desktop opens first
    const desktopCtx = await browser.newContext();
    const desktopPage = await desktopCtx.newPage();
    await loginPage(desktopPage);
    await desktopPage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(desktopPage);
    await waitForWsConnected(desktopPage);
    await desktopPage.waitForTimeout(1000);

    // Mobile opens as 2nd viewer
    const mobileCtx = await browser.newContext({
      ...pixel5,
    });
    const mobilePage = await mobileCtx.newPage();
    await loginPage(mobilePage);
    await mobilePage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(mobilePage);
    await waitForWsConnected(mobilePage);
    await mobilePage.waitForTimeout(1000);

    // Close desktop — mobile becomes sole viewer
    console.log('Closing desktop browser...');
    await desktopCtx.close();

    // Wait for the server to detect the disconnect
    await mobilePage.waitForTimeout(2000);

    // Instrument mobile
    await mobilePage.evaluate(() => {
      window._mobileDebug = { onDataCalls: [], wsSendCalls: [] };
      if (window.ws) {
        const origSend = window.ws.send.bind(window.ws);
        window.ws.send = function(data) {
          window._mobileDebug.wsSendCalls.push(data);
          return origSend(data);
        };
      }
      if (window.term) {
        window.term.onData(data => {
          window._mobileDebug.onDataCalls.push(data);
        });
      }
    });

    // Type as sole viewer using insertText
    await mobileInsertText(mobilePage, 'echo SOLE_MOBILE');
    await mobilePage.waitForTimeout(1000);

    const debug = await mobilePage.evaluate(() => window._mobileDebug);
    console.log('=== Mobile as sole viewer ===');
    console.log('onData calls:', JSON.stringify(debug.onDataCalls));
    console.log('ws.send calls:', JSON.stringify(debug.wsSendCalls.filter(d => !d.includes('heartbeat') && !d.includes('resize'))));

    const termContent = await mobilePage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    console.log('Terminal content (last 500 chars):', termContent.slice(-500));

    const hasText = termContent.includes('SOLE_MOBILE');
    console.log(`Sole mobile text appeared: ${hasText}`);

    // Press Enter and check echo works
    if (debug.onDataCalls.length > 0) {
      await mobilePage.keyboard.press('Enter');
      await mobilePage.waitForTimeout(1000);

      const afterEnter = await mobilePage.evaluate(() => {
        const buf = window.term.buffer.active;
        let text = '';
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line) text += line.translateToString(true) + '\n';
        }
        return text;
      });
      console.log('After Enter:', afterEnter.includes('SOLE_MOBILE') ? 'echo worked' : 'echo NOT found');
    }

    await mobileCtx.close();
  });

  // ----------------------------------------------------------
  // Test 8: Terminal resize behavior when mobile connects/desktop disconnects
  // ----------------------------------------------------------
  test('terminal resize when mobile connects and desktop disconnects', async ({ browser }) => {
    test.setTimeout(60000); // This test needs extra time for the 10s requestResize delay
    // Desktop opens first
    const desktopCtx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const desktopPage = await desktopCtx.newPage();
    await loginPage(desktopPage);
    await desktopPage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(desktopPage);
    await waitForWsConnected(desktopPage);
    await desktopPage.waitForTimeout(1500);

    const desktopTermSize = await desktopPage.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
    }));
    console.log('Desktop terminal size:', desktopTermSize);

    // Query the PTY size by running a command that prints terminal dimensions
    // Use `tput cols` and `tput lines` piped through the shell
    await typeInTerminal(desktopPage, 'echo PTY_SIZE:$(tput cols)x$(tput lines)');
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForTimeout(1000);

    const ptyBefore = await desktopPage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      const match = text.match(/PTY_SIZE:(\d+)x(\d+)/);
      return match ? { cols: parseInt(match[1]), rows: parseInt(match[2]) } : null;
    });
    console.log('PTY size before mobile:', ptyBefore);

    // Mobile connects as 2nd viewer
    const mobileCtx = await browser.newContext({
      ...pixel5,
    });
    const mobilePage = await mobileCtx.newPage();
    await loginPage(mobilePage);
    await mobilePage.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(mobilePage);
    await waitForWsConnected(mobilePage);
    await mobilePage.waitForTimeout(1500);

    const mobileTermSize = await mobilePage.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
    }));
    console.log('Mobile terminal size:', mobileTermSize);

    // Verify PTY didn't shrink when 2nd viewer connects (server only resizes for sole client)
    // Type the size check command again from desktop
    await typeInTerminal(desktopPage, 'echo PTY_DURING:$(tput cols)x$(tput lines)');
    await desktopPage.keyboard.press('Enter');
    await desktopPage.waitForTimeout(1000);

    const ptyDuring = await desktopPage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      const match = text.match(/PTY_DURING:(\d+)x(\d+)/);
      return match ? { cols: parseInt(match[1]), rows: parseInt(match[2]) } : null;
    });
    console.log('PTY size with both viewers:', ptyDuring);

    if (ptyBefore && ptyDuring) {
      expect(ptyDuring.cols).toBe(ptyBefore.cols);
      expect(ptyDuring.rows).toBe(ptyBefore.rows);
      console.log('PTY size preserved during multi-viewer: YES');
    }

    // Close desktop — now requestResize should fire after 10s delay
    console.log('Closing desktop, mobile becomes sole viewer...');
    await desktopCtx.close();

    // Wait for 10s requestResize delay + buffer
    console.log('Waiting 12s for requestResize delay...');
    await mobilePage.waitForTimeout(12000);

    // Check if PTY resized to mobile dimensions by running tput from mobile
    // Use insertText since mobile keyboard.press may not work (that's what we're diagnosing)
    await mobilePage.evaluate(() => {
      if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send('echo PTY_AFTER:$(tput cols)x$(tput lines)\n');
      }
    });
    await mobilePage.waitForTimeout(1000);

    const ptyAfter = await mobilePage.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      const match = text.match(/PTY_AFTER:(\d+)x(\d+)/);
      return match ? { cols: parseInt(match[1]), rows: parseInt(match[2]) } : null;
    });
    console.log('PTY size after desktop disconnect + resize delay:', ptyAfter);

    const mobileTermSizeAfter = await mobilePage.evaluate(() => ({
      cols: window.term.cols,
      rows: window.term.rows,
    }));
    console.log('Mobile terminal size after resize:', mobileTermSizeAfter);

    if (ptyAfter && mobileTermSizeAfter.cols) {
      const resized = ptyAfter.cols === mobileTermSizeAfter.cols;
      console.log(`PTY resized to mobile dimensions: ${resized} (PTY ${ptyAfter.cols}x${ptyAfter.rows} vs term ${mobileTermSizeAfter.cols}x${mobileTermSizeAfter.rows})`);
    }

    await mobileCtx.close();
  });

  // ----------------------------------------------------------
  // Test 9: Compare all mobile input methods side by side
  // ----------------------------------------------------------
  test('compare all mobile input methods', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    const results = {};

    // Method 1: keyboard.press (standard)
    await page.evaluate(() => {
      window._testData = [];
      window.term.onData(d => window._testData.push(d));
    });
    await page.click('.xterm-screen');
    await page.waitForTimeout(200);
    await page.keyboard.press('x');
    await page.waitForTimeout(500);
    results.keyboardPress = await page.evaluate(() => ({ onData: [...window._testData] }));
    console.log('keyboard.press("x"):', JSON.stringify(results.keyboardPress));

    // Method 2: keyboard.type
    await page.evaluate(() => { window._testData = []; });
    await page.keyboard.type('y', { delay: 100 });
    await page.waitForTimeout(500);
    results.keyboardType = await page.evaluate(() => ({ onData: [...window._testData] }));
    console.log('keyboard.type("y"):', JSON.stringify(results.keyboardType));

    // Method 3: keyboard.insertText
    await page.evaluate(() => { window._testData = []; });
    await page.keyboard.insertText('z');
    await page.waitForTimeout(500);
    results.insertText = await page.evaluate(() => ({ onData: [...window._testData] }));
    console.log('keyboard.insertText("z"):', JSON.stringify(results.insertText));

    // Method 4: dispatchEvent input on textarea
    await page.evaluate(() => { window._testData = []; });
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (ta) {
        ta.dispatchEvent(new InputEvent('input', { data: 'w', inputType: 'insertText', bubbles: true }));
      }
    });
    await page.waitForTimeout(500);
    results.dispatchInput = await page.evaluate(() => ({ onData: [...window._testData] }));
    console.log('dispatchEvent input("w"):', JSON.stringify(results.dispatchInput));

    // Method 5: Direct ws.send (bypass terminal entirely)
    await page.evaluate(() => { window._testData = []; });
    await page.evaluate(() => {
      if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        window.ws.send('q');
      }
    });
    await page.waitForTimeout(500);
    // Check if 'q' echoed back
    const termContent = await page.evaluate(() => {
      const buf = window.term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      return text;
    });
    results.directWsSend = { echoVisible: termContent.includes('q') };
    console.log('direct ws.send("q"):', JSON.stringify(results.directWsSend));

    console.log('\n=== INPUT METHOD COMPARISON ===');
    console.log('keyboard.press:   onData fired =', results.keyboardPress.onData.length > 0 ? 'YES' : 'NO', `(${results.keyboardPress.onData.length} calls)`);
    console.log('keyboard.type:    onData fired =', results.keyboardType.onData.length > 0 ? 'YES' : 'NO', `(${results.keyboardType.onData.length} calls)`);
    console.log('insertText:       onData fired =', results.insertText.onData.length > 0 ? 'YES' : 'NO', `(${results.insertText.onData.length} calls)`);
    console.log('dispatchEvent:    onData fired =', results.dispatchInput.onData.length > 0 ? 'YES' : 'NO', `(${results.dispatchInput.onData.length} calls)`);
    console.log('direct ws.send:   echo visible =', results.directWsSend.echoVisible ? 'YES' : 'NO');

    // At least one method should work — if none do, there's a fundamental WS issue
    const anyWorked = results.keyboardPress.onData.length > 0 ||
                      results.keyboardType.onData.length > 0 ||
                      results.insertText.onData.length > 0 ||
                      results.dispatchInput.onData.length > 0;
    console.log(`\nAny input method produced onData: ${anyWorked}`);

    // Direct ws.send should always work (it bypasses all terminal input handling)
    expect(results.directWsSend.echoVisible).toBe(true);

    await context.close();
  });

  // ----------------------------------------------------------
  // Test 10: Verify the IME handler return value blocks xterm input processing
  // ----------------------------------------------------------
  test('verify IME handler blocking mechanism on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();

    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForWsConnected(page);
    await page.waitForTimeout(1500);

    // The core question: the custom key handler returns false for printable keys on mobile.
    // In xterm.js, returning false from attachCustomKeyEventHandler means "I handled this key,
    // don't process it further." But for mobile, we rely on the textarea input event to
    // provide the character. The question is: does returning false from the keydown handler
    // also suppress xterm's textarea input event processing?

    // Test by temporarily removing the custom key handler and comparing behavior
    const testChars = 'abc';

    // Test WITH the current handler (should fail on mobile due to suppression)
    await page.evaluate(() => {
      window._test1 = [];
      window.term.onData(d => window._test1.push(d));
    });
    await page.click('.xterm-screen');
    await page.waitForTimeout(200);
    for (const ch of testChars) {
      await page.keyboard.press(ch);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    const withHandler = await page.evaluate(() => [...window._test1]);
    console.log('With IME handler (return false for printable):', JSON.stringify(withHandler));

    // Now test: what if we use keyboard.insertText instead? (no keydown = handler not invoked)
    await page.evaluate(() => {
      window._test2 = [];
      window.term.onData(d => window._test2.push(d));
    });
    for (const ch of testChars) {
      await page.keyboard.insertText(ch);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    const withInsert = await page.evaluate(() => [...window._test2]);
    console.log('With insertText (no keydown fired):', JSON.stringify(withInsert));

    console.log('\n=== IME Handler Impact ===');
    console.log(`keyboard.press with handler active: ${withHandler.length} onData calls`);
    console.log(`insertText bypassing handler:       ${withInsert.length} onData calls`);

    if (withHandler.length === 0 && withInsert.length > 0) {
      console.log('DIAGNOSIS: The IME keydown suppression (return false) is blocking ALL input on mobile.');
      console.log('The handler prevents xterm from processing keydown, but xterm.js apparently also');
      console.log('needs the keydown event to trigger its internal input processing pipeline.');
      console.log('FIX: The handler should return true for mobile, and use a different mechanism');
      console.log('to prevent double-input (e.g., track composition state).');
    } else if (withHandler.length === 0 && withInsert.length === 0) {
      console.log('DIAGNOSIS: Neither method works. Issue is NOT the IME handler alone.');
      console.log('There may be a WebSocket, terminal init, or focus issue.');
    } else if (withHandler.length > 0) {
      console.log('DIAGNOSIS: IME handler is NOT blocking input. The issue is elsewhere.');
    }

    await context.close();
  });
});
