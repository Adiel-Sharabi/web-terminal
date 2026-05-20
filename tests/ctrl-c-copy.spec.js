// @ts-check
// Regression: copying with Ctrl+C silently failed when the terminal was
// opened over plain HTTP (LAN / tailscale IP). navigator.clipboard is
// undefined in non-secure contexts, so the copy key handler threw before it
// could return false — Ctrl+C then leaked through to the shell as SIGINT, and
// two of them exited Claude. copyToClipboard() now falls back to a
// temp-textarea + execCommand('copy') and never throws, so the first Ctrl+C
// copies (when there is a selection) and only a subsequent one sends SIGINT.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Ctrl+C copy works in non-secure (plain HTTP) contexts', () => {
  test.beforeEach(async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(400); // let term.open + init settle
  });

  test('copyToClipboard does not throw and copies via execCommand when navigator.clipboard is undefined', async ({ page }) => {
    const result = await page.evaluate(() => {
      // Simulate a plain-HTTP / non-secure context.
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const origExec = document.execCommand;
      let copyArg = null, stagedText = null;
      document.execCommand = function (cmd) {
        if (cmd === 'copy') {
          copyArg = cmd;
          stagedText = document.activeElement && document.activeElement.value;
        }
        return true;
      };
      let threw = false;
      try { window.copyToClipboard('regression-payload-123'); }
      catch (e) { threw = true; }
      document.execCommand = origExec;
      delete navigator.clipboard;
      return { threw, copyArg, stagedText };
    });
    expect(result.threw).toBe(false);
    expect(result.copyArg).toBe('copy');           // fallback path was used
    expect(result.stagedText).toBe('regression-payload-123'); // correct text staged
  });

  test('copyToClipboard prefers navigator.clipboard.writeText when available', async ({ page }) => {
    const written = await page.evaluate(() => {
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
      window.copyToClipboard('secure-context-text');
      navigator.clipboard.writeText = orig;
      return captured;
    });
    expect(written).toBe('secure-context-text');
  });

  test('Ctrl+C with a selection copies and does NOT leak SIGINT to the terminal', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Non-secure context: no navigator.clipboard.
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const origExec = document.execCommand;
      let copyCount = 0;
      document.execCommand = function (cmd) { if (cmd === 'copy') copyCount++; return true; };

      const term = window.term;
      term.focus();
      term.write('selectable terminal text');
      await new Promise(r => setTimeout(r, 80));
      term.selectAll();

      let sent = '';
      const sub = term.onData(d => { sent += d; });

      // The KeyboardEvent constructor ignores keyCode/which, but xterm's
      // escape-sequence resolution needs keyCode 67 for the 'c' key.
      const ev = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { value: 67 });
      Object.defineProperty(ev, 'which', { value: 67 });
      document.querySelector('.xterm-helper-textarea').dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 80));

      sub.dispose();
      document.execCommand = origExec;
      delete navigator.clipboard;
      return { sent, copyCount };
    });
    expect(result.sent.includes('\x03')).toBe(false); // SIGINT not forwarded
    expect(result.copyCount).toBeGreaterThan(0);       // copy actually happened
  });

  test('Ctrl+C with no selection passes through as SIGINT (so a second press still interrupts)', async ({ page }) => {
    const sent = await page.evaluate(async () => {
      const term = window.term;
      term.focus();
      term.clearSelection();
      await new Promise(r => setTimeout(r, 40));

      let data = '';
      const sub = term.onData(d => { data += d; });

      const ev = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { value: 67 });
      Object.defineProperty(ev, 'which', { value: 67 });
      document.querySelector('.xterm-helper-textarea').dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 80));

      sub.dispose();
      return data;
    });
    expect(sent.includes('\x03')).toBe(true);
  });
});
