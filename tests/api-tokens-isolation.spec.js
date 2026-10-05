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
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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

test.describe('#272 the test server mints into its OWN token store', () => {
  // Serial WITHIN this describe only: the redirect check gates the mint below.
  test.describe.configure({ mode: 'serial' });

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

      // The point. Absent stays absent (CI, a fresh checkout); present stays the
      // same size with the same mtime — with ONE tolerated exception. A production
      // server sharing this checkout rewrites its own store when an EXPIRED token
      // is presented to it (`verifyApiToken` prunes it), which SHRINKS the file. The
      // leak under test is a MINT, which can only GROW it, so a strictly smaller
      // file is someone else's prune, never this suite — and a leaked mint still
      // fails. (Production MINTING in the same sub-second window would false-fail;
      // that is rare enough to accept rather than open the file to tell them apart.)
      const after = statOf(PROD_STORE);
      expect(after.exists, 'the suite must not CREATE a production api-tokens.json')
        .toBe(before.exists);
      if (after.exists && (after.size !== before.size || after.mtimeMs !== before.mtimeMs)) {
        expect(after.size, 'the production api-tokens.json GREW while the suite minted a token')
          .toBeLessThan(before.size);
      }
    } finally {
      if (token) await ctx.delete(`/api/auth/tokens/${encodeURIComponent(token)}`).catch(() => {});
      await ctx.dispose();
    }
  });
});

// The reset that makes #240 and #272 hold lives in the webServer COMMAND
// (scripts/reset-test-run-files.js). Without these, reverting the command to
// `node server.js` or deleting the script's guards leaves the whole suite green
// while both leaks silently reopen.
test.describe('#240/#272 the start-of-run reset is wired, guarded and refuses production', () => {
  const SCRIPT = path.join(ROOT, 'scripts', 'reset-test-run-files.js');

  /** A scratch tree OUTSIDE the checkout — the refusal is never driven against ROOT. */
  function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reset-'));
    // Not merely "not the root": not anywhere INSIDE the repo either.
    const rel = path.relative(path.resolve(ROOT), path.resolve(dir));
    expect(rel === '' || !(rel.startsWith('..') || path.isAbsolute(rel)),
      `scratch dir ${dir} must be outside the checkout`).toBe(false);
    return dir;
  }

  /** Run the script with `env` layered over a copy WITHOUT any inherited WT_TEST. */
  function runReset(env) {
    const base = { ...process.env };
    delete base.WT_TEST;
    delete base.WT_API_TOKENS_FILE;
    delete base.WT_RESET_ROOT;
    return spawnSync(process.execPath, [SCRIPT], { env: { ...base, ...env }, encoding: 'utf8', windowsHide: true });
  }

  test('the webServer command runs the reset BEFORE server.js, with WT_TEST=1', () => {
    // The loaded config, not a regex over its source: this is what Playwright runs.
    const cfg = require('../playwright.config.js');
    const cmd = String(cfg.webServer && cfg.webServer.command);
    expect(cmd, 'the reset must run first and gate server.js with &&')
      .toMatch(/^node scripts[/\\]reset-test-run-files\.js && node server\.js$/);
    expect(cfg.webServer.env.WT_TEST, 'the script refuses to run without WT_TEST=1').toBe('1');
    expect(cfg.webServer.env.WT_API_TOKENS_FILE).toBe(process.env.WT_API_TOKENS_FILE);
  });

  test('a WT_RESET_ROOT left in the shell does NOT reach the real run', () => {
    // Re-load the config with the variable set, as a developer's shell would have it.
    // `...process.env` would carry it into the webServer, the reset would look for
    // config.test.json under that directory, and #240 would reopen with a green suite.
    const cfgPath = require.resolve('../playwright.config.js');
    const saved = process.env.WT_RESET_ROOT;
    process.env.WT_RESET_ROOT = path.join(os.tmpdir(), 'wt-reset-stray');
    delete require.cache[cfgPath];
    try {
      const cfg = require(cfgPath);
      expect(cfg.webServer.env.WT_RESET_ROOT, 'the webServer env must clear WT_RESET_ROOT').toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.WT_RESET_ROOT; else process.env.WT_RESET_ROOT = saved;
      delete require.cache[cfgPath];
    }
  });

  test('positive control: allowed, it removes both per-run files', () => {
    // Without this, the two refusals below would also pass against a script that
    // deletes nothing at all.
    const dir = scratch();
    try {
      fs.writeFileSync(path.join(dir, 'config.test.json'), '{}');
      fs.writeFileSync(path.join(dir, 'tokens.test.json'), '{}');
      const r = runReset({ WT_TEST: '1', WT_RESET_ROOT: dir, WT_API_TOKENS_FILE: path.join(dir, 'tokens.test.json') });
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(path.join(dir, 'config.test.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'tokens.test.json'))).toBe(false);
      expect(r.stderr).toContain('[test-reset] removed'); // stderr: what Playwright forwards
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without WT_TEST it exits non-zero and deletes nothing', () => {
    const dir = scratch();
    try {
      fs.writeFileSync(path.join(dir, 'config.test.json'), '{}');
      fs.writeFileSync(path.join(dir, 'tokens.test.json'), '{}');
      const r = runReset({ WT_RESET_ROOT: dir, WT_API_TOKENS_FILE: path.join(dir, 'tokens.test.json') });
      expect(r.status, r.stderr).not.toBe(0);
      expect(fs.existsSync(path.join(dir, 'config.test.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'tokens.test.json'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pointed at a production store it REFUSES: non-zero exit, file intact', () => {
    const dir = scratch();
    try {
      const fake = path.join(dir, 'api-tokens.json');   // a FAKE store, in scratch
      fs.writeFileSync(fake, '{"fake":true}');
      const r = runReset({ WT_TEST: '1', WT_RESET_ROOT: dir, WT_API_TOKENS_FILE: fake });
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('REFUSED');
      expect(fs.readFileSync(fake, 'utf8')).toBe('{"fake":true}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('WT_RESET_ROOT never NARROWS the refusal: the checkout store stays refused', () => {
    // A COPY of the script in <scratch>/co/scripts/, so <scratch>/co plays the checkout
    // and its api-tokens.json is a fake. The real checkout is never involved.
    const dir = scratch();
    try {
      const co = path.join(dir, 'co');
      const other = path.join(dir, 'other');
      fs.mkdirSync(path.join(co, 'scripts'), { recursive: true });
      fs.mkdirSync(other);
      const copy = path.join(co, 'scripts', 'reset-test-run-files.js');
      fs.copyFileSync(SCRIPT, copy);
      const fake = path.join(co, 'api-tokens.json');
      fs.writeFileSync(fake, '{"fake":true}');
      const base = { ...process.env };
      delete base.WT_TEST; delete base.WT_API_TOKENS_FILE; delete base.WT_RESET_ROOT;
      const r = spawnSync(process.execPath, [copy], {
        env: { ...base, WT_TEST: '1', WT_RESET_ROOT: other, WT_API_TOKENS_FILE: fake },
        encoding: 'utf8', windowsHide: true,
      });
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('REFUSED');
      expect(fs.readFileSync(fake, 'utf8')).toBe('{"fake":true}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
