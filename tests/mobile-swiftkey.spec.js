// @ts-check
// Regression test for issue #8:
// SwiftKey on Android duplicates text when the user types a word character
// by character and then SwiftKey finalizes the word on space/punctuation —
// it fires a compositionend that re-sends the ENTIRE word (sometimes with
// an autocorrect change). xterm.js delivers this as a single onData call
// containing the full committed word, and without dedup the client forwards
// it to the server, producing "hihi" for "hi", or "tehthe" when SwiftKey
// autocorrects "teh" → "the".
//
// The pre-fix heuristic in app.html only dedup'd chunks longer than 5 chars
// AND required an exact single-char count match, which missed short words
// and autocorrect changes. These tests pin down the correct behavior.
const { test, expect, devices } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

const pixel5 = devices['Pixel 5'];

/** Install a WS.send hook that captures only session data frames.
 *  We filter out:
 *   - JSON control messages (resize/mode/heartbeat)
 *   - WebSocket URLs that aren't /ws/<sessionId> (e.g., /ws/notify)
 *   - Terminal escape responses (ESC-prefixed) — xterm replies to shell
 *     queries like CSI Primary DA over the WS, which are unrelated to the
 *     user's typed input. */
function swiftkeyInitScript() {
  return () => {
    window.__wtSends = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try {
        const url = this.url || '';
        if (typeof data === 'string'
            && !data.startsWith('{')
            && data !== 'ping'
            && !data.startsWith('\x1b')   // terminal control reply
            && /\/ws\/[^\/]+$/.test(url.replace(/\?.*$/, ''))) {
          window.__wtSends.push(data);
        }
      } catch {}
      return origSend.call(this, data);
    };
  };
}

async function waitForTerminal(page, timeoutMs = 15000) {
  await page.waitForSelector('.xterm-screen', { state: 'visible', timeout: timeoutMs });
  await page.waitForTimeout(400);
}

async function waitForAppReady(page, timeoutMs = 15000) {
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: timeoutMs });
  // Status chip goes to "connected" once the session WS handshake completes
  await page.waitForFunction(() => {
    const s = document.getElementById('status');
    return s && (s.textContent || '').toLowerCase().includes('connected');
  }, { timeout: timeoutMs }).catch(() => {});
  // Let initial server-side prompt output settle
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__wtSends = []; });
}

async function drainSends(page, waitMs = 400) {
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const out = [...window.__wtSends];
    window.__wtSends = [];
    return out;
  });
}

/**
 * Simulate SwiftKey's sequence of onData events: N single taps followed by
 * a single chunk containing the committed (possibly autocorrected) word.
 *
 * term.input(data, wasUserInput=true) is the exact path xterm.js invokes
 * internally after parsing textarea input events, so driving it directly
 * reproduces the same onData sequence our mobile dedup sees in production.
 */
async function simulateSwiftKey(page, singles, committed) {
  await page.evaluate(async ({ singles, committed }) => {
    const term = window.term;
    if (!term) throw new Error('term not exposed on window');
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    for (const c of singles) {
      term.input(c, true);
      await delay(30);
    }
    await delay(20);
    term.input(committed, true);
    await delay(40);
  }, { singles, committed });
}

