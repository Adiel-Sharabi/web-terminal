// Regression tests for lib/git-safe.js — the hardening that stops the
// version/update-check git calls from prompting for credentials.
//
// Postmortem (2026-06-10): server.js ran `git fetch --dry-run` every 5 min for
// the update badge. The private HTTPS remote's credential broke after a repo
// rename, so each fetch spawned git-credential-manager, which blocked forever
// on a prompt in the headless Session-0 service. execFile's timeout killed only
// the direct git child, orphaning the credential-manager tree — ~1 leaked .NET
// process per refresh until the machine hit 236 GB committed and died. These
// tests lock in: (a) every git invocation disables credential prompting, and
// (b) the watchdog kills the whole process tree so nothing can leak.

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SAFE_CONFIG, gitSafeArgs, gitSafeEnv, killTree, execGit } = require('../lib/git-safe');

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('SAFE_CONFIG disables credential prompting (the core fix)', () => {
  const joined = SAFE_CONFIG.join(' ');
  // GCM/terminal must never be allowed to prompt -> git fails fast instead of
  // hanging on a private remote with no usable credential.
  expect(joined).toContain('credential.interactive=false');
  expect(joined).toContain('credential.helper=');
});

test('gitSafeArgs prepends the no-prompt flags to every git argv', () => {
  const out = gitSafeArgs(['fetch', '--dry-run']);
  // flags come first, original args preserved after
  expect(out.slice(0, SAFE_CONFIG.length)).toEqual(SAFE_CONFIG);
  expect(out.slice(SAFE_CONFIG.length)).toEqual(['fetch', '--dry-run']);
  // handles empty / missing args without throwing
  expect(gitSafeArgs()).toEqual(SAFE_CONFIG);
});

test('gitSafeEnv disables prompts at the env level and preserves the base env', () => {
  const env = gitSafeEnv({ PATH: '/usr/bin', FOO: 'bar' });
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  expect(env.GCM_INTERACTIVE).toBe('never');
  expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  expect(env.PATH).toBe('/usr/bin');   // base preserved (git must still resolve)
  expect(env.FOO).toBe('bar');
});

test('execGit runs a normal local git command through the hardened path', async () => {
  // Proves the no-prompt flags do not break ordinary (non-network) git usage.
  const hash = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: path.join(__dirname, '..'), timeoutMs: 5000 });
  expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
});

test('execGit resolves to null on a git error instead of throwing', async () => {
  const out = await execGit(['rev-parse', '--verify', 'no-such-ref-xyzzy'], { cwd: path.join(__dirname, '..'), timeoutMs: 5000 });
  expect(out).toBeNull();
});

test('killTree terminates the target process', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true });
  await wait(300);
  expect(isAlive(child.pid)).toBe(true);
  killTree(child.pid);
  // poll for death
  for (let i = 0; i < 40 && isAlive(child.pid); i++) await wait(100);
  expect(isAlive(child.pid)).toBe(false);
});

// The actual leak was an orphaned *grandchild* (credential-manager). On Windows
// killTree uses `taskkill /T` to take down the whole tree. Verify a grandchild
// is killed before it can do its delayed work.
test('killTree kills the whole tree (grandchild cannot survive)', async () => {
  test.skip(process.platform !== 'win32', 'tree-kill semantics are Windows-specific (taskkill /T)');
  const marker = path.join(os.tmpdir(), `git-safe-tree-${process.pid}-${Date.now()}.txt`);
  try { fs.unlinkSync(marker); } catch {}
  // child spawns a detached grandchild that writes the marker after 6s
  const code = `const {spawn}=require('child_process');` +
    `spawn(process.execPath,['-e','setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"leaked"),6000)'],{detached:true,stdio:"ignore"});` +
    `setTimeout(()=>{},60000);`;
  const child = spawn(process.execPath, ['-e', code], { windowsHide: true });
  await wait(800);
  killTree(child.pid);
  await wait(7000); // past the grandchild's 6s write
  expect(fs.existsSync(marker)).toBe(false); // grandchild was killed -> never wrote
  try { fs.unlinkSync(marker); } catch {}
});
