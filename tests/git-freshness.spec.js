// @ts-check
// #248 - `behind: 0` on a box that has not fetched for days.
//
// `_gitRefresh` probes with `git fetch --dry-run`, which writes no refs and no
// FETCH_HEAD, then counts `git rev-list HEAD..@{u} --count` against the ref that probe
// declined to update. On a box where HEAD has not moved either, the count is 0 by
// construction - "up to date", the one answer that guarantees nobody looks. Measured on
// adiel-0ffice 2026-09-09: `behind: 0` for four days while 8 commits behind.
//
// THE GATE, in the issue's own words: a stale `@{u}` must not produce a `behind` the
// caller would read as up-to-date. `-1` already means "could not tell" and every reader
// of this shape has to handle it; the defect was that this case took the 0.
//
// The load-bearing half of this file is the unit block. It CANNOT be vacuous: each case
// names the exact inputs and the exact number, and flipping the rule back to the old
// expression turns the first one red. The API block underneath pins the wire shape and
// drives the real code path, and its own possible vacuity is dealt with explicitly there.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx } = require('./test-helpers');
const gitFreshness = require('../lib/git-freshness');

const { FETCH_FRESH_MS, parseBehindCount, readFetchedAt, publishedBehind } = gitFreshness;

const HOUR = 60 * 60 * 1000;
const NOW = 1757000000000; // a fixed instant - nothing here may depend on the wall clock

test.describe('#248: the rule - a stale ref may not claim up to date', () => {
  test('a stale ref with a count of 0 reports -1, not 0', () => {
    // THE REGRESSION. Four days since the last real fetch, HEAD unmoved, rev-list says 0.
    // The old code published that 0 verbatim.
    expect(publishedBehind({ count: 0, fetchedAt: NOW - 4 * 24 * HOUR, now: NOW })).toBe(-1);
  });

  test('a FRESH ref with a count of 0 still reports 0', () => {
    // The field's one genuinely useful moment - just after a deploy - is kept. Without
    // this case the "fix" would be indistinguishable from deleting the field.
    expect(publishedBehind({ count: 0, fetchedAt: NOW - 60 * 1000, now: NOW })).toBe(0);
  });

  test('the horizon is a boundary, not a vibe', () => {
    expect(publishedBehind({ count: 0, fetchedAt: NOW - FETCH_FRESH_MS, now: NOW })).toBe(0);
    expect(publishedBehind({ count: 0, fetchedAt: NOW - FETCH_FRESH_MS - 1, now: NOW })).toBe(-1);
  });

  test('a POSITIVE count is published however stale the ref is', () => {
    // A stale ref's positive count is a lower bound, and it already says "not up to
    // date" - the direction that makes someone look. Suppressing it would throw away
    // true information to punish the ref. This is the case that stops the rule from
    // being "always answer -1", which would pass every other test here.
    expect(publishedBehind({ count: 8, fetchedAt: NOW - 4 * 24 * HOUR, now: NOW })).toBe(8);
    expect(publishedBehind({ count: 1, fetchedAt: null, now: NOW })).toBe(1);
  });

  test('a count that never happened is -1, not 0 - the second door to the same lie', () => {
    // `execGit` resolves to null on any error, and `HEAD..@{u}` errors outright on a
    // branch with no upstream (`fatal: no upstream configured for branch ...`, observed
    // on this checkout while writing the fix). The expression this replaced ended
    // `: 0`, so that failure reported "up to date" forever.
    expect(parseBehindCount(null)).toBe(null);
    expect(parseBehindCount('')).toBe(null);
    expect(parseBehindCount('fatal: no upstream configured')).toBe(null);
    expect(parseBehindCount('8')).toBe(8);
    expect(parseBehindCount('0')).toBe(0);
    expect(publishedBehind({ count: null, fetchedAt: NOW, now: NOW })).toBe(-1);
  });

  test('an unreadable FETCH_HEAD is "could not tell", never "up to date"', () => {
    // A fresh `git clone` writes no FETCH_HEAD, so this is a real case rather than a
    // defensive branch. It is a false "could not tell" on a checkout that IS up to date,
    // and that is the right direction to be wrong in.
    expect(publishedBehind({ count: 0, fetchedAt: null, now: NOW })).toBe(-1);
    expect(publishedBehind({ count: 0, fetchedAt: undefined, now: NOW })).toBe(-1);
  });

  test('a clock stamped in the future cannot buy a 0', () => {
    expect(publishedBehind({ count: 0, fetchedAt: NOW + 5 * HOUR, now: NOW })).toBe(-1);
  });

  test('readFetchedAt reads a real mtime, and answers null rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt248-'));
    const file = path.join(dir, 'FETCH_HEAD');
    try {
      fs.writeFileSync(file, 'fixture', 'utf8');
      const when = new Date(NOW);
      fs.utimesSync(file, when, when);
      // A tolerance, not a timer: some filesystems store mtime at 1s or 2s resolution,
      // and the rule's horizon is an HOUR, so nothing here turns on the milliseconds.
      expect(Math.abs(readFetchedAt(file) - NOW)).toBeLessThanOrEqual(2000);
      // ...and the whole rule, driven through the real stat rather than a literal.
      expect(publishedBehind({ count: 0, fetchedAt: readFetchedAt(file), now: NOW + 4 * 24 * HOUR })).toBe(-1);
      expect(publishedBehind({ count: 0, fetchedAt: readFetchedAt(file), now: NOW + 1000 })).toBe(0);

      expect(readFetchedAt(path.join(dir, 'nope'))).toBe(null);
      expect(readFetchedAt(null)).toBe(null);
      expect(readFetchedAt('')).toBe(null);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });
});

