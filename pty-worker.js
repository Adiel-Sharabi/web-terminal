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

const WORKER_VERSION = '0.5.1';

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
// Gap between typing text and the CR that submits it. Claude's TUI reads input
// in raw mode where Enter is CR (\r) — not LF (\n) — and debounces fast bursts
// as pastes, so we type the text, pause, then send the CR on its own.
const CLAUDE_SUBMIT_GAP_MS = _apiErrFast ? 10 : 60;

function autoContinueEnabled() {
  // Ops/test override wins, then live config (default ON).
  if (process.env.WT_AUTO_CONTINUE_API_ERROR === '0') return false;
  if (process.env.WT_AUTO_CONTINUE_API_ERROR === '1') return true;
  return liveConfig('autoContinueOnApiError', true) === true;
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
    projectDir = path.join(getClaudeProjectsDir(),
      cwd.replace(/^([A-Z]):\\/, '$1--').replace(/[\\/]/g, '-'));
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
    configs.push({ id, name: s.name, cwd: s.cwd, autoCommand: s.autoCommand || '', claudeSessionId: s.claudeSessionId || null });
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
      try { claudeSubmitLine(s, '/compact'); } catch (e) { log(`api-error: /compact write failed: ${e.message}`); return; }
      log(`api-error: "${s.name}" auto attempt ${attempt}/${API_ERROR_MAX_ATTEMPTS}: sent /compact`);
      armCompactReplay(s);
      broadcastEvent('apiError', { id: s.id, name: s.name, apiError: true, text: s.apiErrorText || '', transient: true, autoContinue: attempt, action: 'compact' });
    } else {
      try { claudeSubmitLine(s, 'continue'); } catch (e) { log(`api-error: continue write failed: ${e.message}`); return; }
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

// Low-level write to a session's PTY. Mirrors the write into a per-session
// buffer under WT_TEST so specs can assert the exact bytes we send to Claude
// (CR-vs-LF is the difference between "submitted" and "stuck in the box").
function claudeTermWrite(session, data) {
  if (process.env.WT_TEST) (session._testWrites || (session._testWrites = [])).push(data);
  session.term.write(data);
}

// Submit a single line to Claude's interactive TUI. Claude reads its input box
// in raw mode where the Enter/submit key is CR (\r) — NOT LF (\n): sending \n
// just leaves the text sitting unsubmitted (the bug that silently broke
// auto-continue). Type the text, then send the CR on a short delay so the TUI
// has ingested the text — and doesn't treat the burst as a paste — before Enter.
function claudeSubmitLine(session, text) {
  claudeTermWrite(session, text); // may throw → caller's try/catch decides
  const t = setTimeout(() => { try { claudeTermWrite(session, '\r'); } catch (e) { log(`api-error: submit CR failed: ${e.message}`); } }, CLAUDE_SUBMIT_GAP_MS);
  if (typeof t.unref === 'function') t.unref();
}

// Submit text to Claude's TUI. Multi-line prompts go through bracketed paste so
// embedded newlines don't submit early; a trailing CR then sends it. Single
// lines go through claudeSubmitLine (text + CR).
function writePromptToTerm(session, text) {
  try {
    if (text.includes('\n')) {
      claudeTermWrite(session, '\x1b[200~' + text + '\x1b[201~');
      const t = setTimeout(() => { try { claudeTermWrite(session, '\r'); } catch {} }, CLAUDE_SUBMIT_GAP_MS);
      if (typeof t.unref === 'function') t.unref();
    } else {
      claudeSubmitLine(session, text);
    }
  } catch (e) { log(`api-error: prompt replay write failed: ${e.message}`); }
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
  if (session.clientCount > 0) {
    broadcastPtyOut(session, buf);
  }
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

function correctStaleStatus(session) {
  // #37 — a session running a build / background process / in-flight subagent
  // produces continuous PTY output (build logs, Claude's elapsed-time spinner
  // redraw) but fires NO Claude hook, so keying the stale-flip only on
  // lastHookActivity wrongly marked it idle-green after 5 min while it was still
  // busy. Require BOTH the hook clock AND the output clock (lastActivity, bumped
  // on every PTY chunk in processPtyOutput) to be stale before flipping. This is
  // self-bounding: a genuinely hung process emits nothing, so lastActivity also
  // goes stale and the session still corrects to idle after the timeout.
  const now = Date.now();
  if ((session.status === 'working' || session.status === 'waiting') &&
      session.lastHookActivity && (now - session.lastHookActivity) > STALE_STATUS_TIMEOUT_MS &&
      (now - (session.lastActivity || 0)) > STALE_STATUS_TIMEOUT_MS) {
    const prev = session.status;
    session.status = 'idle';
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

function sessionSummary(id, s) {
  let claudeSessionId = s.claudeSessionId || null;
  if (!claudeSessionId && s.autoCommand && /\bclaude\b/i.test(s.autoCommand)) {
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
    claudeSessionId,
    hookStatus: !!s.hookStatus,
    apiError: !!s.apiError,
    apiErrorText: s.apiError ? (s.apiErrorText || '') : '',
  };
}

// runCommand (optional): the command actually typed at the shell prompt.
// Defaults to autoCommand. Restore uses this to send `claude --resume <id>`
// while keeping the user-facing autoCommand (e.g. "claude --continue") intact
// in sessions.json — so the UI doesn't suddenly show a derived --resume form.
function createSession(id, cwd, name, autoCommand, savedScrollback, claudeSessionId, runCommand) {
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
    autoCommand: autoCommand || '',
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
        setTimeout(() => {
          term.write(cmdToRun + '\n');
          log(`session ${id} auto-command: ${cmdToRun}`);
        }, 100);
      }
    });
    setTimeout(() => {
      if (!autoFired) {
        autoFired = true;
        autoListener.dispose();
        term.write(cmdToRun + '\n');
        log(`session ${id} auto-command (fallback): ${cmdToRun}`);
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
function handleHook(session, event, claudeSessionId, prompt) {
  if (!event) throw new Error('event required');
  const prevStatus = session.status;
  let notifyType = null, notifyMsg = null;
  session.hookStatus = true;

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
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
      session.status = 'working';
      if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
      // Claude resumed (a retry — ours or the user's): drop the API-error mark.
      clearApiError(session);
      break;
    case 'Notification':
    case 'Stop':
      session.status = 'idle';
      // If a /compact recovery is in flight, Claude reaching idle means compact
      // finished — replay the captured prompt now (the fallback timer is a
      // backstop). Ignore the immediate settle-idle right after we sent it.
      if (session._compactReplay && (Date.now() - session._compactReplay.setAt) > API_ERROR_COMPACT_MIN_WAIT_MS) {
        doCompactReplay(session, 'idle-hook');
      }
      if (prevStatus !== 'idle') {
        notifyType = 'idle';
        notifyMsg = event === 'Stop'
          ? `"${session.name}" — Claude stopped`
          : `"${session.name}" — Claude is done, waiting for input`;
      }
      break;
    case 'PermissionRequest':
      session.status = 'waiting';
      notifyType = 'approval_needed';
      notifyMsg = `"${session.name}" — Claude needs your approval`;
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
    createSession(id, cwd, name, autoCommand, null, null);
    broadcastEvent('sessionCreated', { id, name, cwd, autoCommand });
    return { id, name };
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
      try { session.term.write(`/rename ${safeName}\n`); } catch {}
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
    return handleHook(session, params.event, params.claudeSessionId, params.prompt);
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

  // Returns the exact byte-strings written to the PTY via claudeTermWrite (the
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
    const savedScrollback = loadScrollback(cfg.id);
    try {
      createSession(cfg.id, cfg.cwd, cfg.name, original, savedScrollback, cfg.claudeSessionId || null, runCmd);
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
      // Binary keystroke frame from web.js — write to the session's PTY.
      let parsed;
      try { parsed = ipc.parsePtyFrame(frame); } catch { return; }
      const session = sessions.get(parsed.sessionId);
      if (!session) return;
      try { session.term.write(parsed.data); } catch {}
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
