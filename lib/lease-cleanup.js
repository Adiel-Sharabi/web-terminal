'use strict';
// #412 - what a released lease cleans up: ONLY the processes, temp dirs and worktrees it
// recorded, on the machine that recorded them.
//
// Two rules, each of which has already cost this fleet production once:
//
//  - A process is killed BY PID, and only while its creation time still equals the one
//    read when it was recorded. Windows reuses pids, so a bare pid recorded on Monday can
//    name somebody else's process by Tuesday. Never by name, never by command line
//    (~/.claude/CLAUDE.md, the kill-by-name incident). Only that pid: no /T tree kill,
//    because Windows keeps a dead parent's pid in its children, and a reused parent pid
//    would hand us a tree that is not ours.
//  - A directory is removed by walking it with lstat, and a junction or symlink met on
//    the way is UNLINKED, never entered (CLAUDE.md: `rmdir /s` through a node_modules
//    junction gutted production). Only paths strictly inside a configured root, never a
//    real git repository (a `.git` DIRECTORY - a worktree has a `.git` FILE), never this
//    checkout, its parents or anything inside it. Checked when recorded and again when
//    removed: the tree may have changed in between.
//
// Every read that cannot be taken answers "unknown", and unknown keeps: a process whose
// start time could not be read is not killed, it is retried.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const QUERY_TIMEOUT_MS = 15000;
/** A tree bigger than this is not scanned to the end, so it cannot be proven repo-free:
 *  refused. A worktree with node_modules is ~100k entries. */
const SCAN_MAX_ENTRIES = 400000;
/** Pids below this are the kernel's (System is 4 on Windows, init is 1). */
const PID_MIN = 5;
const IS_WIN = process.platform === 'win32';

const norm = (p) => {
  const r = path.resolve(p);
  return IS_WIN ? r.toLowerCase() : r;
};
/** Is [child] strictly inside [parent]? Both normalised. */
const inside = (child, parent) => child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const sameOrRelated = (a, b) => a === b || inside(a, b) || inside(b, a);

// --- processes -------------------------------------------------------------------------

