const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { performance } = require('perf_hooks');
const workerClientLib = require('./lib/worker-client');
const { mintDirectToken, verifyDirectToken } = require('./lib/cluster-token');
const { sanitizeReplay } = require('./lib/replay-sanitize');
const { execGit, gitSafeArgs, gitSafeEnv } = require('./lib/git-safe');
const notifyPush = require('./lib/notify-push');
const transcript = require('./lib/transcript');
const fcm = require('./lib/fcm');

const SERVER_VERSION = '1.30.0'; // 2026-07-09: chat-mode subagent trace — GET /api/sessions/:id/transcript now stamps each Task tool_use with a { agentType, description, running } subagent stub (present when a subagents/agent-*.meta.json links that tool_use id), and a NEW GET /api/sessions/:id/subagent/:toolUseId lazily pages that subagent's OWN transcript (reusing scanTurnsBackward — the sidechain .jsonl shares the main turn shape, so ONE parser). Lets the companion Chat view drill into a running subagent's nested tool calls, mirroring the terminal's arrow-navigable subagent panel. `running` = subagent exists but its Task has no tool_result yet. Additive + backward-compatible (older app ignores the stub; new app vs old server falls back to the flat Task card). Prior 1.29.6: #42 — Chat lens now resolves the transcript for cwds with special chars ('_'/'.'/space). The cwd→Claude-project-dir encoder was duplicated in 3 places (server deriveTranscriptPath + server detectClaudeSessionIdFromDir + pty-worker) and lossy — it only mapped '\'/'/', leaving '_'/'.'/space intact, so e.g. C:\dev\Acme_Core resolved to a non-existent C--dev-Acme_Core dir (Claude actually uses C--dev-Acme-Core) → /transcript 404 → Chat hidden. One SSOT encoder now lives in lib/transcript.js (claudeProjectDirName: replace EVERY non-alphanumeric char with '-', case preserved, verified vs ~/.claude/projects); server + pty-worker both call it, and the dead server-side detectClaudeSessionIdFromDir copy was removed. server.js hot-reloadable; the pty-worker leg needs a cold restart. Prior 1.29.5: #37b — the "finished/idle" push (notify level 'all') no longer fires while a background build / in-flight subagent is still emitting output. The idle debounce now re-checks the worker's output clock (lastActivity via getSession) when it fires: if output landed within the window the session isn't finished, so it re-arms and waits for a genuine quiet period before pushing "Claude is done" (a non-idle statusChanged still cancels). Same output-clock signal #37 gave correctStaleStatus — SSOT. server.js-only → hot-reload. Prior 1.29.4: #38 — Claude context-window % now shows on each session tab/list row (web sidebar + companion list), not only inside the session. Both list endpoints already attach per-session `metrics` (getStatusMetrics); the web sidebar (new ctxBadge helper → .sb-ctx) and the companion SessionCard now render metrics.ctx as a small badge, colored by shared warn-50/danger-70 thresholds (companion ctxColor SSOT in lib/widgets/format_utils.dart, reused by the in-session _MetricsHeader). No server logic changed — asset/version bump only. Prior 1.29.3: #37 — a session running a build / background process / in-flight subagent no longer flips to idle-green while still busy. correctStaleStatus (pty-worker.js) now requires BOTH the hook clock (lastHookActivity) AND the output clock (lastActivity, bumped on every PTY chunk) to be stale past the 5-min timeout before force-flipping working/waiting → idle: a busy session emits continuous output (build logs / Claude's spinner redraw) so it stays non-idle, while a genuinely silent hang still self-corrects (both clocks go stale). Test endpoint /api/test/age-session gains hookOnly/activityOnly to age each clock independently. WORKER code → needs a cold restart to take effect. Prior 1.29.2: #41 — desktop sidebar resize handle fixed + made discoverable. `--sb-width` is now the SINGLE source of truth for width: drag sets the custom property (was inline `style.width`, a separate path from restore-on-load's `--sb-width`); pointerup removes any lingering inline width so toggling the sidebar closed after a resize collapses correctly (was stuck at the dragged width). Handle moved inside the panel (`right:0`, no longer clipped by `overflow:hidden`) + a persistent grip pill (::before, hover/active states) — desktop only; doResize still re-fits the terminal; width clamped 160–600px. app.html-only (served asset → version bump). Prior 1.29.1: #23 (regression) — a NEW claude session in a folder that already holds older conversations no longer adopts one of them. pty-worker's cwd-newest-.jsonl detection (sessionSummary / onExit / 15s timer) now gates on the session's start time via ownClaudeSessionId(): a .jsonl is only attributed to a session if it was written at/after that session started, so a fresh session starts clean (was: mislabeled with the previous conversation's id → auto-opened the Chat lens on the old transcript). Explicit --resume <id> still honored; rename's newest-on-disk name-tracking unchanged. WORKER code → needs a cold restart to take effect. Prior 1.29.0: rich transcript tool data — GET /api/sessions/:id/transcript now includes, per tool_use, its `id`, a per-field-capped structured `input`, and the paired tool_result `result` (output). lib/transcript.js pairs results→tool_uses by id during the backward scan and exposes extractToolResults; the app renders shells (Bash cmd+output), subagents (Task desc/report), and file ops as rich cards. Backward-compatible (name/inputPreview unchanged). Prior 1.28.2: attention-clear now fires on session OPEN — the web app (app.html switchSession) calls POST /api/sessions/:id/attention/clear when foregrounding a session that has a live alert, so opening it in the browser dismisses the phone push (was mobile-only). Web also handles inbound 'clear' notify frames (drops the chip / closes the browser toast) — previously a 'clear' frame fell through to showNotification and could pop an "undefined" toast. Mobile companion (#2): opening a session now cancels its OS notification locally (NotificationService.cancelForSession) instead of relying on a dead FCM 'clear' round-trip that never fires while the app is foreground; a foreground 'clear' push is also routed to cancel. Prior 1.28.1: #25 — idle/'finished' FCM pushes are now high-priority so an 'all'-level session's finish notification wakes the phone through Android Doze (was normal-priority → deferred/dropped). Prior 1.28.0: #21 — session takeover relaxed: multiple devices now SHARE one PTY (shared I/O) by default instead of the second viewer force-disconnecting the first. Opt back into the old single-owner kick with config `exclusiveViewer: true`. Prior 1.27.0: #24 — POST /api/sessions/:id/attention/clear clears a session's attention across devices (flips recorded attention, FCM 'clear' to dismiss phone toasts, broadcasts a 'clear' notify frame so in-app viewers drop the chip); capability 'attention-clear'. Prior 1.26.1: (a) #23 fix — restore no longer appends implicit `--continue` to an unknown-id claude session (that resumed the most-recent conversation in the cwd, so a new session came up "Resumed" to the last one). Unknown-id restore now starts fresh; `--resume <own-id>` and explicit user --continue/--resume still honored (lib/restore-command.js). (b) /api/cluster/sessions cache (1500ms) is now invalidated on session create/delete/rename/reorder, so a just-created session shows in the sidebar immediately instead of after the TTL

