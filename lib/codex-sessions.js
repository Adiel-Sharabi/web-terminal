'use strict';
// Locate a Codex CLI session's rollout transcript for a given working directory.
//
// Claude encodes the cwd into its project dir name, so a session's transcript path is
// a pure string derivation (claudeProjectDirName). Codex does NOT: rollouts live at
//   <codexHome>/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
// keyed only by date + uuid. The cwd appears exactly once, inside the first line
// (`session_meta`). So resolving "which rollout belongs to this cwd" means reading the
// head of candidate files, newest first, and stopping at the first match.
//
// I/O is INJECTED (io.listRollouts / io.readFirstLine) so the walk order, the cwd
// comparison and the scan bound are all unit-testable without touching a real disk.
const { parseSessionMeta } = require('./transcript-codex');

// Only look at the newest N rollouts. A long-lived machine accumulates thousands of
// them; a session's transcript is essentially always among the most recent, and an
// unbounded walk would stat + read every file on every cache miss.
const MAX_SCAN = 200;

// Windows records a working directory several ways for the same folder: either case,
// either separator, and sometimes with the `\\?\` extended-length prefix (Codex's own
// config.toml contains e.g. `\\?\C:\dev\Emulator2026`). Normalise all of that before
// comparing, or a session silently resolves to no transcript.
function normalizeCwd(p, platform = process.platform) {
  if (typeof p !== 'string' || !p) return '';
  const isWin = platform === 'win32';
  let s = p.trim();
  if (isWin) {
    s = s.replace(/^\\\\\?\\/, '');   // strip extended-length prefix
    s = s.replace(/\//g, '\\');       // one separator
    s = s.toLowerCase();              // case-insensitive
  }
  return s.replace(/[\\/]+$/, '');    // no trailing separator
}

function sameCwd(a, b, platform = process.platform) {
  const na = normalizeCwd(a, platform);
  const nb = normalizeCwd(b, platform);
  return na !== '' && na === nb;
}

// The newest rollout whose session_meta.cwd matches `cwd`, or '' when none does.
// Candidates are consumed newest-first; a file whose first line isn't parseable
// session_meta is skipped rather than aborting the search (a half-written rollout
// from a session still starting up must not hide an older, valid match).
function findRolloutForCwd(cwd, io, opts = {}) {
  if (!cwd || !io || typeof io.listRollouts !== 'function' || typeof io.readFirstLine !== 'function') return '';
  const platform = opts.platform || process.platform;
  const max = opts.maxScan || MAX_SCAN;

  let candidates;
  try { candidates = io.listRollouts() || []; } catch { return ''; }
  candidates = candidates
    .slice()
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, max);

  for (const c of candidates) {
    let head;
    try { head = io.readFirstLine(c.path); } catch { continue; }
    const meta = parseSessionMeta(head);
    if (meta && sameCwd(meta.cwd, cwd, platform)) return c.path;
  }
  return '';
}

module.exports = { findRolloutForCwd, sameCwd, normalizeCwd, MAX_SCAN };
