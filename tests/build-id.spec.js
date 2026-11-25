// @ts-check
// A build is named by its commit hash + commit date, not by a number bumped per change
// (lib/build-id.js). This pins what that means: the identity is read from git at start,
// "same build" is a strict rule, the CLI that proves a reload reports it, and nothing
// brings the per-change changelog back onto the version line (the line two open PRs
// used to conflict on).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const { readBuildId, sameBuild, UNKNOWN } = require('../lib/build-id');
const { authCtx, BASE } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');

function git(cwd, args, dateIso) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  if (dateIso) { env.GIT_AUTHOR_DATE = dateIso; env.GIT_COMMITTER_DATE = dateIso; }
  return execFileSync('git', args, { cwd, encoding: 'utf8', env, windowsHide: true }).trim();
}

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-buildid-'));
  git(dir, ['init', '-q']);
  return dir;
}

function dropDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* read-only git objects on Windows: a temp dir, left for the OS */ }
}

test.describe('lib/build-id - the identity of a build', () => {
  test('reads the abbreviated hash and the date of the HEAD commit', () => {
    const dir = scratchRepo();
    try {
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'first'], '2026-01-02T03:04:05+0200');
      const id = readBuildId(dir);
      expect(id.hash).toBe(git(dir, ['rev-parse', '--short', 'HEAD']));
      // The COMMIT date, in git's own `%ci` shape - a stable answer for one commit, which a
      // wall-clock "built at" would not be.
      expect(id.date).toBe('2026-01-02 03:04:05 +0200');
    } finally { dropDir(dir); }
  });

  test('a read follows HEAD - it is the server that reads once, at start', () => {
    const dir = scratchRepo();
    try {
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'first'], '2026-01-02T03:04:05+0200');
      const first = readBuildId(dir);
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'second'], '2026-02-03T04:05:06+0200');
      const second = readBuildId(dir);
      expect(second.hash).not.toBe(first.hash);
      expect(second.date).toBe('2026-02-03 04:05:06 +0200');
    } finally { dropDir(dir); }
  });

  test('answers unknown, never throws, when git cannot say', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-buildid-none-'));
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    // Never let git walk up out of the scratch dir into whatever repo holds the temp dir.
    process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
    try {
      expect(readBuildId(dir)).toEqual(UNKNOWN);                 // not a repository
      expect(readBuildId(path.join(dir, 'missing'))).toEqual(UNKNOWN); // no such directory
      git(dir, ['init', '-q']);
      expect(readBuildId(dir)).toEqual(UNKNOWN);                 // a repository with no commit yet
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = prev;
      dropDir(dir);
    }
    expect(UNKNOWN.hash).toBe('unknown');
    expect(UNKNOWN.date).toBe('');
  });

  test('sameBuild: an abbreviation of the same commit matches, "could not tell" never does', () => {
    const full = 'aabbccddeeff00112233445566778899aabbccdd';
    expect(sameBuild(full.slice(0, 7), full)).toBe(true);
    expect(sameBuild(full, full.slice(0, 12))).toBe(true);
    expect(sameBuild(full.slice(0, 7).toUpperCase(), full)).toBe(true);
    expect(sameBuild('aabbccd', 'aabbcce')).toBe(false);
    expect(sameBuild('aabbcc', 'aabbcc')).toBe(false);         // under 7 digits is not an identity
    expect(sameBuild('unknown', 'unknown')).toBe(false);       // two failures are not "the same"
    expect(sameBuild('', '')).toBe(false);
    expect(sameBuild(undefined, full)).toBe(false);
    expect(sameBuild(null, null)).toBe(false);
  });
});

test.describe('scripts/wt-build.js - the check that proves a reload took the new code', () => {
  let ctx;
  test.beforeAll(async () => {
    ctx = await authCtx();
    // The CLI authenticates with a token from the suite's own token store.
    expect((await ctx.post('/api/cluster/client-token', { data: { label: 'build-cli-spec' } })).status()).toBe(200);
  });
  test.afterAll(async () => { await ctx.dispose(); });

  const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wt-build.js'), ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, WT_SESSION_PORT: new URL(BASE).port, ...env },
  });

  test('--head: exit 0 when the server runs this checkout\'s commit, and it prints the build', () => {
    const r = cli(['--head']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const head = git(ROOT, ['rev-parse', '--short', 'HEAD']);
    expect(r.stdout).toContain(`running build ${head} of `);
    expect(r.stdout).toContain('matches');
  });

  test('--expect another commit: exit 1 and it says the server runs other code', () => {
    const head = git(ROOT, ['rev-parse', 'HEAD']);
    // A hash that is certainly not HEAD: flip the first digit.
    const other = (head[0] === '0' ? '1' : '0') + head.slice(1, 12);
    const r = cli(['--expect', other]);
    expect(r.status, r.stderr + r.stdout).toBe(1);
    expect(r.stdout).toContain('does NOT match');
  });

  test('no build asked for: prints the running build and exits 0', () => {
    const r = cli([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^running build [0-9a-f]{7,} of \S/);
  });

  test('could not ask: exit 2, never a pass', () => {
    const empty = path.join(os.tmpdir(), `wt-build-empty-${process.pid}.json`);
    fs.writeFileSync(empty, '{}');
    try {
      const r = cli(['--head'], { WT_API_TOKENS_FILE: empty });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('no unexpired API token');
      expect(cli(['--expect', 'not-a-hash']).status).toBe(2);
    } finally { fs.rmSync(empty, { force: true }); }
  });
});

test.describe('server.js - source gates', () => {
  const lines = () => fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split(/\r?\n/);

  // Collected as LINES and asserted on those: a failing `expect(src)` would print the whole
  // of server.js.
  test('the version line is a release number and a short note, never a changelog', () => {
    const v = lines().filter((l) => /^const SERVER_VERSION = /.test(l));
    expect(v.length).toBe(1);
    expect(v[0]).toMatch(/^const SERVER_VERSION = '\d+\.\d+\.\d+';/);
    // Every PR used to PREPEND its note to this line, so any two open PRs conflicted on it
    // and each re-merge cost a full CI run. Long notes belong in the PR and the commit.
    expect(v[0].length, 'SERVER_VERSION line grew; put the note in the PR, not on this line').toBeLessThan(400);
  });

  test('the build identity is read once, in lib/build-id.js - the server never re-reads HEAD', () => {
    const code = lines()
      .filter((l) => !/^\s*\/\//.test(l))
      .map((l) => l.replace(/\s\/\/.*$/, ''));
    expect(code.some((l) => l.includes("require('./lib/build-id')"))).toBe(true);
    // A hash refreshed from the checkout names the pulled commit while the old code still
    // runs, so "running hash == HEAD" would pass for a server that was never reloaded.
    const rereads = code.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /'--short'|'rev-parse'[^\n]*'HEAD'/.test(l));
    expect(rereads.map(({ l, n }) => `server.js:${n}  ${l.trim().slice(0, 100)}`)).toEqual([]);
  });
});