// --- Optional latency instrumentation (opt-in via WT_LATENCY_DEBUG=1) -----
// Event-loop lag monitor: interval is 10ms; anything ≥ 50ms slip is a stall.
// Slow-op wrapper: call sites tag sync/async blocks and we log any > 30ms.
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
function _slowOp(name, fn) {
  if (!_LATENCY_DEBUG) return fn;
  return async function _wrapped(...args) {
    const t0 = performance.now();
    try { return await fn.apply(this, args); }
    finally {
      const dur = performance.now() - t0;
      if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} ${name} dur=${dur.toFixed(0)}ms`);
    }
  };
}
// Stale status auto-correction now lives in pty-worker.js.

// --- Config: config.json > env vars > defaults ---
// Use separate config file during tests to avoid corrupting production config
const CONFIG_FILE = process.env.WT_TEST ? path.join(__dirname, 'config.test.json') : path.join(__dirname, 'config.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.default.json');

function readConfig() {
  try { return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {}; } catch (e) { return {}; }
}
let _claudeHome = null;
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  _claudeHome = null; // re-detect on next use
  _liveConfigCache = cfg; _liveConfigTime = Date.now(); // update cache
}
let config = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else if (fs.existsSync(DEFAULT_CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load config:', e.message); }

const PORT = parseInt(process.env.WT_PORT || config.port || '7681');
let _USER = process.env.WT_USER || config.user || 'admin';
let PASS = process.env.WT_PASS || config.password || 'admin';
const SHELL = process.env.WT_SHELL || config.shell || 'C:\\Program Files\\Git\\bin\\bash.exe';
function getServerName() { return liveConfig('serverName', os.hostname()); }

// Live-reloadable settings (cached, refreshed every 5s to avoid sync I/O stalls)
let _liveConfigCache = null;
let _liveConfigTime = 0;
const LIVE_CONFIG_TTL = 5000; // 5 seconds

function _refreshLiveConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      _liveConfigCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  _liveConfigTime = Date.now();
}

function liveConfig(key, fallback) {
  if (!_liveConfigCache || Date.now() - _liveConfigTime > LIVE_CONFIG_TTL) {
    _refreshLiveConfig();
  }
  if (_liveConfigCache && _liveConfigCache[key] !== undefined) return _liveConfigCache[key];
  return fallback;
}
function getDefaultCwd() { return process.env.WT_CWD || liveConfig('defaultCwd', 'C:\\dev'); }
function getScanFolders() { return liveConfig('scanFolders', [getDefaultCwd()]); }
function getDefaultCommand() {
  let cmd = liveConfig('defaultCommand', '');
  if (!cmd) {
    try { cmd = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')).defaultCommand || ''; } catch {}
  }
  return cmd;
}
function getScrollbackReplayLimit() { return parseInt(liveConfig('scrollbackReplayLimit', 32768)) || 32768; }

function buildSafeEnv() {
  return config.passAllEnv ? Object.assign({}, process.env, { TERM: 'xterm-256color' }) : {
    TERM: 'xterm-256color',
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
// Kept for backward compat in startup code
const DEFAULT_CWD = getDefaultCwd();
// Session + scrollback persistence paths are now owned by pty-worker.js.
const CLIPBOARD_DIR = path.join(__dirname, 'clipboard-images');
function detectClaudeHome() {
  // 1. Explicit config
  const configured = liveConfig('claudeHome', '');
  if (configured) return configured;
  // 2. Current user profile
  const profile = process.env.USERPROFILE || os.homedir();
  if (fs.existsSync(path.join(profile, '.claude'))) return profile;
  // 3. Scan C:\Users for a profile with .claude (handles scheduled task / Session 0)
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
// M1: sanitize a hook-supplied transcript_path before we ever trust it. Any hook
// can set transcript_path, and /attention + the ntfy detail then read + expose
// that file — so realpath it (resolves symlinks + '..'), then require a .jsonl
// strictly under the Claude projects root. Anything else returns '' (ignored —
// never throws into the hook). The pure containment/extension decision lives in
// lib/transcript.js (isAllowedTranscriptPath) and is unit-tested there.
function safeTranscriptPath(p) {
  if (!p || typeof p !== 'string') return '';
  try {
    const resolved = fs.realpathSync(p);
    let root;
    try { root = fs.realpathSync(getClaudeProjectsDir()); }
    catch { root = getClaudeProjectsDir(); } // projects root may not exist yet
    return transcript.isAllowedTranscriptPath(resolved, root) ? resolved : '';
  } catch { return ''; } // missing file / bad path → ignore
}

// G5 persistence sub-gap mitigation. _nstate(id).transcriptPath is in-memory, so a
// server restart loses it until the next hook fires. When a transcript request
// arrives with no stashed path, derive one from the session's persisted
// claudeSessionId + cwd (same cwd→project-dir encoding the claude-sessions scanner
// uses). The candidate is run back through safeTranscriptPath — the identical
// .jsonl-strictly-under-the-projects-root trust chain — so derivation can never
// widen what a request may read. Returns '' on any miss (no session, no
// claudeSessionId yet, file absent, or path rejected).
async function deriveTranscriptPath(id) {
  try {
    const s = await workerClient.rpc('getSession', { id });
    const csid = s && s.claudeSessionId;
    const cwd = s && s.cwd;
    if (!csid || !cwd) return '';
    const dirName = transcript.claudeProjectDirName(cwd);
    return safeTranscriptPath(path.join(getClaudeProjectsDir(), dirName, csid + '.jsonl'));
  } catch { return ''; }
}

// Resolve a session's transcript path: the in-memory stash (set + validated by the
// http-hook) first, then a validated derivation (stashed back so later reads skip
// it). '' on any miss. SSOT for the transcript-read routes (/transcript, /subagent,
// /pending-question) so the .jsonl-under-projects-root trust chain lives in ONE place.
async function resolveSessionTranscriptPath(id) {
  let tpath = (_notifyState.get(id) || {}).transcriptPath || '';
  if (!tpath) {
    tpath = await deriveTranscriptPath(id);
    if (tpath) _nstate(id).transcriptPath = tpath;
  }
  return tpath;
}

// --- subagent trace: a session's spawned-subagent transcripts -----------------
// Claude Code stores each spawned subagent's own transcript in a sibling dir of
// the main <sessionId>.jsonl:  <...>/<sessionId>/subagents/agent-<agentId>.jsonl
// (+ an agent-<agentId>.meta.json sidecar). These three helpers turn that on-disk
// layout into a Task-tool_use → subagent-file index the /transcript stub and the
// /subagent drill endpoint share. All I/O is best-effort — a missing dir or a bad
// sidecar just yields no trace, never an error (the flat Task card still renders).
function subagentDirForTranscript(tpath) {
  // tpath = <projectsDir>/<projectDir>/<sessionId>.jsonl → sibling <sessionId>/subagents
  return path.join(path.dirname(tpath), path.basename(tpath, '.jsonl'), 'subagents');
}

// Map a Task tool_use id → { file, agentType, description } by reading every
// agent-*.meta.json sidecar in a session's subagents dir. The agent .jsonl path is
// built from the real dir entry name (agent-<id>.jsonl), NEVER from a request value,
// so a caller-supplied toolUseId can only ever be a map key — no path traversal.
function buildSubagentIndex(subDir) {
  const map = new Map();
  let names;
  try { names = fs.readdirSync(subDir); } catch { return map; } // no subagents → empty
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
    let meta;
    try { meta = transcript.parseAgentMeta(fs.readFileSync(path.join(subDir, name), 'utf8')); }
    catch { continue; }
    if (!meta) continue;
    const agentId = name.slice('agent-'.length, name.length - '.meta.json'.length);
    if (!agentId) continue;
    map.set(meta.toolUseId, {
      file: path.join(subDir, `agent-${agentId}.jsonl`),
      agentType: meta.agentType,
      description: meta.description,
    });
  }
  return map;
}

// The set of finished (resolved) tool_use ids from a transcript's last 256KB — the
// "running" signal for subagent stubs: a Task whose id is NOT resolved is in flight.
// Reads only the tail (a Task's tool_result lands right after its subagent ends), so
// it's cheap regardless of transcript size. Returns an empty set on any read error.
function resolvedIdsTail(tpath) {
  try {
    const size = fs.statSync(tpath).size;
    const start = Math.max(0, size - 262144); // 256KB tail
    const len = size - start;
    if (len <= 0) return new Set();
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(tpath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    return transcript.collectResolvedIds(text);
  } catch { return new Set(); }
}

const CLUSTER_TOKENS_FILE = path.join(__dirname, 'cluster-tokens.json');
const CLAUDE_SESSION_NAMES_FILE = path.join(__dirname, 'claude-session-names.json');

function loadClaudeSessionNames() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SESSION_NAMES_FILE, 'utf8')); } catch { return {}; }
}
function saveClaudeSessionNames(names) {
  fs.writeFileSync(CLAUDE_SESSION_NAMES_FILE, JSON.stringify(names, null, 2));
}

// (Claude-session-from-dir detection lives in pty-worker.js, the process that
// owns sessions; server.js resolves transcripts by cwd via deriveTranscriptPath
// + the shared transcript.claudeProjectDirName encoder.)

/** Extract Claude session ID from a command string (--resume flag) */
function extractClaudeSessionIdFromCmd(cmd) {
  if (!cmd) return null;
  const match = cmd.match(/--resume\s+([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

// --- Password helpers ---
const DEFAULT_PASSWORDS = ['admin'];

function needsPasswordChange() {
  return DEFAULT_PASSWORDS.includes(PASS);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored.startsWith('$scrypt$')) return password === stored;
  const parts = stored.split('$');
  const salt = parts[2];
  const hash = parts[3];
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch (e) { return false; }
}

// --- Auto-hash plaintext password on startup ---
// Skip persisting to config.json when password came from env var (e.g. test runs)
if (PASS && !DEFAULT_PASSWORDS.includes(PASS) && !PASS.startsWith('$scrypt$')) {
  const hashed = hashPassword(PASS);
  if (process.env.WT_PASS) {
    PASS = hashed;
    console.log('Password auto-hashed (env var, not persisted to config)');
  } else {
    const cfg = readConfig();
    cfg.password = hashed;
    try {
      writeConfig(cfg);
      PASS = hashed;
      console.log('Password auto-hashed in config.json');
    } catch (e) { console.error('Failed to auto-hash password:', e.message); }
  }
}

const app = express();
const wsInstance = expressWs(app, null, {
  wsOptions: { perMessageDeflate: false }
});

// --- WebSocket keepalive: ping every 30s, kill after 2 missed pings (tolerates background tabs) ---
const WS_PING_INTERVAL = 30000;
setInterval(() => {
  const wss = wsInstance.getWss();
  for (const ws of wss.clients) {
    if (ws._wtAlive === false) {
      // Allow one missed ping — browsers throttle background tabs to ~60s
      ws._wtMissed = (ws._wtMissed || 0) + 1;
      if (ws._wtMissed >= 3) {
        ws.terminate();
        continue;
      }
    } else {
      ws._wtMissed = 0;
    }
    ws._wtAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, WS_PING_INTERVAL);

// --- Session manager: all PTY state now lives in pty-worker.js (see lib/worker-client.js). ---
// server.js holds only notifyClients (browser notification WS set) and a per-session
// Map of WebSocket clients currently attached to each session id.
const notifyClients = new Set();

// Map<sessionId, Set<ws>> — which browser WebSockets are subscribed to each session.
// Needed for exclusive-viewer kick logic and for fanning out PTY data events from the worker.
const sessionClients = new Map();
function getSessionClients(id) {
  let set = sessionClients.get(id);
  if (!set) { set = new Set(); sessionClients.set(id, set); }
  return set;
}

// Map<sessionId, () => void> — active PTY_OUT dispose handles (one per session,
// regardless of how many browser WS clients are attached).
const ptyOutDisposers = new Map();

function ensurePtyOutSubscription(id) {
  if (ptyOutDisposers.has(id)) return;
  // Browser xterm.js expects WS text frames with UTF-8 string payload. Raw
  // Buffers arrive as Blobs in the browser which xterm cannot render.
  //
  // Per-session streaming decoder: when a Claude Code redraw pushes bytes
  // through IPC in chunks, a chunk boundary can fall inside a multi-byte
  // UTF-8 codepoint (e.g., box-drawing `╭` is 3 bytes). A stateless
  // buf.toString('utf8') per chunk replaces the partial bytes with U+FFFD
  // and corrupts the next chunk's orphan continuation bytes — so Claude's
  // prompt-box corners disappear and the UI ends up rendered in the middle
  // of the viewport. TextDecoder with { stream: true } keeps incomplete
  // sequences pending across calls, so codepoints split at chunk boundaries
  // are delivered intact on the following chunk.
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const dispose = workerClient.onPtyOut(id, (buf) => {
    const set = sessionClients.get(id);
    if (!set || set.size === 0) return;
    const str = decoder.decode(buf, { stream: true });
    if (!str) return;
    for (const client of set) {
      try { client.send(str); } catch {}
    }
  });
  ptyOutDisposers.set(id, dispose);
}

function releasePtyOutSubscription(id) {
  const set = sessionClients.get(id);
  if (set && set.size > 0) return; // still has clients
  const dispose = ptyOutDisposers.get(id);
  if (dispose) {
    try { dispose(); } catch {}
    ptyOutDisposers.delete(id);
  }
}

try { if (!fs.existsSync(CLIPBOARD_DIR)) fs.mkdirSync(CLIPBOARD_DIR); } catch (e) {}

// --- Worker client setup --------------------------------------------------
const WORKER_PIPE_PATH = process.env.WT_WORKER_PIPE || (
  process.platform === 'win32'
    ? '\\\\.\\pipe\\web-terminal-pty'
    : '/tmp/web-terminal-pty.sock'
);
const workerClient = workerClientLib.create();

// Optionally spawn the worker ourselves (controlled by WT_SPAWN_WORKER=1).
// In production, monitor.js spawns the worker; for tests we spawn it here.
let _spawnedWorker = null;
function maybeSpawnWorker() {
  if (!process.env.WT_SPAWN_WORKER) return;
  const workerPath = path.join(__dirname, 'pty-worker.js');
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      WT_WORKER_PIPE: WORKER_PIPE_PATH,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  _spawnedWorker = child;
  child.on('exit', (code, sig) => {
    console.error(`[${new Date().toISOString()}] pty-worker exited (${code}/${sig}) — exiting server so monitor restarts both`);
    process.exit(1);
  });
}
maybeSpawnWorker();

// Forward worker-pushed events to browser clients.
// Binary PTY output: per-session subscription is set up in the WS attach path.
// (Legacy ptyData JSON event was removed in Phase 4.)

// --- ntfy push notifications ----------------------------------------------
// Per-session level (off/important/all, default important) stored server-side
// so the push decision — which happens here, when a hook event arrives — can
// read it. All server-side + a gitignored prefs file → hot-reloadable, no
// worker change, no new npm dependency (ntfy is a plain HTTPS POST).
const NOTIFY_PREFS_FILE = path.join(__dirname, 'notify-prefs.json');
let _notifyPrefs = null, _notifyPrefsAt = 0;
function loadNotifyPrefs() {
  if (!_notifyPrefs || Date.now() - _notifyPrefsAt > 5000) {
    try { _notifyPrefs = fs.existsSync(NOTIFY_PREFS_FILE) ? JSON.parse(fs.readFileSync(NOTIFY_PREFS_FILE, 'utf8')) : {}; }
    catch { _notifyPrefs = {}; }
    _notifyPrefsAt = Date.now();
  }
  return _notifyPrefs;
}
function getNotifyLevel(id) { return notifyPush.normalizeLevel(loadNotifyPrefs()[id]); }
function setNotifyLevel(id, level) {
  const lv = notifyPush.normalizeLevel(level);
  const prefs = loadNotifyPrefs();
  if (lv === notifyPush.DEFAULT_LEVEL) delete prefs[id]; else prefs[id] = lv; // store only overrides
  try { fs.writeFileSync(NOTIFY_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('notify-prefs write failed:', e.message); }
  _notifyPrefs = prefs; _notifyPrefsAt = Date.now();
  return lv;
}
function pruneNotifyPref(id) {
  const prefs = loadNotifyPrefs();
  if (prefs[id]) { delete prefs[id]; try { fs.writeFileSync(NOTIFY_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {} }
}

function ntfyConfig() {
  const c = liveConfig('ntfy', null);
  if (!c || c.enabled === false || !c.topic) return null;
  return { server: String(c.server || 'https://ntfy.sh').replace(/\/+$/, ''), topic: String(c.topic) };
}
// Tests capture pushes instead of hitting the network.
const _NTFY_SINK = process.env.WT_NTFY_TEST ? [] : null;

// --- FCM transport + device registry (G1/G2) ------------------------------
// Content-free data-only wake messages (see COMPANION-APP-DESIGN.md). The pure
// message/JWT/token-cache logic lives in lib/fcm.js; server.js owns the registry
// file, the service-account read, and the fire-and-forget dispatch.
const PUSH_DEVICES_FILE = path.join(__dirname, 'push-devices.json');
// Tests capture FCM sends instead of hitting the network.
const _FCM_SINK = process.env.WT_FCM_TEST ? [] : null;

// Which transport(s) to use. BACK-COMPAT: absent `push` config (and no env
// override) behaves EXACTLY as today — ntfy only, from the `ntfy` config key.
// 'fcm' disables ntfy; 'both' sends both. WT_PUSH_PROVIDER overrides (tests).
// Precedence/validation is pure logic in lib/fcm.js (unit-tested); this is the
// thin I/O wrapper that reads env + live config.
function pushProvider() {
  const p = liveConfig('push', null);
  return fcm.resolvePushProvider({ env: process.env.WT_PUSH_PROVIDER, configProvider: p && p.provider });
}

// Gitignored device registry: [{token, deviceName, platform, registeredAt}].
// Same cache-with-TTL pattern as loadApiTokens/loadNotifyPrefs.
let _pushDevicesCache = null, _pushDevicesTime = 0;
function loadPushDevices() {
  if (!_pushDevicesCache || Date.now() - _pushDevicesTime > LIVE_CONFIG_TTL) {
    try {
      _pushDevicesCache = fs.existsSync(PUSH_DEVICES_FILE) ? JSON.parse(fs.readFileSync(PUSH_DEVICES_FILE, 'utf8')) : [];
      if (!Array.isArray(_pushDevicesCache)) _pushDevicesCache = [];
    } catch { _pushDevicesCache = []; }
    _pushDevicesTime = Date.now();
  }
  return _pushDevicesCache;
}
function savePushDevices(devices) {
  fs.writeFileSync(PUSH_DEVICES_FILE, JSON.stringify(devices, null, 2), 'utf8');
  _pushDevicesCache = devices; _pushDevicesTime = Date.now();
}
function pruneDevice(token) {
  const devices = loadPushDevices();
  const idx = devices.findIndex(d => d.token === token);
  if (idx !== -1) { devices.splice(idx, 1); try { savePushDevices(devices); } catch {} }
}

// FCM is "configured" when a service account is set (production) OR the test sink
// is active. Drives the 'fcm' capability flag and lazy client creation.
// Capability honesty (code-review #6): this advertises that FCM is *configured*,
// not that the client is live-healthy. We deliberately do NOT flip it off on a
// service-account load failure — getFcmClient() now backs off and re-attempts the
// build (self-healing within CLIENT_BUILD_BACKOFF_MS) instead of latching dead, so
// a transient failure is at most a ~60s window, and flapping the capability on
// transient I/O would be noisier and less truthful than "config present".
function fcmConfigured() {
  if (_FCM_SINK) return true;
  const p = liveConfig('push', null);
  return !!(p && p.fcm && p.fcm.serviceAccountPath);
}
// Lazily load the service account (absolute path, outside the repo) and build a
// client. Cached on success. A load failure does NOT latch FCM dead until the
// next restart: it records an "errored until" deadline and backs off for
// CLIENT_BUILD_BACKOFF_MS (mirrors the token-exchange negative cache), then
// re-attempts — so a transiently locked / half-written SA file self-heals.
// Key material is never logged (F4: fixed string + e.code/e.name only; a
// JSON.parse SyntaxError message can echo file-content snippets). Returns null in
// sink mode (server captures directly).
let _fcmClient = null, _fcmClientErrUntil = 0;
function getFcmClient() {
  if (_FCM_SINK) return null;
  if (_fcmClient) return _fcmClient;
  const p = liveConfig('push', null);
  const saPath = p && p.fcm && p.fcm.serviceAccountPath;
  if (!saPath) return null;
  // Still inside the post-failure backoff window → don't re-attempt the load yet.
  if (!fcm.shouldRetryClientBuild(_fcmClientErrUntil, Date.now())) return null;
  try {
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    _fcmClient = fcm.createFcmClient({ serviceAccount: sa });
    _fcmClientErrUntil = 0; // clear any prior backoff on success
    return _fcmClient;
  } catch (e) {
    _fcmClientErrUntil = Date.now() + fcm.CLIENT_BUILD_BACKOFF_MS; // retry after backoff
    console.error('FCM service account load failed:', e.code || e.name); // never e.message (may embed key material)
    return null;
  }
}

// Fire a content-free FCM wake to every registered device for one session event.
// Fire-and-forget: never throws into pushNotify. Prunes tokens FCM reports dead.
async function fcmDispatch(kind, { id, click }) {
  if (!fcm.providerSendsFcm(pushProvider())) return;
  const devices = loadPushDevices();
  if (!devices.length) return;
  const ts = Date.now();
  const client = getFcmClient(); // null in sink mode
  for (const dev of devices.slice()) {
    const body = fcm.buildFcmMessage(kind, {
      serverName: getServerName(), sessionId: id, ts, deepLink: click || '', token: dev.token,
    });
    if (_FCM_SINK) { _FCM_SINK.push({ token: dev.token, ...body.message }); continue; }
    if (!client) continue;
    try {
      const r = await client.send(body);
      if (!r.ok && fcm.shouldPruneOnError(r.errorCode)) pruneDevice(dev.token);
    } catch (e) { console.error('FCM send failed:', e.message); }
  }
}

// Deep-link click URL for a session, or undefined when no publicUrl is set.
// Shared by the ntfy push, the FCM wake, and the G3 'clear' path.
function sessionClickUrl(id) {
  const pub = liveConfig('publicUrl', null);
  return pub ? `${String(pub).replace(/\/+$/, '')}/app/${encodeURIComponent(id)}` : undefined;
}

// Send a push for one session event, gated by that session's level (unless
// force=true, for the manual test endpoint). The attention record is written
// UNCONDITIONALLY (before the gate) — only the actual push delivery is gated.
async function pushNotify(kind, { id, name, reason, force } = {}) {
  // G3 clear: a resolution, not a fresh alert. Handled BEFORE the level gate so
  // it works even for a session set to 'off' (there may be a delivered
  // notification to dismiss). Flip the recorded attention to cleared so
  // GET /api/sessions/:id/attention reflects it (and a companion app can stop
  // nagging). ntfy can't recall a delivered push, so there's nothing to send on
  // that transport; FCM uses the collapse_key'd 'clear' to auto-dismiss. Never
  // records a new 'clear' attention.
  if (kind === 'clear') {
    const att = _nstate(id).lastAttention;
    if (att) att.cleared = true;
    // FCM: a real dismissal — the collapse_key'd 'clear' supersedes the earlier
    // push on the device. No-op for ntfy (can't recall). fcmDispatch self-gates
    // on the provider. Fire-and-forget.
    fcmDispatch('clear', { id, click: sessionClickUrl(id) })
      .catch(e => console.error('FCM clear dispatch failed:', e.message));
    return;
  }
  // Record what needs attention so a companion app / voice layer can pull the
  // real content privately over the LAN via GET /api/sessions/:id/attention,
  // rather than trusting it to the push relay. Recorded UNCONDITIONALLY — a muted
  // ('off') session, or an 'idle' below the 'important' threshold, still needs
  // its state queryable even though no push is sent. cleared flips true once the
  // state resolves (see the statusChanged / apiError handlers, G3).
  _nstate(id).lastAttention = notifyPush.makeAttention(kind, { reason, name });
  // Level gate: below-threshold / muted sessions record attention but send nothing.
  if (!force && !notifyPush.shouldPush(kind, getNotifyLevel(id))) return;

  const provider = pushProvider();
  const click = sessionClickUrl(id);
  // ntfy (a plain HTTPS POST): build + send only when this provider sends ntfy —
  // in fcm-only mode we skip the config read, the transcript read, and the
  // message build entirely.
  if (fcm.providerSendsNtfy(provider)) {
    const cfg = ntfyConfig();
    // Quote Claude's last message (from its transcript) so the push shows *what*
    // Claude said/asked. Set ntfy.includeContent=false to keep sensitive content
    // OFF the push relay (e.g. public ntfy.sh) — a companion app then fetches it
    // over the private network via /attention instead. Default (true) keeps
    // today's behavior. NOTE: this feeds ONLY the ntfy detail; /attention does
    // its own independent transcript read, so that path is unaffected here.
    const includeContent = (liveConfig('ntfy', {}) || {}).includeContent !== false;
    const detail = includeContent ? transcript.lastAssistantText(_nstate(id).transcriptPath) : '';
    const msg = notifyPush.buildNtfyMessage(kind, { sessionName: name, serverName: getServerName(), reason, click, detail });
    if (_NTFY_SINK) { _NTFY_SINK.push({ kind, id, ...msg }); }
    else if (cfg) {
      try {
        await fetch(cfg.server, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: cfg.topic, title: msg.title, message: msg.message, priority: msg.priority, tags: msg.tags, click: msg.click }),
        });
      } catch (e) { console.error('ntfy push failed:', e.message); }
    }
  }
  // FCM: content-free wake to every registered device (fire-and-forget). Gated
  // here so fcm-absent (ntfy-only) mode skips the device load + async hop.
  if (fcm.providerSendsFcm(provider)) {
    fcmDispatch(kind, { id, click }).catch(e => console.error('FCM dispatch failed:', e.message));
  }
}

// Anti-flood timers per session. Approval pushes immediately (debounced); an
// API error only pushes if it hasn't cleared ~25s later (so quick auto-recovery
// blips stay silent); idle only pushes if it stays idle ~2 min (settled), and
// only when the session is on the "all" level.
const _notifyState = new Map(); // id -> { idleTimer, apiErrTimer, apiErrCooldownUntil, lastApprovalAt, lastAttention, transcriptPath }
const _NOTIFY_IDLE_MS = process.env.WT_NOTIFY_FAST ? 300 : 120000;
const _NOTIFY_APIERR_MS = process.env.WT_NOTIFY_FAST ? 200 : 25000;
const _NOTIFY_APPROVAL_DEBOUNCE_MS = 60000;
const _NOTIFY_APIERR_COOLDOWN_MS = 300000;
function _nstate(id) { let s = _notifyState.get(id); if (!s) { s = {}; _notifyState.set(id, s); } return s; }

workerClient.on('statusChanged', ({ id, status, notifyType, notifyMsg }) => {
  // ntfy: any move away from idle cancels a pending settled-idle push.
  if (status && status !== 'idle') {
    const st = _notifyState.get(id);
    if (st && st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
  }
  // G3: an approval resolves when the session moves off 'waiting'. Flip the
  // recorded attention to cleared and emit a 'clear' push so a companion app can
  // auto-dismiss the approval notification. Placed before the early-return path
  // below since the resolving status change usually carries no notifyType.
  {
    const att = _notifyState.get(id)?.lastAttention;
    if (notifyPush.statusClearsApproval(status, att)) pushNotify('clear', { id, name: att.name });
  }
  // Fan out to notifyClients (browser notify WS subscribers)
  // sessionName is retrieved lazily via session list RPC? Instead, pull name from
  // notifyMsg (which carries it) or skip when not set.
  if (!notifyType && !notifyMsg) {
    // Status change without notification; still broadcast to notifyClients for UI.
    const payload = JSON.stringify({
      notification: { type: 'status', message: '', session: '', sessionId: id, status }
    });
    for (const client of notifyClients) { try { client.send(payload); } catch {} }
    return;
  }
  const payload = JSON.stringify({
    notification: { type: notifyType || 'status', message: notifyMsg || '', session: '', sessionId: id, status }
  });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }

  // ntfy push gating.
  try {
    const { name, reason } = notifyPush.splitNotifyMsg(notifyMsg);
    if (notifyType === 'approval_needed') {
      const st = _nstate(id); const now = Date.now();
      if (!st.lastApprovalAt || now - st.lastApprovalAt > _NOTIFY_APPROVAL_DEBOUNCE_MS) {
        st.lastApprovalAt = now;
        pushNotify('approval', { id, name, reason });
      }
    } else if (notifyType === 'idle' && getNotifyLevel(id) === 'all') {
      // Only push if it STAYS idle AND the terminal goes quiet — a mid-task
      // pause shouldn't ping, and neither should an idle Claude prompt that sits
      // above a still-running background build / in-flight subagent. Those keep
      // emitting PTY output (bumping the worker's lastActivity), so at fire time
      // we re-check the output clock: if output landed within the debounce
      // window the session isn't finished — re-arm and wait for a genuine quiet
      // period. A non-idle statusChanged still cancels via the clear above.
      // Same output-clock signal #37 gave correctStaleStatus (SSOT).
      const st = _nstate(id);
      if (st.idleTimer) clearTimeout(st.idleTimer);
      const fireIdle = async () => {
        st.idleTimer = null;
        try {
          const s = await workerClient.rpc('getSession', { id });
          if (s && s.lastActivity && (Date.now() - s.lastActivity) < _NOTIFY_IDLE_MS) {
            st.idleTimer = setTimeout(fireIdle, _NOTIFY_IDLE_MS); // still busy — wait for quiet
            if (st.idleTimer.unref) st.idleTimer.unref();
            return;
          }
        } catch { /* worker unreachable — fall through and push (best-effort) */ }
        pushNotify('idle', { id, name, reason });
      };
      st.idleTimer = setTimeout(fireIdle, _NOTIFY_IDLE_MS);
      if (st.idleTimer.unref) st.idleTimer.unref();
    }
  } catch (e) { console.error('notify(status) failed:', e.message); }
});

// API-error detection from the worker. Fan out to notify clients so the UI can
// highlight the session (and pop a browser notification on first detection).
// `cleared` flips the highlight off; `autoContinue`/`action` are progress-only
// (sent as type 'status' so they don't spawn a browser notification per retry).
workerClient.on('apiError', ({ id, name, apiError, text, transient, cleared, autoContinue, action, replayText }) => {
  const isInitialDetect = apiError === true && !autoContinue && !cleared;
  const type = isInitialDetect ? 'api_error' : 'status';
  // The notification title already carries the session name, so the body is
  // just the error line.
  const message = isInitialDetect ? (text || 'API error') : '';
  const payload = JSON.stringify({
    notification: {
      type, message, session: name || '', sessionId: id,
      apiError: !!apiError, apiErrorText: apiError ? (text || '') : '',
      transient: !!transient, autoContinue: autoContinue || 0, action: action || '', replayText: replayText || '',
    }
  });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }

  // ntfy push gating: only alert if the error is STUCK — i.e. it hasn't cleared
  // ~25s after detection (so quick auto-recovery blips stay silent). Cleared
  // cancels a pending alert.
  try {
    const st = _nstate(id);
    if (cleared) {
      if (st.apiErrTimer) { clearTimeout(st.apiErrTimer); st.apiErrTimer = null; }
      // G3: a stuck API error that already pushed and has now recovered resolves
      // the attention — emit a 'clear' so the companion app can auto-dismiss it.
      const att = st.lastAttention;
      if (notifyPush.apiRecoveryClearsError(att)) pushNotify('clear', { id, name: att.name });
    } else if (isInitialDetect) {
      const now = Date.now();
      if (!st.apiErrTimer && (!st.apiErrCooldownUntil || now > st.apiErrCooldownUntil)) {
        const reason = text ? `API error — ${String(text).slice(0, 140)}` : 'API error (session stuck)';
        st.apiErrTimer = setTimeout(() => {
          st.apiErrTimer = null;
          st.apiErrCooldownUntil = Date.now() + _NOTIFY_APIERR_COOLDOWN_MS;
          pushNotify('apierror', { id, name, reason });
        }, _NOTIFY_APIERR_MS);
        if (st.apiErrTimer.unref) st.apiErrTimer.unref();
      }
    }
  } catch (e) { console.error('notify(apiError) failed:', e.message); }
});

workerClient.on('sessionExited', ({ id }) => {
  hookForgetSession(id);
  // ntfy: drop any pending timers + stored level for the dead session.
  const nst = _notifyState.get(id);
  if (nst) { if (nst.idleTimer) clearTimeout(nst.idleTimer); if (nst.apiErrTimer) clearTimeout(nst.apiErrTimer); _notifyState.delete(id); }
  pruneNotifyPref(id);
  const set = sessionClients.get(id);
  if (set) {
    for (const client of set) {
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(4000, 'Session ended'); } catch {}
    }
    sessionClients.delete(id);
  }
  const dispose = ptyOutDisposers.get(id);
  if (dispose) {
    try { dispose(); } catch {}
    ptyOutDisposers.delete(id);
  }
  // Issue #11: drop the cached idBytes entry so long-running servers don't
  // accumulate entries for dead sessions.
  try { workerClient.forgetSession(id); } catch {}
});

workerClient.onExit(() => {
  console.error(`[${new Date().toISOString()}] Worker IPC disconnected — server exiting so monitor restarts`);
  process.exit(1);
});

// --- Auth helpers ---
// Persist session secret so cookies survive server restarts
const SESSION_SECRET_FILE = path.join(__dirname, '.session-secret');
const SESSION_SECRET = (() => {
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
  } catch (e) {}
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SESSION_SECRET_FILE, secret, 'utf8'); } catch (e) {}
  return secret;
})();

// H1: per-process hook token. Written to .hook-token in the same dir so
// claude-hook.js / claude-hook.sh (which live alongside) can read it. The
// token is regenerated on each fresh startup if the file is missing. Unix
// chmod 0600; Windows has no equivalent.
const HOOK_TOKEN_FILE = path.join(__dirname, '.hook-token');
const HOOK_TOKEN = (() => {
  try {
    if (fs.existsSync(HOOK_TOKEN_FILE)) {
      const existing = fs.readFileSync(HOOK_TOKEN_FILE, 'utf8').trim();
      if (existing && existing.length >= 32) return existing;
    }
  } catch (e) {}
  const tok = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(HOOK_TOKEN_FILE, tok, 'utf8');
    if (process.platform !== 'win32') {
      try { fs.chmodSync(HOOK_TOKEN_FILE, 0o600); } catch {}
    }
  } catch (e) {}
  return tok;
})();
const HOOK_TOKEN_BUF = Buffer.from(HOOK_TOKEN, 'utf8');

// Localhost-only callers may skip the hook token. On Windows .hook-token is
// world-readable (no chmod 0600 equivalent), so H1's protection against
// same-host processes was never real there; requiring the token still forces
// a worker-restart cycle to inject WT_HOOK_TOKEN into existing PTY env,
// which drops every running Claude session. Accepting loopback traffic
// closes that gap without weakening the wire-level protection against
// non-localhost callers.
function isLocalhostReq(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function verifyHookToken(headerVal) {
  if (!headerVal || typeof headerVal !== 'string') return false;
  const got = Buffer.from(headerVal, 'utf8');
  if (got.length !== HOOK_TOKEN_BUF.length) return false;
  try {
    return crypto.timingSafeEqual(got, HOOK_TOKEN_BUF);
  } catch (e) { return false; }
}
const COOKIE_NAME = 'wt_session';
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days

function checkCredentials(user, pass) {
  if (!user || !pass) return false;
  try {
    const userMatch = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(user).digest(),
      crypto.createHash('sha256').update(_USER).digest()
    );
    const passMatch = PASS.startsWith('$scrypt$')
      ? verifyPassword(pass, PASS)
      : crypto.timingSafeEqual(
          crypto.createHash('sha256').update(pass).digest(),
          crypto.createHash('sha256').update(PASS).digest()
        );
    return userMatch && passMatch;
  } catch (e) { return false; }
}

function makeSessionToken(user) {
  const payload = `${user}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(Buffer.from(payload, 'base64').toString()).digest('hex');
  let hmacOk = false;
  try {
    hmacOk = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) { return false; }
  if (!hmacOk) return false;
  // M1: enforce server-side cookie expiry. Payload is `user:timestampMs`.
  // Reject if timestamp is older than COOKIE_MAX_AGE, or unparseable (fail closed).
  try {
    const decoded = Buffer.from(payload, 'base64').toString();
    const colon = decoded.lastIndexOf(':');
    if (colon === -1) return false;
    const ts = Number(decoded.substring(colon + 1));
    if (!Number.isFinite(ts) || ts <= 0) return false;
    if (Date.now() - ts > COOKIE_MAX_AGE) return false;
  } catch (e) { return false; }
  return true;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function setAuthCookie(res, user) {
  const token = makeSessionToken(user);
  res.set('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE / 1000}`);
}

function authenticateWs(ws, req, opts) {
  const cookies = parseCookies(req.headers.cookie);
  // Try cookie auth first, then Bearer token
  if (verifySessionToken(cookies[COOKIE_NAME])) return true;
  // Check for token in query string (express-ws may use req.query or req.url)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = req.query?.token || url.searchParams.get('token');
  if (token && verifyApiToken(token)) return true;
  // Issue #20 direct terminal: accept a short-lived signed token bound to this
  // session id. HMAC key is any of our api-tokens (the peer that minted it
  // used the token we issued to them as the shared secret).
  if (opts && opts.expectedSid) {
    const dt = req.query?.dt || url.searchParams.get('dt');
    if (dt) {
      const apiTokens = loadApiTokens();
      const candidates = Object.keys(apiTokens).filter(k => {
        const entry = apiTokens[k];
        return !(entry && entry.expires && Date.now() > entry.expires);
      });
      const vr = verifyDirectToken(dt, candidates);
      if (vr.valid && vr.payload && vr.payload.sid === opts.expectedSid) {
        // Authenticated as vr.payload.user — attach for downstream use.
        ws._wtUser = vr.payload.user;
        ws._wtAuthMode = 'direct';
        return true;
      }
      // Specific close codes so the client can tell expired vs wrong:
      //   4003 = direct token expired (client should refresh session list)
      //   4004 = direct token invalid (wrong sig / sid mismatch / malformed)
      if (vr.expired) {
        try { ws.close(4003, 'Direct token expired'); } catch {}
      } else {
        try { ws.close(4004, 'Direct token invalid'); } catch {}
      }
      return false;
    }
  }
  ws.close(1008, 'Unauthorized');
  return false;
}

// --- API Token auth (for cluster inter-server communication) ---
const API_TOKENS_FILE = path.join(__dirname, 'api-tokens.json');

let _apiTokensCache = null, _apiTokensTime = 0;
function loadApiTokens() {
  if (!_apiTokensCache || Date.now() - _apiTokensTime > LIVE_CONFIG_TTL) {
    try {
      if (fs.existsSync(API_TOKENS_FILE)) _apiTokensCache = JSON.parse(fs.readFileSync(API_TOKENS_FILE, 'utf8'));
      else _apiTokensCache = {};
    } catch (e) { _apiTokensCache = {}; }
    _apiTokensTime = Date.now();
  }
  return _apiTokensCache;
}

function saveApiTokens(tokens) {
  fs.writeFileSync(API_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  _apiTokensCache = tokens; _apiTokensTime = Date.now(); // update cache immediately
}

function verifyApiToken(token) {
  const tokens = loadApiTokens();
  const entry = tokens[token];
  if (!entry) return false;
  if (entry.expires && Date.now() > entry.expires) {
    delete tokens[token];
    saveApiTokens(tokens);
    return false;
  }
  return true;
}

function createApiToken(label) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = loadApiTokens();
  tokens[token] = {
    label: label || 'cluster',
    created: Date.now(),
    expires: Date.now() + 90 * 24 * 60 * 60 * 1000 // 90 days
  };
  saveApiTokens(tokens);
  return token;
}

// --- Cluster: remote server management ---
let _clusterTokensCache = null, _clusterTokensTime = 0;
function loadClusterTokens() {
  if (!_clusterTokensCache || Date.now() - _clusterTokensTime > LIVE_CONFIG_TTL) {
    try {
      if (fs.existsSync(CLUSTER_TOKENS_FILE)) _clusterTokensCache = JSON.parse(fs.readFileSync(CLUSTER_TOKENS_FILE, 'utf8'));
      else _clusterTokensCache = {};
    } catch (e) { _clusterTokensCache = {}; }
    _clusterTokensTime = Date.now();
  }
  return _clusterTokensCache;
}

function saveClusterTokens(tokens) {
  fs.writeFileSync(CLUSTER_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  _clusterTokensCache = tokens; _clusterTokensTime = Date.now();
}

// Read cluster config (uses cached liveConfig)
function getClusterConfig() {
  return liveConfig('cluster', []);
}

// --- Login page ---
const LOGIN_PAGE = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Terminal — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;
    display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
  .login{background:#16213e;border:1px solid #0f3460;border-radius:12px;padding:32px;
    width:360px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.5)}
  h1{color:#00d4aa;font-size:22px;margin-bottom:20px;text-align:center}
  label{display:block;color:#888;font-size:12px;margin-bottom:4px;margin-top:14px}
  input{width:100%;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;
    padding:10px 14px;border-radius:6px;font-size:15px}
  input:focus{border-color:#00d4aa;outline:none}
  .btn{width:100%;margin-top:20px;padding:12px;border:none;border-radius:6px;
    background:#00d4aa;color:#1a1a2e;font-size:16px;font-weight:600;cursor:pointer}
  .btn:hover{opacity:0.9}
  .error{color:#e94560;font-size:13px;margin-top:10px;display:none;text-align:center}
</style>
</head><body>
<div class="login">
  <h1>Web Terminal</h1>
  <form method="POST" action="/login">
    <label>Username</label>
    <input name="user" required autocomplete="username" autofocus>
    <label>Password</label>
    <input name="password" type="password" required autocomplete="current-password">
    <div id="error" class="error">ERRMSG</div>
    <button type="submit" class="btn">Sign in</button>
  </form>
</div>
</body></html>`;

// --- Rate limiting ---
const loginAttempts = new Map(); // ip -> { count, firstAttempt }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 1000;  // 60 seconds
const RATE_LIMIT_BLOCK = parseInt(process.env.WT_RATE_LIMIT_BLOCK) || 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > RATE_LIMIT_BLOCK) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX;
}

function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    record.count++;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now - record.firstAttempt > RATE_LIMIT_BLOCK) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

// --- PWA static assets (before auth) ---
app.get('/manifest.json', (req, res) => {
  const name = getServerName();
  res.json({
    name: `Terminal — ${name}`,
    short_name: name,
    description: 'Browser-based terminal with multi-server session management',
    start_url: '/app',
    display: 'standalone',
    background_color: '#1e1e1e',
    theme_color: '#16213e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]
  });
});
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/icon.svg', (req, res) => res.sendFile(path.join(__dirname, 'icon.svg')));

// --- Security headers ---
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data:");
  next();
});

// --- Public routes (before auth middleware) ---
app.get('/login', (req, res) => {
  // If already logged in, redirect to lobby
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME]) && !needsPasswordChange()) {
    return res.redirect('/');
  }
  res.send(LOGIN_PAGE.replace('ERRMSG', ''));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).send(LOGIN_PAGE.replace('display:none', 'display:block').replace('ERRMSG', 'Too many failed attempts. Try again in a few minutes.'));
  }
  const { user, password } = req.body || {};
  if (checkCredentials(user, password)) {
    clearLoginAttempts(ip);
    setAuthCookie(res, user);
    return res.redirect('/');
  }
  recordFailedLogin(ip);
  res.status(401).send(LOGIN_PAGE.replace('display:none', 'display:block').replace('ERRMSG', 'Invalid username or password'));
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// --- API: auth token creation (before auth middleware — validates credentials itself) ---
app.post('/api/auth/token', express.json({ limit: '16kb' }), (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts' });
  }
  const { user, password, label } = req.body || {};
  if (!checkCredentials(user, password)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearLoginAttempts(ip);
  const token = createApiToken(label || 'cluster');
  res.json({ ok: true, token });
});

// --- Claude hook endpoint (before auth middleware) ---
// H1: gated by X-WT-Hook-Token header (per-process secret in .hook-token).
// The token is generated on startup; hook senders (claude-hook.js /
// claude-hook.sh) read it from the same file.
// Supports two modes:
// 1. POST /api/session/:id/hook with {event} body (from command hooks)
// 2. POST /api/hook with X-WT-Session-ID header (from HTTP hooks, no subprocess)
// Claude Code hook payloads include the full tool_input / tool_response, which
// can exceed 16kb easily (e.g. Bash output, file reads). Bumped to 256kb to
// stop the steady drip of PayloadTooLargeError in error.log without
// accepting unbounded payloads.
//
// --- Hook event transform layer ---
// Claude's raw events alone produce noisy status: every Notification subtype
// (permission_prompt, idle_prompt, auth_success, elicitation_dialog) maps to
// the same hook_event_name, Stop fires between agentic turns even when the
// next turn starts ms later, and SubagentStop (which Stop auto-converts to
// inside an Agent tool) was previously dropped on the floor. We shape events
// here so the worker only sees clean transitions:
//   - Notification: read the payload `message` to decide
//       permission text  → PermissionRequest (waiting)
//       idle text        → Notification     (idle, after Claude's own 60s)
//       anything else    → dropped (don't flip status)
//   - Stop / Notification(idle): held for HOOK_STOP_DEBOUNCE_MS. Any non-idle
//     event arriving during the window cancels the pending idle so the user
//     never sees a flash of "stopped" between agentic turns.
//   - SubagentStop: dropped. The parent agent is still working; the next
//     PreToolUse/Stop from the parent will move status correctly.
const HOOK_STOP_DEBOUNCE_MS = parseInt(process.env.WT_HOOK_STOP_DEBOUNCE_MS, 10) || 750;
const _hookState = new Map(); // sessionId -> { pendingIdle, lastSeq }
let _hookSeqCounter = 0;
// Same regex the worker uses to reject non-UUID session ids. Mirrored here so
// processHookEvent can return a clean "session not found" before kicking off
// a debounce timer for an id that the worker would never accept anyway.
const _HOOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _isWorkingEvent = (e) =>
  e === 'UserPromptSubmit' || e === 'PreToolUse' || e === 'PostToolUse' ||
  e === 'SubagentStart' || e === 'PermissionRequest';

function _hookGetState(id) {
  let s = _hookState.get(id);
  if (!s) { s = { pendingIdle: null, lastSeq: 0 }; _hookState.set(id, s); }
  return s;
}
function _hookCancelPending(state) {
  if (state.pendingIdle) {
    clearTimeout(state.pendingIdle.timer);
    state.pendingIdle = null;
  }
}
function _classifyNotification(body) {
  // Claude payload shape varies by version; check the common fields. The
  // matcher value comes through as `notification_type` in newer versions and
  // as part of `message` in older ones — match both.
  const matcher = String(body?.notification_type || body?.matcher || '').toLowerCase();
  const msg = String(body?.message || '').toLowerCase();
  if (matcher === 'permission_prompt' || /\bpermission\b|\bapprov/.test(msg)) return 'permission';
  if (matcher === 'idle_prompt' || /waiting for your input|idle/.test(msg)) return 'idle';
  if (matcher === 'auth_success' || matcher === 'elicitation_dialog') return 'drop';
  return 'drop';
}

// Drop tracked state when a session is removed so we don't leak Maps.
function hookForgetSession(id) {
  const s = _hookState.get(id);
  if (s) { _hookCancelPending(s); _hookState.delete(id); }
}

// Returns { status } like the worker RPC. Resolves immediately for transient
// transforms (drop/debounce) so the calling HTTP handler can reply.
async function processHookEvent(id, rawEvent, claudeSessionId, body) {
  if (!id || !rawEvent) return { status: 'unchanged', skipped: 'no id/event' };

  // SubagentStop: parent is still in the loop, ignore entirely. Bail before
  // any state allocation so a flood of SubagentStops can't grow _hookState.
  if (rawEvent === 'SubagentStop') {
    return { status: 'unchanged', skipped: 'subagent-stop' };
  }

  // Reject invalid session ids before any state allocation or debounce
  // scheduling so callers get a real 404 instead of a fire-and-forget 200,
  // and a flood of bogus ids can't grow _hookState. The worker uses the
  // same regex, so anything that fails here would have failed at the worker.
  if (!_HOOK_UUID_RE.test(id)) {
    throw new Error('session not found');
  }

  const state = _hookGetState(id);
  const seq = ++_hookSeqCounter;

  // Remember where this session's Claude transcript lives so a later push can
  // quote its last message. Every http-hook payload carries transcript_path;
  // stash it before any early return. Cleaned up on sessionExited with the rest
  // of the notify-state. M1: validate it (realpath'd .jsonl under the Claude
  // projects root) before trusting it — an unvalidated path would let a hook
  // steer /attention + the ntfy detail at any file on disk.
  if (body && typeof body.transcript_path === 'string' && body.transcript_path) {
    const safe = safeTranscriptPath(body.transcript_path);
    if (safe) _nstate(id).transcriptPath = safe;
  }

  // #19: track a LIVE interactive question. Claude writes the AskUserQuestion
  // tool_use to the transcript only once it's ANSWERED, so the transcript can't
  // reveal a prompt while it's on screen. The PreToolUse hook carries the full
  // questions up front — stash them so the app can render the overlay while the
  // prompt is pending; clear on PostToolUse (answered), a new user turn, Stop,
  // or the next (different) tool.
  const _tool = body && body.tool_name;
  if (rawEvent === 'PreToolUse' && _tool === 'AskUserQuestion') {
    const questions = transcript.shapeQuestions(body.tool_input);
    if (questions.length) {
      _nstate(id).pendingQuestion = { toolUseId: `hook-${id}-${seq}`, questions };
    }
  } else if (
    (rawEvent === 'PostToolUse' && _tool === 'AskUserQuestion') ||
    rawEvent === 'PreToolUse' || // a different tool started → prior question resolved
    rawEvent === 'UserPromptSubmit' ||
    rawEvent === 'Stop'
  ) {
    const ns = _notifyState.get(id);
    if (ns && ns.pendingQuestion) ns.pendingQuestion = null;
  }

  let event = rawEvent;
  let isIdleEvent = false;

  if (event === 'Notification') {
    const kind = _classifyNotification(body);
    if (kind === 'permission') { event = 'PermissionRequest'; }
    else if (kind === 'idle')  { event = 'Notification'; isIdleEvent = true; }
    else                       { return { status: 'unchanged', skipped: 'notification-other' }; }
  } else if (event === 'Stop') {
    isIdleEvent = true;
  }

  // Any working signal cancels a pending idle (the agent is clearly still
  // active — Stop between turns was a false alarm).
  if (_isWorkingEvent(event) && state.pendingIdle) {
    _hookCancelPending(state);
  }

  if (isIdleEvent) {
    // Coalesce: replace any prior pending idle with this one. The debounce
    // window starts from the latest idle event we saw.
    _hookCancelPending(state);
    state.pendingIdle = {
      event,
      claudeSessionId,
      seq,
      timer: setTimeout(() => {
        const s = _hookState.get(id);
        if (!s || !s.pendingIdle || s.pendingIdle.seq !== seq) return;
        const { event: pendingEvent, claudeSessionId: pendingCsid } = s.pendingIdle;
        s.pendingIdle = null;
        workerClient.rpc('hookEvent', { id, event: pendingEvent, claudeSessionId: pendingCsid })
          .catch(() => {})
          .finally(() => {
            // Drop the state entry if nothing else is keeping it alive. This
            // keeps the map from accumulating one entry per UUID that ever
            // sent us an idle event (incl. valid-format UUIDs the worker
            // rejected as "not found").
            const cur = _hookState.get(id);
            if (cur && !cur.pendingIdle) _hookState.delete(id);
          });
      }, HOOK_STOP_DEBOUNCE_MS),
    };
    if (typeof state.pendingIdle.timer.unref === 'function') state.pendingIdle.timer.unref();
    return { status: 'pending', deferred: event };
  }

  state.lastSeq = seq;
  // Forward the user's prompt on UserPromptSubmit so the worker can replay it
  // during API-error /compact recovery. (Claude's hook payload carries `prompt`.)
  const prompt = (event === 'UserPromptSubmit' && body && typeof body.prompt === 'string')
    ? body.prompt : undefined;
  return workerClient.rpc('hookEvent', { id, event, claudeSessionId, prompt });
}

app.post('/api/hook', express.json({ limit: '256kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = req.headers['x-wt-session-id'];
  if (!id) return res.json({ ok: true, skipped: 'no session ID' });
  const event = req.body?.hook_event_name || req.body?.event;
  const claudeSessionId = req.body?.session_id;
  try {
    const result = await processHookEvent(id, event, claudeSessionId, req.body);
    res.json({ ok: true, status: result.status, ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.deferred ? { deferred: result.deferred } : {}) });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.json({ ok: true, skipped: 'session not found' });
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/session/:id/hook', express.json({ limit: '256kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const event = req.body?.hook_event_name || req.body?.event;
  if (!event) return res.status(400).json({ error: 'event required' });
  const claudeSessionId = req.body?.session_id;
  try {
    const result = await processHookEvent(req.params.id, event, claudeSessionId, req.body);
    res.json({ ok: true, status: result.status, ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.deferred ? { deferred: result.deferred } : {}) });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: 'session not found' });
    if (/event required/i.test(e.message)) return res.status(400).json({ error: 'event required' });
    res.status(500).json({ error: e.message });
  }
});

// Claude Code status-line metrics (ctx%, 5h/7d rate-limit %, model, effort).
// Pushed by the global statusline script (throttled, safe-fail) — the only
// source for these numbers, which Claude Code exposes to nothing but its own
// statusLine invocation. Keyed by Claude session id; ephemeral (reposted every
// few seconds), so a plain in-memory Map is fine — it self-heals after a
// server hot-reload. Localhost-only: same trust boundary as the local hooks.
const claudeStatusMetrics = new Map(); // claudeSessionId -> { ctx, fiveH, sevenD, model, effort, ts }
// Idle sessions stop rendering their status line, so they stop posting. Keep the
// last-known metrics for hours: context % is frozen while idle (accurate), and
// stale 5h/7d numbers are low-stakes. Prevents an idle session showing only its
// folder. Bounded by the 200-entry prune + a session vanishing from /api/sessions.
const CLAUDE_STATUS_TTL_MS = 4 * 60 * 60 * 1000;

function getStatusMetrics(claudeSessionId) {
  if (!claudeSessionId) return null;
  const m = claudeStatusMetrics.get(claudeSessionId);
  if (!m || Date.now() - m.ts > CLAUDE_STATUS_TTL_MS) return null;
  return { ctx: m.ctx, fiveH: m.fiveH, sevenD: m.sevenD, model: m.model, effort: m.effort };
}

// Drop stale entries so the Map can't grow without bound as sessions come and go.
function pruneStatusMetrics() {
  const now = Date.now();
  for (const [k, v] of claudeStatusMetrics) {
    if (now - v.ts > CLAUDE_STATUS_TTL_MS) claudeStatusMetrics.delete(k);
  }
}

app.post('/api/claude-status', express.json({ limit: '16kb' }), (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const sid = typeof b.session_id === 'string' ? b.session_id : '';
  if (!sid) return res.json({ ok: true, skipped: 'no session_id' });
  const num = (v) => {
    if (v === '' || v == null) return null; // Number('') === 0 — treat blank as absent, not 0%
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  };
  const str = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);
  claudeStatusMetrics.set(sid, {
    ctx: num(b.ctx),
    fiveH: num(b.five),
    sevenD: num(b.seven),
    model: str(b.model),
    effort: str(b.effort),
    ts: Date.now(),
  });
  if (claudeStatusMetrics.size > 200) pruneStatusMetrics();
  res.json({ ok: true });
});

// --- Peer relay (Claude <-> Codex mediator) ---
// Localhost-only message bus so two agents running in separate PTY sessions
// on this host can ask each other for second opinions. State is in-memory
// and resets on server reload (which the protocol doc warns about).
// Rate limits exist to stop runaway back-and-forth burning tokens overnight.
const RELAY_MAX_TURNS = Math.max(1, parseInt(process.env.WT_RELAY_MAX_TURNS_PER_CONV, 10) || 6);
const RELAY_DAILY_MAX = Math.max(1, parseInt(process.env.WT_RELAY_DAILY_MAX, 10) || 50);
const RELAY_MAX_MSG_BYTES = Math.max(256, parseInt(process.env.WT_RELAY_MAX_MSG_BYTES, 10) || 16384);
const RELAY_LONGPOLL_MAX_MS = Math.max(1000, parseInt(process.env.WT_RELAY_LONGPOLL_MAX_MS, 10) || 30000);
const RELAY_QUEUE_MAX = Math.max(10, parseInt(process.env.WT_RELAY_QUEUE_MAX, 10) || 100);
const RELAY_CONV_IDLE_MS = 60 * 60 * 1000; // drop conversation records after 1h idle

// Per-agent inbox: each conversation is buffered until the asker closes it
// with more=false. A conv is "ready" once its last message has more=false.
// recv only returns messages from ready convs (so batched asks are delivered
// as one unit and the answerer doesn't reply mid-batch).
const _relayBoxes = new Map();       // agent -> { convs: Map<conv_id, {messages:[], ready:bool}>, waiters: [] }
const _relayConvs = new Map();       // conv_id -> { turns, lastTs, participants: Set }
let _relayDay = '';
let _relayDayUsed = 0;

function _relayToday() { return new Date().toISOString().slice(0, 10); }
function _relayCheckDay() {
  const today = _relayToday();
  if (today !== _relayDay) { _relayDay = today; _relayDayUsed = 0; }
}
function _relayBox(agent) {
  let box = _relayBoxes.get(agent);
  if (!box) { box = { convs: new Map(), waiters: [] }; _relayBoxes.set(agent, box); }
  return box;
}
function _relayBoxTotal(box) {
  let n = 0;
  for (const c of box.convs.values()) n += c.messages.length;
  return n;
}
function _relayBoxHasReady(box, convFilter) {
  for (const [id, c] of box.convs) {
    if (!c.ready) continue;
    if (convFilter && id !== convFilter) continue;
    return true;
  }
  return false;
}
function _relayDrain(box, convFilter) {
  const out = [];
  for (const [id, c] of [...box.convs]) {
    if (!c.ready) continue;
    if (convFilter && id !== convFilter) continue;
    for (const m of c.messages) out.push(m);
    box.convs.delete(id);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
function _relayCleanConvs() {
  const now = Date.now();
  for (const [id, c] of _relayConvs) {
    if (now - c.lastTs > RELAY_CONV_IDLE_MS) _relayConvs.delete(id);
  }
}
function _relayValidAgent(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(name);
}

app.post('/api/relay/send', express.json({ limit: '64kb' }), (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { from, to, message } = req.body || {};
  let conv_id = req.body?.conv_id;
  const more = req.body?.more === true; // true = batch open, withhold delivery; false/missing = ready to deliver
  if (!_relayValidAgent(from)) return res.status(400).json({ error: 'invalid from' });
  if (!_relayValidAgent(to)) return res.status(400).json({ error: 'invalid to' });
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });
  if (typeof message !== 'string' || !message.length) return res.status(400).json({ error: 'message required' });
  if (Buffer.byteLength(message, 'utf8') > RELAY_MAX_MSG_BYTES) {
    return res.status(413).json({ error: 'message too large', max_bytes: RELAY_MAX_MSG_BYTES });
  }

  _relayCheckDay();
  if (_relayDayUsed >= RELAY_DAILY_MAX) {
    return res.status(429).json({
      error: 'daily-cap',
      daily_max: RELAY_DAILY_MAX,
      daily_used: _relayDayUsed,
      resets_at: _relayToday() + 'T24:00:00Z',
    });
  }

  let conv;
  if (conv_id) {
    if (typeof conv_id !== 'string' || conv_id.length > 64) return res.status(400).json({ error: 'invalid conv_id' });
    conv = _relayConvs.get(conv_id);
    if (!conv) return res.status(404).json({ error: 'conv not found (it may have expired)' });
    if (conv.turns >= RELAY_MAX_TURNS) {
      return res.status(429).json({
        error: 'conv-cap',
        conv_id,
        turns: conv.turns,
        max_turns: RELAY_MAX_TURNS,
        hint: 'this conversation hit its turn cap; start a new conv_id only if a fresh question is justified',
      });
    }
  } else {
    conv_id = crypto.randomUUID();
    conv = { turns: 0, lastTs: Date.now(), participants: new Set() };
    _relayConvs.set(conv_id, conv);
  }
  conv.turns += 1;
  conv.lastTs = Date.now();
  conv.participants.add(from);
  conv.participants.add(to);
  _relayDayUsed += 1;

  const box = _relayBox(to);
  // Bound total per-agent buffered messages: drop oldest from the largest buffered conv.
  if (_relayBoxTotal(box) >= RELAY_QUEUE_MAX) {
    let victim = null, victimSize = -1;
    for (const [id, c] of box.convs) {
      if (c.messages.length > victimSize) { victim = id; victimSize = c.messages.length; }
    }
    if (victim) {
      const c = box.convs.get(victim);
      c.messages.shift();
      if (c.messages.length === 0) box.convs.delete(victim);
    }
  }
  const entry = { conv_id, from, to, message, ts: Date.now(), turn: conv.turns, more };
  let cbuf = box.convs.get(conv_id);
  if (!cbuf) { cbuf = { messages: [], ready: false }; box.convs.set(conv_id, cbuf); }
  cbuf.messages.push(entry);
  cbuf.ready = !more;

  if (cbuf.ready) {
    // Wake a waiter that's interested in this conv (or any conv).
    for (let i = 0; i < box.waiters.length; i++) {
      const w = box.waiters[i];
      if (!w.convFilter || w.convFilter === conv_id) {
        box.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve();
        break;
      }
    }
  }

  res.json({
    ok: true,
    conv_id,
    turn: conv.turns,
    more,
    buffered: cbuf.messages.length,
    remaining_turns: Math.max(0, RELAY_MAX_TURNS - conv.turns),
    daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed),
  });
});

app.get('/api/relay/recv', (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const agent = String(req.query.agent || '');
  if (!_relayValidAgent(agent)) return res.status(400).json({ error: 'invalid agent' });
  const convFilter = req.query.conv_id ? String(req.query.conv_id) : null;
  const waitMsRaw = parseInt(req.query.wait, 10);
  const waitMs = isNaN(waitMsRaw) ? 0 : Math.min(Math.max(0, waitMsRaw * 1000), RELAY_LONGPOLL_MAX_MS);
  _relayCheckDay();
  _relayCleanConvs();
  const box = _relayBox(agent);

  const immediate = _relayDrain(box, convFilter);
  if (immediate.length || waitMs === 0) {
    return res.json({ messages: immediate, daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed) });
  }

  const waiter = { convFilter };
  const p = new Promise((resolve) => { waiter.resolve = resolve; });
  waiter.timer = setTimeout(() => {
    const idx = box.waiters.indexOf(waiter);
    if (idx >= 0) box.waiters.splice(idx, 1);
    waiter.resolve();
  }, waitMs);
  if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
  box.waiters.push(waiter);
  req.on('close', () => {
    clearTimeout(waiter.timer);
    const idx = box.waiters.indexOf(waiter);
    if (idx >= 0) box.waiters.splice(idx, 1);
  });
  p.then(() => {
    if (res.writableEnded) return;
    const msgs = _relayDrain(box, convFilter);
    res.json({ messages: msgs, daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed) });
  });
});

app.get('/api/relay/status', (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  _relayCheckDay();
  _relayCleanConvs();
  const queues = Object.create(null); // null-proto so a hostile agent name (e.g. __proto__) cannot pollute it
  for (const [name, box] of _relayBoxes) {
    let total = 0, ready = 0, pending = 0;
    for (const c of box.convs.values()) {
      total += c.messages.length;
      if (c.ready) ready += c.messages.length; else pending += c.messages.length;
    }
    queues[name] = { total, ready, pending, waiters: box.waiters.length };
  }
  const convs = [];
  for (const [id, c] of _relayConvs) {
    convs.push({ conv_id: id, turns: c.turns, max_turns: RELAY_MAX_TURNS, participants: [...c.participants], last_ts: c.lastTs });
  }
  res.json({
    limits: {
      max_turns_per_conv: RELAY_MAX_TURNS,
      daily_max: RELAY_DAILY_MAX,
      max_msg_bytes: RELAY_MAX_MSG_BYTES,
      longpoll_max_ms: RELAY_LONGPOLL_MAX_MS,
      queue_max: RELAY_QUEUE_MAX,
    },
    day: _relayDay || _relayToday(),
    daily_used: _relayDayUsed,
    daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed),
    queues,
    conversations: convs,
  });
});

// --- Auth middleware ---
app.use((req, res, next) => {
  // Try cookie auth
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME])) {
    // Refresh cookie so active users stay logged in
    setAuthCookie(res, _USER);
    // Force password change if still using default
    if (needsPasswordChange() && req.path !== '/api/setup') {
      return res.send(SETUP_PAGE);
    }
    req._wtAuth = { mode: 'cookie', identity: `cookie:${_USER}`, label: _USER };
    return next();
  }
  // Try Bearer token auth (for cluster/API access)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (verifyApiToken(token)) {
      const tok = loadApiTokens()[token];
      req._wtAuth = { mode: 'bearer', identity: `bearer:${token}`, label: (tok && tok.label) || 'bearer' };
      return next();
    }
  }
  // Try query-string token (for WebSocket upgrades through cluster proxy)
  const qToken = req.query?.token;
  if (qToken && verifyApiToken(qToken)) {
    const tok = loadApiTokens()[qToken];
    req._wtAuth = { mode: 'bearer', identity: `bearer:${qToken}`, label: (tok && tok.label) || 'bearer' };
    return next();
  }
  // Issue #20: direct-mode WS — let the /ws/:id handler validate the `dt`
  // token itself (it knows the :id to verify against). We defer here to
  // avoid parsing the token twice. Only applies to /ws/ paths with ?dt=.
  if (req.path.startsWith('/ws/') && req.query?.dt) return next();
  // API/cluster/WS routes return 401, pages redirect to login
  if (req.path.startsWith('/api/') || req.path.startsWith('/cluster/') || req.path.startsWith('/ws/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
});

const SETUP_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Terminal — Setup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: 'Segoe UI', sans-serif;
    display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
  .setup { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 32px;
    width: 400px; max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  h1 { color: #00d4aa; font-size: 22px; margin-bottom: 8px; }
  p { color: #888; font-size: 14px; margin-bottom: 20px; }
  .warn { background: #3a2a1a; border: 1px solid #da4; border-radius: 6px; padding: 10px 14px;
    color: #da4; font-size: 13px; margin-bottom: 20px; }
  label { display: block; color: #888; font-size: 12px; margin-bottom: 4px; margin-top: 14px; }
  input { width: 100%; background: #1a1a2e; color: #e0e0e0; border: 1px solid #0f3460;
    padding: 10px 14px; border-radius: 6px; font-size: 15px; }
  input:focus { border-color: #00d4aa; outline: none; }
  .btn { width: 100%; margin-top: 20px; padding: 12px; border: none; border-radius: 6px;
    background: #00d4aa; color: #1a1a2e; font-size: 16px; font-weight: 600; cursor: pointer; }
  .btn:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error { color: #e94560; font-size: 13px; margin-top: 10px; display: none; }
  .req { color: #666; font-size: 11px; margin-top: 6px; }
</style>
</head><body>
<div class="setup">
  <h1>Set Your Password</h1>
  <p>You're using the default password. Please set a secure password before continuing.</p>
  <div class="warn">Default credentials are publicly known. Change your password now to secure your terminal.</div>
  <form id="form" onsubmit="return save(event)">
    <label>New Username</label>
    <input id="user" value="admin" autocomplete="username">
    <label>New Password</label>
    <input id="pass" type="password" required minlength="6" autocomplete="new-password" placeholder="Min 6 characters">
    <label>Confirm Password</label>
    <input id="pass2" type="password" required minlength="6" autocomplete="new-password" placeholder="Repeat password">
    <div class="req">Minimum 6 characters</div>
    <div id="error" class="error"></div>
    <button type="submit" class="btn">Save &amp; Continue</button>
  </form>
</div>
<script>
async function save(e) {
  e.preventDefault();
  const err = document.getElementById('error');
  const user = document.getElementById('user').value.trim();
  const pass = document.getElementById('pass').value;
  const pass2 = document.getElementById('pass2').value;
  if (!user) { err.textContent = 'Username is required'; err.style.display = 'block'; return; }
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.style.display = 'block'; return; }
  if (pass !== pass2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('.btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password: pass })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = 'Saved! Redirecting...';
      location.href = '/logout';
    } else {
      err.textContent = data.error || 'Failed to save';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Save & Continue';
    }
  } catch(e) {
    err.textContent = 'Connection error';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Save & Continue';
  }
}
</script>
</body></html>`;

app.post('/api/setup', express.json(), (req, res) => {
  if (!needsPasswordChange()) {
    return res.status(403).json({ error: 'Password already set' });
  }
  const { user, password } = req.body || {};
  if (!user || typeof user !== 'string' || user.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (DEFAULT_PASSWORDS.includes(password)) {
    return res.status(400).json({ error: 'Please choose a different password' });
  }

  // Hash and save
  const hashed = hashPassword(password);
  const cfg = readConfig();
  cfg.user = user.trim();
  cfg.password = hashed;
  writeConfig(cfg);

  // Update running credentials
  PASS = hashed;
  // Need to update USER too — but it's const, so we use a module-level let
  _USER = user.trim();

  console.log(`[${new Date().toISOString()}] Password changed via setup (user: ${_USER})`);
  res.json({ ok: true });
});

// --- API: config ---
app.get('/api/config', (req, res) => {
  // Return full config (already behind auth)
  const current = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      Object.assign(current, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (e) {}
  // Fill in running values
  current.port = current.port || PORT;
  current.user = current.user || _USER;
  current.password = current.password || PASS;
  current.shell = current.shell || SHELL;
  current.defaultCwd = current.defaultCwd || getDefaultCwd();
  current.scanFolders = current.scanFolders || getScanFolders();
  current.defaultCommand = current.defaultCommand || getDefaultCommand();
  current.openInNewTab = current.openInNewTab !== undefined ? current.openInNewTab : liveConfig('openInNewTab', true);
  current.serverName = current.serverName || getServerName();
  current.scrollbackReplayLimit = current.scrollbackReplayLimit || getScrollbackReplayLimit();
  current.cluster = current.cluster || [];
  current.publicUrl = current.publicUrl || '';
  current.claudeHome = current.claudeHome || '';
  current.keepSessionsOpen = current.keepSessionsOpen !== undefined ? current.keepSessionsOpen : true;
  current.autoContinueOnApiError = current.autoContinueOnApiError !== undefined ? current.autoContinueOnApiError : true;
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'scrollbackReplayLimit', 'cluster', 'publicUrl', 'claudeHome', 'keepSessionsOpen', 'autoContinueOnApiError', 'exclusiveViewer'];

app.put('/api/config', express.json({ limit: '16kb' }), (req, res) => {
  try {
    // Only allow known config keys
    const sanitized = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }
    // If password is masked, preserve existing password; otherwise hash the new one
    if (sanitized.password === '***' || !sanitized.password) {
      const existing = readConfig();
      sanitized.password = existing.password || PASS;
    } else if (!sanitized.password.startsWith('$scrypt$')) {
      sanitized.password = hashPassword(sanitized.password);
    }
    // Basic type validation
    if (sanitized.port !== undefined) sanitized.port = parseInt(sanitized.port) || 7681;
    if (sanitized.scanFolders && !Array.isArray(sanitized.scanFolders)) sanitized.scanFolders = [String(sanitized.scanFolders)];
    if (sanitized.openInNewTab !== undefined) sanitized.openInNewTab = !!sanitized.openInNewTab;
    if (sanitized.keepSessionsOpen !== undefined) sanitized.keepSessionsOpen = !!sanitized.keepSessionsOpen;
    if (sanitized.autoContinueOnApiError !== undefined) sanitized.autoContinueOnApiError = !!sanitized.autoContinueOnApiError;
    if (sanitized.scrollbackReplayLimit !== undefined) sanitized.scrollbackReplayLimit = Math.max(10240, parseInt(sanitized.scrollbackReplayLimit) || 102400);
    // Compare restart-sensitive keys against running values
    const RESTART_KEYS = { port: PORT, host: config.host || '127.0.0.1', shell: SHELL };
    const needsRestart = Object.entries(RESTART_KEYS).some(
      ([k, running]) => sanitized[k] !== undefined && String(sanitized[k]) !== String(running)
    );
    writeConfig(sanitized);
    res.json({
      ok: true,
      needsRestart,
      message: needsRestart
        ? 'Saved. Port, host, or shell changed — restart required.'
        : 'Saved. Changes are live.'
    });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: hostname ---
app.get('/api/hostname', (req, res) => {
  res.json({ hostname: getServerName() });
});

// --- API: auth token management (listing/deletion require auth) ---
app.get('/api/auth/tokens', (req, res) => {
  const tokens = loadApiTokens();
  const list = Object.entries(tokens).map(([token, info]) => ({
    token: token.substring(0, 8) + '...',
    tokenFull: token,
    label: info.label,
    created: info.created,
    expires: info.expires
  }));
  res.json(list);
});

app.delete('/api/auth/tokens/:token', (req, res) => {
  const tokens = loadApiTokens();
  if (tokens[req.params.token]) {
    delete tokens[req.params.token];
    saveApiTokens(tokens);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Token not found' });
});

// --- Cluster: register endpoint (requires Bearer token auth) ---
// Allows a remote server to register itself in our cluster config
app.post('/api/cluster/register', express.json({ limit: '16kb' }), (req, res) => {
  // Must authenticate with a valid API token (the remote server sends one it just received)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !verifyApiToken(authHeader.substring(7))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { name, url, token } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ error: 'name, url, token required' });
  // Validate URL format
  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  // Add to cluster config if not already there
  const cfg = readConfig();
  if (!cfg.cluster) cfg.cluster = [];
  if (!cfg.cluster.find(s => s.url === url)) {
    cfg.cluster.push({ name, url });
    writeConfig(cfg);
  }

  // Store the token for this remote server
  const clusterTokens = loadClusterTokens();
  clusterTokens[url] = { token, name, authenticated: Date.now() };
  saveClusterTokens(clusterTokens);

  console.log(`[${new Date().toISOString()}] Cluster: registered remote server "${name}" (${url})`);
  res.json({ ok: true });
});

// --- Cluster: proxy to remote servers ---
const http = require('http');
const https = require('https');

app.get('/api/cluster/servers', (req, res) => {
  const clusterTokens = loadClusterTokens();
  const servers = getClusterConfig().map(s => ({
    name: s.name,
    url: s.url,
    hasToken: !!clusterTokens[s.url]
  }));
  res.json(servers);
});

// Authenticate to a remote server and store its token
app.post('/api/cluster/auth', express.json({ limit: '16kb' }), async (req, res) => {
  const { url, user, password } = req.body || {};
  if (!url || !user || !password) return res.status(400).json({ error: 'url, user, password required' });

  // Verify this URL is in our cluster config
  const server = getClusterConfig().find(s => s.url === url);
  if (!server) return res.status(400).json({ error: 'Server not in cluster config' });

  try {
    const tokenRes = await clusterFetch(url + '/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password, label: `cluster:${getServerName()}` })
    });
    if (!tokenRes.ok) return res.status(401).json({ error: 'Remote server rejected credentials' });
    const data = JSON.parse(tokenRes.body);
    const clusterTokens = loadClusterTokens();
    clusterTokens[url] = { token: data.token, name: server.name, authenticated: Date.now() };
    saveClusterTokens(clusterTokens);

    // Auto-register back: create a token for the remote server and register ourselves there
    try {
      const myName = getServerName();
      const myUrl = liveConfig('publicUrl', null);
      if (myUrl) {
        const reverseToken = createApiToken(`cluster:${server.name}`);
        await clusterFetch(url + '/api/cluster/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + data.token
          },
          body: JSON.stringify({ name: myName, url: myUrl, token: reverseToken })
        });
      }
    } catch (e) {
      // Non-fatal — reverse registration is best-effort
      console.warn('Cluster reverse-register failed:', e.message);
    }

    res.json({ ok: true, name: server.name });
  } catch (e) {
    res.status(502).json({ error: `Cannot reach server: ${e.message}` });
  }
});

// Remove stored token for a remote server
app.delete('/api/cluster/auth/:url', (req, res) => {
  const clusterTokens = loadClusterTokens();
  const url = decodeURIComponent(req.params.url);
  delete clusterTokens[url];
  saveClusterTokens(clusterTokens);
  res.json({ ok: true });
});

// Fetch all sessions across cluster.
//
// Cached per-user for CLUSTER_SESSIONS_TTL_MS so N concurrent browser tabs all
// share a single fan-out to peers (each call hits every peer with 2 GETs;
// without coalescing this becomes a polling storm that wedges the event loop
// and trips the monitor's health check).
const CLUSTER_SESSIONS_TTL_MS = 1500;
const _clusterSessionsCache = new Map(); // user -> { ts, promise }

// Drop the cached cluster-session list so the next /api/cluster/sessions call
// recomputes. Call after any local session mutation (create/delete/rename/
// reorder) — otherwise a just-created session is invisible in the sidebar until
// the TTL lapses (a session you create doesn't show for up to 1.5s). Cheap: the
// next fetch simply re-fans-out. Clears all users (a local mutation is visible
// to every viewer).
function invalidateClusterSessionsCache() { _clusterSessionsCache.clear(); }

// Throttle for verbose cluster-fan-out logs. We only emit when the session
// summary changes OR CLUSTER_LOG_MIN_GAP_MS has passed.
const CLUSTER_LOG_MIN_GAP_MS = 30000;
const _clusterLogState = new Map(); // key -> { ts, summary }
function _throttledClusterLog(key, summary, format) {
  const prev = _clusterLogState.get(key);
  const now = Date.now();
  if (prev && prev.summary === summary && now - prev.ts < CLUSTER_LOG_MIN_GAP_MS) return;
  _clusterLogState.set(key, { ts: now, summary });
  console.log(format(new Date().toISOString()));
}

async function _computeClusterSessions(reqUser) {
  const result = [];

  // Local sessions (via worker)
  try {
    const { sessions: localList } = await workerClient.rpc('listSessions');
    for (const s of localList) {
      result.push({
        id: s.id, name: s.name, cwd: s.cwd, status: s.status,
        clients: s.clients || 0, pid: s.pid,
        lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
        claudeSessionId: s.claudeSessionId,
        server: getServerName(), serverUrl: null,
        notifyLevel: getNotifyLevel(s.id),
        metrics: getStatusMetrics(s.claudeSessionId),
      });
    }
  } catch (e) {
    console.error('worker listSessions failed:', e.message);
  }

  // Remote sessions (parallel, with timeout) — skip self-reference
  const clusterTokens = loadClusterTokens();
  const publicUrl = liveConfig('publicUrl', null);
  const clusterCfg = getClusterConfig();
  const remoteServers = clusterCfg.filter(server => !publicUrl || server.url !== publicUrl);
  const remotePromises = remoteServers.map(async (server) => {
    const tokenEntry = clusterTokens[server.url];
    if (!tokenEntry) return { server: server.name, url: server.url, online: false, needsAuth: true, sessions: [] };
    try {
      const r = await clusterFetch(server.url + '/api/sessions', {
        headers: { 'Authorization': 'Bearer ' + tokenEntry.token },
        timeout: 3000
      });
      if (r.status === 401) {
        return { server: server.name, url: server.url, online: true, needsAuth: true, sessions: [] };
      }
      if (!r.ok) return { server: server.name, url: server.url, online: false, sessions: [] };
      const remoteSessions = JSON.parse(r.body);
      // Fetch version from remote
      let version = '';
      try {
        const vr = await clusterFetch(server.url + '/api/version', {
          headers: { 'Authorization': 'Bearer ' + tokenEntry.token }, timeout: 2000
        });
        if (vr.ok) { const v = JSON.parse(vr.body); version = `${v.version} (${v.hash})`; }
      } catch (e) {}
      // Issue #20: if this peer opts into direct-mode, mint a short-lived
      // HMAC token per session so the browser can WS straight to the peer.
      // HMAC key is our stored bearer for that peer (peer has same value in
      // its api-tokens.json, so it can verify without new key exchange).
      const directConnect = server.directConnect === true;
      const mapped = remoteSessions.map(s => {
        const base = { ...s, server: server.name, serverUrl: server.url };
        if (directConnect && tokenEntry.token) {
          try {
            const dt = mintDirectToken(tokenEntry.token, { sid: s.id, user: reqUser });
            const wsBase = server.url.replace(/^http/, 'ws').replace(/\/+$/, '');
            base.directUrl = `${wsBase}/ws/${encodeURIComponent(s.id)}?dt=${encodeURIComponent(dt)}`;
            base.directToken = dt;
          } catch (e) {
            // Mint failed — silently omit directUrl so client falls back to proxy
            console.warn(`[cluster/direct] mint failed for ${server.name}: ${e.message}`);
          }
        }
        return base;
      });
      return {
        server: server.name, url: server.url, online: true, needsAuth: false, version,
        directConnect, sessions: mapped
      };
    } catch (e) {
      return { server: server.name, url: server.url, online: false, sessions: [] };
    }
  });

  const _tClusterFetch = _LATENCY_DEBUG ? performance.now() : 0;
  const remotes = await Promise.all(remotePromises);
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _tClusterFetch;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} cluster-sessions-fetch peers=${remotePromises.length} dur=${dur.toFixed(0)}ms`);
  }
  for (const r of remotes) {
    if (r.sessions.length > 0) {
      const summary = r.sessions.map(s => {
        const ageMins = s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 60000) : '?';
        return `"${s.name}"(${s.status}, ${ageMins}m ago)`;
      }).join(', ');
      _throttledClusterLog(`fetch:${r.server}`, `${r.online ? '1' : '0'}|${r.sessions.length}|${summary}`,
        (ts) => `[${ts}] Cluster fetch: ${r.server} (${r.online ? 'online' : 'offline'}) → ${r.sessions.length} sessions: ${summary}`);
    }
    result.push(...r.sessions);
  }

  // Get local version info (cached — no sync git per request). See _getGitInfo().
  const _gitInfo = _getGitInfo();
  const localVersion = `${SERVER_VERSION} (${_gitInfo.hash})`;

  return {
    sessions: result,
    servers: [
      { name: getServerName(), url: null, online: true, needsAuth: false, version: localVersion },
      ...remotes.map(r => ({ name: r.server, url: r.url, online: r.online, needsAuth: r.needsAuth, version: r.version || '', directConnect: r.directConnect === true }))
    ]
  };
}

app.get('/api/cluster/sessions', async (req, res) => {
  // Direct-mode (issue #20): look up the current user from the session cookie so
  // minted tokens bind to them. Cluster API calls via Bearer have no cookie —
  // in that case we fall back to the configured server user.
  const reqUser = (() => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const tok = cookies[COOKIE_NAME];
      if (!tok) return _USER;
      const dot = tok.lastIndexOf('.');
      if (dot === -1) return _USER;
      const payload = Buffer.from(tok.substring(0, dot), 'base64').toString();
      const colon = payload.indexOf(':');
      return colon > 0 ? payload.substring(0, colon) : _USER;
    } catch { return _USER; }
  })();

  try {
    const now = Date.now();
    let entry = _clusterSessionsCache.get(reqUser);
    if (!entry || now - entry.ts > CLUSTER_SESSIONS_TTL_MS) {
      entry = { ts: now, promise: _computeClusterSessions(reqUser).catch((e) => {
        // On failure, evict so the next caller retries instead of getting cached error.
        if (_clusterSessionsCache.get(reqUser) === entry) _clusterSessionsCache.delete(reqUser);
        throw e;
      }) };
      _clusterSessionsCache.set(reqUser, entry);
    }
    const payload = await entry.promise;
    res.json(payload);
  } catch (e) {
    console.error('cluster/sessions failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch cluster sessions' });
  }
});

// Proxy API requests to remote servers
app.all('/cluster/:serverUrl/api/*', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const serverUrl = decodeURIComponent(req.params.serverUrl);
  const clusterTokens = loadClusterTokens();
  const tokenEntry = clusterTokens[serverUrl];
  if (!tokenEntry) return res.status(401).json({ error: 'Not authenticated to remote server' });

  const remotePath = '/api/' + req.params[0];
  const contentType = req.headers['content-type'] || 'application/json';
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    body = contentType.includes('json') ? JSON.stringify(JSON.parse(req.body.toString() || '{}')) : req.body;
  }
  try {
    const r = await clusterFetch(serverUrl + remotePath, {
      method: req.method,
      headers: {
        'Authorization': 'Bearer ' + tokenEntry.token,
        'Content-Type': contentType
      },
      body,
      timeout: 30000
    });
    res.status(r.status);
    try { res.json(JSON.parse(r.body)); } catch (e) { res.send(r.body); }
  } catch (e) {
    res.status(502).json({ error: `Remote server unreachable: ${e.message}` });
  }
});

// Proxy WebSocket to remote server (with transparent reconnection)
app.ws('/cluster/:serverUrl/ws/:id', (localWs, req) => {
  if (!authenticateWs(localWs, req)) return;

  const serverUrl = decodeURIComponent(req.params.serverUrl);
  const clusterTokens = loadClusterTokens();
  const tokenEntry = clusterTokens[serverUrl];
  if (!tokenEntry) { localWs.close(1008, 'Not authenticated to remote'); return; }

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/' + req.params.id + '?token=' + tokenEntry.token;
  const WebSocket = require('ws');
  const sessionId = req.params.id;
  const logPfx = `Cluster proxy ${serverUrl}/ws/${sessionId.substring(0, 8)}`;

  // Disable Nagle on local side of proxy
  if (localWs._socket) localWs._socket.setNoDelay(true);

  // Mutable remote connection — replaced on reconnect
  let remoteWs = null;
  let remoteAlive = false;
  let localClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let proxyPingTimer = null;
  const buffered = [];
  const MAX_RECONNECT_ATTEMPTS = 10;
  const MAX_BUFFER_SIZE = 100;

  function connectRemote() {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false, perMessageDeflate: false });

    ws.on('open', () => {
      if (ws._socket) ws._socket.setNoDelay(true);
      remoteWs = ws;
      remoteAlive = true;
      reconnectAttempts = 0;
      const label = reconnectAttempts === 0 ? 'connected' : 'reconnected';
      console.log(`[${new Date().toISOString()}] ${logPfx}: ${label}`);
      // Flush buffered input
      for (const b of buffered) {
        try { ws.send(b.msg, { binary: b.isBinary }); } catch (e) {}
      }
      buffered.length = 0;
      // Ask the local client (browser) to re-send its resize dimensions so
      // the remote PTY matches the client's terminal size after reconnect.
      // Sending this to the remote would get it written to the PTY as input.
      try { localWs.send(JSON.stringify({ requestResize: true })); } catch (e) {}
      startProxyPing();
    });

    ws.on('message', (data, isBinary) => {
      if (localClosed) return;
      try { localWs.send(data, { binary: isBinary }); } catch (e) {}
    });

    ws.on('pong', () => { remoteAlive = true; });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[${new Date().toISOString()}] ${logPfx}: remote closed (${code} ${reasonStr})`);
      stopProxyPing();
      // Session-level closes: don't reconnect, propagate to browser
      if (code === 4000 || code === 4001) {
        try { localWs.close(code, reason); } catch (e) {}
        return;
      }
      // Unexpected close: try transparent reconnect
      if (!localClosed) attemptReconnect();
    });

    ws.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] ${logPfx}: remote error: ${err.message}`);
      stopProxyPing();
      // The 'close' event will fire after 'error', which triggers reconnect
    });
  }

  function attemptReconnect() {
    if (localClosed) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log(`[${new Date().toISOString()}] ${logPfx}: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      try { localWs.close(1001, 'Remote unreachable'); } catch (e) {}
      return;
    }
    reconnectAttempts++;
    // Exponential backoff: 500ms, 1s, 2s, 4s, capped at 5s
    const delay = Math.min(5000, 500 * Math.pow(2, reconnectAttempts - 1));
    console.log(`[${new Date().toISOString()}] ${logPfx}: reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      if (!localClosed) connectRemote();
    }, delay);
  }

  // Ping remote every 20s to detect dead connections faster than the 30s server keepalive
  function startProxyPing() {
    stopProxyPing();
    proxyPingTimer = setInterval(() => {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return;
      if (!remoteAlive) {
        // Missed pong — connection is dead, force reconnect
        console.log(`[${new Date().toISOString()}] ${logPfx}: remote ping timeout, forcing reconnect`);
        try { remoteWs.terminate(); } catch (e) {}
        return;
      }
      remoteAlive = false;
      try { remoteWs.ping(); } catch (e) {}
    }, 20000);
  }

  function stopProxyPing() {
    if (proxyPingTimer) { clearInterval(proxyPingTimer); proxyPingTimer = null; }
  }

  function cleanup() {
    localClosed = true;
    stopProxyPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (remoteWs) { try { remoteWs.close(); } catch (e) {} }
  }

  // Start first connection
  connectRemote();

  localWs._wtAlive = true;
  localWs.on('pong', () => { localWs._wtAlive = true; });
  localWs.on('message', (msg, isBinary) => {
    // Absorb client heartbeats — don't forward to remote PTY
    const firstByte = Buffer.isBuffer(msg) ? msg[0] : (msg.length > 0 ? msg.charCodeAt(0) : 0);
    if (firstByte === 0x7B) {
      const str = Buffer.isBuffer(msg) ? msg.toString() : msg;
      if (str.startsWith('{"heartbeat":')) { localWs._wtAlive = true; return; }
    }
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      try { remoteWs.send(msg, { binary: isBinary }); } catch (e) {}
    } else if (buffered.length < MAX_BUFFER_SIZE) {
      buffered.push({ msg, isBinary });
    }
  });
  localWs.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ${logPfx}: local error: ${err.message}`);
    cleanup();
  });
  localWs.on('close', () => { cleanup(); });
});

// --- Git version info cache --------------------------------------------
// /api/version and /api/cluster/sessions both want the current git hash +
// staleness data. Each of them calls execSync('git ...') several times,
// and one of the calls (`git fetch --dry-run`) allows a 5s timeout which
// under network trouble blocks the Node event loop for up to 5s. Since
// peers cross-poll each other every 5s, the practical impact is severe:
// a single slow `git fetch --dry-run` on one peer blocks keystroke echo
// on every peer that cross-polls it. This was the top p99 offender.
//
// Fix: cache the expensive computation and recompute in the background.
//   - Cheap keys (hash, date, dirty, local-hash)  — refreshed every 30s.
//   - Expensive keys (behind = `git fetch --dry-run` + `rev-list`) —
//     refreshed every 5 minutes, never on the request path.
// On request we just return the cached struct synchronously. If the
// cache is empty (first call) we do a single sync call (for `hash`
// only — cheap), and schedule a full refresh. Behind=-1 until ready.
let _gitCache = null;       // { hash, date, behind, dirty, hashOnlyFallback }
let _gitCacheTime = 0;
let _gitRefreshing = false;
let _gitBehindRefreshing = false;
let _gitBehindTime = 0;
const GIT_CACHE_TTL = 30 * 1000;        // refresh cheap keys every 30s
const GIT_BEHIND_TTL = 5 * 60 * 1000;   // refresh behind every 5 min

function _gitExecAsync(cmd, args, timeoutMs) {
  // All version/update-check git calls go through the hardened runner so they
  // can never prompt for credentials (which would hang git-credential-manager
  // forever in the headless service context and leak process trees until the
  // machine OOMs). See lib/git-safe.js.
  if (cmd === 'git') {
    return execGit(args, { cwd: __dirname, timeoutMs: timeoutMs || 3000 });
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: timeoutMs || 3000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

async function _gitRefresh(includeBehind) {
  if (_gitRefreshing) return;
  _gitRefreshing = true;
  try {
    const [hash, date, dirtyRaw] = await Promise.all([
      _gitExecAsync('git', ['rev-parse', '--short', 'HEAD']),
      _gitExecAsync('git', ['log', '-1', '--format=%ci']),
      _gitExecAsync('git', ['status', '--porcelain']),
    ]);
    let behind = _gitCache ? _gitCache.behind : -1;
    if (includeBehind && !_gitBehindRefreshing) {
      _gitBehindRefreshing = true;
      try {
        // git fetch --dry-run with 5s timeout — in background so it NEVER
        // blocks the request path. Once it returns, the cached `behind`
        // updates and subsequent responses pick it up.
        const fetchOk = await _gitExecAsync('git', ['fetch', '--dry-run'], 5000);
        if (fetchOk !== null) {
          const count = await _gitExecAsync('git', ['rev-list', 'HEAD..@{u}', '--count']);
          behind = (count != null && count !== '') ? (parseInt(count) || 0) : 0;
          _gitBehindTime = Date.now();
        } else {
          behind = -1;
        }
      } finally {
        _gitBehindRefreshing = false;
      }
    }
    _gitCache = {
      hash: hash || 'unknown',
      date: date || '',
      behind,
      dirty: (dirtyRaw || '').length > 0,
    };
    _gitCacheTime = Date.now();
  } finally {
    _gitRefreshing = false;
  }
}

function _getGitInfo() {
  // Kick off a refresh if stale (non-blocking).
  const now = Date.now();
  const cheapStale = !_gitCache || (now - _gitCacheTime) > GIT_CACHE_TTL;
  const behindStale = !_gitCache || (now - _gitBehindTime) > GIT_BEHIND_TTL;
  if (cheapStale || behindStale) {
    // Fire and forget. Will complete within a few hundred ms typically,
    // up to the fetch-dry-run 5s timeout for the `behind` calc.
    _gitRefresh(behindStale).catch(() => {});
  }
  if (_gitCache) return _gitCache;
  // Cold start: no cached value at all. Do ONE cheap sync call (git rev-parse
  // is fast — ~50ms typical — and the alternative is reporting `unknown`
  // forever until the first async refresh lands, which is awkward for the
  // UI. Behind=-1 until the async refresh arrives.
  try {
    const { execSync } = require('child_process');
    const hash = execSync(`git ${gitSafeArgs(['rev-parse', '--short', 'HEAD']).join(' ')}`, { cwd: __dirname, encoding: 'utf8', windowsHide: true, env: gitSafeEnv() }).trim();
    _gitCache = { hash, date: '', behind: -1, dirty: false };
    _gitCacheTime = Date.now();
  } catch {
    _gitCache = { hash: 'unknown', date: '', behind: -1, dirty: false };
  }
  return _gitCache;
}

// Helper: fetch with timeout (works with http and https)
function clusterFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const timeout = opts.timeout || 5000;

    const reqOpts = {
      method: opts.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: Object.assign({}, opts.headers || {}),
      rejectUnauthorized: false // Tailscale certs are valid but we're lenient
    };
    if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);

    const r = lib.request(reqOpts, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body }));
    });

    r.setTimeout(timeout, () => { r.destroy(); reject(new Error('Timeout')); });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// --- API: version info (for cluster version checking) ---
