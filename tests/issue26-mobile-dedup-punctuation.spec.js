// @ts-check
// Issue #26: on mobile, typing "hello." causes "hello.hello." in the terminal
// because _mobileIsWordChar excluded '.' and ',', so the word buffer reset
// the instant the punctuation arrived — and the immediately-following
// compositionend chunk ("hello.") then looked unrelated and was passed through.
// We now keep trailing punctuation in the word buffer so the chunk-dedup
// recognizes the re-send.
const { test, expect } = require('@playwright/test');
const { BASE, loginPage } = require('./test-helpers');

test.describe('Issue #26: mobile dedup recognizes trailing punctuation', () => {
  test.beforeEach(async ({ page }) => {
    await loginPage(page);
    await page.goto(BASE + '/app');
    // Let init() run and register the window hook.
    await page.waitForTimeout(300);
  });

  test('isWordChar includes letters, digits, and trailing punctuation', async ({ page }) => {
    const chars = await page.evaluate(() => {
      const ic = window.__wtMobileDedup.isWordChar;
      return {
        a: ic('a'), Z: ic('Z'), zero: ic('0'), apostrophe: ic("'"),
        dot: ic('.'), comma: ic(','), bang: ic('!'), q: ic('?'), semi: ic(';'), colon: ic(':'),
        space: ic(' '), slash: ic('/'), dash: ic('-'),
      };
    });
    expect(chars.a).toBe(true);
    expect(chars.Z).toBe(true);
    expect(chars.zero).toBe(true);
    expect(chars.apostrophe).toBe(true);
    expect(chars.dot).toBe(true);
    expect(chars.comma).toBe(true);
    expect(chars.bang).toBe(true);
    expect(chars.q).toBe(true);
    expect(chars.semi).toBe(true);
    expect(chars.colon).toBe(true);
    // Space must still break words (otherwise multi-word chunks get confused).
    expect(chars.space).toBe(false);
    expect(chars.slash).toBe(false);
    expect(chars.dash).toBe(false);
  });

  test('chunk "hello." after typing "hello." is suppressed', async ({ page }) => {
    const result = await page.evaluate(() => {
      const m = window.__wtMobileDedup;
      m.reset();
      // Simulate six single-char onData calls that build the word buffer.
      // (We call setWord to mirror what _mobileHandleChunk would see.)
      m.setWord('hello.');
      const out = m.handleChunk('hello.', Date.now());
      return { out, word: m.getWord() };
    });
    expect(result.out).toBe(''); // exact-match case: chunk suppressed.
    expect(result.word).toBe(''); // buffer reset after the match.
  });

  test('chunk "hi," after typing "hi," is suppressed', async ({ page }) => {
    const out = await page.evaluate(() => {
      const m = window.__wtMobileDedup;
      m.reset();
      m.setWord('hi,');
      return m.handleChunk('hi,', Date.now());
    });
    expect(out).toBe('');
  });

  test('autocorrect: typing "teh" and chunk "the" still triggers backspace-rewrite', async ({ page }) => {
    const out = await page.evaluate(() => {
      const m = window.__wtMobileDedup;
      m.reset();
      m.setWord('teh');
      return m.handleChunk('the', Date.now());
    });
    // Expected: erase 3 chars + send corrected form.
    expect(out).toBe('\b\b\bthe');
  });

  test('unrelated chunk after a word is not mangled (pass-through)', async ({ page }) => {
    const out = await page.evaluate(() => {
      const m = window.__wtMobileDedup;
      m.reset();
      m.setWord('hi');
      // Entirely different content; lengths differ by > 3 so no autocorrect
      // heuristic collision.
      return m.handleChunk('completely different text', Date.now());
    });
    expect(out).toBe('completely different text');
  });

  test('stale word (older than MOBILE_CHUNK_GAP_MS) does not match a later chunk', async ({ page }) => {
    const out = await page.evaluate(() => {
      const m = window.__wtMobileDedup;
      m.reset();
      m.setWord('hello.');
      // Simulate 2s of idle before the chunk arrives — beyond the 500ms gap.
      return m.handleChunk('hello.', Date.now() + 2000);
    });
    expect(out).toBe('hello.'); // pass-through, nothing suppressed.
  });
});
