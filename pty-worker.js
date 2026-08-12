// pty-worker.js — stateful PTY process manager
//
// Owns: node-pty sessions, scrollback buffers, sessions.json / scrollback/*.json persistence.
// Communicates with web.js (server.js) over a named pipe (see lib/ipc.js for the protocol).
//
// Started by monitor.js before web.js. Survives web.js restarts so PTYs keep running
// even while the HTTP/WS layer is reloaded.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const pty = require('node-pty');
const ipc = require('./lib/ipc');
const { resolveRestoreRunCommand } = require('./lib/restore-command');
const { claudeProjectDirName } = require('./lib/transcript');
const agents = require('./lib/agents');
const { splitTrailingCr, isEscapeKey, endsBracketedPaste } = require('./lib/submit-frames');
const { endsInAltScreen } = require('./lib/replay-sanitize');
const { scanOsc9 } = require('./lib/osc9-notify');

const WORKER_VERSION = '0.6.2'; // 0.6.2: a session restored from a scrollback that ends mid-alt-screen (Claude killed while in /tui fullscreen, so ?1049l never arrived) gets a corrective ?1049l appended, instead of stranding xterm in the alt buffer showing a frozen frame over a live shell. Prior 0.6.1: the submit gap is measured against the wire, not the frame.

// --- Optional latency instrumentation (opt-in via WT_LATENCY_DEBUG=1) -----
const _LATENCY_DEBUG = process.env.WT_LATENCY_DEBUG === '1';
if (_LATENCY_DEBUG) {
  let _lagLast = performance.now();
  const _lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - _lagLast - 10;
    if (lag > 50) {
      const mem = process.memoryUsage();
      console.log(`[latency-lag] ${new Date().toISOString()} stall=${lag.toFixed(0)}ms heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
    }
    _lagLast = performance.now();
  }, 10);
  if (typeof _lagTimer.unref === 'function') _lagTimer.unref();
}
function _slowOpLog(name, dur) {
  if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} ${name} dur=${dur.toFixed(0)}ms`);
}
const STALE_STATUS_TIMEOUT_MS = 5 * 60 * 1000;
// Abandonment backstop for a session BLOCKED ON THE USER — 'waiting', or 'working'
// with a question on screen (#79); see correctStaleStatus. Deliberately far beyond
// any plausible answer delay — a question asked in the evening must still be red in
// the morning — so this catches only an agent that died mid-question without firing
// a resolving hook, never a user who simply has not answered yet.
const WAITING_ABANDONED_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024;

// Bracketed-paste mode (DECSET/DECRST 2004). Apps like Claude Code enable it
// once at startup with ESC[?2004h. xterm.js only wraps pastes in the
// ESC[200~ … ESC[201~ markers while that mode is on — without them a
// multi-line paste sends bare CRs, so each line submits and only the last one
// survives. The enable sequence scrolls out of the capped scrollback buffer on
// long sessions, so a freshly-opened browser tab (re-attach) never sees it. We
// track the mode per session from the PTY stream and re-assert it on attach.
const BP_ON = Buffer.from('\x1b[?2004h');
const BP_OFF = Buffer.from('\x1b[?2004l');
// Returns the resulting bracketed-paste state if `buf` contains a 2004 toggle,
// else null (leave the session's current state unchanged). Whichever marker
// appears last in the chunk wins.
function scanBracketedPaste(buf) {
  const on = buf.lastIndexOf(BP_ON);
  const off = buf.lastIndexOf(BP_OFF);
  if (on === -1 && off === -1) return null;
  return on > off;
}

// --- Config ----------------------------------------------------------------
// Pipe path — overrideable for tests
const PIPE_PATH = process.env.WT_WORKER_PIPE || (
  process.platform === 'win32'
    ? '\\\\.\\pipe\\web-terminal-pty'
    : '/tmp/web-terminal-pty.sock'
);

// Data dir — where sessions.json + scrollback/ live. Tests override this.
const DATA_DIR = process.env.WT_WORKER_DATA_DIR || __dirname;
const SESSIONS_FILE = process.env.WT_TEST && !process.env.WT_WORKER_DATA_DIR
  ? path.join(DATA_DIR, 'sessions.test.json')
  : path.join(DATA_DIR, 'sessions.json');
const SCROLLBACK_DIR = path.join(DATA_DIR, 'scrollback');
const CLAUDE_SESSION_NAMES_FILE = path.join(DATA_DIR, 'claude-session-names.json');
const CONFIG_FILE = process.env.WT_TEST && !process.env.WT_WORKER_DATA_DIR
  ? path.join(__dirname, 'config.test.json')
  : path.join(__dirname, 'config.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.default.json');

try { if (!fs.existsSync(SCROLLBACK_DIR)) fs.mkdirSync(SCROLLBACK_DIR, { recursive: true }); } catch {}

// --- Live config (re-read every 5s) ---------------------------------------
let _liveConfigCache = null;
let _liveConfigTime = 0;
const LIVE_CONFIG_TTL = 5000;

function _refreshLiveConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      _liveConfigCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } else if (fs.existsSync(DEFAULT_CONFIG_FILE)) {
      _liveConfigCache = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
    }
  } catch {}
  _liveConfigTime = Date.now();
}

function liveConfig(key, fallback) {
  if (!_liveConfigCache || Date.now() - _liveConfigTime > LIVE_CONFIG_TTL) _refreshLiveConfig();
  if (_liveConfigCache && _liveConfigCache[key] !== undefined) return _liveConfigCache[key];
  return fallback;
}

function getDefaultCwd() { return process.env.WT_CWD || liveConfig('defaultCwd', 'C:\\dev'); }

const SHELL = process.env.WT_SHELL || liveConfig('shell', process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash');
const PORT_HINT = parseInt(process.env.WT_PORT || liveConfig('port', '7681'));

// --- API-error detection + auto-continue ----------------------------------
// Claude Code prints "API Error: <code> <msg>" into the PTY stream when a
// request fails (no hook fires for it), so we sniff it out of the output path.
// On a transient/overload error we walk an escalation ladder: continue,
// continue, then /compact + replay the user's last prompt. Non-transient
// errors (400/401 — retrying won't help) only flag + notify.
const _apiErrFast = process.env.WT_API_ERROR_FAST === '1'; // tests: shrink timers
// Backoff before each auto action (overload often needs a breather to subside).
const API_ERROR_BACKOFF_MS = _apiErrFast ? [40, 40, 40] : [5000, 15000, 30000];
const API_ERROR_MAX_ATTEMPTS = 3;     // total auto actions per episode
const API_ERROR_COMPACT_ATTEMPT = 3;  // the attempt that runs /compact + replay
const API_ERROR_EPISODE_MS = 120000;  // a new error this long after the last auto
                                       // action starts a fresh episode (resets count)
const API_ERROR_COMPACT_MIN_WAIT_MS = _apiErrFast ? 10 : 1500;       // ignore the settle-idle right after /compact
const API_ERROR_COMPACT_FALLBACK_MS = _apiErrFast ? 300 : 45000;     // replay anyway if no idle hook arrives
const API_ERROR_NEEDLE = Buffer.from('API Error');

// Gap between typing text and the CR that submits it. An agent TUI reads input in raw
// mode where Enter is CR (\r) — not LF (\n). How long the CR must trail the text is a
// property OF THE AGENT, so it lives in the provider registry (lib/agents.js), not here.
function submitGapMs(session) {
  if (_apiErrFast) return 10; // tests: shrink timers
  return agents.submitPolicy(sessionAgent(session)).gapMs;
}

function autoContinueEnabled() {
  // Ops/test override wins, then live config (default ON).
  if (process.env.WT_AUTO_CONTINUE_API_ERROR === '0') return false;
  if (process.env.WT_AUTO_CONTINUE_API_ERROR === '1') return true;
  return liveConfig('autoContinueOnApiError', true) === true;
}

// --- 5h usage-limit auto-resume (issue #69) ---------------------------------
// A session pinned on its account's 5-hour rate-limit window can only be revived
// once that window resets. When the reset time is KNOWN — today only for Codex,
// which records it in its rollout (lib/metrics-codex.js: fiveHResetAt); Claude's
// status push carries no such field yet, see the stub at POST /api/claude-status —
// arm a ONE-SHOT timer that sends the SAME 'continue' the API-error ladder sends
// (via submitLine, below), AUTO_RESUME_DELAY_MS after the window turns over (a
// small buffer so the account-side counter has actually rolled before we retry).
//
// OPT-IN, default OFF, unlike the API-error ladder above (which reacts to a real,
// observed error): this fires purely off a timestamp with no proof the session is
// actually stalled on the cap — see the status check in fireAutoResume for the one
// cheap guard this pass has. Precise blocked-state detection (a real "hit the 5h
// cap" signal, for both agents) is a follow-up.
const _autoResumeFast = process.env.WT_AUTO_RESUME_FAST === '1'; // tests: shrink the post-reset delay
const AUTO_RESUME_DELAY_MS = _autoResumeFast ? 50 : 60000; // #69: resetAt + ~1 minute

function autoResumeOnResetEnabled() {
  // Ops/test override wins, then live config (default OFF — see config.default.json).
  if (process.env.WT_AUTO_RESUME_ON_RESET === '0') return false;
  if (process.env.WT_AUTO_RESUME_ON_RESET === '1') return true;
  return liveConfig('autoResumeOnReset', false) === true;
}

function isClaudeSession(session) {
  return !!(session.hookStatus
    || session.claudeSessionId
    || (session.autoCommand && /\bclaude\b/i.test(session.autoCommand)));
}

function stripAnsiForScan(s) {
  // CSI sequences (incl. SGR colour codes) wrap the error text; strip them so
  // the status code / phrase classification sees clean text.
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function isTransientApiError(line) {
  // Retryable: overload, rate limit, gateway/timeout, transport errors.
  if (/\b(408|409|425|429|500|502|503|504|520|521|522|523|524|529)\b/.test(line)) return true;
  return /overload|rate.?limit|temporar|time(?:d)?\s*out|timeout|connection (?:error|reset)|econnreset|etimedout|enetunreach|fetch failed|socket hang up|service unavailable|bad gateway|gateway time/i.test(line);
}

// Write a minimal readline config that enables bracketed paste mode.
// Bash 4.4 ships with the setting available but OFF by default; this opts it
// back on without overriding the user's own .inputrc (we $include it first).
// Written once per worker process; sessions share the same file.
const _WT_INPUTRC_PATH = path.join(__dirname, '.wt_inputrc');
(function _ensureInputrc() {
  try {
    const content = [
      '# Web-terminal generated — enables bracketed paste mode for this shell.',
      '# Your own ~/.inputrc is included first so your keybindings still apply.',
      '$include /etc/inputrc',
      '$include ~/.inputrc',
      'set enable-bracketed-paste on',
    ].join('\n') + '\n';
    fs.writeFileSync(_WT_INPUTRC_PATH, content, 'utf8');
  } catch (e) {
    log('warning: could not write .wt_inputrc:', e.message);
  }
})();

function buildSafeEnv() {
  if (liveConfig('passAllEnv', false)) return Object.assign({}, process.env, { TERM: 'xterm-256color', INPUTRC: _WT_INPUTRC_PATH });
  return {
    TERM: 'xterm-256color',
    INPUTRC: _WT_INPUTRC_PATH,
    HOME: process.env.USERPROFILE || os.homedir(),
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG || 'en_US.UTF-8',
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ProgramFiles: process.env.ProgramFiles,
    'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
}

const log = (...args) => {
  if (process.env.WT_WORKER_QUIET) return;
  console.log(`[pty-worker ${new Date().toISOString()}]`, ...args);
};

// --- Claude session helpers -----------------------------------------------
let _claudeHome = null;

function detectClaudeHome() {
  // Tests override via WT_CLAUDE_HOME to point at a temp dir.
  if (process.env.WT_CLAUDE_HOME) return process.env.WT_CLAUDE_HOME;
  const configured = liveConfig('claudeHome', '');
  if (configured) return configured;
  const profile = process.env.USERPROFILE || os.homedir();
  if (fs.existsSync(path.join(profile, '.claude'))) return profile;
  try {
    const usersDir = 'C:\\Users';
    for (const d of fs.readdirSync(usersDir)) {
      if (d === 'Public' || d === 'Default' || d === 'Default User' || d === 'All Users') continue;
      const candidate = path.join(usersDir, d);
      if (fs.existsSync(path.join(candidate, '.claude'))) return candidate;
    }
  } catch {}
  return profile;
}

function getClaudeProjectsDir() {
  if (!_claudeHome) _claudeHome = detectClaudeHome();
  return path.join(_claudeHome, '.claude', 'projects');
}

// Issue #16: cache per-cwd session-id detection.
//
// Before: every sessionSummary (i.e. every listSessions RPC and every event
// broadcast) called detectClaudeSessionIdFromDir, which did a full readdir +
// per-file statSync of `~/.claude/projects/<encoded-cwd>`. With dozens of
// accumulated Claude .jsonl session logs per project, cost grew linearly in
// history depth and the work was repeated on every tick.
//
// After: per-cwd cache keyed by the encoded project dir mtime. A single stat
// of the dir is cheap; when mtimeMs hasn't moved, we reuse the last answer.
// When Claude writes a new .jsonl or touches an existing one, the parent
// dir's mtime advances on all major filesystems (NTFS, ext4, APFS), so we
// invalidate naturally. Misses (dir absent) are also cached so repeated
// polls during session startup don't each stat a missing dir; the cached
// miss is invalidated the next time the dir appears (fs.statSync succeeds
// with a different mtime than the sentinel).
//
// The cache is a Map keyed by cwd (not by encoded dir) so we don't recompute
// the encoding string on every call.
//
// Test hook (WT_TEST only): __testClaudeDetectCounters RPC exposes hit/miss
// counters and can reset them. The counters wrap the readdir path so tests
// can assert "cache hit did NOT walk the dir".
const _claudeSessionIdCache = new Map(); // cwd -> { sessionId, dirMtime }
let _claudeDetectReaddirCount = 0;

// Newest .jsonl in the cwd's Claude project dir, WITH its mtime.
// Returns { sessionId, mtimeMs } or null. The mtime is what lets callers tell
// a conversation that predates a freshly-created session (a *previous* one)
// from one the session wrote itself — see ownClaudeSessionId (#23).
function detectClaudeSessionFromDir(cwd) {
  const _t0 = _LATENCY_DEBUG ? performance.now() : 0;
  const _res = _detectClaudeSessionFromDirInner(cwd);
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _t0;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} detectClaudeSessionFromDir cwd=${cwd || ''} dur=${dur.toFixed(0)}ms`);
  }
  return _res;
}
// Back-compat: id only, regardless of when it was written. Callers that
// genuinely want the newest-on-disk id (e.g. rename, which tracks the forked
// jsonl Claude creates when resuming) use this.
function detectClaudeSessionIdFromDir(cwd) {
  const r = detectClaudeSessionFromDir(cwd);
  return r ? r.sessionId : null;
}
function _detectClaudeSessionFromDirInner(cwd) {
  if (!cwd) return null;
  let projectDir;
  try {
    projectDir = path.join(getClaudeProjectsDir(), claudeProjectDirName(cwd));
  } catch { return null; }

  let dirMtime;
  try {
    dirMtime = fs.statSync(projectDir).mtimeMs;
  } catch {
    // Dir doesn't exist (ENOENT) or is otherwise unreadable. Clear any stale
    // cached answer and return null. We intentionally do NOT cache the miss
    // — a single stat per call is cheap and guarantees we pick up the dir
    // the instant Claude creates it, without needing any cache-invalidation
    // signal from the spawn path.
    _claudeSessionIdCache.delete(cwd);
    return null;
  }

  const cached = _claudeSessionIdCache.get(cwd);
  if (cached && cached.dirMtime === dirMtime) {
    return cached.sessionId ? { sessionId: cached.sessionId, mtimeMs: cached.mtimeMs } : null;
  }

  // mtime changed (or first lookup) — do the full readdir.
  let sessionId = null, mtimeMs = 0;
  try {
    _claudeDetectReaddirCount++;
    const newest = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ id: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) { sessionId = newest.id; mtimeMs = newest.mtime; }
  } catch {
    // Race: dir vanished between stat and readdir. Fall through; null is
    // a valid cacheable answer for this mtime snapshot.
  }
  _claudeSessionIdCache.set(cwd, { sessionId, mtimeMs, dirMtime });
  return sessionId ? { sessionId, mtimeMs } : null;
}

// The Claude conversation id we can PROVE belongs to THIS session:
//   1. an explicit `--resume <id>` the user put in its command, or
//   2. the newest .jsonl in the cwd — but ONLY if it was written at/after the
//      session started.
// #23 — a brand-new `claude` session opened in a folder that already holds
// older conversations must NOT adopt one of them. Before it has written its
// own .jsonl the newest file on disk is a *previous* conversation; adopting it
// made a fresh session come up "Resumed" (and auto-opened the Chat lens on the
// old transcript). Gating by the session's start time drops that pre-existing
// id, so an unknown session starts fresh; once the session's own claude writes
// its .jsonl (mtime after startedAt) detection succeeds again. Returns null
// when nothing is provably this session's own.
function ownClaudeSessionId(session) {
  const fromCmd = extractClaudeSessionIdFromCmd(session.autoCommand);
  if (fromCmd) return fromCmd;
  const found = detectClaudeSessionFromDir(session.cwd);
  if (found && found.mtimeMs >= (session.startedAt || 0)) return found.sessionId;
  return null;
}

function extractClaudeSessionIdFromCmd(cmd) {
  if (!cmd) return null;
  const match = cmd.match(/--resume\s+([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

function loadClaudeSessionNames() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SESSION_NAMES_FILE, 'utf8')); } catch { return {}; }
}
function saveClaudeSessionNames(names) {
  const _t0 = _LATENCY_DEBUG ? performance.now() : 0;
  try { fs.writeFileSync(CLAUDE_SESSION_NAMES_FILE, JSON.stringify(names, null, 2)); } catch {}
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _t0;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} saveClaudeSessionNames entries=${Object.keys(names).length} dur=${dur.toFixed(0)}ms`);
  }
}