// Reads from the 30s cache so the endpoint never blocks. See _getGitInfo()
// for the caching strategy. Peer cross-polling (every 5s from each browser)
// previously drove `git fetch --dry-run` on the hot path which blocked the
// event loop for up to 5s under network trouble.
app.get('/api/version', (req, res) => {
  const info = _getGitInfo();
  // G8: features this server implements, so the companion app can gate per
  // server during a rolling upgrade (never assume a homogeneous fleet). The
  // device registry is always available; 'fcm' is advertised only when a
  // service account is configured (or the test sink is active) — a server with
  // no FCM key can still take registrations but won't send FCM.
  const capabilities = ['attention', 'clear', 'attention-clear', 'push-devices', 'transcript', 'status-metrics', 'pending-question', 'subagent-trace'];
  if (fcmConfigured()) capabilities.push('fcm');
  res.json({
    version: SERVER_VERSION,
    hash: info.hash,
    date: info.date,
    behind: info.behind,
    dirty: info.dirty,
    serverName: getServerName(),
    capabilities,
  });
});

// --- API: upload image, return path for bracketed-paste insert ---
// Claude Code's paste handler detects absolute image paths in pasted text and
// reads the file directly via readFileBytesSync, so we don't touch the Windows
// clipboard at all — that path was unreliable and only worked locally. The
// path-paste flow works for remote cluster sessions too: the request hits the
// remote server, the file is saved on the remote disk, and the remote Claude
// Code reads its own local file.
app.post('/api/clipboard-image', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  try {
    const ct = req.headers['content-type'] || 'image/png';
    const ext = ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '.png';
    const filename = `clip-${Date.now()}${ext}`;
    const filepath = path.join(CLIPBOARD_DIR, filename);
    fs.writeFileSync(filepath, req.body);
    res.json({ ok: true, path: filepath });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: list sessions ---
app.get('/api/sessions', async (req, res) => {
  try {
    const { sessions: list } = await workerClient.rpc('listSessions');
    const shaped = list.map(s => ({
      id: s.id, name: s.name, cwd: s.cwd,
      clients: s.clients || 0, pid: s.pid, status: s.status,
      lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
      claudeSessionId: s.claudeSessionId,
      notifyLevel: getNotifyLevel(s.id),
      metrics: getStatusMetrics(s.claudeSessionId),
    }));
    // Log when a remote server fetches our sessions (Bearer = cluster call).
    // Throttled to avoid hammering the disk: only logs on change or after
    // CLUSTER_LOG_MIN_GAP_MS. Without this, peer polling produces multiple
    // log lines per second and stalls the event loop on synchronous fs writes.
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const summary = shaped.map(s => {
        const ageMins = s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 60000) : '?';
        return `"${s.name}"(${s.status}, ${ageMins}m ago, ${s.clients} clients)`;
      }).join(', ');
      _throttledClusterLog('served', `${shaped.length}|${summary}`,
        (ts) => `[${ts}] Sessions served to cluster caller: ${shaped.length} sessions: ${summary}`);
    }
    res.json(shaped);
  } catch (e) {
    console.error('listSessions failed:', e.message);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// --- Test helper: artificially age a session's lastActivity (test mode only) ---
if (process.env.WT_TEST) {
  app.post('/api/test/age-session/:id', express.json(), async (req, res) => {
    const ageMinutes = req.body?.ageMinutes || 10;
    const aged = Date.now() - (ageMinutes * 60 * 1000);
    // #37: allow aging each clock independently so a test can leave one fresh —
    // e.g. hookOnly ages lastHookActivity (stale hook) while lastActivity (PTY
    // output) stays recent, the exact "busy build/subagent" case.
    const rpcArgs = { id: req.params.id };
    if (req.body?.hookOnly) {
      rpcArgs.lastHookActivity = aged;
    } else if (req.body?.activityOnly) {
      rpcArgs.lastActivity = aged;
    } else {
      rpcArgs.lastActivity = aged;
      rpcArgs.lastHookActivity = aged;
    }
    try {
      const result = await workerClient.rpc('ageSession', rpcArgs);
      res.json({ ok: true, aged, ...rpcArgs, ...result });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'session not found' });
      res.status(500).json({ error: e.message });
    }
  });
}

// --- API: execute command and return output ---
// M3: opt-in (enableRemoteExec config key, default false), per-token sliding-window
// rate limit (30/min), audit logged to logs/exec-audit.log. The route is only
// registered when the feature is enabled, so it returns 404 when disabled.
const EXEC_RATE_MAX = 30;               // 30 calls/min/token
const EXEC_RATE_WINDOW_MS = 60 * 1000;  // 1 minute
const _execRateBuckets = new Map();     // identity -> [timestamps...]

function _execRateCheck(identity) {
  const now = Date.now();
  let arr = _execRateBuckets.get(identity);
  if (!arr) { arr = []; _execRateBuckets.set(identity, arr); }
  // Drop timestamps outside the sliding window.
  while (arr.length && arr[0] <= now - EXEC_RATE_WINDOW_MS) arr.shift();
  if (arr.length >= EXEC_RATE_MAX) {
    const retryMs = EXEC_RATE_WINDOW_MS - (now - arr[0]);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  arr.push(now);
  return { allowed: true };
}

const EXEC_AUDIT_FILE = process.env.WT_EXEC_AUDIT_FILE || path.join(__dirname, 'logs', 'exec-audit.log');
const EXEC_AUDIT_DIR = path.dirname(EXEC_AUDIT_FILE);
function _execAudit(entry) {
  // Tolerate log-write errors — never fail the request because of logging.
  try {
    try { fs.mkdirSync(EXEC_AUDIT_DIR, { recursive: true }); } catch {}
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(EXEC_AUDIT_FILE, line, 'utf8');
  } catch (e) {
    try { console.warn('[exec-audit] write failed:', e.message); } catch {}
  }
}

function _registerExecRoute() {
  app.post('/api/exec', express.json({ limit: '64kb' }), (req, res) => {
    const auth = req._wtAuth || { identity: 'unknown', label: 'unknown' };
    const rl = _execRateCheck(auth.identity);
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: 'rate limit exceeded (30 calls/min/token)' });
    }
    const command = req.body?.command;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command is required' });
    }
    if (command.length > 4096) {
      return res.status(400).json({ error: 'command too long (max 4096 chars)' });
    }
    const cwd = req.body?.cwd ? String(req.body.cwd).substring(0, 260) : undefined;
    const timeout = Math.min(Math.max(parseInt(req.body?.timeout) || 30000, 1000), 120000);

    const cmdSha256 = crypto.createHash('sha256').update(command).digest('hex');
    const clientIp = (req.ip || req.connection?.remoteAddress || '').toString();
    const startedAt = Date.now();

    const child = execFile(SHELL, ['-c', command], {
      cwd: cwd || DEFAULT_CWD,
      timeout,
      maxBuffer: 1024 * 1024,
      env: buildSafeEnv(),
      windowsHide: true
    }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code === 'ETIMEDOUT' ? -1 : (err.code || 1)) : 0;
      _execAudit({
        ts: new Date(startedAt).toISOString(),
        label: auth.label,
        cmdSha256,
        clientIp,
        exitCode,
        durationMs: Date.now() - startedAt,
      });
      res.json({ stdout, stderr, exitCode });
    });
  });
}

