'use strict';
// #248 - HOW OLD is the ref that `behind` is measured against, and may a `behind: 0` be
// published from it?
//
// `_gitRefresh` in server.js probes with `git fetch --dry-run`, which contacts the remote
// and then WRITES NOTHING: `refs/remotes/origin/*` and `.git/FETCH_HEAD` are left exactly
// where the last REAL fetch put them. So `git rev-list HEAD..@{u} --count` counts against
// a ref the probe declined to update, and on a box where HEAD has not moved either the
// answer is 0 by construction - "up to date", which is the one answer that guarantees
// nobody looks.
//
// MEASURED on adiel-0ffice 2026-09-09: `/api/version` answered `behind: 0` while the box
// was 8 commits behind (1.73.4 against 1.73.13), and had been answering 0 for four days;
// `.git/FETCH_HEAD` was stamped 2026-09-05. The positive control is what makes it a
// measurement rather than a reading of the code: a real `git fetch`, changing nothing
// else, moved origin/master and the same rev-list then answered 8. HEAD never moved.
//
// WHY NOT JUST FETCH FOR REAL. `--dry-run` -> `--quiet` would make the number true, and
// it is refused on purpose. This is a POLLED READ path - `GET /api/version`, a 5-minute
// TTL, on every peer in the cluster - and a real fetch writes refs, writes objects and
// takes .git locks in a production checkout somebody may be mid-pull in. This repo has
// already paid once for automatic git work in this endpoint (the credential-manager leak
// that lib/git-safe.js exists to prevent: 10,499 processes, 236 GB committed). A read
// endpoint does not get to mutate the repository it reports on.
//
// So the endpoint publishes what it actually knows: the AGE of the ref, and a `behind`
// that refuses to claim up-to-date from a ref too old to support the claim. `-1` is
// already this field's "could not tell" and every consumer of the shape has to handle it
// already; the defect was that this case took the 0 instead. Confidently wrong is worse
// than absent.

// How old the last real fetch may be before a `behind: 0` stops being information.
//
// It is a JUDGEMENT, and the two ends of the range are what pin it rather than any
// measurement. It cannot be much SHORTER: nothing in the server ever refreshes the ref,
// so the only thing that does is a human running a fetch or a pull (a deploy), and a
// threshold under that cadence makes `behind` permanently -1 on every box. It cannot be
// much LONGER: a whole working day of deploys would hide behind one 0, which is exactly
// the four-day failure above with a smaller number on it.
//
// One hour keeps the field's one genuinely useful moment - right after a deploy, "yes,
// you are on the tip" - and loses only the part that was lying.
const FETCH_FRESH_MS = 60 * 60 * 1000;

// Parse the output of `git rev-list HEAD..@{u} --count`.
//
// `null` means COULD NOT COUNT, and it is a real case rather than defensive padding:
// `execGit` resolves to null on any error, and `@{u}` errors outright on a branch with
// no upstream - `fatal: no upstream configured for branch '<name>'`, observed on this
// checkout. The code this replaces mapped that to `behind = 0`, so a branch with no
// upstream reported "up to date" forever from a command that had failed. Same lie as the
// stale ref, through a different door.
function parseBehindCount(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^[0-9]+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// The mtime of `.git/FETCH_HEAD` in ms, or null when it cannot be read.
//
// FETCH_HEAD is written by a real `git fetch` (and by `git pull`, which contains one) and
// NOT by `--dry-run` - which is the measurement above, not an assumption: the probe had
// been running every five minutes for four days against a file stamped four days earlier.
//
// A fresh `git clone` writes no FETCH_HEAD at all, so this returns null there and the
// rule below reads null as "cannot support the claim". That is a false "could not tell"
// on a checkout that genuinely is up to date, and it is the right direction to be wrong
// in: the only harm is that nobody is told a number, against the harm this issue is
// about, which is being told the wrong one.
//
// The path is passed in (server.js gets it from `git rev-parse --git-path FETCH_HEAD`,
// which resolves correctly in a linked worktree, where .git is a file) so the rule can be
// pointed at a fixture instead of the real repository.
function readFetchedAt(fetchHeadPath, fsModule) {
  if (!fetchHeadPath) return null;
  const fsMod = fsModule || require('fs');
  try {
    const ms = fsMod.statSync(fetchHeadPath).mtimeMs;
    return Number.isFinite(ms) ? Math.round(ms) : null;
  } catch (e) {
    return null;
  }
}

// The number the endpoint is allowed to publish.
//
//   count === null        -> -1   nothing was counted (no upstream, git failed)
//   count  >  0           -> count   published REGARDLESS of the ref's age. A stale ref's
//                                    positive count is a LOWER BOUND, and it already says
//                                    "not up to date", which is the direction that makes
//                                    someone look. Suppressing it to -1 would throw away
//                                    true information to punish the ref.
//   count === 0, fresh    ->  0   the only case that may claim up to date
//   count === 0, stale    -> -1   could not tell - the bug this whole module is about
function publishedBehind(opts) {
  const o = opts || {};
  const count = o.count;
  if (!Number.isInteger(count) || count < 0) return -1;
  if (count > 0) return count;
  if (!Number.isFinite(o.fetchedAt)) return -1;
  const limit = Number.isFinite(o.freshMs) ? o.freshMs : FETCH_FRESH_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  // ABSOLUTE age. A FETCH_HEAD stamped in the future is a broken clock, not a fetch that
  // has not happened yet, and a broken clock must not be able to buy a `0`.
  return Math.abs(now - o.fetchedAt) > limit ? -1 : 0;
}

module.exports = { FETCH_FRESH_MS, parseBehindCount, readFetchedAt, publishedBehind };
