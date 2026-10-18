'use strict';

/// The pure rules for listing an agent's BACKGROUND agents (#366): what a CLI's listing
/// output is allowed to become, which executable to run, and which of our own
/// environment the child must not inherit. No I/O - the spawn and the cache live in
/// lib/background-listing-runner.js, which injects what it needs, so every rule here is
/// testable from plain values.
///
/// Why a listing at all: Claude's background and dispatched agents (Agent View) write
/// nothing to the transcript (#146), so the only honest source is the CLI itself
/// (`claude agents --json`, see the `backgroundListing` field in lib/agents.js). The
/// output names EVERY project's sessions and working directories on the machine, which
/// is why this module reduces each row to the few fields a dashboard needs and drops the
/// rest at the door: `pid`, the full `cwd`, and anything a later release adds.
///
/// Fails CLOSED. A listing that is not an array is UNAVAILABLE (`null`), never an empty
/// list: "claude changed its output" and "nothing is running" are different facts, and a
/// dashboard that reads the first as the second shows a blank strip while work runs.
const path = require('path');

/// Bound on rows kept. Without `--all` the CLI lists live agents only, so this is a
/// ceiling nobody should reach, not a page size.
const MAX_ROWS = 200;
const MAX_NAME = 200;
const MAX_WAITING_FOR = 200;
const MAX_CWD_TAIL = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The background id is 8 hex characters on 2.1.302; the pattern is wider on purpose so a
// release that lengthens it does not blank the strip, but narrow enough that it can
// never carry markup or a path.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// `state` / `status` are short lowercase words (working, blocked, done, failed, stopped /
// busy, idle, waiting). A word we have not seen is passed through, not dropped - the
// client decides how to render the unfamiliar - but only if it is shaped like a word.
const WORD_RE = /^[a-z][a-z0-9_-]{0,23}$/;

// Control characters, ESC included (so an ANSI sequence in a session name cannot reach a
// terminal-ish client as one).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/// A display string: control characters removed, trimmed, capped by CODE POINT (a cut
/// through a surrogate pair would leave a lone half). '' becomes null.
function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL_RE, ' ').trim();
  if (!s) return null;
  const pts = Array.from(s);
  return pts.length > max ? pts.slice(0, max).join('').trim() : s;
}

function wordOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return WORD_RE.test(s) ? s : null;
}

/// The last non-empty path segment, either separator. A name for the project, without
/// leaking the layout of the disk above it.
function cwdTailOf(cwd) {
  if (typeof cwd !== 'string') return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? cleanText(parts[parts.length - 1], MAX_CWD_TAIL) : null;
}

function shapeRow(r) {
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : null;
  const sessionId = typeof r.sessionId === 'string' && UUID_RE.test(r.sessionId)
    ? r.sessionId.toLowerCase() : null;
  // A row we can neither name nor map to a conversation is noise, not an agent.
  if (!id && !sessionId) return null;
  const startedAt = typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) && r.startedAt > 0
    ? Math.round(r.startedAt) : null;
  return {
    id,
    sessionId,
    name: cleanText(r.name, MAX_NAME),
    cwdTail: cwdTailOf(r.cwd),
    state: wordOf(r.state),
    status: wordOf(r.status),
    waitingFor: cleanText(r.waitingFor, MAX_WAITING_FOR),
    startedAt,
  };
}

/// Parse the listing's stdout. Returns the background rows as
/// `[{ id, sessionId, name, cwdTail, state, status, waitingFor, startedAt }]` (each field
/// null when absent or malformed), in the CLI's own order, or `null` when the text is not
/// a JSON array - unavailable, not empty.
///
/// Interactive rows are dropped: those are the PTY sessions web-terminal already lists,
/// and with no parent field there is no way to tell whose they are anyway.
function parseBackgroundListing(text) {
  let arr;
  try { arr = JSON.parse(String(text == null ? '' : text)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object' || r.kind !== 'background') continue;
    const row = shapeRow(r);
    if (row) out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/// A copy of [env] without the variables whose NAME starts with [spec.prefix], except
/// those in [spec.keep]. Case-insensitive, because Windows environment names are: a copy
/// of `process.env` is a plain object, so `Claudecode` would otherwise slip through a
/// case-sensitive match that `process.env.CLAUDECODE` itself would have caught.
function scrubEnv(env, spec) {
  const out = {};
  const prefix = String((spec && spec.prefix) || '').toUpperCase();
  const keep = new Set(((spec && spec.keep) || []).map((k) => String(k).toUpperCase()));
  for (const [k, v] of Object.entries(env || {})) {
    const up = k.toUpperCase();
    if (prefix && up.startsWith(prefix) && !keep.has(up)) continue;
    out[k] = v;
  }
  return out;
}

/// Which executable to run, or null when there is none. In order:
///  1. [override] - an operator (or a test) naming the binary outright, used verbatim;
///  2. [bin] on PATH;
///  3. [bin] in `~/.local/bin`, where the native installer puts it. A service started in
///     a stale session can carry a PATH that predates that install (CLAUDE.md "Session 0"),
///     and the user's shell finds it anyway.
///
/// Windows looks for `<bin>.exe` ONLY. An npm-installed `claude.cmd` shim cannot be
/// spawned without a shell (Node >= 20.12 refuses it, EINVAL), and routing it through
/// `cmd.exe` is more attack surface than a read-only listing is worth: such a machine
/// reports "unavailable", which is true to what we can run.
///
/// [exists] is injected (`fs.existsSync`) so this stays pure.
function resolveBin({ bin, override, pathValue, home, platform, exists }) {
  const forced = typeof override === 'string' ? override.trim() : '';
  if (forced) return forced;
  if (!bin) return null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const file = win ? `${bin}.exe` : bin;
  const dirs = String(pathValue || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  if (home) dirs.push(p.join(home, '.local', 'bin'));
  for (const d of dirs) {
    const cand = p.join(d, file);
    let ok;
    try { ok = !!exists(cand); } catch { ok = false; }
    if (ok) return cand;
  }
  return null;
}

module.exports = {
  parseBackgroundListing,
  scrubEnv,
  resolveBin,
  MAX_ROWS,
};
