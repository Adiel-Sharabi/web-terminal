'use strict';
// What a build IS: the commit it was made from, and when that commit was made.
//
// This repo does not number its changes. Two open PRs both bumping a version literal
// conflicted on that line and each re-merge cost a fresh full CI run, so the per-change
// number is gone; the human version (`SERVER_VERSION`) moves only when the owner cuts a
// release. A running server is identified by `hash` + `date` on `/api/version`, which
// come from here.
//
// THE RULE THAT MAKES THAT TRUE: the identity is read ONCE, when the process starts
// (server.js calls readBuildId at load), and never refreshed. The checkout on disk moves
// under a running server - a `git pull` lands before the reload that picks it up - so a
// hash that followed the checkout would name the NEW commit while the OLD code still ran,
// and "running hash == HEAD" would pass for a server that never restarted. Read at start,
// it names the commit whose code this process loaded; a pulled-but-not-reloaded server
// shows an older hash than the checkout, which is exactly what a deploy check must see.

const { execFileSync } = require('child_process');
const { gitSafeArgs, gitSafeEnv } = require('./git-safe');

// What a checkout git cannot read (no git, not a repository, no commit yet) reports. A
// literal rather than null, so a client printing `hash` never prints "undefined".
const UNKNOWN = Object.freeze({ hash: 'unknown', date: '' });

/**
 * { hash, date } of HEAD in [cwd]: the abbreviated commit hash and that commit's date
 * (`%ci`, e.g. "2026-11-25 14:03:12 +0200"). One git call, no shell, never throws -
 * a failure answers UNKNOWN. Read-only and non-interactive (lib/git-safe.js).
 */
function readBuildId(cwd) {
  try {
    const out = execFileSync('git', gitSafeArgs(['log', '-1', '--format=%h %ci']), {
      cwd, encoding: 'utf8', windowsHide: true, env: gitSafeEnv(), timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const at = out.indexOf(' ');
    const hash = at < 0 ? out : out.slice(0, at);
    if (!/^[0-9a-f]{7,40}$/.test(hash)) return UNKNOWN;
    return Object.freeze({ hash, date: at < 0 ? '' : out.slice(at + 1).trim() });
  } catch {
    return UNKNOWN;
  }
}

/**
 * Whether two commit hashes name the same commit. The server reports an ABBREVIATED
 * hash and a checkout can be asked for the full one, so one being the prefix of the
 * other is a match. Anything that is not 7-40 hex digits (including `unknown`) never
 * matches: "could not tell" must not read as "the same".
 */
function sameBuild(a, b) {
  const ok = (h) => typeof h === 'string' && /^[0-9a-f]{7,40}$/i.test(h);
  if (!ok(a) || !ok(b)) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

module.exports = { readBuildId, sameBuild, UNKNOWN };
