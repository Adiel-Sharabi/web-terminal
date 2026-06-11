'use strict';
// Hardening for the git commands server.js runs to compute version / update
// info (hash, "behind", dirty). These are all read-only / automatic and must
// NEVER prompt for credentials.
//
// Why this exists: origin can be a private HTTPS remote. If the stored
// credential stops working (token expiry, repo rename, SSO), an interactive
// `git fetch`/`git pull` spawns git-credential-manager, which blocks forever
// waiting on a prompt in the headless service context. Node's execFile/execSync
// `timeout` only signals the direct git child — the git-remote-https /
// credential-manager grandchildren are orphaned and keep hanging. That leaks
// ~one .NET credential-manager process per refresh (every 5 min) until the box
// runs out of commit memory and everything — including this server — dies.
// (Postmortem 2026-06-10: 10,499 leaked processes, 236 GB committed.)
//
// Disabling prompts makes git fail fast (~1s) instead of hanging, so nothing
// can pile up. killTree() is defense-in-depth for any other stall.

const { execFile } = require('child_process');

// Inline -c flags so Git Credential Manager and the terminal never prompt,
// independent of the machine's global/system gitconfig.
const SAFE_CONFIG = ['-c', 'credential.interactive=false', '-c', 'credential.helper='];

// Prepend the no-prompt config flags to a git argv.
function gitSafeArgs(args) {
  return [...SAFE_CONFIG, ...(args || [])];
}

// Build an environment that also disables prompting at the env level (belt and
// suspenders with SAFE_CONFIG). Preserves the base env (PATH etc.).
function gitSafeEnv(base) {
  return {
    ...(base || process.env),
    GIT_TERMINAL_PROMPT: '0',   // never prompt for username/password on a tty
    GCM_INTERACTIVE: 'never',   // Git Credential Manager: never show UI / prompt
    GIT_OPTIONAL_LOCKS: '0',    // don't take locks for read-only info commands
  };
}

// Kill a whole process tree. execFile's own `timeout` signals only the direct
// child, which would orphan git's helper grandchildren — exactly the leak we
// are preventing. On Windows use taskkill /T while the parent is still alive so
// the descendants are mapped and killed too.
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
  } catch (e) { /* best effort */ }
}

// Run a hardened git command. Resolves to trimmed stdout, or null on any
// error / timeout. Never rejects, never prompts, never leaks a child tree.
function execGit(args, opts = {}) {
  const { cwd, timeoutMs = 3000 } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const child = execFile('git', gitSafeArgs(args), {
      cwd, encoding: 'utf8', windowsHide: true, env: gitSafeEnv(),
    }, (err, stdout) => finish(err ? null : String(stdout || '').trim()));
    // Own watchdog (don't use execFile's timeout — it won't kill the tree).
    const timer = setTimeout(() => { killTree(child.pid); finish(null); }, timeoutMs);
  });
}

module.exports = { SAFE_CONFIG, gitSafeArgs, gitSafeEnv, killTree, execGit };
