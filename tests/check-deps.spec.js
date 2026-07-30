// The preflight that keeps a cold restart from converting a wedged box into a dead one.
//
// 2026-07-30 (Home): production's node_modules was gutted by a worktree node_modules
// JUNCTION plus `rmdir /s` / `git worktree remove --force`, which follow the link and
// delete the target. Running processes kept serving from memory, so it stayed invisible
// for 21 hours. The cold restart then could not start the worker at all
// (`Cannot find module 'node-pty'`, exit 1), the monitor burned its 5-crash budget and
// exited, and the whole server went down. The check has to happen BEFORE the first kill.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkDeps, REQUIRED_MODULES } = require('../scripts/check-deps');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-deps.js');
const COLD_RESTART = path.join(__dirname, '..', 'scripts', 'cold-restart.ps1');

test.describe('checkDeps', () => {
  test('passes when every runtime dep loads', () => {
    const { ok, missing } = checkDeps();
    expect(missing).toEqual([]);
    expect(ok).toBe(true);
  });

  test('guards the three modules the worker and web actually need', () => {
    expect(REQUIRED_MODULES).toEqual(['node-pty', 'express', 'express-ws']);
  });

  test('reports the module that cannot load — the 2026-07-30 outage', () => {
    const { ok, missing } = checkDeps((name) => {
      if (name === 'node-pty') {
        const err = new Error("Cannot find module 'node-pty'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return require(name);
    });

    expect(ok).toBe(false);
    expect(missing.map((m) => m.name)).toEqual(['node-pty']);
    expect(missing[0].code).toBe('MODULE_NOT_FOUND');
  });

  // Resolution is not the same as loading: a package with a broken native binding
  // resolves fine and throws on require. That is why checkDeps loads for real.
  test('catches a load failure that is not MODULE_NOT_FOUND', () => {
    const { ok, missing } = checkDeps((name) => {
      if (name === 'node-pty') throw new Error('The specified module could not be found.');
      return require(name);
    });

    expect(ok).toBe(false);
    expect(missing[0].code).toBe('LOAD_FAILED');
  });

  test('CLI exits 0 on a healthy tree', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(out).toContain('deps OK');
  });
});

test.describe('cold-restart.ps1 wiring', () => {
  // The ordering IS the guard. A preflight that runs after the kill is worthless, so pin
  // it in the source rather than trusting a future edit to keep the order.
  test('aborts on bad deps before the first Stop-Process', () => {
    // Comment lines are stripped so the assertion measures the CODE order. (The header
    // and the preflight both mention Stop-Process in prose, which would otherwise match
    // ahead of the real kill.)
    const src = fs
      .readFileSync(COLD_RESTART, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    const check = src.indexOf('check-deps.js');
    const abort = src.indexOf('ABORTED - runtime deps not loadable');
    const kill = src.indexOf('Stop-Process');

    expect(check).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(check);
    expect(kill).toBeGreaterThan(abort);
  });

  // Measured on Office and XPS: /api/exec runs with a trimmed environment (passAllEnv
  // defaults false), so `Get-Command node` finds nothing there and a PATH-only lookup
  // skipped the preflight in exactly the case it exists for — a peer restart driven from
  // another machine, which is the documented practice.
  test('resolves node beyond PATH — the running server, then the default install', () => {
    const src = fs.readFileSync(COLD_RESTART, 'utf8');

    expect(src).toContain('ExecutablePath');
    expect(src).toMatch(/nodejs\\node\.exe/);
  });

  // Measured on Office: an /api/exec shell arrives with PATHEXT set to just ".CPL", and
  // PowerShell then refuses to run node.exe as a program ("Cannot run a document in the
  // middle of a pipeline") — so the preflight aborted a restart on a healthy peer.
  test('repairs a PATHEXT that lacks .EXE', () => {
    const src = fs.readFileSync(COLD_RESTART, 'utf8');

    expect(src).toContain('PATHEXT');
    expect(src).toMatch(/\$env:PATHEXT\s*=/);
  });

  // Only a real verdict may block a restart. A check that could not RUN leaves
  // LASTEXITCODE unset, and treating that as failure is what produced an abort with an
  // empty message on two healthy machines.
  test('a check that cannot run is skipped, not treated as a failure', () => {
    const src = fs.readFileSync(COLD_RESTART, 'utf8');

    const nullGuard = src.indexOf('$null -eq $LASTEXITCODE');
    const abort = src.indexOf('ABORTED - runtime deps not loadable');

    expect(nullGuard).toBeGreaterThan(-1);
    expect(nullGuard).toBeLessThan(abort);
  });

  test('-CheckOnly reports the preflight and kills nothing', async () => {
    test.skip(process.platform !== 'win32', 'PowerShell restart script is Windows-only');

    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', COLD_RESTART, '-CheckOnly'],
      { encoding: 'utf8', timeout: 25000 }
    );

    expect(out).toContain('preflight OK');
    expect(out).toContain('deps OK');
  });
});
