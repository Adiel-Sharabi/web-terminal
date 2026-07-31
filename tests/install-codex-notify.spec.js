// @ts-check
// scripts/install-codex-notify.js — writing the three [tui] keys that turn on Codex's
// in-band status channel, without disturbing a config.toml this repo does not own.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { patch } = require('../scripts/install-codex-notify');

const INSTALLER = path.join(__dirname, '..', 'scripts', 'install-codex-notify.js');
const COLD_RESTART = path.join(__dirname, '..', 'scripts', 'cold-restart.ps1');

// Run the installer as a REAL process against a throwaway CODEX_HOME. patch() unit tests
// prove the string surgery; this proves the thing the deploy path actually invokes.
function runInstaller(codexHome, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALLER, ...args], {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8', windowsHide: true,
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function tempCodexHome(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-codex-'));
  if (contents !== null) fs.writeFileSync(path.join(dir, 'config.toml'), contents, 'utf8');
  return dir;
}

const KEYS = ['notifications = true', 'notification_method = "osc9"', 'notification_condition = "always"'];
const tuiBlockOf = (s) => {
  const lines = s.split('\n');
  const i = lines.findIndex((l) => /^\s*\[tui\]\s*$/.test(l));
  if (i === -1) return null;
  let end = i + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return lines.slice(i, end).join('\n');
};

test('appends a [tui] section when there is none', () => {
  const src = 'model = "gpt-5.5"\n';
  const { text } = patch(src);
  expect(text).toContain('model = "gpt-5.5"');   // original preserved
  for (const k of KEYS) expect(tuiBlockOf(text)).toContain(k);
});

test('does NOT write into [tui.model_availability_nux] — a subtable is a different table', () => {
  // The trap: keys placed under [tui.x] belong to that subtable and Codex silently
  // ignores them, exactly like its camelCase hook keys. The real config on this
  // machine has this subtable and no bare [tui].
  const src = [
    'model = "gpt-5.5"', '',
    '[tui.model_availability_nux]', '"gpt-5.5" = 2', '',
  ].join('\n');
  const { text } = patch(src);

  const sub = text.split('[tui.model_availability_nux]')[1].split(/^\s*\[/m)[0];
  expect(sub).not.toContain('notification_method');
  expect(sub).toContain('"gpt-5.5" = 2');
  for (const k of KEYS) expect(tuiBlockOf(text)).toContain(k);
});

test('fills missing keys into an existing [tui] section without touching its others', () => {
  const src = ['[tui]', 'theme = "dark"', '', '[features]', 'x = true', ''].join('\n');
  const { text } = patch(src);
  const block = tuiBlockOf(text);
  expect(block).toContain('theme = "dark"');
  for (const k of KEYS) expect(block).toContain(k);
  expect(text).toContain('[features]');
  expect(text).toContain('x = true');
});

test('corrects a wrong value rather than duplicating the key', () => {
  // notification_condition defaults to "unfocused"; a PTY has no focus, so a config
  // left on the default emits nothing at all and looks like a broken feature.
  const src = ['[tui]', 'notifications = true', 'notification_method = "bel"',
    'notification_condition = "unfocused"', ''].join('\n');
  const { text, changed } = patch(src);
  const block = tuiBlockOf(text);
  expect(block).toContain('notification_method = "osc9"');
  expect(block).toContain('notification_condition = "always"');
  expect(block).not.toContain('"unfocused"');
  expect(block).not.toContain('"bel"');
  expect(changed.sort()).toEqual(['notification_condition', 'notification_method']);
  expect((block.match(/notification_method/g) || []).length).toBe(1);
});

test('is idempotent — a second run is a no-op', () => {
  const first = patch('model = "gpt-5.5"\n').text;
  const second = patch(first);
  expect(second.text).toBe(first);
  expect(second.added).toEqual([]);
  expect(second.changed).toEqual([]);
});

// --- The deploy path (#82) -------------------------------------------------------------
// The feature shipped in 1.45.0 and was inert on all three machines for over a week: the
// installer was a manual per-machine step, and an unconfigured box is SILENT rather than
// noisy, so nothing surfaced the gap. A cold restart is already required for this config
// to take effect, so that is where it belongs.

test('the cold restart applies the codex notify config', () => {
  const ps = fs.readFileSync(COLD_RESTART, 'utf8');
  expect(ps).toContain('install-codex-notify.js');
  // Applied before the relaunch, so the box comes back configured.
  expect(ps.indexOf('Invoke-CodexNotifyConfig)')).toBeLessThan(ps.indexOf('start-server.vbs'));
});

test('-CheckOnly reports config drift and still changes nothing', () => {
  const ps = fs.readFileSync(COLD_RESTART, 'utf8');
  const checkBlock = ps.slice(ps.indexOf('if ($CheckOnly)'), ps.indexOf('$procs = Get-CimInstance'));
  expect(checkBlock).toContain('Invoke-CodexNotifyConfig -Check');
  expect(checkBlock).toContain('codex notify config:');
});

test('applying the config is NON-FATAL when codex is not installed', () => {
  // A machine with no ~/.codex must never block a restart of the terminal server.
  // The installer exits non-zero, so cold-restart.ps1 has to swallow that verdict —
  // which it does by capturing output instead of testing $LASTEXITCODE.
  const home = tempCodexHome(null);
  const res = runInstaller(home);
  expect(res.code).not.toBe(0);
  expect(res.out).toMatch(/No Codex config/i);

  const ps = fs.readFileSync(COLD_RESTART, 'utf8');
  const at = ps.indexOf('function Invoke-CodexNotifyConfig');
  expect(at).toBeGreaterThan(-1);   // else the slice below is empty and asserts nothing
  const fn = ps.slice(at, ps.indexOf('if ($nodeExe) {'));
  expect(fn).not.toMatch(/exit\s+1/);
  expect(fn).not.toMatch(/LASTEXITCODE/);
});

test('a real run patches a real config.toml, and a second run rewrites nothing', () => {
  const home = tempCodexHome('model = "gpt-5.5"\n\n[tui.model_availability_nux]\n"gpt-5.5" = 2\n');
  const cfg = path.join(home, 'config.toml');

  expect(runInstaller(home).code).toBe(0);
  const after = fs.readFileSync(cfg, 'utf8');
  for (const k of KEYS) expect(tuiBlockOf(after)).toContain(k);
  expect(after).toContain('notify = ["node"');

  // One backup for the one real edit — the installer is touching a file this repo does
  // not own, so that is the point.
  const baks = () => fs.readdirSync(home).filter((f) => f.includes('.bak-wt-'));
  expect(baks()).toHaveLength(1);

  // Idempotence matters here specifically because this now runs on EVERY cold restart:
  // a second run must not rewrite the file, or every deploy litters another .bak beside
  // it and a year of deploys buries the real config in copies of itself.
  const second = runInstaller(home);
  expect(second.code).toBe(0);
  expect(second.out).toMatch(/already correct/i);
  expect(fs.readFileSync(cfg, 'utf8')).toBe(after);
  expect(baks()).toHaveLength(1);
});
