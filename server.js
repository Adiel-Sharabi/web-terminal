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

const SERVER_VERSION = '1.11.7';

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
function getScrollbackReplayLimit() { return parseInt(liveConfig('scrollbackReplayLimit', 1048576)) || 1048576; }

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
const HISTORY_FILE = path.join(__dirname, 'history.json');
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
const CLUSTER_TOKENS_FILE = path.join(__dirname, 'cluster-tokens.json');
const CLAUDE_SESSION_NAMES_FILE = path.join(__dirname, 'claude-session-names.json');

function loadClaudeSessionNames() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SESSION_NAMES_FILE, 'utf8')); } catch { return {}; }
}
function saveClaudeSessionNames(names) {
  fs.writeFileSync(CLAUDE_SESSION_NAMES_FILE, JSON.stringify(names, null, 2));
}

/** Detect the most recently modified Claude session ID from the project's JSONL files */
function detectClaudeSessionIdFromDir(cwd) {
  try {
    const projectDir = path.join(getClaudeProjectsDir(),
      cwd.replace(/^([A-Z]):\\/, '$1--').replace(/[\\/]/g, '-'));
    if (fs.existsSync(projectDir)) {
      const newest = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ id: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) return newest.id;
    }
  } catch (e) {}
  return null;
}

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

workerClient.on('statusChanged', ({ id, status, notifyType, notifyMsg }) => {
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
});

workerClient.on('sessionExited', ({ id }) => {
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
app.get('/sw.js', (req, res) => { res.set('Content-Type', 'application/javascript'); res.sendFile(path.join(__dirname, 'sw.js')); });
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
app.post('/api/hook', express.json({ limit: '16kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = req.headers['x-wt-session-id'];
  if (!id) return res.json({ ok: true, skipped: 'no session ID' });
  const event = req.body?.hook_event_name || req.body?.event;
  try {
    const result = await workerClient.rpc('hookEvent', { id, event });
    res.json({ ok: true, status: result.status });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.json({ ok: true, skipped: 'session not found' });
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/session/:id/hook', express.json({ limit: '16kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const event = req.body?.hook_event_name || req.body?.event;
  if (!event) return res.status(400).json({ error: 'event required' });
  try {
    const result = await workerClient.rpc('hookEvent', { id: req.params.id, event });
    res.json({ ok: true, status: result.status });
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: 'session not found' });
    if (/event required/i.test(e.message)) return res.status(400).json({ error: 'event required' });
    res.status(500).json({ error: e.message });
  }
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
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'scrollbackReplayLimit', 'cluster', 'publicUrl', 'claudeHome', 'keepSessionsOpen'];

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

// Fetch all sessions across cluster
app.get('/api/cluster/sessions', async (req, res) => {
  const result = [];

  // Local sessions (via worker)
  try {
    const { sessions: localList } = await workerClient.rpc('listSessions');
    for (const s of localList) {
      result.push({
        id: s.id, name: s.name, cwd: s.cwd, status: s.status,
        clients: s.clients || 0, pid: s.pid,
        lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
        server: getServerName(), serverUrl: null,
      });
    }
  } catch (e) {
    console.error('worker listSessions failed:', e.message);
  }

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
      console.log(`[${new Date().toISOString()}] Cluster fetch: ${r.server} (${r.online ? 'online' : 'offline'}) → ${r.sessions.length} sessions: ${summary}`);
    }
    result.push(...r.sessions);
  }

  // Get local version info (cached — no sync git per request). See _getGitInfo().
  const _gitInfo = _getGitInfo();
  const localVersion = `${SERVER_VERSION} (${_gitInfo.hash})`;

  res.json({
    sessions: result,
    servers: [
      { name: getServerName(), url: null, online: true, needsAuth: false, version: localVersion },
      ...remotes.map(r => ({ name: r.server, url: r.url, online: r.online, needsAuth: r.needsAuth, version: r.version || '', directConnect: r.directConnect === true }))
    ]
  });
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
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8', windowsHide: true }).trim();
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
  res.json({
    version: SERVER_VERSION,
    hash: info.hash,
    date: info.date,
    behind: info.behind,
    dirty: info.dirty,
    serverName: getServerName(),
  });
});

// --- API: upload image to server clipboard ---
app.post('/api/clipboard-image', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  try {
    // Determine extension from content-type
    const ct = req.headers['content-type'] || 'image/png';
    const ext = ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '.png';
    const filename = `clip-${Date.now()}${ext}`;
    const filepath = path.join(CLIPBOARD_DIR, filename);

    fs.writeFileSync(filepath, req.body);

    // Copy image to Windows clipboard via PowerShell
    const ps = `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${filepath.replace(/'/g, "''")}'))`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err) => {
      if (err) {
        console.error('Clipboard copy failed:', err.message);
        // Still return success — file is saved even if clipboard fails
        return res.json({ ok: true, path: filepath, clipboard: false });
      }
      res.json({ ok: true, path: filepath, clipboard: true });
    });
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
    }));
    // Log when a remote server fetches our sessions (Bearer = cluster call)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const summary = shaped.map(s => {
        const ageMins = s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 60000) : '?';
        return `"${s.name}"(${s.status}, ${ageMins}m ago, ${s.clients} clients)`;
      }).join(', ');
      console.log(`[${new Date().toISOString()}] Sessions served to cluster caller: ${shaped.length} sessions: ${summary}`);
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
    try {
      const result = await workerClient.rpc('ageSession', { id: req.params.id, lastActivity: aged, lastHookActivity: aged });
      res.json({ ok: true, lastActivity: aged, lastHookActivity: aged, ...result });
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
    saveFolder(cwd);
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
    res.json({ id: req.params.id, name: newName || current.name, autoCommand });
  } catch (e) {
    console.error(`PATCH /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to update session' });
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
    res.json({ ok: true });
  } catch (e) {
    console.error(`DELETE /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to kill session' });
  }
});

// --- Folder history ---
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {}
  return { folders: [] };
}

function saveFolder(folder) {
  const history = loadHistory();
  // Remove if exists, add to front
  history.folders = history.folders.filter(f => f.toLowerCase() !== folder.toLowerCase());
  history.folders.unshift(folder);
  // Keep last 20
  history.folders = history.folders.slice(0, 20);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8'); } catch (e) {}
}

app.get('/api/history/folders', (req, res) => {
  const history = loadHistory().folders;
  // Also scan configured folders and their subdirectories
  const scanned = new Set(history);
  for (const baseDir of getScanFolders()) {
    try {
      scanned.add(baseDir);
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'));
      for (const d of dirs) scanned.add(path.join(baseDir, d.name));
    } catch (e) {}
  }
  // History items first, then scanned extras
  const result = [...history];
  for (const f of scanned) {
    if (!result.find(r => r.toLowerCase() === f.toLowerCase())) result.push(f);
  }
  res.json(result);
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
    // Pull latest code before restarting
    try { execSync('git pull --ff-only', { cwd: __dirname, timeout: 15000, windowsHide: true }); } catch (e) {
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'lobby.html'));
});

// --- Unified app page (A/B test) ---
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.get('/app/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
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
        full = full.replace(/\x1b\[[23]J/g, '').replace(/\x1b\[\?1049[hl]/g, '');
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
