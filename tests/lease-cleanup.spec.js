// @ts-check
// lib/lease-cleanup.js (#412): what a released lease cleans up - ONLY what it recorded.
//
// Real processes and real junctions, because the two rules here are the ones that have
// already cost production a checkout and a server (CLAUDE.md, ~/.claude/CLAUDE.md):
//   - a pid is killed only while its creation time still matches the one recorded (PID
//     reuse), never by name;
//   - a recorded directory is removed without ever following a junction or symlink.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/lease-cleanup');

const spawned = [];
function sleeper() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  spawned.push(p);
  return p;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 100)); }
  return !alive(pid);
}
test.afterAll(() => {
  // Only the pids this spec started.
  for (const p of spawned) { try { p.kill(); } catch { /* gone */ } }
});

test.describe('recorded processes (#412)', () => {
  test.setTimeout(60000);

  test('a recorded pid is killed; an unrelated process started beside it is not', async () => {
    const mine = sleeper();
    const other = sleeper();
    await new Promise((r) => setTimeout(r, 300));
    const rec = await C.recordPid(mine.pid, { protectedPids: [process.pid] });
    expect(rec.ok).toBe(true);
    expect(rec.item).toMatchObject({ pid: mine.pid });
    expect(typeof rec.item.startMs).toBe('number');
    const r = await C.killRecorded(rec.item);
    expect(r.result).toBe('killed');
    expect(await waitDead(mine.pid)).toBe(true);
    expect(alive(other.pid)).toBe(true);
  });

  test('a pid whose creation time no longer matches (PID reuse) is left alone', async () => {
    const p = sleeper();
    await new Promise((r) => setTimeout(r, 300));
    const rec = await C.recordPid(p.pid, { protectedPids: [] });
    expect(rec.ok).toBe(true);
    // The same number, but recorded for a process that started a minute earlier.
    const r = await C.killRecorded({ pid: p.pid, startMs: rec.item.startMs - 60000 });
    expect(r.result).toBe('reused');
    expect(alive(p.pid)).toBe(true);
  });

  test('a process that already exited is reported gone', async () => {
    const p = sleeper();
    await new Promise((r) => setTimeout(r, 300));
    const rec = await C.recordPid(p.pid, { protectedPids: [] });
    p.kill();
    expect(await waitDead(p.pid)).toBe(true);
    expect((await C.killRecorded(rec.item)).result).toBe('gone');
  });

  test('recording refuses junk, a protected pid (this server) and a pid that does not exist', async () => {
    for (const bad of [0, -1, 1.5, '123', null, 4]) {
      expect((await C.recordPid(/** @type {any} */ (bad), { protectedPids: [] })).ok, String(bad)).toBe(false);
    }
    expect((await C.recordPid(process.pid, { protectedPids: [process.pid] })).ok).toBe(false);
    const p = sleeper();
    await new Promise((r) => setTimeout(r, 300));
    const pid = p.pid;
    p.kill();
    await waitDead(pid);
    expect((await C.recordPid(pid, { protectedPids: [] })).ok).toBe(false);
  });
});

test.describe('recorded paths (#412)', () => {
  let base;
  let outside;
  test.beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wt412-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious');
  });
  test.afterEach(() => {
    for (const d of [base, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });
  const opts = () => ({ roots: [base], protect: [path.join(__dirname, '..')] });

  test('a recorded dir is removed, and a junction INSIDE it is unlinked, never followed', async () => {
    const dir = path.join(base, 'work');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x');
    fs.symlinkSync(outside, path.join(dir, 'sub', 'node_modules'), 'junction');
    const chk = (await C.checkPath(dir, opts()));
    expect(chk.ok).toBe(true);
    const r = (await C.removeRecorded(chk.path, opts()));
    expect(r.result).toBe('removed');
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious');
  });

  test('a recorded path that IS a junction: the link goes, its target stays', async () => {
    const link = path.join(base, 'link');
    fs.symlinkSync(outside, link, 'junction');
    const chk = (await C.checkPath(link, opts()));
    expect(chk.ok).toBe(true);
    expect((await C.removeRecorded(chk.path, opts())).result).toBe('removed');
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious');
  });

  test('a worktree (a .git FILE) may be recorded; a real repository (a .git DIRECTORY) may not', async () => {
    const wt = path.join(base, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: C:/nowhere/.git/worktrees/wt\n');
    expect((await C.checkPath(wt, opts())).ok).toBe(true);
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect((await C.checkPath(repo, opts()))).toMatchObject({ ok: false });
    // ...and a dir that CONTAINS a repository is refused too.
    expect((await C.checkPath(base, { roots: [path.dirname(base)], protect: [] })).ok).toBe(false);
  });

  test('refused: relative, outside every root, a root itself, the checkout, and a path through a junction', async () => {
    const o = opts();
    expect((await C.checkPath('relative\\dir', o)).ok).toBe(false);
    expect((await C.checkPath(path.join(outside, 'x'), o)).ok).toBe(false);
    expect((await C.checkPath(base, o)).ok).toBe(false);
    expect((await C.checkPath(path.join(base, '..', path.basename(outside)), o)).ok).toBe(false);
    expect((await C.checkPath(path.join(__dirname, '..'), { roots: [path.dirname(path.join(__dirname, '..'))], protect: [path.join(__dirname, '..')] })).ok).toBe(false);
    expect((await C.checkPath(path.join(__dirname), { roots: [path.dirname(path.join(__dirname, '..'))], protect: [path.join(__dirname, '..')] })).ok).toBe(false);
    // Lexically under the root, really outside it: base\via -> outside, recorded base\via\x.
    fs.symlinkSync(outside, path.join(base, 'via'), 'junction');
    fs.mkdirSync(path.join(outside, 'x'));
    expect((await C.checkPath(path.join(base, 'via', 'x'), o)).ok).toBe(false);
    expect((await C.checkPath(123, o)).ok).toBe(false);
  });

  test('a folder INSIDE a repository or worktree, or a .git folder, is refused; no roots configured refuses all', async () => {
    const repo = path.join(base, 'repo2');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    expect((await C.checkPath(path.join(repo, 'src'), opts())).ok).toBe(false);
    expect((await C.checkPath(path.join(repo, '.git'), opts())).ok).toBe(false);
    expect((await C.removeRecorded(path.join(repo, 'src'), opts())).result).toBe('refused');
    expect(fs.existsSync(path.join(repo, 'src'))).toBe(true);
    const wt = path.join(base, 'wt2');
    fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: C:/nowhere/.git/worktrees/wt2\n');
    expect((await C.checkPath(path.join(wt, 'node_modules'), opts())).ok).toBe(false);
    const plain = path.join(base, 'plain');
    fs.mkdirSync(plain);
    expect((await C.checkPath(plain, { roots: C.DEFAULT_ROOTS, protect: [] })).error).toMatch(/cleanupRoots/);
  });

  test('removal re-checks at release time: a path that became a repository since is refused', async () => {
    const dir = path.join(base, 'later-repo');
    fs.mkdirSync(dir);
    const chk = (await C.checkPath(dir, opts()));
    expect(chk.ok).toBe(true);
    fs.mkdirSync(path.join(dir, '.git'));
    expect((await C.removeRecorded(chk.path, opts())).result).toBe('refused');
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('a path already gone is reported gone', async () => {
    expect((await C.removeRecorded(path.join(base, 'never'), opts())).result).toBe('gone');
  });
});