function _queryStartWindows(pid) {
  return new Promise((resolve) => {
    // [pid] is a validated integer: nothing a caller sent reaches the command text.
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; ` +
      'if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { \'NONE\' }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: QUERY_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve({ known: false });
        const out = String(stdout || '').trim();
        if (out === 'NONE') return resolve({ known: true, startMs: null });
        const ms = parseInt(out, 10);
        resolve(Number.isFinite(ms) ? { known: true, startMs: ms } : { known: false });
      });
  });
}

function _queryStartPosix(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: QUERY_TIMEOUT_MS }, (err, stdout) => {
      const out = String(stdout || '').trim();
      // ps exits 1 with no output for a pid that does not exist.
      if (err && !out && err.code === 1) return resolve({ known: true, startMs: null });
      if (err) return resolve({ known: false });
      const ms = Date.parse(out);
      resolve(Number.isFinite(ms) ? { known: true, startMs: ms } : { known: false });
    });
  });
}

let _queryForTests = null;
function _setStartQueryForTests(fn) { _queryForTests = fn; }

/** `{known:true, startMs}` (null when no such process) or `{known:false}` (could not tell). */
function processStart(pid) {
  if (_queryForTests) return Promise.resolve(_queryForTests(pid));
  return IS_WIN ? _queryStartWindows(pid) : _queryStartPosix(pid);
}

const validPid = (pid) => Number.isInteger(pid) && pid >= PID_MIN && pid <= 0x7fffffff;

/** Read [pid]'s creation time now, so release can tell it from a later process with the
 *  same number. Refuses a pid that is not running, a protected one (this server, its
 *  worker, its supervisor) and anything that is not a pid. */
async function recordPid(pid, { protectedPids = [] } = {}) {
  if (!validPid(pid)) return { ok: false, error: 'a pid must be a whole number' };
  if (protectedPids.includes(pid)) return { ok: false, error: `pid ${pid} is part of web-terminal itself` };
  const r = await processStart(pid);
  if (!r.known) return { ok: false, error: `could not read when pid ${pid} started; try again` };
  if (r.startMs === null) return { ok: false, error: `no process ${pid} is running` };
  return { ok: true, item: { pid, startMs: r.startMs } };
}

/** Kill one recorded process if it is still the one recorded.
 *  -> {result: 'killed' | 'gone' | 'reused' | 'unknown' | 'error'} */
async function killRecorded(item) {
  if (!item || !validPid(item.pid) || typeof item.startMs !== 'number') return { result: 'error', error: 'not a recorded process' };
  const r = await processStart(item.pid);
  if (!r.known) return { result: 'unknown' };
  if (r.startMs === null) return { result: 'gone' };
  if (r.startMs !== item.startMs) return { result: 'reused' };
  try {
    process.kill(item.pid);
    return { result: 'killed' };
  } catch (e) {
    if (e && e.code === 'ESRCH') return { result: 'gone' };
    return { result: 'error', error: e.message };
  }
}

// --- paths -----------------------------------------------------------------------------

/** The roots a recorded path may live under when config `leases.cleanupRoots` says
 *  nothing: the temp dir, and the folder that holds this checkout (where worktrees go,
 *  e.g. C:\dev\wt-412). */
function defaultRoots(checkoutDir) {
  return [os.tmpdir(), path.dirname(path.resolve(checkoutDir))];
}

async function _real(p) {
  try { return norm(await fsp.realpath(p)); } catch { return null; }
}

async function _lstat(p) {
  try { return await fsp.lstat(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

/** Walk [dir] without following links; true when a `.git` DIRECTORY is anywhere in it. */
async function _containsRepo(dir) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { unknown: true };
    }
    for (const e of entries) {
      if (++seen > SCAN_MAX_ENTRIES) return { unknown: true };
      // withFileTypes reports a junction/symlink as a link, not a directory: never entered.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === '.git') return { found: true };
      stack.push(path.join(d, e.name));
    }
  }
  return { found: false };
}

/**
 * May [p] be recorded (and later removed)? -> {ok:true, path} | {ok:false, error}.
 * `roots`: where recorded paths may live; `protect`: paths that are never touched, nor
 * anything inside them, nor any of their parents (this checkout, its data dir).
 */
async function checkPath(p, { roots = [], protect = [] } = {}) {
  const no = (error) => ({ ok: false, error });
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > 1024) return no('a path must be a string');
  if (!path.isAbsolute(p) || (IS_WIN && !/^[A-Za-z]:[\\/]/.test(p))) return no('a path must be absolute');
  const abs = norm(p);
  if (path.parse(abs).root === abs) return no('a drive root is never removed');
  const home = norm(os.homedir());
  if (abs === home || inside(home, abs)) return no('the home folder is never removed');
  for (const pr of protect) if (sameOrRelated(abs, norm(pr))) return no('that path is web-terminal\'s own');
  const lexRoots = roots.map(norm);
  if (!lexRoots.some((r) => inside(abs, r))) return no('that path is outside every leases.cleanupRoots folder');
  const realRoots = (await Promise.all(roots.map(_real))).filter(Boolean);
  const realProtect = (await Promise.all(protect.map(_real))).filter(Boolean);
  const st = await _lstat(abs).catch(() => undefined);
  if (st === undefined) return no('that path could not be read');
  if (st === null) {
    // Not there (yet). Its nearest existing parent must really be inside a root.
    let parent = path.dirname(abs);
    while (parent !== path.dirname(parent)) {
      const real = await _real(parent);
      if (real) {
        if (!(realRoots.some((r) => real === r || inside(real, r)))) return no('that path leads outside every cleanup root');
        break;
      }
      parent = path.dirname(parent);
    }
    return { ok: true, path: abs };
  }
  // The thing itself may be a link (it is then only unlinked); what holds it must be real.
  const realParent = await _real(path.dirname(abs));
  if (!realParent || !realRoots.some((r) => realParent === r || inside(realParent, r))) return no('that path leads outside every cleanup root');
  if (st.isSymbolicLink()) return { ok: true, path: abs };
  const real = await _real(abs);
  if (!real || !realRoots.some((r) => inside(real, r))) return no('that path leads outside every cleanup root');
  for (const pr of realProtect) if (sameOrRelated(real, pr)) return no('that path is web-terminal\'s own');
  if (st.isDirectory()) {
    const repo = await _containsRepo(abs);
    if (repo.unknown) return no('that folder could not be checked for git repositories');
    if (repo.found) return no('that folder holds a git repository; only worktrees and temp folders are removed');
  }
  return { ok: true, path: abs };
}

async function _unlinkLink(p) {
  try { await fsp.unlink(p); } catch (e) {
    // A directory junction on Windows: rmdir removes the LINK, never its target.
    if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) await fsp.rmdir(p); else throw e;
  }
}

async function _rmTree(p) {
  const st = await _lstat(p);
  if (!st) return;
  if (st.isSymbolicLink()) return _unlinkLink(p);
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) await _rmTree(path.join(p, name));
    return fsp.rmdir(p);
  }
  try { await fsp.unlink(p); } catch (e) {
    if (e && e.code === 'EPERM') { await fsp.chmod(p, 0o666); await fsp.unlink(p); } else throw e;
  }
}

/** The main repository's git dir when [dir] is a worktree (`.git` file), so its stale
 *  registration can be pruned once the folder is gone. */
async function _worktreeGitDir(dir) {
  try {
    const txt = await fsp.readFile(path.join(dir, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(txt);
    if (!m) return null;
    const wtAdmin = path.resolve(dir, m[1]);
    const common = path.dirname(path.dirname(wtAdmin));
    return path.basename(path.dirname(wtAdmin)) === 'worktrees' && path.basename(common) === '.git' ? common : null;
  } catch { return null; }
}

/** Remove one recorded path, re-checked now.
 *  -> {result: 'removed' | 'gone' | 'refused' | 'error', error?, gitDir?} */
async function removeRecorded(p, opts) {
  let st;
  try { st = await _lstat(p); } catch (e) { return { result: 'error', error: e.message }; }
  if (!st) return { result: 'gone' };
  const chk = await checkPath(p, opts);
  if (!chk.ok) return { result: 'refused', error: chk.error };
  const gitDir = !st.isSymbolicLink() && st.isDirectory() ? await _worktreeGitDir(chk.path) : null;
  try {
    await _rmTree(chk.path);
    return { result: 'removed', gitDir };
  } catch (e) {
    return { result: 'error', error: e.message };
  }
}

/** `git worktree prune` for a worktree folder that was just removed. Best effort. */
function pruneWorktrees(gitDir) {
  return new Promise((resolve) => {
    if (!gitDir) return resolve(false);
    execFile('git', ['--git-dir', gitDir, 'worktree', 'prune'], { windowsHide: true, timeout: QUERY_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

module.exports = {
  recordPid, killRecorded, processStart, defaultRoots, checkPath, removeRecorded, pruneWorktrees,
  SCAN_MAX_ENTRIES, _setStartQueryForTests,
};