// --- Scrollback chunk store ----------------------------------------------
// Issue #12: store scrollback as a list of chunks + running total byte length
// instead of joining to a single string on every append/read.
// Issue #13: chunks are now Buffers (bytes), not strings. See the term.onData
// handler in createSession — it normalizes PTY output to Buffer once before
// appending, and broadcastPtyOut uses the same Buffer directly (no per-
// destination Buffer.from copy).
//
// Before:
//   - scrollback: string[] plus a manually-maintained scrollbackSize int
//   - attachSession / getScrollback called scrollback.join('') on every call,
//     re-allocating the full ~1-2 MB buffer per reconnect. 5 sessions × 1 MB
//     × N reconnects is GB of alloc + GC pressure.
//
// After:
//   - scrollback: { chunks: Buffer[], totalLen: number }
//   - append is O(1) push + add; trim shifts/head-slices the oldest chunk.
//   - read does exactly one Buffer.concat + toString('utf8') per call.
//
// Note: MAX_SCROLLBACK_SIZE and .length arithmetic work identically for
// strings and Buffers (both report byte/char length; for ASCII-heavy
// terminal output they match, and for multi-byte UTF-8 the Buffer's
// byte length is the correct resource-limit metric anyway).
function newScrollback(initialChunks) {
  const sb = { chunks: [], totalLen: 0 };
  if (initialChunks && initialChunks.length) {
    for (const c of initialChunks) {
      if (c == null || c.length === 0) continue;
      // Defensive: normalize any strings (legacy on-disk format, hand-edited
      // files) to Buffers so the runtime invariant "chunks are Buffers" holds.
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
      sb.chunks.push(buf);
      sb.totalLen += buf.length;
    }
  }
  return sb;
}

function appendScrollback(sb, data) {
  if (data == null || data.length === 0) return;
  // Normalize strings to Buffers — term.onData already hands us Buffers, but
  // test-only __testInjectScrollback helpers and the restart banner pass
  // strings. Doing the conversion here keeps the chunk-list invariant
  // "all entries are Buffers" so concatScrollback can skip the per-chunk
  // type check on the hot read path.
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  sb.chunks.push(buf);
  sb.totalLen += buf.length;
}

function trimScrollback(sb, maxBytes) {
  while (sb.totalLen > maxBytes && sb.chunks.length > 0) {
    const head = sb.chunks[0];
    const overflow = sb.totalLen - maxBytes;
    if (head.length <= overflow) {
      // Drop the whole head chunk.
      sb.chunks.shift();
      sb.totalLen -= head.length;
    } else {
      // Head-slice: keep the tail of this chunk so totalLen lands at maxBytes.
      // Buffer.slice() returns a view (no copy) — cheap.
      sb.chunks[0] = head.slice(overflow);
      sb.totalLen -= overflow;
      break;
    }
  }
}

// Issue #13: chunks are Buffers — one Buffer.concat + UTF-8 decode per call.
// For the single-chunk case we skip the concat allocation.
function concatScrollback(sb) {
  if (sb.chunks.length === 0) return '';
  if (sb.chunks.length === 1) return sb.chunks[0].toString('utf8');
  return Buffer.concat(sb.chunks).toString('utf8');
}

// --- Persistence ----------------------------------------------------------
function loadSessionConfigs() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) { log('failed to load sessions.json:', e.message); }
  return [];
}

function saveSessionConfigs() {
  const configs = [];
  for (const [id, s] of sessions) {
    configs.push({
      id, name: s.name, cwd: s.cwd, autoCommand: s.autoCommand || '', agent: s.agent || null, claudeSessionId: s.claudeSessionId || null,
      // #69 — persisted so a cold restart re-arms the auto-resume timer from the
      // ABSOLUTE reset time (see restoreSessionsOnStartup) instead of losing it, and
      // so a window already handled before the restart is never re-fired.
      fiveHResetAt: s.fiveHResetAt || null,
      autoResumeFiredForResetAt: s.autoResumeFiredForResetAt || null,
    });
  }
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(configs, null, 2), 'utf8'); }
  catch (e) { log('failed to save sessions.json:', e.message); }
}

// Persist scrollback to disk only when explicitly enabled in config. Off by
// default: scrollback captures everything typed into shells (including
// secrets, env dumps, SSH key paste, aws sts output, git config contents
// etc.) and plaintext-on-disk is a weak security posture. When disabled:
// - save/saveAll are no-ops
// - load returns []
// - delete is a no-op (nothing to clean)
// Existing scrollback files are left on disk — users can `rm -rf scrollback/`
// to clean them up after flipping the switch.
function _scrollbackPersistEnabled() {
  // Env var takes precedence (tests + ops override). Default: off.
  if (process.env.WT_PERSIST_SCROLLBACK === '1') return true;
  if (process.env.WT_PERSIST_SCROLLBACK === '0') return false;
  return liveConfig('persistScrollback', false) === true;
}

function saveScrollback(id, session, sync) {
  if (!_scrollbackPersistEnabled()) {
    if (session) session.dirty = false;
    return;
  }
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    // Issue #12: serialize the concatenated scrollback as a single-element
    // JSON array so the on-disk format matches the legacy string[] shape
    // (loadScrollback returns an array that createSession spreads into chunks).
    // One concat per save is equivalent cost to the old string[] JSON.stringify.
    const joined = concatScrollback(session.scrollback);
    const data = JSON.stringify(joined.length > 0 ? [joined] : []);
    if (sync) fs.writeFileSync(file, data, 'utf8');
    else fs.writeFile(file, data, 'utf8', () => {});
    // Clear the dirty flag optimistically — a new chunk of PTY output
    // arriving between now and the next save will re-set it via term.onData.
    // Async write is fire-and-forget; if it fails, next tick's term.onData
    // either re-dirties the session or the data was truly empty.
    if (session) session.dirty = false;
  } catch {}
}

function loadScrollback(id) {
  if (!_scrollbackPersistEnabled()) return [];
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // On-disk format is still a JSON array of UTF-8 strings (same shape as
    // every prior version). Issue #13 switched the in-memory chunk list to
    // Buffers; convert at load so the runtime invariant holds. Each string
    // becomes a single Buffer; the typical modern case is a one-element
    // array (per saveScrollback's single-concat write), but legacy multi-
    // chunk files still decode correctly.
    if (Array.isArray(parsed)) {
      const out = [];
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry.length > 0) {
          out.push(Buffer.from(entry, 'utf8'));
        } else if (Buffer.isBuffer(entry) && entry.length > 0) {
          // Shouldn't happen via JSON.parse but tolerate.
          out.push(entry);
        }
      }
      return out;
    }
    // Defensive: if someone hand-edited the file to a bare string, accept it.
    if (typeof parsed === 'string' && parsed.length > 0) return [Buffer.from(parsed, 'utf8')];
  } catch {}
  return [];
}

