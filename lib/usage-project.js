'use strict';
// --- Which project a session worked in (#529) -------------------------------------------
//
// The project key of a cwd is the NAME of the repository it sits in: the last path segment
// of the repo's `origin` URL, lower-cased, `.git` stripped. Every worktree of one repo
// therefore shares one key, and a clone made under another folder name still groups with its
// siblings. No repo -> '(none)'; a repo with no origin -> the folder's name; a folder that is
// gone (a removed worktree) -> its own name.
//
// Read straight from the `.git` files, never by spawning git (the collector runs in a worker
// thread and must not start processes). A worktree's `.git` is a FILE naming its gitdir; the
// gitdir's `commondir` names the main repo's `.git`, where the shared `config` lives.

const fs = require('fs');
const path = require('path');

const NONE = '(none)';

function readText(file, fsx) {
  try { return fsx.readFileSync(file, 'utf8'); } catch { return null; }
}

/** The `url` of `[remote "origin"]` in a git config's text, or null. */
function originUrl(configText) {
  if (typeof configText !== 'string') return null;
  let inOrigin = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** `https://host/org/_git/My_Repo.git`, `git@host:org/repo.git`, `C:\x\repo` -> `my_repo` / `repo`. */
function keyOfUrl(url) {
  const parts = String(url).replace(/[/\\]+$/, '').split(/[/\\:]/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last.replace(/\.git$/i, '').toLowerCase() || null;
}

/** The directory holding the repo's shared `config` for the repo whose top folder is [top], or
 *  null when [top] has no `.git`. */
function gitCommonDir(top, fsx) {
  const dotGit = path.join(top, '.git');
  let st;
  try { st = fsx.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dotGit, fsx) || '');
  if (!m) return null;
  const gitdir = path.resolve(top, m[1].trim());
  const common = readText(path.join(gitdir, 'commondir'), fsx);
  return common ? path.resolve(gitdir, common.trim()) : gitdir;
}

/** The project key of [cwd]. [cache] (a Map) remembers the answer per cwd. */
function projectKey(cwd, { fsx = fs, cache = new Map() } = {}) {
  if (typeof cwd !== 'string' || !cwd) return NONE;
  if (cache.has(cwd)) return cache.get(cwd);
  let key = null;
  let existing = false;
  try { existing = fsx.statSync(cwd).isDirectory(); } catch { /* gone */ }
  if (!existing) key = (path.basename(cwd) || '').toLowerCase() || NONE;
  else {
    let dir = path.resolve(cwd);
    for (;;) {
      const common = gitCommonDir(dir, fsx);
      if (common) {
        const url = originUrl(readText(path.join(common, 'config'), fsx));
        key = (url && keyOfUrl(url)) || (path.basename(dir).toLowerCase() || NONE);
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (key === null) key = NONE;
  }
  cache.set(cwd, key);
  return key;
}

/** The names of the git repositories directly under [root] (a folder that has a `.git`). */
function reposUnder(root, fsx = fs) {
  let entries;
  try { entries = fsx.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = new Set();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const common = gitCommonDir(dir, fsx);
    if (!common) continue;
    const url = originUrl(readText(path.join(common, 'config'), fsx));
    out.add((url && keyOfUrl(url)) || e.name.toLowerCase());
  }
  return [...out].sort();
}

module.exports = { NONE, originUrl, keyOfUrl, projectKey, reposUnder };
