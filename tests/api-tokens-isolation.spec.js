// @ts-check
// #272 follow-up — the suite's server must never mint into the PRODUCTION token store.
//
// `server.js` resolved `api-tokens.json` beside itself with no override, so every
// Playwright run minted live, 90-day, full-access bearer tokens into the real store of
// whatever checkout it ran in: hundreds of `exec-test`, `client:companion:test-device`
// and `client:evilscript` entries, none ever revoked. `WT_API_TOKENS_FILE` now redirects
// the store and `playwright.config.js` points it at a gitignored per-run file.
//
// SERIAL ON PURPOSE. The first test is the cheap, side-effect-free check that the
// redirect is in place; if it fails, the second test — which MINTS a token — is skipped
// rather than run against a server that would write it into production. A gate that
// demonstrates the leak by causing it would be its own defect.
//
// The production file is compared by STAT ONLY (existence, size, mtime) and is never
// opened: it holds real credentials, and nothing in a test log should ever carry one.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { authCtx } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const PROD_STORE = path.resolve(ROOT, 'api-tokens.json');

/** Existence, size and mtime of a file — never its contents. */
function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('#272 the test server mints into its OWN token store', () => {
  test('the store is redirected, away from production, to a gitignored file', () => {
    const store = process.env.WT_API_TOKENS_FILE;
    expect(store, 'playwright.config.js must set WT_API_TOKENS_FILE').toBeTruthy();
    expect(path.resolve(String(store)).toLowerCase(),
      'the test store must not BE the production api-tokens.json')
      .not.toBe(PROD_STORE.toLowerCase());

    // A per-run credential file that is not ignored is one `git add .` from public.
    const rel = path.relative(ROOT, path.resolve(String(store)));
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, windowsHide: true });
    } catch { ignored = false; }
    expect(ignored, `${rel} must be gitignored`).toBe(true);

    // And the server must actually HONOUR it. The env var alone proves nothing if
    // server.js still joins `api-tokens.json` unconditionally — which is the bug.
    // A boolean, not `toMatch`: on failure `toMatch` prints the whole received
    // string, and server.js is ~700 KB.
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(/const API_TOKENS_FILE = process\.env\.WT_API_TOKENS_FILE\s*\|\|/.test(src),
      'server.js must resolve API_TOKENS_FILE from WT_API_TOKENS_FILE first').toBe(true);
  });

  test('minting a token writes the test store and leaves production untouched', async () => {
    const store = path.resolve(String(process.env.WT_API_TOKENS_FILE));
    const before = statOf(PROD_STORE);
    const ctx = await authCtx();
    let token = '';
    try {
      const res = await ctx.post('/api/cluster/client-token', {
        data: { label: 'api-tokens-isolation' },
      });
      expect(res.status()).toBe(200);
      token = (await res.json()).token;
      expect(typeof token).toBe('string');

      // Positive control: the token landed where the redirect says. Without this,
      // "production did not change" would also pass against a server that wrote
      // the token nowhere at all.
      const testStore = JSON.parse(fs.readFileSync(store, 'utf8'));
      expect(Object.prototype.hasOwnProperty.call(testStore, token),
        'the minted token must be in the redirected store').toBe(true);

      // The point. Absent stays absent (CI, a fresh checkout); present stays
      // byte-for-byte the same size with the same mtime. The real server on this
      // box can legitimately write its own store, but only on a mint or an expiry
      // prune, so a change inside this sub-second window is not expected noise.
      const after = statOf(PROD_STORE);
      expect(after, 'the production api-tokens.json must not be written by the suite')
        .toEqual(before);
    } finally {
      if (token) await ctx.delete(`/api/auth/tokens/${encodeURIComponent(token)}`).catch(() => {});
      await ctx.dispose();
    }
  });
});