function deleteScrollback(id) {
  if (!_scrollbackPersistEnabled()) return;
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

// Async save: yields to the event loop between sessions so JSON.stringify of
// large scrollbacks across many sessions doesn't block input/output/RPC.
// Used by the periodic timer, flushState RPC, and signal-based shutdown.
//
// Issue #10: when `force` is false (the periodic path), skip sessions whose
// scrollback is unchanged since their last save. When `force` is true
// (flushState, shutdown), save every session regardless — that matters for
// correctness on restart, because saveAllScrollbackSync in process.on('exit')
// needs to be able to write everything if a sync flush was somehow missed.
async function saveAllScrollback(sync, force) {
  if (!_scrollbackPersistEnabled()) return;
  const _t0 = _LATENCY_DEBUG ? performance.now() : 0;
  // Snapshot entries so concurrent session mutation during await points
  // doesn't trip the iterator. A session deleted mid-loop will still get
  // its stale scrollback written — harmless; the next tick overwrites or
  // deleteScrollback cleans up.
  const entries = Array.from(sessions);
  let writtenCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const [id, session] = entries[i];
    if (force || session.dirty) {
      const _tSess = _LATENCY_DEBUG ? performance.now() : 0;
      saveScrollback(id, session, sync);
      writtenCount++;
      if (_LATENCY_DEBUG) {
        const d = performance.now() - _tSess;
        if (d > 30) console.log(`[slow-op] ${new Date().toISOString()} saveScrollback[${id.substring(0,8)}] sync=${!!sync} bytes=${session.scrollback.totalLen} dur=${d.toFixed(0)}ms`);
      }
    }
    // Yield after each session except the last to release the event loop.
    if (i < entries.length - 1) {
      await new Promise(r => setImmediate(r));
    }
  }
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _t0;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} saveAllScrollback sync=${!!sync} force=${!!force} sessions=${entries.length} written=${writtenCount} dur=${dur.toFixed(0)}ms`);
  }
}

// Synchronous-only save — for the `process.on('exit')` handler, which runs
// after the event loop has stopped and cannot await. Normal shutdown paths
// already flushed via the async version; this is a last-resort safety net.
// Always saves every session (force=true semantics) — we can't risk losing
// scrollback on final exit.
function saveAllScrollbackSync() {
  if (!_scrollbackPersistEnabled()) return;
  for (const [id, session] of sessions) saveScrollback(id, session, true);
}

// --- Session map ----------------------------------------------------------
const sessions = new Map();
const attachedConnections = new Set(); // currently-connected web.js connections (for event push)

// Per-connection subscription map: conn -> Map<sessionId, refCount>
// refCount allows the same web.js connection to attach to the same session
// multiple times (one WS client per attach) and only stop forwarding when
// the last reference is detached.
const connSubs = new WeakMap();

function getSubs(conn) {
  let subs = connSubs.get(conn);
  if (!subs) { subs = new Map(); connSubs.set(conn, subs); }
  return subs;
}

function subscribeConn(conn, sessionId) {
  const subs = getSubs(conn);
  subs.set(sessionId, (subs.get(sessionId) || 0) + 1);
}

function unsubscribeConn(conn, sessionId) {
  const subs = connSubs.get(conn);
  if (!subs) return;
  const next = (subs.get(sessionId) || 0) - 1;
  if (next <= 0) subs.delete(sessionId);
  else subs.set(sessionId, next);
}

function broadcastEvent(event, params) {
  const frame = ipc.encodeJson({ event, params });
  for (const conn of attachedConnections) {
    try { conn.send(frame); } catch {}
  }
}

// --- API-error detection + auto-continue (see constants block up top) ------

// Per-PTY-chunk sniff. Hot path: a single Buffer.includes() memmem when not
// already flagged; the toString + regex only runs on the rare chunk that
// actually carries "API Error". Gated to Claude sessions so a logfile that
// happens to contain the phrase in a plain shell doesn't trip it.
function detectApiErrorInOutput(session, buf) {
  if (session.apiError) return;            // already flagged — wait for clear
  if (!isClaudeSession(session)) return;
  if (!buf.includes(API_ERROR_NEEDLE)) return;
  const text = stripAnsiForScan(buf.toString('utf8'));
  const m = /API Error[^\n\r]*/.exec(text);
  if (!m) return;
  markApiError(session, m[0].trim().slice(0, 200));
}

function markApiError(session, line) {
  const transient = isTransientApiError(line);
  session.apiError = true;
  session.apiErrorText = line;
  session.lastApiErrorAt = Date.now();
  log(`api-error: "${session.name}" (${session.id}) ${transient ? 'transient' : 'non-transient'}: ${line}`);
  broadcastEvent('apiError', { id: session.id, name: session.name, apiError: true, text: line, transient });
  if (transient) scheduleAutoContinue(session);
}

// Clears the highlight (called when Claude next starts working — a retry, ours
// or the user's). Cancels a pending auto-continue timer but deliberately does
// NOT reset the attempt counter: a brief working blip between two overload
// errors must stay in the same episode, else the ladder loops forever. The
// counter only resets via the episode-timeout in scheduleAutoContinue.
function clearApiError(session) {
  if (session._autoContinueTimer) { clearTimeout(session._autoContinueTimer); session._autoContinueTimer = null; }
  if (!session.apiError) return false;
  session.apiError = false;
  session.apiErrorText = '';
  log(`api-error: "${session.name}" (${session.id}) cleared`);
  broadcastEvent('apiError', { id: session.id, name: session.name, apiError: false, text: '', cleared: true });
  return true;
}

function scheduleAutoContinue(session) {
  if (!autoContinueEnabled()) return;
  const now = Date.now();
  if (!session._lastAutoContinueAt || (now - session._lastAutoContinueAt) > API_ERROR_EPISODE_MS) {
    session.autoContinueCount = 0; // fresh episode
  }
  const count = session.autoContinueCount || 0;
  if (count >= API_ERROR_MAX_ATTEMPTS) {
    log(`api-error: "${session.name}" exhausted ${API_ERROR_MAX_ATTEMPTS} auto-continue attempts; leaving highlighted`);
    return;
  }
  const attempt = count + 1;
  session.autoContinueCount = attempt;
  session._lastAutoContinueAt = now;
  const delay = API_ERROR_BACKOFF_MS[Math.min(attempt - 1, API_ERROR_BACKOFF_MS.length - 1)];
  if (session._autoContinueTimer) clearTimeout(session._autoContinueTimer);
  session._autoContinueTimer = setTimeout(() => {
    session._autoContinueTimer = null;
    const s = sessions.get(session.id);
    if (!s) return;
    if (attempt >= API_ERROR_COMPACT_ATTEMPT) {
      // Failed twice — shrink context with /compact, then replay the last
      // prompt once Claude settles (idle hook or fallback timer).
      try { submitLine(s, '/compact'); } catch (e) { log(`api-error: /compact write failed: ${e.message}`); return; }
      log(`api-error: "${s.name}" auto attempt ${attempt}/${API_ERROR_MAX_ATTEMPTS}: sent /compact`);
      armCompactReplay(s);
      setCompacting(s, 'auto-recovery'); // #65 — same indicator as a user's own /compact
      broadcastEvent('apiError', { id: s.id, name: s.name, apiError: true, text: s.apiErrorText || '', transient: true, autoContinue: attempt, action: 'compact' });
    } else {
      try { submitLine(s, 'continue'); } catch (e) { log(`api-error: continue write failed: ${e.message}`); return; }
      log(`api-error: "${s.name}" auto attempt ${attempt}/${API_ERROR_MAX_ATTEMPTS}: sent continue`);
      broadcastEvent('apiError', { id: s.id, name: s.name, apiError: true, text: s.apiErrorText || '', transient: true, autoContinue: attempt, action: 'continue' });
    }
  }, delay);
  if (typeof session._autoContinueTimer.unref === 'function') session._autoContinueTimer.unref();
}

function armCompactReplay(session) {
  const text = (session.lastPrompt && session.lastPrompt.trim()) ? session.lastPrompt : 'continue';
  session._compactReplay = { text, setAt: Date.now() };
  if (session._compactReplayTimer) clearTimeout(session._compactReplayTimer);
  session._compactReplayTimer = setTimeout(() => doCompactReplay(session, 'timeout'), API_ERROR_COMPACT_FALLBACK_MS);
  if (typeof session._compactReplayTimer.unref === 'function') session._compactReplayTimer.unref();
}

function doCompactReplay(session, reason) {
  const s = sessions.get(session.id);
  if (!s || !s._compactReplay) return;
  const { text } = s._compactReplay;
  s._compactReplay = null;
  if (s._compactReplayTimer) { clearTimeout(s._compactReplayTimer); s._compactReplayTimer = null; }
  writePromptToTerm(s, text);
  log(`api-error: "${s.name}" compact-replay (${reason}): ${text.slice(0, 80)}`);
  broadcastEvent('apiError', { id: s.id, name: s.name, apiError: !!s.apiError, text: s.apiErrorText || '', autoContinue: API_ERROR_COMPACT_ATTEMPT, action: 'replay-prompt', replayText: text.slice(0, 200) });
}

// --- 5h usage-limit auto-resume timer (issue #69) ---------------------------
// session.fiveHResetAt (ms-epoch | null) arrives via the setFiveHResetAt RPC —
// server.js calls it whenever sessionMetrics() learns a value (Codex transcript
// read today; Claude's stub always sends null, a no-op here). session.
// autoResumeFiredForResetAt is the LAST resetAt this session already acted on,
// so a window can only ever fire once — comparing against the current
// fiveHResetAt is what makes a genuinely NEW window (Codex reports a fresh
// resets_at once the old one passes) re-arm automatically. Both fields are
// persisted (saveSessionConfigs/restoreSessionsOnStartup) so a cold restart
// re-arms from the ABSOLUTE deadline instead of losing it.

// Cancel any armed timer without touching autoResumeFiredForResetAt — used on
// user activity / Esc / a new UserPromptSubmit (same call sites clearApiError
// uses, see handleHook and noteInterrupt): the user is back, so whatever we were
// about to say is now stale. This does NOT consume the window — if the session
// goes quiet again before it resets, a later setFiveHResetAt/restore can still
// re-arm it.
function cancelAutoResume(session) {
  if (session._autoResumeTimer) { clearTimeout(session._autoResumeTimer); session._autoResumeTimer = null; }
}

// (Re-)arm the one-shot reset timer from session.fiveHResetAt. Safe to call any
// time fiveHResetAt might have changed (the RPC handler, session restore) — a
// no-op when the feature is off, resetAt is unknown, or this window is already
// handled. Arms from the ABSOLUTE fireAt (resetAt + AUTO_RESUME_DELAY_MS): if
// that has already passed — e.g. the worker was down across the reset — this
// fires almost immediately on the next call rather than silently dropping the
// catch-up action.
function armAutoResumeTimer(session) {
  cancelAutoResume(session);
  if (!autoResumeOnResetEnabled()) return;
  const resetAt = session.fiveHResetAt;
  if (typeof resetAt !== 'number' || !isFinite(resetAt) || resetAt <= 0) return;
  if (session.autoResumeFiredForResetAt === resetAt) return; // one-shot: already handled
  const fireAt = resetAt + AUTO_RESUME_DELAY_MS;
  const delay = Math.max(0, fireAt - Date.now());
  session._autoResumeTimer = setTimeout(() => fireAutoResume(session, resetAt), delay);
  if (typeof session._autoResumeTimer.unref === 'function') session._autoResumeTimer.unref();
  log(`auto-resume: "${session.name}" (${session.id}) armed for ${new Date(fireAt).toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

function fireAutoResume(session, resetAt) {
  session._autoResumeTimer = null;
  const s = sessions.get(session.id);
  if (!s) return;
  // Re-check at fire time, not just at arm time: this wait can be hours long, so
  // the config can flip, or a fresher resetAt can supersede this one, before it
  // elapses. A superseding resetAt already re-armed via armAutoResumeTimer, so
  // this stale timer (its closure still holds the OLD resetAt) must stand down.
  if (!autoResumeOnResetEnabled() || s.fiveHResetAt !== resetAt) return;
  s.autoResumeFiredForResetAt = resetAt; // one-shot: consumed whether or not we act below
  saveSessionConfigs();
  // Best-effort "is this session actually stalled?" guard — see the comment on
  // autoResumeOnResetEnabled above: there is no real blocked-state signal yet, so
  // this only avoids typing 'continue' into a session that is visibly mid-turn.
  if (s.status === 'working') {
    log(`auto-resume: "${s.name}" (${s.id}) reset window passed but session is working — skipped`);
    return;
  }
  try { submitLine(s, 'continue'); } catch (e) { log(`auto-resume: continue write failed: ${e.message}`); return; }
  log(`auto-resume: "${s.name}" (${s.id}) sent continue after 5h reset (${new Date(resetAt).toISOString()})`);
  broadcastEvent('autoResume', { id: s.id, name: s.name, resetAt });
}

// #65 — unified "compacting" indicator so the chat lens can show a
// "Compacting conversation…" state regardless of trigger: a user's own
// /compact (PreCompact hook, source 'hook') or our own auto-recovery /compact
// (source 'auto-recovery', above). ONE field (session.compacting), read by
// sessionSummary() and pushed live over the 'compacting' broadcast — no
// per-source duplicate state. Reuses the same fallback pattern/constant as
// armCompactReplay: a /compact that never settles (no idle hook arrives)
// still clears the indicator instead of sticking forever.
function setCompacting(session, source) {
  session.compacting = { since: Date.now(), source };
  if (session._compactingFallbackTimer) clearTimeout(session._compactingFallbackTimer);
  session._compactingFallbackTimer = setTimeout(() => clearCompacting(session, 'timeout'), API_ERROR_COMPACT_FALLBACK_MS);
  if (typeof session._compactingFallbackTimer.unref === 'function') session._compactingFallbackTimer.unref();
  log(`compacting: "${session.name}" (${session.id}) started (${source})`);
  broadcastEvent('compacting', { id: session.id, compacting: true, since: session.compacting.since });
}

// Idempotent — clearing an already-clear session is a no-op (no broadcast).
function clearCompacting(session, reason) {
  if (session._compactingFallbackTimer) { clearTimeout(session._compactingFallbackTimer); session._compactingFallbackTimer = null; }
  if (!session.compacting) return;
  session.compacting = null;
  log(`compacting: "${session.name}" (${session.id}) cleared (${reason})`);
  broadcastEvent('compacting', { id: session.id, compacting: false, since: null });
}

// Low-level write to a session's PTY. Mirrors the write into a per-session
// buffer under WT_TEST so specs can assert the exact bytes we send to the agent
// (CR-vs-LF is the difference between "submitted" and "stuck in the box").
function termWrite(session, data) {
  if (process.env.WT_TEST) (session._testWrites || (session._testWrites = [])).push(data);
  // The one place every byte destined for this PTY passes through, so the one place that
  // can know whether a paste is still open to a CR arriving behind it. Stamped here rather
  // than in deliver() because the TUI does not care WHO wrote the close — a worker-side
  // paste (a replayed prompt) shades a client's next CR exactly as a client paste does.
  session._pasteClosedAt = endsBracketedPaste(data) ? Date.now() : null;
  session.term.write(data);
}

// Is the last thing written to this PTY still able to swallow a lone submit CR? True only
// just after a bracketed-paste close: the agent's own gap is the window the registry
// already declares to be long enough for a CR to read as Enter, so anything older than
// that is, by that same measurement, safely separate.
function pasteStillOpenToCr(session) {
  if (!session._pasteClosedAt) return false;
  return Date.now() - session._pasteClosedAt < submitGapMs(session);
}

// Submit a single line to an agent's interactive TUI. The TUI reads its input box
// in raw mode where the Enter/submit key is CR (\r) — NOT LF (\n): sending \n
// just leaves the text sitting unsubmitted (the bug that silently broke
// auto-continue). Type the text, then send the CR on the agent's delay so the TUI
// has ingested the text — and doesn't treat the burst as a paste — before Enter.
function submitLine(session, text) {
  termWrite(session, text); // may throw → caller's try/catch decides
  const t = setTimeout(() => { try { termWrite(session, '\r'); } catch (e) { log(`api-error: submit CR failed: ${e.message}`); } }, submitGapMs(session));
  if (typeof t.unref === 'function') t.unref();
}

// Submit text to an agent's TUI. Multi-line prompts go through bracketed paste so
// embedded newlines don't submit early; a trailing CR then sends it. Single
// lines go through submitLine (text + CR).
function writePromptToTerm(session, text) {
  try {
    if (text.includes('\n')) {
      termWrite(session, '\x1b[200~' + text + '\x1b[201~');
      const t = setTimeout(() => { try { termWrite(session, '\r'); } catch {} }, submitGapMs(session));
      if (typeof t.unref === 'function') t.unref();
    } else {
      submitLine(session, text);
    }
  } catch (e) { log(`api-error: prompt replay write failed: ${e.message}`); }
}

// Deliver a keystroke frame from a client to the PTY.
//
// For an agent whose TUI folds a whole read into a paste (Codex — see
// lib/submit-frames.js), a frame like `hello\r` never submits: the CR becomes a newline
// in its composer. Hold the CR back and write it alone, submitGapMs later. Frames that
// arrive during that gap queue behind it, so input order is preserved.
//
// An agent whose TUI does NOT fold a read into a paste takes the untouched single
// write. Every agent we ship does fold one, so in practice every submit is split — see
// the measurements on `claude.submit` in lib/agents.js.
function writeUserInput(session, data) {
  if (!agents.submitPolicy(sessionAgent(session)).crBurstsAsPaste) {
    deliver(session, data);
    return;
  }
  if (session._submitTimer) { (session._inputQueue || (session._inputQueue = [])).push(data); return; }
  _writeFrame(session, data);
}

// The ONE point where a frame from a CLIENT reaches the PTY — whether it went straight
// through or waited its turn in the queue. Status is read off the bytes here, at DELIVERY,
// never at arrival: a frame that lands mid-gap is held back (see writeUserInput), and
// reporting an interrupt the PTY has not been given yet would show idle for up to gapMs
// while the withheld CR was still about to submit. The worker's own writes (auto-command,
// api-error replay) go through termWrite directly and are never mistaken for a keypress.
function deliver(session, data) {
  noteInterrupt(session, data);
  termWrite(session, data);
}

// #55 §6 — Esc ends the turn, and the worker is the only component that can know.
//
// Status here is otherwise driven entirely by Claude's hooks, and Claude fires NO hook on a
// user interrupt (Stop does not run when a turn is cancelled). So an interrupted session kept
// reporting "Claude is working" until correctStaleStatus flipped it — five minutes later, and
// only once BOTH the hook clock and the output clock had gone quiet — while the terminal lens
// plainly showed an idle agent.
//
// The signal was always here: the worker writes the Esc byte to the PTY itself. A lone 0x1b
// (never an arrow or a paste — see isEscapeKey) sent to a session that is *working* is an
// interrupt, so the turn is over. Gated on 'working' on purpose: Esc at a permission prompt
// ('waiting') REJECTS the tool and Claude carries on, and its next hook reports the truth.
// Which agents interrupt on Esc is the registry's call, never a branch in here.
function noteInterrupt(session, data) {
  if (session.status !== 'working') return;
  if (!isEscapeKey(data)) return;
  if (!agents.interruptsOnEscape(sessionAgent(session))) return;
  session.status = 'idle';
  // Esc cancels the whole turn — subagents included. Their SubagentStop may never
  // arrive, so drop the tracking with the turn (#61). Cancel any armed idle flip
  // too: it would otherwise still fire, and applyIdle drives the API-error /compact
  // replay — re-submitting the very prompt the user just interrupted.
  cancelPendingIdle(session);
  resetSubagentTracking(session);
  // #69 — the user is at the keyboard interrupting a turn; a pending 5h-reset
  // auto-resume for this session is now stale (same reasoning as clearApiError).
  cancelAutoResume(session);
  log(`interrupt: "${session.name}" working → idle (Esc)`);
  // No notifyType: the user is at the keyboard — they just pressed Esc. Pushing "Claude is
  // done" to their phone for an interrupt they performed themselves would be noise.
  broadcastEvent('statusChanged', { id: sessionIdOf(session), status: session.status });
}

// Write one frame. If it ends in a submit CR, the CR is withheld and the gap is armed.
// A LONE CR is withheld too when it lands on a still-open paste — the images-only submit,
// where the frame before it was the image's `ESC[200~<path>ESC[201~` and there is no
// prompt text to carry the CR clear of it. `head` is empty in that case: there is nothing
// to write now, only the CR to write later.
function _writeFrame(session, data) {
  const split = splitTrailingCr(data, { afterPasteClose: pasteStillOpenToCr(session) });
  if (!split) { deliver(session, data); return; }
  if (split.head.length) deliver(session, split.head);
  session._submitTimer = setTimeout(() => {
    session._submitTimer = null;
    try { termWrite(session, split.cr); } catch (e) { log(`submit CR failed: ${e.message}`); }
    _drainInputQueue(session);
  }, submitGapMs(session));
  if (typeof session._submitTimer.unref === 'function') session._submitTimer.unref();
}

// Write queued frames in order. A queued frame that itself ends in CR re-arms the gap and
// stops the drain — the rest stay queued behind it.
function _drainInputQueue(session) {
  const q = session._inputQueue;
  while (q && q.length && !session._submitTimer) {
    const next = q.shift();
    try { _writeFrame(session, next); } catch (e) { log(`queued input write failed: ${e.message}`); }
  }
}

// Per-chunk PTY output processing — shared by the real term.onData handler and
// the test-only __testInjectOutput RPC so both exercise the same path.
function processPtyOutput(session, buf) {
  // Track bracketed-paste mode so we can re-assert it on re-attach.
  const bp = scanBracketedPaste(buf);
  if (bp !== null) session.bracketedPaste = bp;
  appendScrollback(session.scrollback, buf);
  trimScrollback(session.scrollback, MAX_SCROLLBACK_SIZE);
  session.dirty = true;
  session.lastActivity = Date.now();
  detectApiErrorInOutput(session, buf);
  detectStatusNotificationInOutput(session, buf);
  if (session.clientCount > 0) {
    broadcastPtyOut(session, buf);
  }
}

// --- In-band status for agents without usable hooks (Codex) ----------------
//
// Codex writes its notifications into the PTY as OSC 9 (see lib/osc9-notify.js for the
// measurements and why its hooks are unusable unattended). The worker already reads
// every byte, so it can drive status from them exactly as Claude's hooks do.
//
// Hot path: the overwhelming majority of chunks contain no ESC at all, so the gate is a
// single Buffer.includes for 0x1b before anything is decoded or allocated. Only a
// session whose agent DECLARES the channel is scanned — a plain shell that prints an
// OSC 9 (vim, a build script) must never move a dot.
const ESC_BYTE = 0x1b;
function detectStatusNotificationInOutput(session, buf) {
  const agent = sessionAgent(session);
  if (!agents.readsStatusFromOutput(agent)) return;
  // A carry from the previous chunk must still be drained even if THIS chunk has no
  // ESC — the terminator may be all that is left to arrive.
  if (!buf.includes(ESC_BYTE) && !session._osc9Carry) return;

  const { bodies, carry } = scanOsc9(session._osc9Carry || '', buf.toString('utf8'));
  session._osc9Carry = carry;
  for (const body of bodies) applyOutputStatusNotification(session, agent, body);
}

function applyOutputStatusNotification(session, agent, body) {
  const kind = agents.classifyStatusNotification(agent, body);
  if (!kind) return;
  log(`osc9: session "${session.name}" ${kind} — ${JSON.stringify(body.slice(0, 120))}`);
  // Reuse the hook path rather than re-implementing status: an approval is a
  // PermissionRequest and a finished turn is a Stop, which is what they genuinely
  // ARE. That inherits the idle debounce, the held-stop rule and the push, and keeps
  // one status machine instead of two that drift. hookDriven:false is required — see
  // handleHook.
  handleHook(session, kind === 'approval' ? 'PermissionRequest' : 'Stop',
    null, null, null, { hookDriven: false });
}

// Route binary PTY output only to connections subscribed to that session.
// Issue #11: uses encodePtyOutFromBytes with the session's pre-computed
// idBytes buffer, avoiding a uuid hex parse + 16-byte Buffer alloc on every
// PTY output chunk (the hottest path in this worker).
// Issue #13: term.onData normalizes to Buffer once before appending to
// scrollback and calling this function, so `data` is always a Buffer. The
// previous per-broadcast Buffer.from(data) copy is gone — on Linux this is
// the original PTY byte Buffer (no decode), on Windows it's the Buffer
// produced once by the onData normalizer (not once per subscriber).
//
// Issue #15 — BACKPRESSURE:
//   If conn.send returns false, the underlying socket has buffered the write
//   in user-space. Without backpressure, subsequent frames keep piling into
//   that buffer, and a slow web.js (or a stalled web client behind it) can
//   drive the worker OOM — killing every PTY including all Claude sessions.
//
//   Fix: track an isDraining flag per connection. When we see false from
//   send(), flip the flag and DROP new PTY_OUT frames for that conn until
//   the conn's 'drain' event clears it. Dropping is correct here because
//   scrollback is persisted and replayed on re-attach — the gap heals
//   automatically as soon as the slow consumer catches up.
//
//   The even harder safety net (overflow → destroy conn) lives in lib/ipc.js
//   IpcConnection.send; we just listen for the 'overflow' event to log.
function broadcastPtyOut(session, data) {
  const _t0 = _LATENCY_DEBUG ? performance.now() : 0;
  const sessionId = session.id;
  let frame = null;
  // Issue #15 revisited: the original implementation tripped a frame-drop at
  // Node's default ~64 KB socket highWaterMark, which is trivially crossed on
  // a normal Claude Code redraw burst. Every drop corrupts an in-flight CSI
  // sequence and leaves the user's terminal rendering Claude's UI at wrong
  // rows until a full reconnect. The real OOM safety net is the 50 MB hard
  // cap in lib/ipc.js IpcConnection.send — that destroys a connection whose
  // peer is genuinely unable to drain. Between 64 KB and 50 MB we simply let
  // net.Socket buffer (that's what it's there for); server.js runs on the
  // same host and drains the pipe on its event loop, so normal bursts catch
  // up in a few ms. We still surface the send's boolean return in a
  // _wtBehind flag purely for diagnostics so the 'drain' event can log when
  // a connection was briefly behind.
  for (const conn of attachedConnections) {
    const subs = connSubs.get(conn);
    if (!subs || !subs.has(sessionId)) continue;
    if (conn._closed) continue;
    if (!frame) frame = ipc.encodePtyOutFromBytes(session.idBytes, data);
    let ok = false;
    try { ok = conn.send(frame); } catch { ok = false; }
    if (!ok && !conn._wtBehind) {
      conn._wtBehind = true;
      conn._wtBehindSince = Date.now();
      log(`conn behind — PTY_OUT user-space queue=${conn.writeQueueBytes} bytes (hard cap 50MB; not dropping)`);
    }
  }
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _t0;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} broadcastPtyOut bytes=${data.length} dur=${dur.toFixed(0)}ms`);
  }
}

// #61 — subagent bookkeeping. Lives on the session and ONLY here, so status stays
// the worker's alone (no second status source, no client counting).
//
// Claude's hook payload says WHO fired each event, which is the whole ballgame:
// every event raised inside a subagent carries `agent_id` (+ `agent_type`), and no
// main-agent event does — verified against the real hook stream (SubagentStart /
// SubagentStop / a subagent's own PreToolUse+PostToolUse all carry it; Stop,
// UserPromptSubmit and the parent's PreToolUse/PostToolUse — including the `Agent`
// tool call itself — do not). So "is the main agent still working?" is not a guess.
//
// Tracked as a SET of agent ids, not a counter: a repeated SubagentStart cannot
// double-count and a SubagentStop for an id we never saw cannot drive it negative.
function subagentSet(session) {
  if (!(session.subagents instanceof Set)) session.subagents = new Set();
  return session.subagents;
}
// Called whenever the turn provably ended (new user prompt, Esc interrupt, stale
// correction). Without this a subagent that dies without firing SubagentStop would
// keep the set non-empty and the session could never reach idle again.
function resetSubagentTracking(session) {
  subagentSet(session).clear();
  session.heldStop = null;
}

// --- The idle decision (#61) ------------------------------------------------
// Claude fires Stop between agentic turns too, so flipping to idle the instant it
// arrives flashes "stopped" milliseconds before the next turn starts. The flip is
// therefore debounced, and any working event cancels it.
//
// This debounce used to live in server.js — which is precisely why #61 bit. That
// layer cannot tell a SUBAGENT's PreToolUse from the main agent's: both post under
// the same session id. So while background subagents ran, their tool calls landed
// inside the parent's debounce window and cancelled the parent's REAL Stop before
// the worker ever saw it. The debounce belongs with the component that owns status
// and knows the subagent count — this one. Both halves of the decision are here:
//   Stop with subagents in flight → HELD (status unchanged, no notify)
//   last SubagentStop             → the held stop is released through the debounce
const HOOK_IDLE_DEBOUNCE_MS = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 750;

function cancelPendingIdle(session) {
  if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
}

// Arm the debounced flip to idle. `event` is the idle event being honoured — Stop
// ("Claude stopped") or an idle Notification ("done, waiting for input") — so a
// held Stop is delivered with its own wording, not the other one's.
function armIdle(session, event) {
  cancelPendingIdle(session);
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    applyIdle(session, event);
  }, HOOK_IDLE_DEBOUNCE_MS);
  if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
}

// The ONE place a hook flips a session to idle.
function applyIdle(session, event) {
  // The debounce outlives the session if it exited in the window — don't announce
  // a status for a PTY that is gone (killSession clears the timer; an exit races).
  if (!sessions.has(sessionIdOf(session))) return;
  const prevStatus = session.status;
  session.status = 'idle';
  // If a /compact recovery is in flight, Claude reaching idle means compact
  // finished — replay the captured prompt now (the fallback timer is a backstop).
  // Ignore the immediate settle-idle right after we sent it.
  if (session._compactReplay && (Date.now() - session._compactReplay.setAt) > API_ERROR_COMPACT_MIN_WAIT_MS) {
    doCompactReplay(session, 'idle-hook');
  }
  // #65 — idle means whatever /compact was in flight (user-triggered or ours)
  // has settled. Idempotent no-op if nothing was compacting.
  clearCompacting(session, 'idle');
  let notifyType = null, notifyMsg = null;
  if (prevStatus !== 'idle') {
    notifyType = 'idle';
    notifyMsg = event === 'Stop'
      ? `"${session.name}" — Claude stopped`
      : `"${session.name}" — Claude is done, waiting for input`;
    log(`hook: session "${session.name}" (${sessionIdOf(session)}) status ${prevStatus} → idle (${event})`);
  }
  if (prevStatus !== session.status || notifyType) {
    broadcastEvent('statusChanged', { id: sessionIdOf(session), status: session.status, notifyType, notifyMsg });
  }
}

function correctStaleStatus(session) {
  // #37 — a session running a build / background process / in-flight subagent
  // produces continuous PTY output (build logs, Claude's elapsed-time spinner
  // redraw) but fires NO Claude hook, so keying the stale-flip only on
  // lastHookActivity wrongly marked it idle-green after 5 min while it was still
  // busy. Require BOTH the hook clock AND the output clock (lastActivity, bumped
  // on every PTY chunk in processPtyOutput) to be stale before flipping. This is
  // self-bounding: a genuinely hung process emits nothing, so lastActivity also
  // goes stale and the session still corrects to idle after the timeout.
  //
  // 'waiting' is NOT subject to the 5-minute rule, because for it the heuristic is
  // inverted. 'working' going quiet suggests the work died. 'waiting' going quiet is
  // the state's DEFINITION — the session is blocked on the user and emits nothing,
  // by design, until they answer. Timing it out therefore fired on exactly the
  // sessions that most needed attention, and did so through one broadcast with three
  // effects: the red pulsing dot went calm green, statusClearsApproval() flipped the
  // attention record to cleared, and an FCM 'clear' auto-dismissed the notification
  // already delivered to the phone. The system retracted its own alarm for a question
  // still open. A 'waiting' session ends the way it reliably already does — the hook
  // that fires when the user answers. Only true ABANDONMENT (agent died mid-question,
  // no resolving hook ever) needs a backstop, at a horizon no real answer delay
  // reaches, so an overnight question is still red in the morning.
  //
  // #79 — 'waiting' was only ever the half of that inversion this process could
  // SEE. A session blocked on an AskUserQuestion is just as silent, and for exactly
  // the same reason, but it is 'working': the question arrives as a PreToolUse,
  // which is a working event. So the 5-minute rule went on firing here and the dot
  // still went calm green on a session that owed an answer — the deeper half of #79,
  // under the visible one the chat lens fixed. The real predicate is "blocked on the
  // user", of which the status is only one signal; the other is questionPending,
  // handed down by server.js in handleHook.
  const now = Date.now();
  const blockedOnUser = session.status === 'waiting' || !!session.questionPending;
  const limit = blockedOnUser ? WAITING_ABANDONED_TIMEOUT_MS : STALE_STATUS_TIMEOUT_MS;
  if ((session.status === 'working' || session.status === 'waiting') &&
      session.lastHookActivity && (now - session.lastHookActivity) > limit &&
      (now - (session.lastActivity || 0)) > limit) {
    const prev = session.status;
    session.status = 'idle';
    // The safety net for #61 too: a subagent that crashed without firing
    // SubagentStop leaves the count above zero, which would otherwise pin this
    // session non-idle forever. Both clocks are stale — nothing is running.
    resetSubagentTracking(session);
    // Same reasoning for the question: reaching the abandonment horizon means the
    // agent died mid-question without ever firing a resolving hook. Drop the flag
    // with the status, or every later turn of this session inherits the 12h limit.
    session.questionPending = false;
    log(`stale correction: "${session.name}" ${prev} → idle`);
    broadcastEvent('statusChanged', { id: sessionIdOf(session), status: session.status });
  }
  return session.status;
}

function sessionIdOf(session) {
  // Issue #9: the session object caches its own id at creation time
  // (see createSession), so this is O(1) instead of O(N).
  return session ? session.id : null;
}

// The AI agent this session runs: the explicit choice made at create time, else
// inferred from the launch command, else null for a plain shell. Never throws — an
// unknown value degrades to inference, so a session written by a newer server loads.
// The rule itself lives in lib/agents.js because `POST /api/sessions` owes the same
// answer about the same session and once gave a different one (#119).
function sessionAgent(s) {
  return agents.resolveAgent(s && s.agent, (s && s.autoCommand) || '');
}

function sessionSummary(id, s) {
  const agent = sessionAgent(s);
  let claudeSessionId = s.claudeSessionId || null;
  // Claude records its conversation id in the cwd's project dir; other agents do not.
  // Gate on the command actually launching Claude — identical to the old inline
  // `/\bclaude\b/` grep, but the program-name test now lives in lib/agents.js.
  if (!claudeSessionId && agent === 'claude' && agents.commandLaunches('claude', s.autoCommand)) {
    // #23: only adopt an id provably written by THIS session — never a
    // pre-existing conversation left in the cwd by an earlier session.
    claudeSessionId = ownClaudeSessionId(s);
    if (claudeSessionId) s.claudeSessionId = claudeSessionId;
  }
  correctStaleStatus(s);
  return {
    id,
    name: s.name,
    cwd: s.cwd,
    pid: s.term.pid,
    status: s.status,
    lastActivity: s.lastActivity,
    clients: s.clientCount || 0,
    autoCommand: s.autoCommand || '',
    agent,
    claudeSessionId,
    hookStatus: !!s.hookStatus,
    apiError: !!s.apiError,
    apiErrorText: s.apiError ? (s.apiErrorText || '') : '',
    compacting: !!(s.compacting),
    compactingSince: s.compacting ? s.compacting.since : null,
    // #69 — surfaced for tests and a future "resumes in Xh" UI. null unless a source
    // (Codex's transcript today) reported a 5h reset time via setFiveHResetAt.
    fiveHResetAt: s.fiveHResetAt || null,
  };
}

// A freshly spawned shell can swallow the FIRST byte written to it once it finishes
// setting up its terminal input (Windows ConPTY + MSYS bash re-arms the tty as it
// enters readline, discarding whatever is mid-flight). Seen after a COLD restart,
// where every session restores at once and the shell is slow to settle: the restore
// typed `claude --resume <id>` and the shell received `laude --resume <id>` →
// "bash: laude: command not found", so the session came up dead.
//
// Two guards, because a bare delay is only ever a bet on how slow the machine is:
//  1. wait [AUTO_CMD_SETTLE_MS] after the prompt appears (was 100ms — too short
//     under a restart storm), then
//  2. send a throwaway PRIME first. `' '` + DEL(0x7f) is typed and immediately
//     erased by readline, so it leaves the input line clean and prints no extra
//     prompt — but it is the byte that gets eaten, if one does. The real command
//     then lands whole.
const AUTO_CMD_SETTLE_MS = 250; // after the prompt is seen, before we type anything
const AUTO_CMD_PRIME_MS = 120;  // between the prime and the real command
const AUTO_CMD_PRIME = ' \x7f'; // space + DEL: types, erases, leaves no trace

function sendAutoCommand(session, id, cmdToRun, how) {
  termWrite(session, AUTO_CMD_PRIME);
  setTimeout(() => {
    try {
      termWrite(session, cmdToRun + '\n');
      log(`session ${id} auto-command${how}: ${cmdToRun}`);
    } catch (e) {
      log(`session ${id} auto-command write failed: ${e.message}`);
    }
  }, AUTO_CMD_PRIME_MS);
}

// runCommand (optional): the command actually typed at the shell prompt.
// Defaults to autoCommand. Restore uses this to send `claude --resume <id>`
// while keeping the user-facing autoCommand (e.g. "claude --continue") intact
// in sessions.json — so the UI doesn't suddenly show a derived --resume form.
function createSession(id, cwd, name, autoCommand, savedScrollback, claudeSessionId, runCommand, agent) {
  const sessionEnv = buildSafeEnv();
  sessionEnv.WT_SESSION_ID = id;
  sessionEnv.WT_SESSION_PORT = String(PORT_HINT);
  // H1: expose the per-process hook token to spawned shells so Claude's
  // HTTP-type hook configs can authenticate. Read from the same file server.js
  // writes on startup.
  try {
    const hookTokenFile = path.join(__dirname, '.hook-token');
    if (fs.existsSync(hookTokenFile)) {
      sessionEnv.WT_HOOK_TOKEN = fs.readFileSync(hookTokenFile, 'utf8').trim();
    }
  } catch {}
  const spawnShell = SHELL.replace(/\\/g, '/');
  const spawnCwd = (cwd || getDefaultCwd()).replace(/\\/g, '/');
  // Issue #13: ask node-pty for binary output (Buffers) instead of UTF-8
  // decoded strings. On Linux this means onData emits the raw PTY bytes with
  // no intermediate UTF-8 decode — correct for TUIs that emit non-UTF-8 byte
  // sequences, and one fewer string→Buffer allocation on the hot path.
  //
  // NOTE — Windows: node-pty hardcodes _outSocket.setEncoding('utf8') in
  // windowsPtyAgent.js regardless of the `encoding` option. The option is
  // silently ignored, so onData still yields strings on Windows. The
  // term.onData handler below normalizes string→Buffer once so the rest of
  // the worker (scrollback chunks, broadcastPtyOut) sees Buffers uniformly.
  // This is a node-pty limitation; we keep `encoding: null` so that if/when
  // upstream fixes Windows, we pick up the correct behavior automatically.
  const term = pty.spawn(spawnShell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: spawnCwd,
    env: sessionEnv,
    encoding: null,
    useConptyDll: liveConfig('useConptyDll', true),
  });

  // Issue #12: scrollback is now { chunks, totalLen } — see newScrollback.
  const scrollback = newScrollback(savedScrollback);
  if (scrollback.chunks.length > 0) {
    appendScrollback(scrollback, '\r\n\x1b[33m--- server restarted ---\x1b[0m\r\n\r\n');
  }

  const session = {
    id,
    // Issue #11: precompute the 16-byte UUID buffer once at session creation
    // so broadcastPtyOut can reuse it on every PTY output chunk (skips the
    // replace + Buffer.from(hex) allocation on the hot path).
    idBytes: ipc.uuidToBytes(id),
    term,
    // Issue #12: scrollback is { chunks: (string|Buffer)[], totalLen: number }.
    scrollback,
    name: name || `Session ${id}`,
    cwd: cwd || getDefaultCwd(),
    idleTimer: null,
    lastActivity: Date.now(),
    // Immutable spawn time (lastActivity mutates on every PTY output). Used by
    // ownClaudeSessionId (#23) to reject a cwd's pre-existing conversations —
    // only a .jsonl written at/after this instant can be this session's own.
    startedAt: Date.now(),
    lastUserInput: 0,
    status: 'active',
    hookStatus: false,
    lastHookActivity: 0,
    // #61 — the agent_ids of the subagents running right now, and the MAIN agent's
    // Stop parked until they finish (null when none is held). In-memory only: a
    // restarted worker knows of no live subagent, which is the safe default —
    // Stop then behaves exactly as it did before this existed.
    subagents: new Set(),
    heldStop: null,
    autoCommand: autoCommand || '',
    // Which AI agent this session runs. An explicit choice (the new-session picker)
    // is authoritative and persisted; null means "infer from the command", which is
    // what every session created before this field existed does.
    agent: agents.isKnownAgent(agent) ? agent : null,
    claudeSessionId: claudeSessionId || null,
    clientCount: 0,
    // Bracketed-paste mode (ESC[?2004h/l), tracked from PTY output and
    // re-asserted on attach. Seed from any carry-over/restored scrollback.
    bracketedPaste: scanBracketedPaste(concatScrollback(scrollback)) === true,
    // Issue #10: set to true whenever scrollback is mutated (term.onData,
    // test injection). Cleared by saveScrollback on successful save. The
    // periodic saveAllScrollback(sync=false, force=false) skips sessions
    // with !dirty to avoid writing ~MB of unchanged data every 30s.
    // Initialize to true if we have carry-over scrollback from restore
    // (the "--- server restarted ---" banner needs to be persisted so a
    // second restart-without-output doesn't silently drop it).
    dirty: (scrollback.chunks.length > 0),
  };
  sessions.set(id, session);

  term.onData((data) => {
    // Issue #13: normalize PTY output to Buffer once here so the rest of the
    // worker (scrollback chunks, broadcastPtyOut) operates on Buffers.
    // - Linux: `data` is already a Buffer (encoding: null honored).
    // - Windows: `data` is a UTF-8 string — node-pty forces setEncoding('utf8')
    //   on the outSocket and ignores the `encoding` option (see createSession
    //   comment). We pay one string→Buffer alloc per PTY chunk on Windows,
    //   but it's still a strict win over the old code, which did one Buffer
    //   allocation per BROADCAST DESTINATION (N subscribers = N allocs).
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    // Issue #12/#10: append+trim scrollback, mark dirty, track bracketed paste,
    // sniff for API errors, and fan out to subscribers. Shared with the
    // test-only __testInjectOutput RPC via processPtyOutput().
    processPtyOutput(session, buf);
  });

  term.onExit(() => {
    log(`session ${id} shell exited`);
    // Drop any pending API-error recovery timers so they don't fire at a dead PTY.
    if (session._autoContinueTimer) { clearTimeout(session._autoContinueTimer); session._autoContinueTimer = null; }
    if (session._compactReplayTimer) { clearTimeout(session._compactReplayTimer); session._compactReplayTimer = null; }
    session._compactReplay = null;
    if (session._submitTimer) { clearTimeout(session._submitTimer); session._submitTimer = null; }
    cancelAutoResume(session); // #69 — same reasoning, a dead PTY has nothing to resume
    session._inputQueue = null; // a withheld CR dies with its PTY
    if (session.autoCommand && /\bclaude\b/i.test(session.autoCommand)) {
      // #23: at exit, only attribute a conversation this session provably owns.
      const claudeId = session.claudeSessionId || ownClaudeSessionId(session);
      if (claudeId) {
        session.claudeSessionId = claudeId;
        const names = loadClaudeSessionNames();
        if (!names[claudeId]) { names[claudeId] = session.name; saveClaudeSessionNames(names); }
      }
    }
    sessions.delete(id);
    deleteScrollback(id);
    saveSessionConfigs();
    broadcastEvent('sessionExited', { id, claudeSessionId: session.claudeSessionId });
  });

  // Track write from server.js (force client count reset) — not needed here;
  // server.js will call detachSession on WS close.

  // Auto-command — runCommand is what we type at the prompt; autoCommand is
  // what we persist to sessions.json (so the UI keeps showing the user's
  // original input even after restore rewrites --continue → --resume <id>).
  const cmdToRun = runCommand || autoCommand;
  if (cmdToRun) {
    let autoFired = false;
    const autoListener = term.onData((data) => {
      if (autoFired) return;
      // Issue #13: `data` may be a Buffer (Linux, encoding: null honored) or
      // a string (Windows, encoding option ignored by node-pty). Normalize
      // to string for the prompt-detection regex.
      const str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
      if (/[$#>]\s*$/.test(str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))) {
        autoFired = true;
        autoListener.dispose();
        setTimeout(() => sendAutoCommand(session, id, cmdToRun, ''), AUTO_CMD_SETTLE_MS);
      }
    });
    setTimeout(() => {
      if (!autoFired) {
        autoFired = true;
        autoListener.dispose();
        sendAutoCommand(session, id, cmdToRun, ' (fallback)');
      }
    }, 5000);
  }

  // Claude session ID detection
  if (cmdToRun && /\bclaude\b/i.test(cmdToRun)) {
    const cmdClaudeId = extractClaudeSessionIdFromCmd(cmdToRun);
    if (cmdClaudeId && !session.claudeSessionId) {
      session.claudeSessionId = cmdClaudeId;
    } else if (!cmdClaudeId) {
      setTimeout(() => {
        if (!session.claudeSessionId) {
          // #23: gate on start time so we don't adopt a pre-existing jsonl.
          const detected = ownClaudeSessionId(session);
          if (detected) {
            session.claudeSessionId = detected;
            log(`session ${id} detected Claude session: ${detected}`);
            saveSessionConfigs();
          }
        }
      }, 15000);
    }
  }

  log(`session ${id} created (pid ${term.pid}, cwd ${session.cwd}${cmdToRun ? ', cmd ' + cmdToRun : ''})`);
  saveSessionConfigs();
  return session;
}

// --- Hook handling --------------------------------------------------------
// `agentId` is Claude's `agent_id`: present iff the event was raised INSIDE a
// subagent. It is what lets this function tell "the main agent is working again"
// from "a subagent is calling a tool" — see subagentSet above.
// `opts.hookDriven === false` applies an event that did NOT come from a hook — today,
// a Codex OSC 9 notification (applyOutputStatusNotification). Everything downstream is
// identical on purpose: the same status transitions, the same idle debounce, the same
// broadcast. Only the `hookStatus` flag is withheld, and that is not cosmetic —
// isClaudeSession() treats it as proof the session is Claude, which gates the API-error
// sniff and its auto-recovery. Setting it for a Codex session would arm Claude's
// recovery on it, and that recovery TYPES: it sends "continue", then "/compact" and
// replays the last prompt. Wrong agent, real damage.
function handleHook(session, event, claudeSessionId, prompt, agentId, opts) {
  if (!event) throw new Error('event required');
  const prevStatus = session.status;
  const fromSubagent = !!agentId;
  let notifyType = null, notifyMsg = null;
  if (!opts || opts.hookDriven !== false) session.hookStatus = true;

  // #79 — record whether a question is on screen, as told by server.js (the only
  // layer that sees the AskUserQuestion payload). Set BEFORE the switch so the
  // status this event produces and the flag agree for the broadcast below.
  // An ABSENT value leaves the flag alone rather than clearing it: OSC 9's
  // synthetic hooks (applyOutputStatusNotification) carry no opinion about
  // questions, and neither does an older server.js talking to this worker across
  // a hot reload — clearing on no evidence would quietly re-open this bug.
  if (opts && typeof opts.questionPending === 'boolean') {
    session.questionPending = opts.questionPending;
  }

  // Remember the user's last real prompt so the API-error /compact escalation
  // can replay it. Skip our own auto-sends ("continue") and slash commands so
  // a recovery action doesn't overwrite the genuine task prompt.
  if (event === 'UserPromptSubmit' && typeof prompt === 'string') {
    const p = prompt.trim();
    if (p && p !== 'continue' && !p.startsWith('/')) {
      session.lastPrompt = prompt.slice(0, 8000);
    }
  }

  // Pin the authoritative Claude session UUID reported by Claude itself.
  // Why: filesystem-mtime detection (detectClaudeSessionIdFromDir) returns the
  // newest .jsonl in the project dir, which collides when two web-terminal
  // sessions share a cwd — both end up with the same UUID and after a server
  // restart both --resume the same Claude session, losing the original.
  // The hook payload is the only source that is per-run authoritative.
  if (claudeSessionId && UUID_RE.test(claudeSessionId) &&
      session.claudeSessionId !== claudeSessionId) {
    session.claudeSessionId = claudeSessionId;
    session.claudeSessionIdFromHook = true;
    saveSessionConfigs();
  } else if (claudeSessionId && UUID_RE.test(claudeSessionId)) {
    // Same value — just mark it as hook-confirmed so later detection paths
    // (rename, exit) don't replace it with a possibly-stale dir scan.
    session.claudeSessionIdFromHook = true;
  }

  switch (event) {
    case 'UserPromptSubmit':
      // A new user turn ends the previous one, so any subagent that never
      // reported SubagentStop died with it. Reset here (and only here): this is
      // the one event that provably comes from the MAIN agent, so it cannot be a
      // subagent's own tool call clearing the parent's deferred Stop.
      resetSubagentTracking(session);
      // falls through
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
      if (event === 'SubagentStart' && fromSubagent) subagentSet(session).add(agentId);
      // #112 — a session that owes an ANSWER is not working, it is waiting.
      //
      // An AskUserQuestion arrives as a PreToolUse, so this line used to mark the
      // one session blocked on the user as busy: orange dot, "Working", and
      // `waitingFor` (which requires status 'waiting') silently returning null, so
      // the chat lens named nothing either. Every consumer reads the status; only
      // this process knew about `questionPending`, and it kept the two apart.
      //
      // The concept already existed one function up — `blockedOnUser` is
      // `status === 'waiting' || questionPending` — which is the tell: a fact that
      // has to be OR-ed back in at each use is a fact the status should have
      // carried. Folding it in here makes the dot, the banner and the abandonment
      // backstop agree by construction instead of by three copies of one rule.
      //
      // Narrow by construction: server.js sends an explicit questionPending:false
      // with every event that RESOLVES a question — a different tool's PreToolUse,
      // PostToolUse of AskUserQuestion, UserPromptSubmit, Stop — so the flag is
      // already clear by the time any of those reach this line. This is #79/#98's
      // third and last polarity: green was fixed, idle was fixed, working was not.
      session.status = session.questionPending ? 'waiting' : 'working';
      // Something is running, so a debounced idle flip was a false alarm.
      cancelPendingIdle(session);
      // Only the MAIN agent working again invalidates a held stop: it proves the
      // parent resumed, so the stop we parked is stale and a fresh one will follow
      // at the end of this turn. A SUBAGENT's tool call says nothing about the
      // parent — treating it as "the parent is alive" is exactly how the first cut
      // of this fix lost the stop it was supposed to hold.
      if (!fromSubagent) session.heldStop = null;
      // Claude resumed (a retry — ours or the user's): drop the API-error mark.
      clearApiError(session);
      // #69 — same signal: the user (or a retry) is back, so a pending 5h-reset
      // auto-resume for this session is now stale. Does not consume the window —
      // see cancelAutoResume.
      cancelAutoResume(session);
      break;
    case 'SubagentStop': {
      // #61 — the last subagent finishing is what actually ends a turn whose main
      // agent already stopped. Until then the session is NOT idle: it has work in
      // flight, the dot must stay amber and no "Claude is done" push may fire.
      const live = subagentSet(session);
      if (fromSubagent) live.delete(agentId);
      else live.clear(); // no id to match (shouldn't happen) — don't strand the session
      if (live.size === 0 && session.heldStop) {
        const held = session.heldStop;
        session.heldStop = null;
        armIdle(session, held);
      }
      break;
    }
    case 'Notification':
    case 'Stop': {
      // #61 — the main agent ending its turn does NOT mean the session is done
      // when subagents are still running. Measured against the real hook stream, a
      // backgrounded Task returns its PostToolUse to the parent at once and the
      // parent's Stop lands SECONDS before the subagent's SubagentStop — so the
      // "done" fired while two agents were still working. Hold the stop; the last
      // SubagentStop above releases it through the same debounce.
      const live = subagentSet(session);
      if (live.size > 0) {
        session.heldStop = event;
        log(`hook: session "${session.name}" ${event} held — ${live.size} subagent(s) in flight`);
        break;
      }
      // #98 — an idle Notification raised while a question is still on screen does
      // not mean "the turn ended", it means "I am blocked on you". Claude fires it
      // after ~60s of waiting for input, which is precisely the state a pending
      // AskUserQuestion produces — so armIdle painted the calm green dot on the one
      // session that owed an answer. correctStaleStatus's #79 exemption cannot help
      // here: that rule only declines to CORRECT a silent session, and this sets the
      // status outright.
      //
      // `Stop` is unaffected in practice rather than by a second condition: server.js
      // classifies Stop as an event that resolves a question and sends an explicit
      // questionPending:false with it, applied above the switch — so by the time a
      // genuine end-of-turn arrives the flag is already clear. Self-bounding for the
      // same reason, plus the 12h abandonment backstop.
      if (session.questionPending) {
        log(`hook: session "${session.name}" ${event} not idled — a question is still on screen`);
        break;
      }
      armIdle(session, event);
      break;
    }
    case 'PermissionRequest':
      session.status = 'waiting';
      cancelPendingIdle(session);
      notifyType = 'approval_needed';
      // The agent's own label from the registry — this event now reaches the phone for
      // Codex too, and a Codex approval that says "Claude needs your approval" sends
      // the user to the wrong session.
      notifyMsg = `"${session.name}" — ${agents.getAdapter(sessionAgent(session)).label} needs your approval`;
      break;
    case 'PreCompact':
      // #65 — a /compact is starting: the user's own (this hook) or ours via
      // API-error auto-recovery (scheduleAutoContinue, source 'auto-recovery').
      // Surfaces the "Compacting conversation…" indicator; status itself is
      // untouched — /compact doesn't end the turn. The next idle hook clears it
      // (applyIdle); the fallback timer inside setCompacting is the stuck-guard
      // for a /compact that never settles.
      setCompacting(session, 'hook');
      break;
  }

  const id = sessionIdOf(session);
  if (prevStatus !== session.status) {
    log(`hook: session "${session.name}" (${id}) status ${prevStatus} → ${session.status} (${event})`);
  }

  if (prevStatus !== session.status || notifyType) {
    broadcastEvent('statusChanged', { id, status: session.status, notifyType, notifyMsg });
  }

  session.lastActivity = Date.now();
  session.lastHookActivity = Date.now();
  return { status: session.status };
}

// --- RPC handlers ---------------------------------------------------------
// Defense-in-depth: any session id received from IPC is used as a filesystem
// key (scrollback file name). Reject non-UUIDs so a malicious IPC peer can't
// smuggle "../" into a path via params.id. Throw "session not found" so the
// server.js error mapping returns 404 (matches behavior pre-validation).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('session not found');
  return id;
}

const rpcHandlers = {
  ping: async () => ({ ok: true, version: WORKER_VERSION }),

  listSessions: async () => {
    const list = [];
    for (const [id, s] of sessions) list.push(sessionSummary(id, s));
    return { sessions: list };
  },

  // Reorder the in-memory sessions Map (and persist) to match the requested
  // id order. Unknown ids are ignored; live sessions not present in the input
  // are appended in their existing order so a stale client list can't drop
  // a session that was just created elsewhere.
  reorderSessions: async (params) => {
    const orderedIds = Array.isArray(params?.orderedIds) ? params.orderedIds : null;
    if (!orderedIds) throw new Error('orderedIds must be an array');
    const snapshot = new Map(sessions);
    sessions.clear();
    for (const id of orderedIds) {
      if (typeof id === 'string' && snapshot.has(id)) sessions.set(id, snapshot.get(id));
    }
    for (const [id, s] of snapshot) {
      if (!sessions.has(id)) sessions.set(id, s);
    }
    saveSessionConfigs();
    return { ok: true, count: sessions.size };
  },

  createSession: async (params) => {
    const id = params.id ? requireUuid(params.id) : crypto.randomUUID();
    const cwd = String(params.cwd || getDefaultCwd()).substring(0, 260);
    const name = String(params.name || `Session ${sessions.size + 1}`).substring(0, 100).replace(/[\x00-\x1f]/g, '');
    const autoCommand = String(params.autoCommand || '').substring(0, 500);
    // Explicit agent choice from the new-session picker; unknown/absent → inferred.
    const agent = agents.isKnownAgent(params.agent) ? params.agent : null;
    createSession(id, cwd, name, autoCommand, null, null, undefined, agent);
    broadcastEvent('sessionCreated', { id, name, cwd, autoCommand, agent });
    return { id, name, agent };
  },

  renameSession: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const newName = String(params.name || '').substring(0, 100).replace(/[\x00-\x1f]/g, '');
    if (!newName) throw new Error('name required');
    session.name = newName;
    if ((session.status === 'idle' || session.status === 'active') &&
        session.autoCommand && /\bclaude\b/i.test(session.autoCommand)) {
      const safeName = newName.replace(/[`$"\\]/g, '');
      // Submit through the SSOT, not a raw write: LF is not Enter (the TUI reads
      // raw mode, where submit is CR), and the CR must land AFTER the agent's gap
      // or the TUI folds the whole burst into a paste and swallows it. A raw
      // `...\n` here typed the slash command into the prompt box and added a
      // newline — it never ran.
      try { submitLine(session, `/rename ${safeName}`); } catch {}
    }
    if (session.autoCommand && /\bclaude\b/i.test(session.autoCommand)) {
      // Claude Code forks a resumed conversation into a NEW jsonl (new UUID) on disk.
      // Save the rename under BOTH the --resume id and the newest-on-disk id so the
      // "old sessions" list reflects the rename on whichever entry is shown.
      const fromCmd = session.claudeSessionId || extractClaudeSessionIdFromCmd(session.autoCommand);
      const fromDir = detectClaudeSessionIdFromDir(session.cwd);
      const claudeIds = new Set([fromCmd, fromDir].filter(Boolean));
      if (claudeIds.size > 0) {
        // Track the newest-on-disk id as the canonical one for subsequent saves/exits.
        if (fromDir) session.claudeSessionId = fromDir;
        else if (fromCmd) session.claudeSessionId = fromCmd;
        const names = loadClaudeSessionNames();
        for (const cid of claudeIds) names[cid] = newName;
        saveClaudeSessionNames(names);
      }
    }
    saveSessionConfigs();
    return { ok: true, name: session.name };
  },

  updateSessionAutoCommand: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    session.autoCommand = String(params.autoCommand || '').substring(0, 500);
    saveSessionConfigs();
    return { autoCommand: session.autoCommand };
  },

  killSession: async (params) => {
    const id = requireUuid(params.id);
    const session = sessions.get(id);
    if (!session) return { ok: true }; // already gone
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session._submitTimer) { clearTimeout(session._submitTimer); session._submitTimer = null; }
    session._inputQueue = null; // a withheld CR dies with its PTY
    cancelAutoResume(session); // #69
    try { session.term.kill(); } catch {}
    // Eagerly remove from the map so immediate follow-up RPCs see it as gone
    // (matches legacy server.js behavior). The onExit handler still fires later
    // for cleanup (delete scrollback, save configs, broadcast event) but it's
    // idempotent via sessions.delete.
    sessions.delete(id);
    deleteScrollback(id);
    saveSessionConfigs();
    return { ok: true };
  },

  getSession: async (params) => {
    const id = requireUuid(params.id);
    const session = sessions.get(id);
    if (!session) throw new Error('session not found');
    return sessionSummary(id, session);
  },

  getScrollback: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const limit = parseInt(params.limit) || 1048576;
    // Issue #12: one concat per call instead of re-joining on every access.
    let full = concatScrollback(session.scrollback);
    if (full.length > limit) full = full.slice(-limit);
    return { data: full };
  },

  hookEvent: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    return handleHook(session, params.event, params.claudeSessionId, params.prompt, params.agentId,
      { questionPending: params.questionPending });
  },

  // #69 — server.js calls this whenever sessionMetrics() learns (or loses) this
  // session's 5h-reset timestamp: Codex's transcript read today, Claude's stub
  // (always null) once a real signal exists. This is the ONE path fiveHResetAt
  // reaches the worker — the process that owns the PTY and can survive server.js
  // restarting. A no-op when the value is unchanged; (re-)arms the auto-resume
  // timer (armAutoResumeTimer) when it moves, including to null (which cancels).
  setFiveHResetAt: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const raw = params.fiveHResetAt;
    const val = (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? Math.round(raw) : null;
    if (session.fiveHResetAt !== val) {
      session.fiveHResetAt = val;
      saveSessionConfigs();
      armAutoResumeTimer(session);
    }
    return { ok: true, fiveHResetAt: session.fiveHResetAt };
  },

  resizeSession: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const cols = Math.max(1, Math.min(500, parseInt(params.cols) || 80));
    const rows = Math.max(1, Math.min(200, parseInt(params.rows) || 24));
    try { session.term.resize(cols, rows); } catch {}
    session.lastUserInput = Date.now();
    return { ok: true };
  },

  // Subscribe server.js (the calling connection) to PTY output for this session
  // and return scrollback replay. Server.js tracks WS clients separately and
  // fans out PTY_OUT frames to them.
  // Each attachSession call increments the client count by 1 AND adds a
  // per-connection subscription so PTY_OUT frames are routed to this conn.
  attachSession: async (params, conn) => {
    const id = requireUuid(params.id);
    const session = sessions.get(id);
    if (!session) throw new Error('session not found');
    session.clientCount = (session.clientCount || 0) + 1;
    if (conn) subscribeConn(conn, id);
    const limit = parseInt(params.scrollbackLimit) || 1048576;
    // Issue #12: one concat per attach — the hot reconnect path. Underlying
    // chunks array is preserved across attaches, so repeated reconnects no
    // longer re-allocate-and-free the full scrollback per call.
    let full = concatScrollback(session.scrollback);
    if (full.length > limit) full = full.slice(-limit);
    // Re-assert bracketed-paste mode for the freshly-attached terminal. If the
    // app turned it on but the enable sequence has scrolled out of `full`, the
    // new xterm would otherwise default to off and break multi-line paste.
    // Prepending is safe: any 2004 toggles inside the replay still apply in
    // order, so the final state matches what the app actually wants.
    // (concatScrollback returns a UTF-8 string; the marker is pure ASCII.)
    if (session.bracketedPaste) full = '\x1b[?2004h' + full;
    return { clients: session.clientCount, scrollback: full };
  },

  detachSession: async (params, conn) => {
    const id = requireUuid(params.id);
    const session = sessions.get(id);
    if (conn) unsubscribeConn(conn, id);
    if (!session) return { ok: true };
    session.clientCount = Math.max(0, (session.clientCount || 0) - 1);
    return { clients: session.clientCount };
  },

  // Flush sessions.json + scrollback files to disk synchronously.
  // Used by server.js on graceful shutdown and by tests before worker restart.
  // force=true so we write every session regardless of dirty flag — shutdown
  // must not lose scrollback.
  flushState: async () => {
    saveSessionConfigs();
    await saveAllScrollback(true, true);
    return { ok: true };
  },

  // Test-only: artificially age lastActivity/lastHookActivity.
  ageSession: async (params) => {
    const session = sessions.get(params.id);
    if (!session) throw new Error('session not found');
    if (params.lastActivity !== undefined) session.lastActivity = params.lastActivity;
    if (params.lastHookActivity !== undefined) session.lastHookActivity = params.lastHookActivity;
    return { ok: true };
  },

  // Test-only: inject a scrollback payload of roughly `bytes` size so tests
  // can exercise the periodic-save path with realistic payloads without
  // having to coax the PTY into producing megabytes of output.
  // Test-only: feed bytes through the exact PTY-output path real term.onData
  // uses (scrollback append/trim, dirty, bracketed-paste, API-error sniff,
  // fan-out). Lets tests exercise API-error detection without a real Claude.
  __testInjectOutput: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    processPtyOutput(session, Buffer.from(String(params.data || ''), 'utf8'));
    return { ok: true, apiError: !!session.apiError };
  },

  // Returns the exact byte-strings written to the PTY via termWrite (the
  // auto-recovery submit path). Lets specs verify Enter is sent as CR, not LF.
  __testGetWrites: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    return { writes: (session._testWrites || []).slice() };
  },

  __testInjectScrollback: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const bytes = Math.max(0, parseInt(params.bytes) || 0);
    const skipTrim = !!params.skipTrim; // test-only: let test #10 inject beyond cap
    if (bytes > 0) {
      const chunk = 'x'.repeat(1024);
      let written = 0;
      while (written < bytes) {
        const take = Math.min(chunk.length, bytes - written);
        const piece = take === chunk.length ? chunk : chunk.slice(0, take);
        appendScrollback(session.scrollback, piece);
        written += take;
      }
      if (!skipTrim) trimScrollback(session.scrollback, MAX_SCROLLBACK_SIZE);
      // Issue #10: mimic term.onData's dirty marking so tests exercise the
      // same code path real PTY output takes.
      session.dirty = true;
    }
    return { size: session.scrollback.totalLen, chunks: session.scrollback.chunks.length };
  },

  // Test-only (Issue #12): inject a specific chunk into scrollback without
  // trimming, and optionally read it back. Exposes the chunked layout for
  // tests that verify reads don't clobber the underlying chunks array.
  __testInjectScrollbackChunk: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const data = String(params.data || '');
    if (data.length > 0) {
      appendScrollback(session.scrollback, data);
      trimScrollback(session.scrollback, MAX_SCROLLBACK_SIZE);
      session.dirty = true;
    }
    return {
      totalLen: session.scrollback.totalLen,
      numChunks: session.scrollback.chunks.length,
    };
  },

  // Test-only (Issue #13): inject a Buffer chunk from hex-encoded bytes. The
  // IPC JSON envelope can't round-trip arbitrary binary bytes in a string
  // (non-UTF-8 sequences get replacement-char'd), so tests pass the bytes
  // as a hex string and we decode here.
  __testInjectScrollbackBytes: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const hex = String(params.hex || '');
    if (hex.length > 0) {
      if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error('hex must be an even-length hex string');
      }
      const buf = Buffer.from(hex, 'hex');
      // Mimic term.onData: track bracketed-paste mode from the injected bytes.
      const bp = scanBracketedPaste(buf);
      if (bp !== null) session.bracketedPaste = bp;
      appendScrollback(session.scrollback, buf);
      trimScrollback(session.scrollback, MAX_SCROLLBACK_SIZE);
      session.dirty = true;
    }
    return {
      totalLen: session.scrollback.totalLen,
      numChunks: session.scrollback.chunks.length,
    };
  },

  // Test-only (Issue #13): return the concatenated scrollback bytes as a
  // hex-encoded string so tests can verify exact byte-level content
  // (including non-UTF-8 sequences) without the JSON-IPC UTF-8 round-trip
  // that getScrollback does.
  __testScrollbackBytesHex: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    if (session.scrollback.chunks.length === 0) return { hex: '' };
    const buf = session.scrollback.chunks.length === 1
      ? session.scrollback.chunks[0]
      : Buffer.concat(session.scrollback.chunks);
    return { hex: buf.toString('hex') };
  },

  // Test-only (Issue #13): assert that the scrollback chunk list is all
  // Buffers — exposes the runtime invariant so tests can check it directly.
  __testScrollbackChunkTypes: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    let allBuffers = true;
    let firstNonBufferIdx = -1;
    for (let i = 0; i < session.scrollback.chunks.length; i++) {
      if (!Buffer.isBuffer(session.scrollback.chunks[i])) {
        allBuffers = false;
        firstNonBufferIdx = i;
        break;
      }
    }
    return { allBuffers, firstNonBufferIdx, numChunks: session.scrollback.chunks.length };
  },

  // Test-only (Issue #12): read scrollback chunk metadata for assertions
  // about the internal layout (number of chunks, totalLen). Doesn't return
  // the raw chunks themselves to keep the IPC payload small.
  __testScrollbackMeta: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    return {
      totalLen: session.scrollback.totalLen,
      numChunks: session.scrollback.chunks.length,
    };
  },

  // Test-only: explicitly trigger periodic-style save path (async, non-sync
  // writes). Resolves after the async loop and its inter-session yields.
  // `force` defaults to false to match the periodic timer's semantics — tests
  // that want to exercise the shutdown path pass force=true.
  __testSaveAllScrollback: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const sync = !!params.sync;
    const force = !!params.force;
    await saveAllScrollback(sync, force);
    return { ok: true };
  },

  // Test-only (Issue #16): inspect / reset the Claude session-id detection
  // cache counters. Returns { readdirCount, cacheSize } and optionally resets
  // the readdir counter (params.reset === true). Tests use readdirCount to
  // assert that a sequence of detection calls hit the cache instead of
  // walking the dir.
  __testClaudeDetectCounters: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const before = _claudeDetectReaddirCount;
    if (params && params.reset) _claudeDetectReaddirCount = 0;
    if (params && params.clearCache) _claudeSessionIdCache.clear();
    return { readdirCount: before, cacheSize: _claudeSessionIdCache.size };
  },

  // Test-only (Issue #16): invoke detectClaudeSessionIdFromDir directly for
  // a given cwd. Returns { sessionId } — null if no .jsonl found. This
  // decouples the test from the full createSession path (which would spawn
  // a real shell), letting us exercise the cache in isolation.
  __testDetectClaudeSessionId: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const cwd = String(params.cwd || '');
    return { sessionId: detectClaudeSessionIdFromDir(cwd) };
  },

  // Test-only (#23): exercise ownClaudeSessionId's start-time gate with a
  // synthetic session (cwd + autoCommand + startedAt), without spawning a
  // real shell. Proves a new session in a used folder starts fresh.
  __testOwnClaudeSessionId: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    return {
      sessionId: ownClaudeSessionId({
        cwd: String(params.cwd || ''),
        autoCommand: String(params.autoCommand || ''),
        startedAt: Number(params.startedAt) || 0,
      }),
    };
  },

  // Test-only (Issue #15): flood the calling conn with JSON frames of the
  // given size on the NEXT tick, then emit a `__testFloodResult` event frame
  // reporting counts. Returns immediately so the RPC reply can be sent
  // BEFORE the flood starts (otherwise a paused reader would never see the
  // RPC reply because the flood fills the write buffer).
  //
  // Callers use this pattern:
  //   1. await RPC reply (confirms worker received the request)
  //   2. pause reads
  //   3. the worker's flood runs on the next tick; backpressure trips
  //   4. caller resumes reads later and collects the __testFloodResult event
  //      to confirm what happened
  __testFloodConn: async (params, conn) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const frames = Math.max(1, parseInt(params.frames) || 1);
    const bytes = Math.max(1, parseInt(params.bytes) || 1024);
    const delayMs = Math.max(0, parseInt(params.delayMs) || 0);
    const payload = Buffer.alloc(bytes, 0x41);
    const frame = ipc.encodeFrame(ipc.TYPE_JSON, payload);
    const doFlood = () => {
      let sent = 0, falseReturns = 0;
      for (let i = 0; i < frames; i++) {
        if (conn._closed) break;
        let ok = false;
        try { ok = conn.send(frame); } catch { ok = false; break; }
        sent++;
        if (!ok) {
          falseReturns++;
          if (!conn._wtBehind) {
            conn._wtBehind = true;
            conn._wtBehindSince = Date.now();
          }
          break;
        }
      }
      // Emit a result event. When the peer eventually drains and reads it,
      // they can assert on the recorded state.
      try {
        conn.send(ipc.encodeJson({
          event: '__testFloodResult',
          params: {
            sent, falseReturns,
            isBehind: !!conn._wtBehind,
            closed: !!conn._closed,
            writeQueueBytes: conn.writeQueueBytes,
          },
        }));
      } catch {}
    };
    setTimeout(doFlood, delayMs);
    return { ok: true };
  },

  // Test-only: measure the worker's event-loop block time during a save.
  // Starts a setImmediate probe loop, runs saveAllScrollback, and reports
  // the longest gap between probe ticks. A non-yielding (blocking) save
  // produces one huge gap equal to the save's total duration; a yielding
  // save produces many small gaps because setImmediate fires between
  // per-session iterations.
  __testMeasureSaveBlock: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const sync = !!params.sync;
    // Default to force=true so the measurement is meaningful even if
    // sessions aren't dirty — tests want to measure the save itself,
    // not whether the dirty-skip short-circuits.
    const force = params.force === undefined ? true : !!params.force;
    const gaps = [];
    let last = Date.now();
    let probing = true;
    function probe() {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
      if (probing) setImmediate(probe);
    }
    setImmediate(probe);
    const start = Date.now();
    await saveAllScrollback(sync, force);
    const duration = Date.now() - start;
    probing = false;
    // Wait one tick so the probe stops cleanly.
    await new Promise(r => setImmediate(r));
    let maxGap = 0;
    for (const g of gaps) if (g > maxGap) maxGap = g;
    return { duration, maxGap, ticks: gaps.length };
  },
};

