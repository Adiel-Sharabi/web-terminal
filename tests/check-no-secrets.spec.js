// @ts-check
// #260 — THE SECRETS GATE SCANNED ONLY TRACKED FILES, SO A NEW FILE WAS INVISIBLE TO IT.
//
// `scripts/check-no-secrets.js` selected its input with a bare `git ls-files`, which lists
// TRACKED files. A file that has not been `git add`ed was never opened — and that is
// exactly the file most likely to carry a token somebody pasted in to see something work.
// The gate failed OPEN and said so cheerfully: `OK — scanned 132759 lines`.
//
// PR #256 is the instance. The same commit was green locally and red in CI:
//
//   local:  OK — scanned 132759 lines, no secrets or machine-identifying data.
//   CI:     Potential secrets or machine-identifying data (2):
//             Anthropic API key: tests/cap-sample.spec.js:163
//             MagicDNS hostname: tests/cap-sample.spec.js:165
//
// Not two runs disagreeing — the local run never looked at the file. On the branch in CI
// everything was tracked, so it did.
//
// THE TRAP IN THE OBVIOUS FIX is the second test below, and it is the reason this file
// exists rather than a one-line change with no gate. `config.json`, `cluster-tokens.json`
// and `api-tokens.json` are gitignored and hold REAL credentials on every box in this
// fleet. A widening that dropped `--exclude-standard` would scan them and print their
// contents into a public CI log — this gate causing the leak it exists to prevent. So
// "an ignored file is NOT scanned" is asserted as hard as "an untracked file IS".
//
// ON VACUITY, stated rather than hoped. Both fixtures assert their own PRECONDITION
// against git before asserting anything about the gate: the untracked probe is confirmed
// untracked-and-not-ignored, the ignored probe is confirmed ignored. Without that, a
// `.gitignore` rule that happened to cover the probe's name would make the first test
// pass for the wrong reason forever — and `.tmp-*` is already in this repo's `.gitignore`,
// so that is a live hazard rather than a hypothetical one.
//
// The fake credential is ASSEMBLED, never written as a literal. This spec is itself
// scanned by the gate it tests, so a literal would make the whole repo permanently red —
// which is #256's own lesson arriving one layer out.
const { test, expect } = require('@playwright/test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'check-no-secrets.js');

// Matches the gate's Anthropic-key rule without this file ever containing that prefix —
// naming it in a comment would be enough to turn the whole repo permanently red.
const FAKE_KEY = ['sk', 'ant', 'x'.repeat(24)].join('-');

// NOT ignored by any rule in .gitignore — asserted below, not assumed.
const UNTRACKED_PROBE = 'wt260-untracked-scan-probe.txt';
// Ignored by `.tmp-*` — also asserted below.
const IGNORED_PROBE = '.tmp-wt260-ignored-scan-probe.txt';

// A NON-ASCII FILENAME, and the reason this spec exists twice over. Built from escapes
// so this source stays ASCII-only: a literal is invisible in a diff and is normalised in
// transit, which is the trap #190/#202 already paid for. Hebrew, because that is what
// this fleet actually types.
const NONASCII_PROBE = 'wt260-\u05e9\u05dc\u05d5\u05dd-scan-probe.txt';

/** Run the gate exactly as CI and the pre-commit flow do. */
function runGate(args = []) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function rm(name) {
  try { fs.unlinkSync(path.join(ROOT, name)); } catch (e) {}
}

/**
 * The untracked-file count out of the summary line, or null if it said nothing.
 *
 * A DELTA, never an absolute. A checkout legitimately carries untracked files — this
 * spec was one of them while it was being written — so an absolute expectation would be
 * a fact about somebody's working tree rather than about the gate.
 */
function untrackedCount(out) {
  // Matches the summary's parenthesised LISTED counts: "(496 tracked, 0 untracked)". The
  // wording changed in review of #261, when the line stopped mixing "read" and "listed" in
  // one phrase — and this helper returns null rather than 0 on a miss precisely so a
  // reworded summary shows up as a failed assertion instead of a silent zero that every
  // delta comparison would still satisfy.
  const m = out.match(/(\d+) untracked\)/);
  return m ? Number(m[1]) : null;
}

/** true when git's standard excludes cover this path. */
function isIgnored(name) {
  return spawnSync('git', ['check-ignore', '-q', '--', name],
    { cwd: ROOT, windowsHide: true }).status === 0;
}

/** true when git has this path in the index. */
function isTracked(name) {
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', name],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }).status === 0;
}

