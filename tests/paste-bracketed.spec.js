// @ts-check
// Client-side multi-line paste must use bracketed paste even when xterm's
// tracked bracketed-paste mode is OFF (the app's ESC[?2004h scrolled out of
// the replayed scrollback). Otherwise the embedded CRs each act as Enter and
// only the last line survives in the receiving app (e.g. Claude Code).
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Desktop multi-line paste brackets when mode is off', () => {
  test.beforeEach(async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/app');
    await page.waitForTimeout(400);
  });

  test('mode OFF + multi-line → explicit bracketed paste with all lines', async ({ page }) => {
    const cap = await page.evaluate(async () => {
      const orig = window.sendInput;
      const seen = [];
      window.sendInput = (data) => { seen.push(data); }; // capture, don't send
      try {
        window.term.write('\x1b[?2004l'); // app turned bracketed paste OFF (or never on)
        await new Promise(r => setTimeout(r, 30));
        const modeOff = !(window.term.modes && window.term.modes.bracketedPasteMode);
        window.pasteText('line one\r\nline two\r\nline three');
        await new Promise(r => setTimeout(r, 30));
        return { modeOff, seen };
      } finally {
        window.sendInput = orig;
      }
    });
    expect(cap.modeOff).toBe(true);
    // Exactly one bracketed block containing every line (CR-separated).
    expect(cap.seen).toContain('\x1b[200~line one\rline two\rline three\x1b[201~');
  });

  test('mode ON + multi-line → xterm.paste still produces a bracketed block', async ({ page }) => {
    const cap = await page.evaluate(async () => {
      const orig = window.sendInput;
      const seen = [];
      window.sendInput = (data) => { seen.push(data); };
      try {
        window.term.write('\x1b[?2004h'); // app enabled bracketed paste
        await new Promise(r => setTimeout(r, 30));
        const modeOn = !!(window.term.modes && window.term.modes.bracketedPasteMode);
        window.pasteText('a\r\nb\r\nc');
        await new Promise(r => setTimeout(r, 30));
        return { modeOn, seen };
      } finally {
        window.sendInput = orig;
      }
    });
    expect(cap.modeOn).toBe(true);
    // xterm.paste wraps it; the whole multi-line block arrives in one piece.
    const joined = cap.seen.join('');
    expect(joined.includes('\x1b[200~')).toBe(true);
    expect(joined.includes('\x1b[201~')).toBe(true);
    expect(joined.includes('a\rb\rc')).toBe(true);
  });

  test('single-line paste is not forced through bracketing', async ({ page }) => {
    const cap = await page.evaluate(async () => {
      const orig = window.sendInput;
      const seen = [];
      window.sendInput = (data) => { seen.push(data); };
      try {
        window.term.write('\x1b[?2004l');
        await new Promise(r => setTimeout(r, 30));
        window.pasteText('just one line');
        await new Promise(r => setTimeout(r, 30));
        return seen;
      } finally {
        window.sendInput = orig;
      }
    });
    // Mode off + single line → goes through term.paste, which (mode off) sends
    // the raw text with no bracketed-paste markers added by us.
    const joined = cap.join('');
    expect(joined.includes('just one line')).toBe(true);
    expect(joined.includes('\x1b[200~')).toBe(false);
  });
});