async function handleRpc(conn, msg) {
  const _t0 = _LATENCY_DEBUG ? performance.now() : 0;
  const handler = rpcHandlers[msg.method];
  if (!handler) {
    conn.send(ipc.encodeJson({ id: msg.id, error: `unknown method: ${msg.method}` }));
    return;
  }
  try {
    const result = await handler(msg.params || {}, conn);
    conn.send(ipc.encodeJson({ id: msg.id, result }));
  } catch (e) {
    conn.send(ipc.encodeJson({ id: msg.id, error: e.message || String(e) }));
  }
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _t0;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} rpc:${msg.method} dur=${dur.toFixed(0)}ms`);
  }
}

// --- Startup: restore sessions from disk ----------------------------------
function restoreSessionsOnStartup() {
  const saved = loadSessionConfigs();
  if (saved.length === 0) {
    // Match legacy behavior: create a default session so the server has at least one.
    // Tests rely on getSessions() returning a non-empty list by default.
    if (!process.env.WT_WORKER_NO_DEFAULT) {
      try {
        createSession(crypto.randomUUID(), getDefaultCwd(), 'Default', '', null, null);
        log('created default session');
      } catch (e) {
        log(`failed to create default session: ${e.message}`);
      }
    }
    return;
  }
  log(`restoring ${saved.length} session(s) from ${SESSIONS_FILE}`);
  for (const cfg of saved) {
    const original = cfg.autoCommand || '';
    // Resolve the command to actually run at the restored prompt. Known Claude
    // conversations reattach with `--resume <id>`; an unknown-id claude session
    // starts fresh (NO implicit `--continue`, which would hijack the last
    // conversation in the cwd — #23). See lib/restore-command.js for rationale.
    const runCmd = resolveRestoreRunCommand(cfg);
    let savedScrollback = loadScrollback(cfg.id);
    // The restored session gets a FRESH shell in the NORMAL screen buffer. If the
    // saved scrollback ends mid-alt-screen (Claude killed in fullscreen, so it never
    // emitted ?1049l), replaying it as-is strands xterm in the alt buffer — a frozen
    // stale frame sitting over a live normal-mode shell, which reads to the user as
    // "I can't type". Append a corrective ?1049l so the replay lands back in the
    // normal buffer; a resumed Claude that re-enters fullscreen re-emits ?1049h itself.
    if (savedScrollback.length && endsInAltScreen(Buffer.concat(savedScrollback).toString('latin1'))) {
      savedScrollback = savedScrollback.concat(Buffer.from('\x1b[?1049l', 'latin1'));
    }
    try {
      // cfg.agent is absent for sessions persisted before the field existed; null
      // there means "infer from the command", preserving their behaviour on restore.
      const session = createSession(cfg.id, cfg.cwd, cfg.name, original, savedScrollback, cfg.claudeSessionId || null, runCmd, cfg.agent || null);
      // #69 — restore the ABSOLUTE reset deadline (and which window is already
      // handled) so a cold restart re-arms the same wall-clock timer rather than
      // losing track of it; armAutoResumeTimer fires almost immediately (catch-up)
      // if that deadline already passed while the worker was down.
      if (cfg.fiveHResetAt) {
        session.fiveHResetAt = cfg.fiveHResetAt;
        session.autoResumeFiredForResetAt = cfg.autoResumeFiredForResetAt || null;
        armAutoResumeTimer(session);
      }
    } catch (e) {
      log(`failed to restore session ${cfg.id}: ${e.message}`);
    }
  }
}

// --- Main ------------------------------------------------------------------
const server = ipc.createServer(PIPE_PATH);
server.listening().then(() => {
  log(`listening on ${PIPE_PATH}`);
  // Restore sessions AFTER pipe is listening, so tests that create sessions via
  // RPC won't race with restore.
  restoreSessionsOnStartup();
}).catch((err) => {
  console.error(`[pty-worker] failed to listen on ${PIPE_PATH}:`, err.message);
  process.exit(1);
});

server.on('connection', (conn) => {
  log('web.js connected');
  attachedConnections.add(conn);
  // Issue #15 (revisited): we no longer drop PTY_OUT frames at the 64 KB
  // socket highWaterMark; only the 50 MB hard cap in lib/ipc.js protects
  // against genuine runaway slow consumers. The _wtBehind flag here is
  // purely diagnostic — the 'drain' event logs how long the conn was
  // briefly behind so latency regressions remain observable in logs.
  conn._wtBehind = false;
  conn._wtBehindSince = 0;
  conn.on('drain', () => {
    if (!conn._wtBehind) return;
    const ms = Date.now() - (conn._wtBehindSince || Date.now());
    log(`conn drained — PTY_OUT caught up after ${ms}ms behind`);
    conn._wtBehind = false;
    conn._wtBehindSince = 0;
  });
  conn.on('overflow', (err) => {
    log('conn overflow — IPC queue limit exceeded, destroying connection:', err.message);
  });
  conn.on('frame', (frame) => {
    if (frame.type === ipc.TYPE_JSON) {
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      if (msg && typeof msg.method === 'string' && typeof msg.id === 'number') {
        handleRpc(conn, msg);
      }
      return;
    }
    if (frame.type === ipc.TYPE_PTY_IN) {
      // Binary keystroke frame from web.js — write to the session's PTY, honouring how
      // this session's agent reads a submit CR (writeUserInput).
      let parsed;
      try { parsed = ipc.parsePtyFrame(frame); } catch { return; }
      const session = sessions.get(parsed.sessionId);
      if (!session) return;
      try { writeUserInput(session, parsed.data); } catch {}
      session.lastUserInput = Date.now();
      return;
    }
    // Other binary types are ignored server-side.
  });
  conn.on('close', () => {
    // Release the client-count references held by this connection's
    // attachments, so sessions no longer broadcast to a gone conn.
    const subs = connSubs.get(conn);
    if (subs) {
      for (const [sid, count] of subs) {
        const s = sessions.get(sid);
        if (!s) continue;
        s.clientCount = Math.max(0, (s.clientCount || 0) - count);
      }
      connSubs.delete(conn);
    }
    attachedConnections.delete(conn);
    log('web.js disconnected');
  });
  conn.on('error', (err) => log('conn error:', err.message));
});

server.on('error', (err) => {
  console.error('[pty-worker] server error:', err.message);
});

// Periodic scrollback save (every 30s). Async with per-session yield so a
// cluster of large scrollbacks doesn't freeze the event loop in one tick.
// Issue #10: force=false skips sessions whose scrollback hasn't changed
// since their last save — 10 idle sessions × ~2 MB = ~20 MB not rewritten
// every 30s.
const scrollbackTimer = setInterval(() => {
  saveAllScrollback(false, false).catch(e => log('periodic scrollback save failed:', e.message));
}, 30000);
scrollbackTimer.unref();

// --- Graceful shutdown ----------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — shutting down`);
  // Kick a 3s hard-exit fallback immediately so a stuck async save can't
  // hang the process forever.
  setTimeout(() => process.exit(0), 3000).unref();
  try {
    saveSessionConfigs();
    // force=true: shutdown must save every session regardless of dirty flag.
    await saveAllScrollback(true, true);
  } catch (e) { log('shutdown save error:', e.message); }
  try { await server.close(); } catch {}
  process.exit(0);
}

function runShutdown(sig) { shutdown(sig).catch(e => log('shutdown error:', e && e.message)); }
process.on('SIGINT', () => runShutdown('SIGINT'));
process.on('SIGTERM', () => runShutdown('SIGTERM'));
process.on('SIGHUP', () => runShutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => runShutdown('SIGBREAK'));
}
process.on('exit', () => {
  // The event loop is stopped here — must be strictly synchronous.
  try { saveSessionConfigs(); saveAllScrollbackSync(); } catch {}
});