const _execEnabled = (liveConfig('enableRemoteExec', false) === true) || process.env.WT_ENABLE_REMOTE_EXEC === '1';
if (_execEnabled) {
  _registerExecRoute();
  console.log(`[${new Date().toISOString()}] /api/exec is ENABLED (enableRemoteExec=true) — rate-limited 30/min/token, audited to logs/exec-audit.log`);
}

// --- API: create session ---
const MAX_SESSIONS = config.maxSessions || 10;
const DEDUP_WINDOW_MS = 2000; // reject duplicate name+cwd within 2 seconds
let _lastSessionCreate = { name: '', cwd: '', time: 0 };
app.post('/api/sessions', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { sessions: existing } = await workerClient.rpc('listSessions');
    if (existing.length >= MAX_SESSIONS) {
      return res.status(429).json({ error: `Session limit reached (max ${MAX_SESSIONS})` });
    }
    const id = crypto.randomUUID();
    const liveCwd = getDefaultCwd();
    let cwd = String(req.body?.cwd || liveCwd).substring(0, 260);
    const name = String(req.body?.name || `Session ${existing.length + 1}`).substring(0, 100).replace(/[\x00-\x1f]/g, '');
    const autoCommand = String(req.body?.autoCommand || getDefaultCommand() || '').substring(0, 500);
    // Deduplicate rapid session creation (same name + cwd within time window)
    const now = Date.now();
    if (name === _lastSessionCreate.name && cwd === _lastSessionCreate.cwd && now - _lastSessionCreate.time < DEDUP_WINDOW_MS) {
      return res.status(409).json({ error: 'Duplicate session — please wait before creating another with the same name and folder' });
    }
    _lastSessionCreate = { name, cwd, time: now };
    // Verify cwd exists — return error if user specified a bad path
    try {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        if (req.body?.cwd) return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
        cwd = liveCwd;
      }
    } catch (e) {
      if (req.body?.cwd) return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
      cwd = liveCwd;
    }
    const created = await workerClient.rpc('createSession', { id, cwd, name, autoCommand });
    invalidateClusterSessionsCache(); // new session must show in the sidebar immediately
    res.json({ id: created.id, name: created.name });
  } catch (e) {
    console.error(`Failed to create session: ${e.message}`);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// --- API: update session (rename, change autoCommand) ---
app.patch('/api/sessions/:id', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    // Verify session exists.
    let current;
    try { current = await workerClient.rpc('getSession', { id: req.params.id }); }
    catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    const newName = req.body?.name ? String(req.body.name).substring(0, 100).replace(/[\x00-\x1f]/g, '') : null;
    if (newName) await workerClient.rpc('renameSession', { id: req.params.id, name: newName });
    let autoCommand = current.autoCommand;
    if (req.body?.autoCommand !== undefined) {
      const r = await workerClient.rpc('updateSessionAutoCommand', {
        id: req.params.id,
        autoCommand: String(req.body.autoCommand).substring(0, 500),
      });
      autoCommand = r.autoCommand;
    }
    if (newName || req.body?.autoCommand !== undefined) invalidateClusterSessionsCache();
    res.json({ id: req.params.id, name: newName || current.name, autoCommand });
  } catch (e) {
    console.error(`PATCH /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// --- API: per-session push (ntfy) level ---
app.get('/api/sessions/:id/notify-level', (req, res) => {
  res.json({ id: req.params.id, level: getNotifyLevel(req.params.id) });
});
app.patch('/api/sessions/:id/notify-level', express.json({ limit: '1kb' }), (req, res) => {
  const level = req.body?.level;
  if (!notifyPush.LEVELS.includes(level)) {
    return res.status(400).json({ error: 'level must be one of ' + notifyPush.LEVELS.join(', ') });
  }
  res.json({ id: req.params.id, level: setNotifyLevel(req.params.id, level) });
});
// Structured "what needs my attention" for one session: the last recorded
// attention event (kind/reason) plus Claude's freshly-read last message. Lets a
// companion app or voice layer pull the real content over the private network,
// so the push relay can stay content-free (ntfy.includeContent=false). Behind
// the same auth as the other session routes; never cached.
app.get('/api/sessions/:id/attention', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const st = _notifyState.get(req.params.id) || {};
  res.json(notifyPush.buildAttentionResponse({
    id: req.params.id,
    serverName: getServerName(),
    lastAttention: st.lastAttention,
    lastMessage: transcript.lastAssistantText(st.transcriptPath),
  }));
});

// POST /api/sessions/:id/attention/clear — a device opened/viewed the session or
// dismissed its alert (#24). Clears the attention EVERYWHERE: flips the recorded
// attention to cleared (so /attention reflects it), fans out an FCM 'clear' so
// every phone auto-dismisses its OS notification, and broadcasts a 'clear' frame
// to the live notify sockets so other in-app viewers drop the attention chip.
// Idempotent — clearing an already-clear (or attention-less) session is a no-op.
app.post('/api/sessions/:id/attention/clear', (req, res) => {
  const id = req.params.id;
  pushNotify('clear', { id }); // flips lastAttention.cleared + FCM 'clear' dispatch
  const payload = JSON.stringify({ notification: { type: 'clear', sessionId: id, cleared: true } });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
  res.json({ ok: true });
});
// --- G5: structured transcript for the companion chat view ---
// GET /api/sessions/:id/transcript?before=<cursor>&limit=<n>
// Returns the session's Claude conversation as typed turns (newest-LAST), paged
// BACKWARD: no `before` → the last `limit` turns (default 50, cap 200); a
// `before=<cursor>` → the `limit` turns preceding that opaque cursor (base64 of a
// line-start byte offset). Response: { messages, cursor, hasMore }; cursor is null
// once the file start is reached. The parser lives SERVER-side (lib/transcript.js)
// so JSONL schema drift is a server fix, not an app release. Serves full Claude
// content, so: behind the same /api auth middleware as every session route; the
// file path comes ONLY from the validated stash (or a re-validated derivation),
// never from the request; Cache-Control: no-store. Reads only the chunks a page
// needs — a tens-of-MB transcript costs a few 256KB reads, not a full-file load.
app.get('/api/sessions/:id/transcript', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  // Validate `limit`: positive integer, capped at 200 (the parser caps too).
  let limit = transcript.DEFAULT_PAGE;
  if (req.query.limit != null && req.query.limit !== '') {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
    limit = Math.min(transcript.MAX_PAGE, n);
  }

  // Validate `before`: opaque cursor → non-negative byte offset. Garbage → 400.
  let before = null;
  if (req.query.before != null && req.query.before !== '') {
    before = transcript.decodeCursor(String(req.query.before));
    if (before == null) return res.status(400).json({ error: 'invalid cursor' });
  }

  // Resolve the transcript path (stash → validated derivation; SSOT helper).
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  let fd;
  try {
    const size = fs.statSync(tpath).size;
    // A stale cursor past EOF just reads the tail rather than erroring.
    if (before != null && before > size) before = size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
    const { turns, cursor, hasMore } = transcript.scanTurnsBackward(readChunk, size, { before, limit });
    // Stamp each Task tool_use that has a spawned subagent with a light stub so the
    // chat view can show a running dot + offer to drill in (via /subagent below).
    // Best-effort: any failure just leaves the flat Task cards as-is.
    try {
      const idx = buildSubagentIndex(subagentDirForTranscript(tpath));
      if (idx.size) {
        const resolved = resolvedIdsTail(tpath);
        transcript.attachSubagentStubs(turns, (tid) => idx.get(tid) || null, (tid) => resolved.has(tid));
      }
    } catch {}
    res.json({ messages: turns, cursor, hasMore });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/transcript failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
});

// --- chat-mode subagent trace: drill into ONE subagent's transcript -----------
// GET /api/sessions/:id/subagent/:toolUseId?before=<cursor>&limit=<n>
// A Task tool_use in /transcript carries a { agentType, description, running }
// stub when it spawned a subagent; this lazily pages that subagent's OWN transcript
// (newest-LAST, same backward cursor as /transcript) so the chat view can show the
// subagent's nested tool calls — the chat-native equivalent of the terminal's
// arrow-navigable subagent panel. :toolUseId is only ever a lookup KEY into the
// meta index built from real dir entries — the agent .jsonl path is never
// constructed from the request — and the resolved file is re-validated through
// safeTranscriptPath (.jsonl strictly under the Claude projects root), so this
// route can read nothing the stash/derivation couldn't. Nested Task tool_uses in
// the response carry their own stubs (all subagents share one flat subagents dir),
// so the client drills deeper via the same endpoint. Cache-Control: no-store.
app.get('/api/sessions/:id/subagent/:toolUseId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  const toolUseId = req.params.toolUseId;

  // Same limit/before validation as /transcript.
  let limit = transcript.DEFAULT_PAGE;
  if (req.query.limit != null && req.query.limit !== '') {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
    limit = Math.min(transcript.MAX_PAGE, n);
  }
  let before = null;
  if (req.query.before != null && req.query.before !== '') {
    before = transcript.decodeCursor(String(req.query.before));
    if (before == null) return res.status(400).json({ error: 'invalid cursor' });
  }

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  // Resolve the subagent file via the meta index (toolUseId is a key, not a path),
  // then re-validate it through the same .jsonl-under-projects-root trust chain.
  const entry = buildSubagentIndex(subagentDirForTranscript(tpath)).get(toolUseId);
  const file = entry ? safeTranscriptPath(entry.file) : '';
  if (!file) return res.status(404).json({ error: 'no subagent for tool_use' });

  let fd;
  try {
    const size = fs.statSync(file).size;
    if (before != null && before > size) before = size;
    fd = fs.openSync(file, 'r');
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
    const { turns, cursor, hasMore } = transcript.scanTurnsBackward(readChunk, size, { before, limit });
    // Deeper nesting: a subagent can itself spawn subagents (all in the same flat
    // subagents dir), so stamp nested Task tool_uses too — resolved-set from THIS
    // subagent's tail (its nested tool_results live in its own transcript).
    try {
      const idx = buildSubagentIndex(subagentDirForTranscript(tpath));
      const resolved = resolvedIdsTail(file);
      transcript.attachSubagentStubs(turns, (tid) => idx.get(tid) || null, (tid) => resolved.has(tid));
    } catch {}
    // This subagent is running iff the PARENT transcript has no tool_result for its
    // Task tool_use id yet (same signal the /transcript stub used).
    const running = !resolvedIdsTail(tpath).has(toolUseId);
    res.json({ agentType: entry.agentType, description: entry.description, running, messages: turns, cursor, hasMore });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/subagent/${toolUseId} failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read subagent transcript' });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
});

// GET /api/sessions/:id/pending-question  (#19)
// The newest UNanswered AskUserQuestion prompt for the session, as structured
// JSON pulled from the transcript (questions/options/multiSelect), so the app
// can render a native question overlay instead of forcing the user to drive
// Claude's TUI selector. { pending: false } when there's nothing to answer.
// Same path-resolution + Cache-Control: no-store contract as /transcript.
app.get('/api/sessions/:id/pending-question', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  // Prefer the LIVE question captured from the PreToolUse hook — it's present
  // while the prompt is on screen, unlike the transcript (which only gets the
  // tool_use after the answer). The transcript scan below stays as a fallback.
  const live = (_notifyState.get(id) || {}).pendingQuestion;
  if (live) return res.json({ pending: true, question: live });
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });
  try {
    const size = fs.statSync(tpath).size;
    const TAIL = 262144; // 256KB tail — a pending question is the last tool_use
    const start = Math.max(0, size - TAIL);
    const len = size - start;
    let text = '';
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tpath, 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      text = buf.toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    }
    const q = transcript.pendingQuestion(text);
    res.json(q ? { pending: true, question: q } : { pending: false });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/pending-question failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  }
});
// Manual verification: fire a sample push (force past the level gate). Returns
// whether ntfy is configured so the UI can tell you if setup is missing.
app.post('/api/notify-test', express.json({ limit: '1kb' }), async (req, res) => {
  const name = req.body?.name ? String(req.body.name).slice(0, 100) : 'Test';
  await pushNotify('approval', { id: 'notify-test', name, reason: 'ntfy test — if you see this on your phone, it works ✅', force: true });
  res.json({ ok: true, configured: !!ntfyConfig() });
});

// --- API: FCM device registry (G1) ---
// The companion app POSTs its FCM token here on startup / onNewToken / foreground
// / network-regain (to every server). Behind the same auth as other API routes.
// Registry file is gitignored; tokens are semi-sensitive and never echoed in full.
app.post('/api/push/devices', express.json({ limit: '8kb' }), (req, res) => {
  // Validation/normalization is pure logic in lib/fcm.js (unit-tested).
  const v = fcm.normalizeDeviceRegistration(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { token, deviceName, platform } = v.device;
  const devices = loadPushDevices();
  const existing = devices.find(d => d.token === token);
  // Cap the registry so a runaway client can't grow it without bound. Upsert of
  // an existing token is always allowed; a NEW token is refused at the cap.
  if (!fcm.canRegisterDevice(devices.length, !!existing)) {
    return res.status(400).json({ error: `device registry full (max ${fcm.MAX_DEVICES})` });
  }
  if (existing) {
    // Upsert by token: keep the original registeredAt, refresh name/platform.
    existing.deviceName = deviceName;
    existing.platform = platform;
  } else {
    devices.push({ token, deviceName, platform, registeredAt: Date.now() });
  }
  savePushDevices(devices);
  res.json({ ok: true, count: devices.length });
});
app.delete('/api/push/devices/:token', (req, res) => {
  const token = req.params.token;
  const devices = loadPushDevices();
  const idx = devices.findIndex(d => d.token === token);
  if (idx === -1) return res.status(404).json({ error: 'device not found' });
  devices.splice(idx, 1);
  savePushDevices(devices);
  res.json({ ok: true, count: devices.length });
});
app.get('/api/push/devices', (req, res) => {
  res.json(loadPushDevices().map(d => ({
    token: fcm.truncateToken(d.token), // display only — never the full token
    deviceName: d.deviceName || '',
    platform: d.platform || 'android',
    registeredAt: d.registeredAt || null,
  })));
});

// Test-only: drain the FCM sink (captured sends). Registered only under
// WT_FCM_TEST so it can never exist in production. Behind auth (declared here,
// after the auth middleware). Reading clears the sink.
if (process.env.WT_FCM_TEST) {
  app.get('/api/push/test-sink', (req, res) => {
    const items = _FCM_SINK.slice();
    _FCM_SINK.length = 0;
    res.json({ items });
  });
}
// Test-only: drain the ntfy sink (captured ntfy publishes). Registered only under
// WT_NTFY_TEST. Lets an integration test inspect the exact ntfy message body
// (e.g. that includeContent=false omits Claude's content). Behind auth; reading
// clears the sink.
if (process.env.WT_NTFY_TEST) {
  app.get('/api/push/ntfy-test-sink', (req, res) => {
    const items = _NTFY_SINK.slice();
    _NTFY_SINK.length = 0;
    res.json({ items });
  });
}

// --- API: reorder sessions ---
// Body: { orderedIds: string[] } — applied as the new in-memory + on-disk order.
// Idempotent. Unknown ids are silently dropped; live sessions not in the list
// are appended in their existing order (race-safe for concurrent creates).
app.post('/api/sessions/order', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const orderedIds = req.body?.orderedIds;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    if (orderedIds.length > 1000) return res.status(400).json({ error: 'orderedIds too long' });
    if (!orderedIds.every(id => typeof id === 'string' && id.length <= 64)) {
      return res.status(400).json({ error: 'orderedIds must be strings <= 64 chars' });
    }
    const result = await workerClient.rpc('reorderSessions', { orderedIds });
    invalidateClusterSessionsCache(); // reflect the new order in the sidebar immediately
    res.json(result);
  } catch (e) {
    console.error(`POST /api/sessions/order failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to reorder sessions' });
  }
});

