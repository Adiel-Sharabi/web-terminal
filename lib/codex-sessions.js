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
const { pickRolloutForProcessStart } = require('./codex-match');

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
// `opts.processStartMs` — when this session's OWN codex process started. Supplying it
// switches resolution from "newest in this cwd" to "the rollout created when THIS
// process started", which is the only thing that tells two Codex sessions sharing a
// folder apart. Without it, behaviour is unchanged (newest wins).
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

  // cwd is the cheap filter; it just isn't an identity when several agents share a
  // directory. Collect every match rather than stopping at the first.
  const inCwd = [];
  for (const c of candidates) {
    let head;
    try { head = io.readFirstLine(c.path); } catch { continue; }
    const meta = parseSessionMeta(head);
    if (meta && sameCwd(meta.cwd, cwd, platform)) inCwd.push(c);
  }
  if (!inCwd.length) return '';

  if (typeof opts.processStartMs === 'number' && Number.isFinite(opts.processStartMs)) {
    const hit = pickRolloutForProcessStart(inCwd, opts.processStartMs, opts.toleranceMs);
    // No match, or two processes started too close together to tell apart: return
    // NOTHING. Serving one session another session's conversation is the defect this
    // exists to prevent, and an empty lens is the honest answer.
    if (!hit || hit.ambiguous) return '';
    return hit.path;
  }

  // No process hint (agent already exited, non-Windows, snapshot unavailable): the
  // historical rule. Correct whenever a folder holds one agent, which is the norm.
  return inCwd[0].path;
}

// The rollout for a KNOWN conversation id — the exact answer, when we have one.
//
// A rollout is named rollout-<iso>-<uuid>.jsonl, so the id is in the filename and this
// costs no head reads at all: no cwd guessing, no newest-wins ranking, and it is immune
// to any number of Codex sessions sharing a directory. scripts/codex-notify.js supplies
// the id (see there for why that route, and why the two obvious alternatives fail).
function findRolloutById(conversationId, io) {
  if (!conversationId || !io || typeof io.listRollouts !== 'function') return '';
  const id = String(conversationId).toLowerCase();
  // A uuid can't appear in a rollout filename by accident, but require the shape anyway
  // so a caller can never turn a stray string into a path fragment.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return '';
  let candidates;
  try { candidates = io.listRollouts() || []; } catch { return ''; }
  for (const c of candidates) {
    if (String(c.path).toLowerCase().includes(id)) return c.path;
  }
  return '';
}

module.exports = { findRolloutForCwd, findRolloutById, sameCwd, normalizeCwd, MAX_SCAN };