test.describe('#260 the secrets gate covers the working tree, not just the index', () => {
  test.beforeEach(() => { rm(UNTRACKED_PROBE); rm(IGNORED_PROBE); rm(NONASCII_PROBE); });
  test.afterEach(() => { rm(UNTRACKED_PROBE); rm(IGNORED_PROBE); rm(NONASCII_PROBE); });

  test('an untracked, unignored file is scanned — and the summary says how many', () => {
    // The tree as it stands, before the probe exists. Everything below is measured
    // against this rather than against a number.
    const before = runGate();
    expect(before.code, before.out).toBe(0);
    const baseline = untrackedCount(before.out);
    expect(baseline, `the summary must NAME its scope: ${before.out}`).not.toBe(null);

    // PRECONDITION, asserted: this probe is the case under test, not something git
    // quietly excludes. Both halves matter — ignored would make the secret test vacuous,
    // tracked would make it pass without the fix.
    fs.writeFileSync(path.join(ROOT, UNTRACKED_PROBE), 'nothing to see here\n', 'utf8');
    expect(isIgnored(UNTRACKED_PROBE),
      `${UNTRACKED_PROBE} must NOT be gitignored or this test proves nothing`).toBe(false);
    expect(isTracked(UNTRACKED_PROBE),
      `${UNTRACKED_PROBE} must NOT be tracked or this test proves nothing`).toBe(false);

    // First, clean: the file is counted, and the summary NAMES the scope it covered.
    // "scanned N lines" is what kept the blind spot invisible — a big number that implies
    // thoroughness and says nothing about which files it meant.
    const clean = runGate();
    expect(clean.code, clean.out).toBe(0);
    expect(untrackedCount(clean.out), `the probe must be counted: ${clean.out}`)
      .toBe(baseline + 1);

    // Now the regression itself. Before the fix this file was never opened, so the gate
    // exited 0 and printed OK.
    fs.writeFileSync(path.join(ROOT, UNTRACKED_PROBE), `token = "${FAKE_KEY}"\n`, 'utf8');
    const dirty = runGate();
    expect(dirty.code, `the gate must REFUSE an untracked file carrying a secret.\n${dirty.out}`).toBe(1);
    expect(dirty.out).toContain('Anthropic API key');
    expect(dirty.out).toContain(UNTRACKED_PROBE);
  });

  test('a GITIGNORED file is still not scanned — the trap in the obvious fix', () => {
    // The three files this protects are real. They are gitignored precisely because they
    // hold live credentials; the gate must never read them, and must never count them.
    for (const f of ['config.json', 'cluster-tokens.json', 'api-tokens.json']) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;   // CI has none of them
      expect(isIgnored(f), `${f} holds real credentials and MUST stay gitignored`).toBe(true);
    }

    const before = runGate();
    expect(before.code, before.out).toBe(0);
    const baseline = untrackedCount(before.out);
    expect(baseline, `the summary must NAME its scope: ${before.out}`).not.toBe(null);

    fs.writeFileSync(path.join(ROOT, IGNORED_PROBE), `token = "${FAKE_KEY}"\n`, 'utf8');
    expect(isIgnored(IGNORED_PROBE),
      `${IGNORED_PROBE} must BE gitignored or this test proves nothing`).toBe(true);

    const r = runGate();
    // Two assertions, because "no hit" alone would also be satisfied by a scan that read
    // the file and happened not to match. The unchanged count pins that it was never
    // even selected — which is the property the real credential files depend on.
    expect(r.code, `a gitignored file must not be scanned.\n${r.out}`).toBe(0);
    expect(untrackedCount(r.out), `an ignored file must not be counted: ${r.out}`)
      .toBe(baseline);
  });

  test('a file whose NAME is not ASCII is scanned - a quoted path is not a path', () => {
    // FOUND IN REVIEW OF THE #260 FIX, which had the defect it was written to remove.
    // `git ls-files` WITHOUT `-z` C-quotes any path carrying a non-ASCII byte, so this
    // name arrives as the 39-character string `"wt260-\\327\\251..."` - the quotes
    // are part of it - and `readFileSync` on that throws ENOENT. The catch swallowed it
    // and the file was STILL COUNTED in the untracked total, so the gate printed
    // `OK - scanned ... + 1 untracked files` over a file it had never opened.
    //
    // This is the load-bearing test for `-z`: remove that one flag and it goes red,
    // while every other test in this file stays green.
    fs.writeFileSync(path.join(ROOT, NONASCII_PROBE), `key: ${FAKE_KEY}\n`, 'utf8');

    expect(isIgnored(NONASCII_PROBE), 'the probe must not be gitignored or this proves nothing')
      .toBe(false);
    expect(isTracked(NONASCII_PROBE), 'the probe must be untracked or this proves nothing')
      .toBe(false);

    const r = runGate();
    expect(r.code, `a non-ASCII-named file carrying a key must FAIL the gate.\n${r.out}`)
      .toBe(1);
    expect(r.out).toContain('Anthropic API key');
    // The name must survive into the report too - a hit nobody can locate is half a gate.
    expect(r.out).toContain(NONASCII_PROBE);
  });

  test('a SUBMODULE gitlink is skipped, not treated as an unreadable file', () => {
    // A gate that reddens for a NON-SECURITY reason is one people learn to bypass, which
    // is worse than the hole it guards. `git ls-files` lists a submodule as a gitlink -
    // the DIRECTORY path, mode 160000 - and `readFileSync` on a directory throws EISDIR.
    // Since #261 made an unreadable file FATAL, that would hard-fail this gate on every
    // run the moment anyone adds a submodule. Measured: without the EISDIR branch this
    // exact scenario exits 1 with `.tmp-wt260-fake-sub (EISDIR)`.
    //
    // LATENT, NOT LIVE: this repo has no .gitmodules and no mode-160000 entry today, so
    // the case is constructed rather than observed - which is the whole reason to pin it
    // now, because the day it appears the symptom is a red gate nobody can explain.
    //
    // THE REAL INDEX IS NEVER TOUCHED. `GIT_INDEX_FILE` points git at a COPY, so the
    // gitlink exists only for the duration of this test. Anything else would be a test
    // that can corrupt the checkout it runs in - and other sessions share this tree.
    const dir = '.tmp-wt260-fake-sub';
    const tmpIndex = path.join(os.tmpdir(), `wt260-index-${process.pid}-${Date.now()}`);
    const abs = path.join(ROOT, dir);
    try {
      fs.mkdirSync(abs, { recursive: true });
      // ASK GIT WHERE THE INDEX IS; never assume `.git/index`. In a LINKED WORKTREE `.git`
      // is a FILE containing a gitdir pointer, and the index lives under the main repo at
      // `.git/worktrees/<name>/index` - so the hardcoded path throws ENOENT and this test
      // reddens for a reason that has nothing to do with secrets, which is precisely the
      // failure its own header warns about. Not hypothetical: this repo runs suites from
      // `.claude/worktrees/`, and one existed while this was being written. Same resolution
      // `git-freshness.spec.js` already uses for FETCH_HEAD. (Found in review of #261.)
      const gitPath = spawnSync('git', ['rev-parse', '--git-path', 'index'],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      expect(gitPath.status, `could not resolve the index path: ${gitPath.stderr}`).toBe(0);
      const realIndex = path.resolve(ROOT, gitPath.stdout.trim());
      expect(fs.existsSync(realIndex), `git named an index that is not there: ${realIndex}`)
        .toBe(true);
      fs.copyFileSync(realIndex, tmpIndex);

      const head = spawnSync('git', ['rev-parse', 'HEAD'],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
      const staged = spawnSync('git',
        ['update-index', '--add', '--cacheinfo', `160000,${head},${dir}`],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
      expect(staged.status, `could not stage the gitlink: ${staged.stderr}`).toBe(0);

      // The precondition, asserted rather than assumed: git really does list it.
      const listed = spawnSync('git', ['ls-files', '--stage'],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, GIT_INDEX_FILE: tmpIndex } }).stdout;
      // Split and compare rather than build a regex: the first cut of this asserted
      // `^160000 .* <dir>$` and went red on its own fixture, because `git ls-files --stage`
      // separates the stage number from the path with a TAB, not a space. The precondition
      // caught it, which is the argument for having one - but a string compare cannot have
      // that class of bug at all.
      const gitlinkRow = listed.split('\n')
        .some((l) => l.startsWith('160000') && l.trim().endsWith(dir));
      expect(gitlinkRow, `the fixture must actually be a mode-160000 gitlink.\n${listed.slice(0, 200)}`)
        .toBe(true);

      const r = spawnSync(process.execPath, [GATE], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      });
      const out = (r.stdout || '') + (r.stderr || '');
      expect(r.status, `a gitlink must not fail the gate.\n${out}`).toBe(0);
      // The summary says "directory entr(y|ies) skipped", NOT "gitlink": EISDIR is what the
      // read observed, while "submodule" is an inference about its cause, and an untracked
      // nested clone or a tracked file replaced by a directory lands there too (review of
      // #261). Asserting the observed label keeps the test honest about the same thing the
      // gate is honest about.
      expect(out, 'the skip must be REPORTED, never silently dropped')
        .toContain('directory entr');
    } finally {
      try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) {}
      try { fs.unlinkSync(tmpIndex); } catch (e) {}
    }
  });

  test('--diff mode still reports a scope of its own', () => {
    // The scope string was added to BOTH branches. A missed one would print
    // `OK — scanned undefined, ...` and nothing else in the suite would notice.
    const r = runGate(['--diff', 'HEAD']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('added lines vs HEAD');
    expect(r.out).not.toContain('undefined');
  });
});
