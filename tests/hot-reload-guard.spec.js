// @ts-check
// #579 - scripts/hot-reload.ps1 must refuse to kill a server.js that no monitor.js will
// respawn. On 2026-11-26 every machine carried an orphan server.js (left by the old
// /api/restart), the monitors had given up on their own web, and the hot reload that
// killed the orphans left five peers dark until each was cold-restarted by hand.
//
// Driven for real with -CheckOnly (which kills nothing) against stand-in processes whose
// command line names this checkout's server.js - the script matches on exactly that.
const { test, expect } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'hot-reload.ps1');
const SERVER_ARG = path.join(REPO, 'server.js'); // never executed: an argv string for -e

function runCheckOnly() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-CheckOnly'],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Spawn `node -e <code> <args...>` and read the first line it prints. */
function spawnNode(code, args) {
  const p = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const first = new Promise((resolve) => {
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i).trim()); });
  });
  return { p, first };
}

const IDLE = 'console.log(String(process.pid)); setInterval(() => {}, 1000)';
// A parent whose OWN command line carries "monitor.js", like the real `node monitor.js`.
const PARENT = `const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, ${JSON.stringify(SERVER_ARG)}], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
c.stdout.once('data', (d) => console.log(String(d).trim()));
setInterval(() => {}, 1000);`;

test.describe('#579 hot-reload.ps1 refuses an unsupervised server.js', () => {
  test.skip(process.platform !== 'win32', 'PowerShell deploy script');

  test('a server.js whose parent is not monitor.js is REFUSED and left running', async () => {
    const { p, first } = spawnNode(IDLE, [SERVER_ARG]);
    try {
      const pid = Number(await first);
      expect(pid).toBeGreaterThan(0);
      const r = runCheckOnly();
      expect(r.out).toMatch(/hot reload REFUSED/);
      expect(r.out).toContain(String(pid));
      expect(r.code).toBe(3);
      expect(alive(pid)).toBe(true);
    } finally { try { p.kill(); } catch {} }
  });

  test('a server.js under a monitor.js passes the guard (positive control)', async () => {
    const { p, first } = spawnNode(PARENT, ['monitor.js']);
    let child = 0;
    try {
      child = Number(await first);
      expect(child).toBeGreaterThan(0);
      const r = runCheckOnly();
      expect(r.out).not.toMatch(/REFUSED|ABORTED/);
      expect(r.out).toMatch(/would reload server\.js only/);
      expect(r.code).toBe(0);
      expect(alive(child)).toBe(true);
    } finally {
      try { if (child) process.kill(child); } catch {}
      try { p.kill(); } catch {}
    }
  });
});