// --- API: kill session ---
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    // Verify session exists before delete so we return 404 properly.
    try { await workerClient.rpc('getSession', { id: req.params.id }); }
    catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    await workerClient.rpc('killSession', { id: req.params.id });
    invalidateClusterSessionsCache(); // removed session must drop from the sidebar immediately
    res.json({ ok: true });
  } catch (e) {
    console.error(`DELETE /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to kill session' });
  }
});

// --- API: ranged scrollback (browser backfill on scroll-to-top) ---
// Offsets and lengths are in JavaScript string units (UTF-16 code units),
// matching what the worker returns from getScrollback after decoding.
const SCROLLBACK_RANGE_MAX = 524288;
app.get('/api/sessions/:id/scrollback', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 32768;
  if (limit > SCROLLBACK_RANGE_MAX) limit = SCROLLBACK_RANGE_MAX;
  if (!Number.isFinite(offset)) return res.status(400).json({ error: 'bad offset' });
  try {
    let full;
    try {
      const r = await workerClient.rpc('getScrollback', { id: req.params.id, limit: 4 * 1024 * 1024 });
      // Sanitize identically to the attach replay path so scroll-up backfill
      // can't re-introduce terminal queries (DA/DSR) and so offsets computed
      // here stay consistent with the sanitized initial replay.
      full = sanitizeReplay((r && r.data) || '');
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    const total = full.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    res.json({ data: full.slice(start, end), total, offset: start, limit: end - start });
  } catch (e) {
    console.error(`GET /api/sessions/:id/scrollback failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read scrollback' });
  }
});

