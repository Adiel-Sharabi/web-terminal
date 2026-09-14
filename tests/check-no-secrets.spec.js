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

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'check-no-secrets.js');

// Matches the gate's Anthropic-key rule without this file ever containing that prefix —
// naming it in a comment would be enough to turn the whole repo permanently red.
const FAKE_KEY = ['sk', 'ant', 'x'.repeat(24)].join('-');

// NOT ignored by any rule in .gitignore — asserted below, not assumed.
const UNTRACKED_PROBE = 'wt260-untracked-scan-probe.txt';
// Ignored by `.tmp-*` — also asserted below.
const IGNORED_PROBE = '.tmp-wt260-ignored-scan-probe.txt';

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
  const m = out.match(/\+ (\d+) untracked files/);
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
  test.beforeEach(() => { rm(UNTRACKED_PROBE); rm(IGNORED_PROBE); });
  test.afterEach(() => { rm(UNTRACKED_PROBE); rm(IGNORED_PROBE); });

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

  test('--diff mode still reports a scope of its own', () => {
    // The scope string was added to BOTH branches. A missed one would print
    // `OK — scanned undefined, ...` and nothing else in the suite would notice.
    const r = runGate(['--diff', 'HEAD']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('added lines vs HEAD');
    expect(r.out).not.toContain('undefined');
  });
});