test.describe('Mobile SwiftKey duplicate text (#8)', () => {
  let apiCtx;
  let sessionId;

  test.beforeAll(async () => {
    apiCtx = await authCtx();
    const res = await apiCtx.post('/api/sessions', { data: { name: 'swiftkey-test' } });
    expect(res.status()).toBe(200);
    sessionId = (await res.json()).id;
  });

  test.afterAll(async () => {
    if (sessionId) {
      try { await apiCtx.delete(`/api/sessions/${sessionId}`); } catch {}
    }
    if (apiCtx) await apiCtx.dispose();
  });

  async function openMobilePage(browser) {
    const context = await browser.newContext({ ...pixel5 });
    await context.addInitScript(swiftkeyInitScript());
    const page = await context.newPage();
    await loginPage(page);
    await page.goto(`${BASE}/app/${sessionId}`);
    await waitForTerminal(page);
    await waitForAppReady(page);
    // Sanity-check mobile detection
    const isMobile = await page.evaluate(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 600);
    expect(isMobile).toBe(true);
    return { context, page };
  }

  test('composition re-send of short word (2 chars) is suppressed', async ({ browser }) => {
    const { context, page } = await openMobilePage(browser);
    await simulateSwiftKey(page, ['h', 'i'], 'hi');
    const sends = await drainSends(page);
    const joined = sends.join('');
    console.log('[hi] sends=', JSON.stringify(sends));
    expect(joined).toBe('hi');
    await context.close();
  });

  test('composition re-send of medium word (5 chars) is suppressed', async ({ browser }) => {
    const { context, page } = await openMobilePage(browser);
    await simulateSwiftKey(page, ['h', 'e', 'l', 'l', 'o'], 'hello');
    const sends = await drainSends(page);
    const joined = sends.join('');
    console.log('[hello] sends=', JSON.stringify(sends));
    expect(joined).toBe('hello');
    await context.close();
  });

  test('autocorrect (typed "teh", committed "the") corrects in place', async ({ browser }) => {
    // The user sees "teh" on screen, then SwiftKey autocorrects to "the".
    // Fix: emit backspaces to erase the typed form on the server, then send
    // the corrected chunk. Bytes on the wire may include control chars, but
    // the net effect on the server's PTY is that the word appears once, in
    // its corrected form.
    const { context, page } = await openMobilePage(browser);
    await simulateSwiftKey(page, ['t', 'e', 'h'], 'the');
    const sends = await drainSends(page);
    const joined = sends.join('');
    console.log('[teh->the] sends=', JSON.stringify(sends));
    // Must not be the buggy concatenation
    expect(joined).not.toBe('tehthe');
    // The joined byte stream should include the corrected word and enough
    // backspaces to erase the typed form. Applying \b (erase-previous) to
    // the stream yields exactly the corrected word.
    let simulatedScreen = '';
    for (const ch of joined) {
      if (ch === '\b') simulatedScreen = simulatedScreen.slice(0, -1);
      else simulatedScreen += ch;
    }
    expect(simulatedScreen).toBe('the');
    await context.close();
  });

  test('composition re-send exactly matching singles is suppressed', async ({ browser }) => {
    // Lowercase "hi" typed then "hi" committed: classic duplication case
    // from the user's screenshot (a. , . etc. after typed sequences).
    const { context, page } = await openMobilePage(browser);
    await simulateSwiftKey(page, ['c', 'a', 't'], 'cat');
    const sends = await drainSends(page);
    expect(sends.join('')).toBe('cat');
    await context.close();
  });

  test('normal single-char typing still reaches server (no false-positive dedup)', async ({ browser }) => {
    // No composition re-send — just individual characters. All must arrive.
    const { context, page } = await openMobilePage(browser);
    await page.evaluate(async () => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      for (const c of 'abcde') {
        window.term.input(c, true);
        await delay(50);
      }
    });
    const sends = await drainSends(page);
    expect(sends.join('')).toBe('abcde');
    await context.close();
  });

  test('paste-like large chunk without preceding singles is NOT suppressed', async ({ browser }) => {
    // A programmatic chunk with no prior singles must pass through (the
    // dedup should only suppress chunks that follow recent single-char typing).
    const { context, page } = await openMobilePage(browser);
    await page.evaluate(() => {
      window.term.input('echo hello world', true);
    });
    const sends = await drainSends(page);
    expect(sends.join('')).toBe('echo hello world');
    await context.close();
  });

  test('composition after long idle gap is NOT suppressed', async ({ browser }) => {
    // If the user types a few chars, then pauses several seconds and then
    // a standalone chunk arrives (e.g. paste), it's NOT autocorrect re-send.
    const { context, page } = await openMobilePage(browser);
    await page.evaluate(async () => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      window.term.input('l', true);
      await delay(30);
      window.term.input('s', true);
      // Long idle gap — beyond the autocorrect window
      await delay(3500);
      window.term.input('echo world', true);
    });
    const sends = await drainSends(page, 600);
    console.log('[idle gap] sends=', JSON.stringify(sends));
    expect(sends.join('')).toBe('lsecho world');
    await context.close();
  });
});