// --- Folder list (live scan of the configured "dev" folders) ---
function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// Returns the folders offered in the New Session dialog. This is a live,
// dynamic scan of the configured scanFolders on every request — no history,
// no memory, no caching. The list always reflects the actual current
// filesystem content, so a folder created/removed under a scan root shows
// up (or disappears) the next time the dialog is opened. Cluster peers each
// serve their own scan against their own disk (the request is proxied per
// server), so switching servers reflects that server's real folders.
app.get('/api/history/folders', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const scanned = new Set();
  for (const baseDir of getScanFolders()) {
    try {
      if (dirExists(baseDir)) scanned.add(baseDir);
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'));
      for (const d of dirs) scanned.add(path.join(baseDir, d.name));
    } catch (e) {}
  }
  res.json([...scanned]);
});

// --- Decode Claude project directory name to actual path ---
function decodeProjectPath(project) {
  // e.g. "C--dev-web-terminal" -> try "C:\dev\web-terminal", "C:\dev\web\terminal", etc.
  // Claude's encoder turns both path separators (\) and underscores (_) into hyphens (-),
  // so we must try both joiners when reconstructing the path.
  const driveMatch = project.match(/^([A-Z])-(.*)$/);
  if (!driveMatch) return project.replace(/-/g, '\\');

  const drive = driveMatch[1] + ':\\';
  const rest = driveMatch[2];
  const cleanRest = rest.replace(/^-/, '');

  const parts = cleanRest.split('-');

  let current = drive;
  let i = 0;
  while (i < parts.length) {
    let found = false;
    // Try joining increasingly more parts — check both hyphen and underscore joins
    for (let j = parts.length; j > i; j--) {
      const seg = parts.slice(i, j);
      const candidates = [seg.join('-')];
      if (seg.length > 1) candidates.push(seg.join('_'));
      for (const candidate of candidates) {
        const candidatePath = path.join(current, candidate);
        try {
          if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
            current = candidatePath;
            i = j;
            found = true;
            break;
          }
        } catch (e) {}
      }
      if (found) break;
    }
    if (!found) {
      current = path.join(current, parts[i]);
      i++;
    }
  }
  return current;
}

