// @ts-check
// Copy / paste / paste-image shortcuts must work under a non-Latin keyboard
// layout (Hebrew, Russian, …). Under such layouts e.key is the layout's
// character (the Hebrew letter on the V/C key), not 'v'/'c', so matching on
// e.key alone breaks the shortcut. The handler now also matches the physical
// key via e.code ('KeyV'/'KeyC'), which is layout-independent.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

// Hebrew letters that sit on the physical V and C keys on a standard layout.
const HEB_ON_V = 'ה'; // ה
const HEB_ON_C = 'ב'; // ב

test.describe('Copy/paste shortcuts under Hebrew layout', () => {
  test.beforeEach(async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(400);
  });

  test('Ctrl+V (Hebrew layout) pastes via the clipboard', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const calls = [];
      const origPaste = window.pasteText;
      window.pasteText = (t) => { calls.push(t); };
      // Make the clipboard return a known value synchronously-ish.
      const origRead = navigator.clipboard.readText;
      navigator.clipboard.readText = async () => 'CLIP-CONTENT';
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ה', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 60));
        return calls;
      } finally {
        window.pasteText = origPaste;
        navigator.clipboard.readText = origRead;
      }
    });
    expect(res).toContain('CLIP-CONTENT');
  });

  test('Ctrl+C (Hebrew layout) copies the current selection', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const calls = [];
      const origCopy = window.copyToClipboard;
      window.copyToClipboard = (t) => { calls.push(t); };
      const term = window.term;
      const origHas = term.hasSelection, origGet = term.getSelection, origClear = term.clearSelection;
      term.hasSelection = () => true;
      term.getSelection = () => 'SELECTED-TEXT';
      term.clearSelection = () => {};
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ב', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 60));
        return calls;
      } finally {
        window.copyToClipboard = origCopy;
        term.hasSelection = origHas; term.getSelection = origGet; term.clearSelection = origClear;
      }
    });
    expect(res).toContain('SELECTED-TEXT');
  });

  test('Alt+V (Hebrew layout) triggers image paste', async ({ page }) => {
    const res = await page.evaluate(async () => {
      let called = 0;
      const origUpload = window.uploadClipboardImage;
      window.uploadClipboardImage = () => { called++; };
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ה', code: 'KeyV', altKey: true, bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 60));
        return called;
      } finally {
        window.uploadClipboardImage = origUpload;
      }
    });
    expect(res).toBe(1);
  });

  test('a plain Hebrew key (no modifier) is NOT hijacked as a shortcut', async ({ page }) => {
    const res = await page.evaluate(async () => {
      let pasted = 0, copied = 0, img = 0;
      const op = window.pasteText, oc = window.copyToClipboard, ou = window.uploadClipboardImage;
      window.pasteText = () => { pasted++; };
      window.copyToClipboard = () => { copied++; };
      window.uploadClipboardImage = () => { img++; };
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        // Typing ה with no Ctrl/Alt must behave like normal text input.
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ה', code: 'KeyV', bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 40));
        return { pasted, copied, img };
      } finally {
        window.pasteText = op; window.copyToClipboard = oc; window.uploadClipboardImage = ou;
      }
    });
    expect(res).toEqual({ pasted: 0, copied: 0, img: 0 });
  });
});