test.describe('#248: the wire, and the real code path', () => {
  test('/api/version carries fetchedAt, additively, and behind keeps its shape', async () => {
    const ctx = await authCtx();
    try {
      const v = await (await ctx.get('/api/version')).json();
      // ADDITIVE: `behind` is unchanged in shape (a count, or -1 for "could not tell"),
      // so a peer that has not been rebuilt parses this response exactly as before.
      expect(Number.isInteger(v.behind)).toBe(true);
      expect(v.behind).toBeGreaterThanOrEqual(-1);
      // The new field is always PRESENT - null is the answer, not the absence of one.
      expect('fetchedAt' in v, 'fetchedAt must be published, null included').toBe(true);
      expect(v.fetchedAt === null || Number.isFinite(v.fetchedAt)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test('after the background refresh has really run, no stale ref reports 0', async () => {
    // This drives the actual `_gitRefresh` path against this checkout's real .git, which
    // is the half the unit block cannot reach.
    //
    // ON VACUITY, stated rather than hoped: the cold-start fallback is
    // `{ behind: -1, fetchedAt: null, date: '' }`, which satisfies the invariant without
    // the new code having run at all. So the poll waits for `date` to become non-empty -
    // `date` is set ONLY by the async `_gitRefresh`, never by the cold-start fallback -
    // and the assertion below is made after that. Waiting is not a latency bet on the
    // assertion: the refresh either completes or the test says so.
    test.setTimeout(60000);
    const ctx = await authCtx();
    try {
      let v = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        v = await (await ctx.get('/api/version')).json();
        if (v.date) break;                       // the async refresh has landed
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(v && v.date, 'the background git refresh never completed').toBeTruthy();

      // THE GATE. Environment-independent: it holds on a CI checkout that fetched
      // seconds ago (fresh -> a 0 is allowed) and on a dev box that has not fetched for
      // days (stale -> a 0 is forbidden).
      const stale = !Number.isFinite(v.fetchedAt)
        || Math.abs(Date.now() - v.fetchedAt) > FETCH_FRESH_MS;
      if (stale) {
        expect(
          v.behind,
          'behind reported "up to date" from a ref nothing had refreshed',
        ).not.toBe(0);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('server.js computes behind through the rule, not inline', async () => {
    // A structural guard, because no behavioural test can see this: the defect was one
    // inline expression, and re-inlining it would leave every test above green. Same
    // shape as the funnel guard in app-input-path.spec.js.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(
      src.includes('gitFreshness.publishedBehind('),
      'the behind value must come from lib/git-freshness.js',
    ).toBe(true);
    expect(
      src.includes('gitFreshness.readFetchedAt('),
      'fetchedAt must come from lib/git-freshness.js',
    ).toBe(true);
    // The exact expression that produced both lies, by both doors.
    //
    // SEARCH THE CODE, NOT THE COMMENTS. server.js documents the expression it
    // replaced by quoting it verbatim, which is the right thing for a reader and
    // made this guard fail against the very fix it exists to protect. That is
    // #138's rule arriving in a test rather than in a detector: a phrase that
    // causes a verdict must not be matchable in our own prose. Stripping
    // whole-line comments is enough here and stays honest about its limit - a
    // trailing comment on a line of real code would still be searched, and that
    // is the safe direction to be wrong in.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(
      code.includes('parseInt(count) || 0'),
      'the old inline behind expression is back in server.js',
    ).toBe(false);
    // And the probe must stay a --dry-run: a real fetch from a polled read path is the
    // fix this issue explicitly refused (it mutates a production checkout every 5
    // minutes on every peer).
    expect(src.includes("'fetch', '--dry-run'")).toBe(true);
  });
});