// --- Claude sessions scanner ---
app.get('/api/claude-sessions', (req, res) => {
  try {
    if (!fs.existsSync(getClaudeProjectsDir())) return res.json([]);

    const projects = fs.readdirSync(getClaudeProjectsDir(), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const customNames = loadClaudeSessionNames();
    const allSessions = [];
    for (const project of projects) {
      const projectDir = path.join(getClaudeProjectsDir(), project);
      // Decode project path: C--dev-my-project -> C:\dev\my_project
      // The encoding is lossy (hyphens in folder names look like path separators),
      // so we try the decoded path and fall back to checking the filesystem.
      const projectPath = decodeProjectPath(project);

      let files;
      try {
        files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const stat = fs.statSync(path.join(projectDir, f));
            return { file: f, id: f.replace('.jsonl', ''), mtime: stat.mtimeMs, size: stat.size };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5); // last 5 sessions per project
      } catch (e) { continue; }

      for (const f of files) {
        // Skip tiny files (< 1KB) — likely empty or failed sessions
        if (f.size < 1024) continue;

        // Skip sessions older than 14 days — unlikely to resume
        if (Date.now() - f.mtime > 14 * 24 * 60 * 60 * 1000) continue;

        // Read first user message as summary, verify session has assistant response
        let summary = '';
        let hasUserMessage = false;
        let hasAssistantResponse = false;
        let permissionMode = '';
        let sessionTitle = '';
        try {
          const lines = fs.readFileSync(path.join(projectDir, f.file), 'utf8').split('\n');
          for (const line of lines.slice(0, 80)) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.permissionMode && !permissionMode) permissionMode = obj.permissionMode;
            if (obj.slug && !sessionTitle) sessionTitle = obj.slug.replace(/-/g, ' ');
            if (obj.type === 'user' && obj.message?.content && !hasUserMessage) {
              hasUserMessage = true;
              summary = typeof obj.message.content === 'string'
                ? obj.message.content.substring(0, 120)
                : JSON.stringify(obj.message.content).substring(0, 120);
            }
            if (obj.type === 'assistant') hasAssistantResponse = true;
            if (hasUserMessage && hasAssistantResponse && permissionMode && sessionTitle) break;
          }
        } catch (e) {}

        // Skip sessions with no real conversation
        if (!hasUserMessage || !hasAssistantResponse) continue;

        allSessions.push({
          id: f.id,
          project,
          projectPath,
          sessionTitle: customNames[f.id] || sessionTitle || '',
          summary: summary.replace(/[\n\r]+/g, ' ').trim(),
          lastModified: f.mtime,
          sizeKB: Math.round(f.size / 1024),
          skipPermissions: permissionMode === 'bypassPermissions'
        });
      }
    }

    // Sort all by last modified, return top 20
    allSessions.sort((a, b) => b.lastModified - a.lastModified);
    res.json(allSessions.slice(0, 20));
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: delete a claude session file ---
app.delete('/api/claude-sessions/:project/:id', (req, res) => {
  // Sanitize to prevent path traversal
  const project = path.basename(req.params.project);
  const id = path.basename(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(getClaudeProjectsDir(), project, id + '.jsonl');
  // Verify the resolved path is still under getClaudeProjectsDir()
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return res.json({ ok: true });
    }
    res.status(404).json({ error: 'not found' });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: rename a claude session ---
app.patch('/api/claude-sessions/:id', express.json(), (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const names = loadClaudeSessionNames();
  names[id] = name;
  saveClaudeSessionNames(names);
  res.json({ ok: true });
});

// --- API: export a claude session file (for transfer) ---
app.get('/api/claude-sessions/:project/:id/export', (req, res) => {
  const project = path.basename(req.params.project);
  const id = path.basename(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(getClaudeProjectsDir(), project, id + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(file, 'utf8');
    res.json({ project, id, content, size: content.length });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: import a claude session file (from transfer) + optionally create terminal session ---
app.post('/api/claude-sessions/import', express.json({ limit: '50mb' }), async (req, res) => {
  const { project, id, content, autoResume, name, skipPermissions } = req.body || {};
  if (!project || !id || !content) {
    return res.status(400).json({ error: 'Missing project, id, or content' });
  }
  const safeProject = path.basename(String(project));
  const safeId = path.basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
  const projectDir = path.join(getClaudeProjectsDir(), safeProject);
  const file = path.join(projectDir, safeId + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[${new Date().toISOString()}] Imported claude session ${safeProject}/${safeId} (${content.length} bytes)`);

    // Optionally create a terminal session to resume this claude session
    if (autoResume) {
      const projectPath = decodeProjectPath(safeProject);
      let cwd = projectPath;
      try { if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) cwd = getDefaultCwd(); } catch (e) { cwd = getDefaultCwd(); }
      let cmd = 'claude --resume ' + safeId;
      if (skipPermissions) cmd += ' --dangerously-skip-permissions';
      const sessionId = crypto.randomUUID();
      const sessionName = String(name || projectPath.split(path.sep).filter(Boolean).pop() || 'Transferred');
      await workerClient.rpc('createSession', {
        id: sessionId, cwd, name: sessionName.substring(0, 100), autoCommand: cmd,
      });
      return res.json({ ok: true, sessionId, name: sessionName });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: restart server ---
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Restarting...' });
  console.log(`[${new Date().toISOString()}] Restart requested via API`);
  setTimeout(async () => {
    try { await workerClient.rpc('flushState'); } catch (e) {}
    const { execSync } = require('child_process');
    // Pull latest code before restarting. Hardened so a broken HTTPS remote
    // credential can't hang git-credential-manager and leak process trees.
    try { execSync(`git ${gitSafeArgs(['pull', '--ff-only']).join(' ')}`, { cwd: __dirname, timeout: 15000, windowsHide: true, env: gitSafeEnv() }); } catch (e) {
      console.error(`[${new Date().toISOString()}] git pull failed: ${e.message}`);
    }
    // Use PM2 if available, otherwise fallback to spawn
    try {
      execSync('pm2 restart web-terminal', { cwd: __dirname, timeout: 10000, windowsHide: true });
    } catch (e) {
      // PM2 not available — fallback to old spawn method
      const { spawn } = require('child_process');
      const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();
      process.exit(0);
    }
  }, 500);
});

// --- Landing page ---
// Serve app.html with cache-busting headers AND a server-version stamp so the
// client can tell if it's running stale JS. Without these, browsers used
// heuristic freshness (~10% of file age) and held an old app.html for minutes
// even after a deploy + click-the-refresh-button.
function _readAppHtml() {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8'); }
  catch { return null; }
  // Replace the CLIENT_VERSION placeholder with the live server version so the
  // toolbar shows the actual deployed app revision, not a hardcoded constant.
  return html.replace(
    /const CLIENT_VERSION = '[^']*';/,
    `const CLIENT_VERSION = '${SERVER_VERSION}';`
  );
}
function _serveApp(req, res) {
  const html = _readAppHtml();
  if (!html) return res.status(500).send('app.html unreadable');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
app.get('/', _serveApp);
app.get('/app', _serveApp);
app.get('/app/:id', _serveApp);
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'lobby.html'));
});

// --- Terminal page ---
app.get('/s/:id', async (req, res) => {
  try {
    await workerClient.rpc('getSession', { id: req.params.id });
    res.sendFile(path.join(__dirname, 'terminal.html'));
  } catch (e) {
    res.redirect('/');
  }
});

// --- WebSocket: global notifications (all sessions) ---
app.ws('/ws/notify', (ws, req) => {
  if (!authenticateWs(ws, req)) return;
  notifyClients.add(ws);
  ws._wtAlive = true;
  ws.on('pong', () => { ws._wtAlive = true; });
  ws.on('error', () => { notifyClients.delete(ws); });
  ws.on('close', () => notifyClients.delete(ws));
});

// --- WebSocket: attach to session ---
app.ws('/ws/:id', (ws, req) => {
  if (!authenticateWs(ws, req, { expectedSid: req.params.id })) return;
  const id = req.params.id;

  // Disable Nagle — send each PTY output chunk immediately
  if (ws._socket) ws._socket.setNoDelay(true);

  const clientsSet = getSessionClients(id);
  let attached = false;
  const pendingMessages = []; // messages received before attach completes

  // Set up message/close handlers IMMEDIATELY so early mode messages aren't dropped.
  ws._wtAlive = true;
  ws._wtBackground = true;   // default until mode message arrives
  ws._wtBrowserId = null;
  ws.on('pong', () => { ws._wtAlive = true; });
  ws.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] WS error session ${id}: ${err.message}`);
  });

  function handleMessage(msg) {
    if (Buffer.isBuffer(msg)) msg = msg.toString();
    if (msg.length > 65536) return;
    if (msg.charCodeAt(0) === 0x7B) {
      if (msg.startsWith('{"heartbeat":')) { ws._wtAlive = true; return; }
      if (msg.startsWith('{"resize":')) {
        if (ws._wtBackground) return;
        try {
          const { resize } = JSON.parse(msg);
          const cols = Math.max(1, Math.min(500, parseInt(resize.cols) || 80));
          const rows = Math.max(1, Math.min(200, parseInt(resize.rows) || 24));
          workerClient.rpc('resizeSession', { id, cols, rows }).catch(() => {});
        } catch (e) {}
        return;
      }
      if (msg.startsWith('{"mode":')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.mode === 'active' || parsed.mode === 'background') {
            if (!liveConfig('keepSessionsOpen', true) && parsed.mode === 'background') {
              ws.close(4002, 'keepSessionsOpen disabled');
              return;
            }
            const browserId = typeof parsed.browserId === 'string' ? parsed.browserId.slice(0, 64) : null;
            ws._wtBrowserId = browserId;

            if (parsed.mode === 'active') {
              ws._wtBackground = false;
              // #21: by default, multiple devices share one PTY (shared I/O) —
              // opening a session on a second device no longer force-disconnects
              // the first. There is a single PTY that echoes once and broadcasts
              // to every attached viewer, so there is no double-echo; input from
              // any active viewer is written to that one PTY. Set
              // `exclusiveViewer: true` to restore the old single-owner takeover
              // (kick every other active viewer with a different browserId).
              if (liveConfig('exclusiveViewer', false)) {
                const kickMsg = JSON.stringify({ sessionTaken: getServerName() });
                for (const existing of clientsSet) {
                  if (existing === ws) continue;
                  if (existing._wtBrowserId === browserId && existing._wtBackground) continue;
                  if (existing._wtBackground) continue;
                  if (existing._wtBrowserId !== browserId) {
                    try { existing.send(kickMsg); } catch (e) {}
                    try { existing.close(4001, 'Session opened elsewhere'); } catch (e) {}
                  }
                }
              }
            } else {
              ws._wtBackground = true;
            }
          }
        } catch (e) {}
        return;
      }
    }
    if (ws._wtBackground) return;
    // Send keystrokes as a TYPE_PTY_IN binary frame (no per-keystroke RPC).
    try {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      workerClient.sendPtyIn(id, buf);
    } catch {}
  }

  ws.on('message', (msg) => {
    if (!attached) { pendingMessages.push(msg); return; }
    handleMessage(msg);
  });

  let closedEarly = false;
  ws.on('close', () => {
    closedEarly = !attached;
    clientsSet.delete(ws);
    if (attached) {
      workerClient.rpc('detachSession', { id }).catch(() => {});
    }
    releasePtyOutSubscription(id);
    console.log(`[${new Date().toISOString()}] Client left session ${id} (${clientsSet.size} clients)`);
  });

  // Attach to the worker session (also verifies existence). Returns scrollback.
  (async () => {
    let attachRes;
    try {
      attachRes = await workerClient.rpc('attachSession', { id, scrollbackLimit: getScrollbackReplayLimit() });
    } catch (e) {
      try { ws.close(4000, 'Session ended'); } catch {}
      return;
    }
    if (closedEarly || ws.readyState !== 1) {
      try { await workerClient.rpc('detachSession', { id }); } catch {}
      return;
    }

    // Send scrollback as a single chunk
    try {
      let full = attachRes.scrollback || '';
      if (full.length) {
        // Strip replay-unsafe sequences: erase-display, alt-screen toggles, and
        // — critically — terminal queries (DA/DSR). Replaying a stale DA query
        // makes xterm answer "ESC[?1;2c" into an idle shell, leaving "1;2c"
        // garbage on the prompt. See lib/replay-sanitize.js.
        full = sanitizeReplay(full);
        ws.send(full);
      }
    } catch (e) {}

    const keepOpen = liveConfig('keepSessionsOpen', true);
    if (keepOpen) {
      // ws._wtBackground is already true — stays until mode message arrives
    } else {
      // Legacy exclusive viewer: kick existing viewers before adding the new one
      if (clientsSet.size > 0) {
        const kickMsg = JSON.stringify({ sessionTaken: getServerName() });
        for (const existing of clientsSet) {
          try { existing.send(kickMsg); } catch {}
          try { existing.close(4001, 'Session opened elsewhere'); } catch {}
        }
        clientsSet.clear();
        console.log(`[${new Date().toISOString()}] Kicked previous viewers from session ${id}`);
      }
      // In legacy mode, treat all connections as active (no background)
      ws._wtBackground = false;
    }

    clientsSet.add(ws);
    ensurePtyOutSubscription(id);
    attached = true;
    console.log(`[${new Date().toISOString()}] Client joined session ${id} (${clientsSet.size} client(s)${keepOpen ? ', keepOpen' : ', exclusive'})`);

    // Drain pending messages that arrived during attach.
    for (const m of pendingMessages) {
      try { handleMessage(m); } catch {}
    }
    pendingMessages.length = 0;
  })();
});

// --- Graceful shutdown: flush worker state before exit ---
async function gracefulShutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received — flushing worker state...`);
  try { await workerClient.rpc('flushState'); } catch {}
  console.log(`[${new Date().toISOString()}] Exiting.`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

const HOST = process.env.WT_HOST || config.host || '127.0.0.1';

// Connect to the worker before starting the HTTP server.
// If the worker isn't ready after ~12 seconds, exit with code 1 so monitor restarts.
(async () => {
  try {
    await workerClient.connect(WORKER_PIPE_PATH, { maxAttempts: 60, delayMs: 200 });
    console.log(`Connected to pty-worker at ${WORKER_PIPE_PATH}`);
  } catch (e) {
    console.error(`FATAL: could not connect to pty-worker: ${e.message}`);
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Web Terminal running at http://${HOST}:${PORT}`);
    console.log(`Sessions: http://${HOST}:${PORT}/`);
    console.log(`Auth: ${_USER}:***`);
    if (needsPasswordChange()) {
      console.log('\x1b[33m⚠  DEFAULT PASSWORD IN USE — you will be prompted to change it on first login\x1b[0m');
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — another instance is likely running. Exiting.`);
      process.exit(2);
    }
    throw err;
  });
})();
