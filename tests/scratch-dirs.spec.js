// @ts-check
// scripts/scratch-dirs.js — the one place that decides where the generated, disposable
// trees live (#80). Before this, three absolute paths were hard-coded across five files
// and C:\dev showed four web-terminal-ish siblings of real repos.
//
// The gate that matters is the LAST test: it fails the build if a hard-coded scratch
// path creeps back into the tooling, which is the only thing that keeps one owner from
// quietly becoming four again.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DIRS, PARENT, toPosix } = require('../scripts/scratch-dirs');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'scratch-dirs.js');

const run = (args, env = {}) => execFileSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
}).trim();

test('every scratch tree sits under one parent', () => {
  for (const [name, dir] of Object.entries(DIRS)) {
    expect(dir.startsWith(PARENT), `${name} (${dir}) is not under ${PARENT}`).toBe(true);
  }
});

test('the rig basename stays distinctive — rig.js globs process command lines with it', () => {
  // rig.js findRigPids() matches `*<basename(RIG)>*` against every node command line to
  // sweep orphans. `wt-rig` can never occur inside `web-terminal`, so that match can only
  // hit rig processes. Renaming it to plain `rig` would match any path containing "rig"
  // and the sweep could kill unrelated node processes — a real foot-gun, not a style nit.
  const base = path.basename(DIRS.rig);
  expect(base).toBe('wt-rig');
  expect('web-terminal'.includes(base)).toBe(false);
  expect(base.length).toBeGreaterThan(4);
});

test('WT_SCRATCH_DIR moves EVERY tree together, however many there are', () => {
  // Deliberately not a hard-coded count. The invariant is "one env var relocates
  // all of them", and pinning the number turns adding a legitimate new tree into
  // a red build that says nothing about the invariant — which is exactly what
  // happened when the codex-hook probe's dir was added.
  const out = run([], { WT_SCRATCH_DIR: path.join('D:', 'scratch') });
  const lines = out.split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBe(Object.keys(DIRS).length);
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines) expect(l.split('\t')[1]).toContain(path.join('D:', 'scratch'));
});

test('a per-tree env var still overrides just that one (WT_RIG_DIR back-compat)', () => {
  const out = run([], { WT_RIG_DIR: 'C:\\legacy\\wt-rig' });
  const map = Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')));
  expect(map.rig).toBe('C:\\legacy\\wt-rig');
  expect(map.winbuild).toContain('.wt-scratch');
});

test('--posix emits the form Git Bash needs', () => {
  expect(toPosix('C:\\dev\\.wt-scratch\\x')).toBe('/c/dev/.wt-scratch/x');
  expect(run(['winbuild', '--posix'])).toMatch(/^\/[a-z]\//);
  expect(run(['winbuild', '--posix'])).not.toContain('\\');
});

test('an unknown name fails loudly rather than printing a wrong path', () => {
  let code = 0;
  try { run(['bogus']); } catch (e) { code = e.status; }
  expect(code).toBe(1);
});

test('no tooling hard-codes a scratch path any more', () => {
  // The regression this pins: five files each owned their own absolute copy, so moving
  // the trees meant finding all five. Anything matching these must go through the SSOT.
  const files = [
    'scripts/rig/rig.js',
    'scripts/rig/verify-submit.js',
    'scripts/rig/verify-interrupt.js',
    'scripts/rig/verify-long-prompt.js',
    'scripts/rig/probe-drive-windows.ps1',
    'ai-terminal/scripts/build-windows.sh',
    'ai-terminal/scripts/build-probe-windows.sh',
  ];
  // A drive-rooted path ending in one of the scratch basenames, in code (not prose).
  const HARDCODED = /['"][A-Za-z]:[\\/]{1,2}dev[\\/]{1,2}(wt-rig|ai-terminal-winbuild|ai-terminal-probe)/i;
  const POSIX_HARDCODED = /['"]\/[a-z]\/dev\/(wt-rig|ai-terminal-winbuild|ai-terminal-probe)/i;

  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const line of src.split(/\r?\n/)) {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#')) continue;
      if (HARDCODED.test(line) || POSIX_HARDCODED.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  expect(offenders, `hard-coded scratch paths found:\n${offenders.join('\n')}`).toEqual([]);
});
