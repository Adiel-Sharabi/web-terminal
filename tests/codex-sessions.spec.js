// @ts-check
// lib/codex-sessions.js — finds a Codex rollout for a cwd. Codex keys rollouts by
// date+uuid (never by cwd), so the cwd lives only in each file's session_meta head
// line. I/O is injected, so the walk order, cwd normalisation and scan bound are all
// testable without a disk.
const { test, expect } = require('@playwright/test');
const { findRolloutForCwd, sameCwd, normalizeCwd, MAX_SCAN } = require('../lib/codex-sessions');

const BS = String.fromCharCode(92); // backslash
const meta = (cwd) => JSON.stringify({
  timestamp: '2026-07-09T12:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'uuid-' + cwd, cwd, cli_version: '0.134.0' },
});

// Build an injected io over an in-memory {path: firstLine} map plus mtimes.
function fakeIo(files) {
  return {
    listRollouts: () => files.map((f) => ({ path: f.path, mtimeMs: f.mtimeMs })),
    readFirstLine: (p) => {
      const f = files.find((x) => x.path === p);
      if (!f) throw new Error('ENOENT');
      if (f.throws) throw new Error('unreadable');
      return f.head;
    },
  };
}

test('finds the rollout whose session_meta.cwd matches', () => {
  const io = fakeIo([
    { path: 'a.jsonl', mtimeMs: 1, head: meta('C:' + BS + 'dev' + BS + 'other') },
    { path: 'b.jsonl', mtimeMs: 2, head: meta('C:' + BS + 'dev' + BS + 'proj') },
  ]);
  expect(findRolloutForCwd('C:' + BS + 'dev' + BS + 'proj', io, { platform: 'win32' })).toBe('b.jsonl');
});

test('prefers the NEWEST rollout when several share a cwd', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const io = fakeIo([
    { path: 'old.jsonl', mtimeMs: 10, head: meta(cwd) },
    { path: 'new.jsonl', mtimeMs: 99, head: meta(cwd) },
    { path: 'mid.jsonl', mtimeMs: 50, head: meta(cwd) },
  ]);
  expect(findRolloutForCwd(cwd, io, { platform: 'win32' })).toBe('new.jsonl');
});

test('returns empty string when no rollout matches', () => {
  const io = fakeIo([{ path: 'a.jsonl', mtimeMs: 1, head: meta('C:' + BS + 'dev' + BS + 'other') }]);
  expect(findRolloutForCwd('C:' + BS + 'dev' + BS + 'proj', io, { platform: 'win32' })).toBe('');
});

test('an unreadable or non-session_meta head is skipped, not fatal', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const io = fakeIo([
    { path: 'broken.jsonl', mtimeMs: 99, throws: true },            // newest, unreadable
    { path: 'garbage.jsonl', mtimeMs: 98, head: '{not json' },      // next, malformed
    { path: 'notmeta.jsonl', mtimeMs: 97, head: JSON.stringify({ type: 'response_item' }) },
    { path: 'good.jsonl', mtimeMs: 1, head: meta(cwd) },            // oldest, valid
  ]);
  expect(findRolloutForCwd(cwd, io, { platform: 'win32' })).toBe('good.jsonl');
});

test('a half-written newest rollout does not hide an older valid match', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const io = fakeIo([
    { path: 'starting.jsonl', mtimeMs: 100, head: '' },
    { path: 'real.jsonl', mtimeMs: 5, head: meta(cwd) },
  ]);
  expect(findRolloutForCwd(cwd, io, { platform: 'win32' })).toBe('real.jsonl');
});

test('the scan is bounded to the newest MAX_SCAN rollouts', () => {
  const cwd = 'C:' + BS + 'dev' + BS + 'proj';
  const files = [];
  // The only match is the OLDEST of MAX_SCAN+50 files, so it must fall outside the window.
  for (let i = 0; i < MAX_SCAN + 50; i++) files.push({ path: `f${i}.jsonl`, mtimeMs: 1000 - i, head: meta('C:' + BS + 'x' + i) });
  files.push({ path: 'match.jsonl', mtimeMs: 0, head: meta(cwd) });
  expect(findRolloutForCwd(cwd, fakeIo(files), { platform: 'win32' })).toBe('');
  // Within the window it is found.
  expect(findRolloutForCwd(cwd, fakeIo(files), { platform: 'win32', maxScan: MAX_SCAN + 100 })).toBe('match.jsonl');
});

test('a listRollouts that throws yields no match rather than an exception', () => {
  const io = { listRollouts: () => { throw new Error('EACCES'); }, readFirstLine: () => '' };
  expect(findRolloutForCwd('C:' + BS + 'dev', io)).toBe('');
});

test('missing cwd or io never throws', () => {
  expect(findRolloutForCwd('', fakeIo([]))).toBe('');
  expect(findRolloutForCwd('C:' + BS + 'dev', null)).toBe('');
  expect(findRolloutForCwd('C:' + BS + 'dev', {})).toBe('');
});

// ---- cwd normalisation ------------------------------------------------------
test('win32 cwd compare ignores case, separator and the \\\\?\\ extended prefix', () => {
  const p = 'C:' + BS + 'dev' + BS + 'Emulator2026';
  expect(sameCwd(p, p.toUpperCase(), 'win32')).toBe(true);
  expect(sameCwd(p, p.split(BS).join('/'), 'win32')).toBe(true);
  expect(sameCwd(BS + BS + '?' + BS + p, p, 'win32')).toBe(true); // Codex writes this form
  expect(sameCwd(p + BS, p, 'win32')).toBe(true);                 // trailing separator
});

test('posix cwd compare is case-sensitive', () => {
  expect(sameCwd('/home/a/proj', '/home/a/proj', 'linux')).toBe(true);
  expect(sameCwd('/home/a/proj', '/home/a/PROJ', 'linux')).toBe(false);
  expect(sameCwd('/home/a/proj/', '/home/a/proj', 'linux')).toBe(true);
});

test('empty cwds never match each other', () => {
  expect(sameCwd('', '', 'win32')).toBe(false);
  expect(sameCwd(null, undefined, 'win32')).toBe(false);
  expect(normalizeCwd(null)).toBe('');
});
