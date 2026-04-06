const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SERVER_VERSION = '1.0.0';

// --- Config: config.json > env vars > defaults ---
// Use separate config file during tests to avoid corrupting production config
const CONFIG_FILE = process.env.WT_PORT ? path.join(__dirname, 'config.test.json') : path.join(__dirname, 'config.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.default.json');
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
const SERVER_NAME = config.serverName || os.hostname(); // startup default
function getServerName() { return liveConfig('serverName', os.hostname()); }

// Live-reloadable settings (read from disk on each use)
function liveConfig(key, fallback) {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg[key] !== undefined) return cfg[key];
    }
  } catch (e) {}
  return fallback;
}
function getDefaultCwd() { return process.env.WT_CWD || liveConfig('defaultCwd', 'C:\\dev'); }
function getScanFolders() { return liveConfig('scanFolders', [getDefaultCwd()]); }
function getDefaultCommand() { return liveConfig('defaultCommand', ''); }
function getScrollbackReplayLimit() { return parseInt(liveConfig('scrollbackReplayLimit', 1048576)) || 1048576; }
// Kept for backward compat in startup code
const DEFAULT_CWD = getDefaultCwd();
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SCROLLBACK_DIR = path.join(__dirname, 'scrollback');
const CLIPBOARD_DIR = path.join(__dirname, 'clipboard-images');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'projects');
const CLUSTER_TOKENS_FILE = path.join(__dirname, 'cluster-tokens.json');

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
    let cfg = {};
    try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
    cfg.password = hashed;
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
      PASS = hashed;
      console.log('Password auto-hashed in config.json');
    } catch (e) { console.error('Failed to auto-hash password:', e.message); }
  }
}

const app = express();
const wsInstance = expressWs(app);

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

// --- Session persistence ---
function loadSessionConfigs() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load sessions.json:', e.message);
  }
  return [];
}

function saveSessionConfigs() {
  const configs = [];
  for (const [id, s] of sessions) {
    configs.push({ id, name: s.name, cwd: s.cwd, autoCommand: s.autoCommand || '' });
  }
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(configs, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save sessions.json:', e.message);
  }
}

// --- Session manager ---
const sessions = new Map();
const notifyClients = new Set();
const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024; // 2MB of scrollback data

// --- Scrollback persistence ---
try { if (!fs.existsSync(SCROLLBACK_DIR)) fs.mkdirSync(SCROLLBACK_DIR); } catch (e) {}
try { if (!fs.existsSync(CLIPBOARD_DIR)) fs.mkdirSync(CLIPBOARD_DIR); } catch (e) {}

function saveScrollback(id, session) {
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    fs.writeFileSync(file, JSON.stringify(session.scrollback), 'utf8');
  } catch (e) {}
}

function loadScrollback(id) {
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return [];
}

function deleteScrollback(id) {
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}

function saveAllScrollback() {
  for (const [id, session] of sessions) {
    saveScrollback(id, session);
  }
}

function createSession(id, cwd, name, autoCommand, savedScrollback) {
  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || DEFAULT_CWD,
    env: config.passAllEnv ? Object.assign({}, process.env, { TERM: 'xterm-256color' }) : {
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
    }
  });

  // Restore previous scrollback with a restart separator
  const scrollback = [];
  if (savedScrollback && savedScrollback.length > 0) {
    scrollback.push(...savedScrollback);
    scrollback.push('\r\n\x1b[33m--- server restarted ---\x1b[0m\r\n\r\n');
  }

  const scrollbackSize = scrollback.reduce((sum, s) => sum + s.length, 0);
  const session = {
    term, clients: new Set(), scrollback, scrollbackSize, name: name || `Session ${id}`,
    cwd: cwd || DEFAULT_CWD, idleTimer: null, lastActivity: Date.now(),
    lastUserInput: 0, status: 'active', autoCommand: autoCommand || ''
  };
  sessions.set(id, session);

  // Patterns that indicate Claude is waiting for user input
  const NOTIFY_PATTERNS = [
    { regex: /Do you want to proceed/i, msg: 'Claude is asking to proceed' },
    { regex: /Allow once|Allow always|Deny/i, msg: 'Claude needs permission' },
    { regex: /\(y\/n\)/i, msg: 'Claude is waiting for yes/no' },
    { regex: /\(Y\/n\)|yes\/no/i, msg: 'Claude is waiting for confirmation' },
    { regex: /Press Enter to continue/i, msg: 'Claude is waiting for Enter' },
  ];
  const IDLE_NOTIFY_MS = 10000;

  function sendNotification(session, type, message) {
    const payload = JSON.stringify({ notification: { type, message, session: session.name, sessionId: id } });
    for (const client of notifyClients) {
      try { client.send(payload); } catch (e) {}
    }
  }

  term.onData(data => {
    session.scrollback.push(data);
    session.scrollbackSize = (session.scrollbackSize || 0) + data.length;
    while (session.scrollbackSize > MAX_SCROLLBACK_SIZE && session.scrollback.length > 1) {
      session.scrollbackSize -= session.scrollback.shift().length;
    }
    for (const client of session.clients) {
      try { client.send(data); } catch (e) {}
    }

    session.lastActivity = Date.now();

    // Ignore user typing/resize echo for status detection
    const isEcho = (Date.now() - session.lastUserInput) < 500;
    if (!isEcho) {
      // Check for waiting-for-input patterns first
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      let isWaiting = false;
      for (const p of NOTIFY_PATTERNS) {
        if (p.regex.test(clean)) {
          session.status = 'waiting';
          sendNotification(session, 'input_needed', `"${session.name}" — ${p.msg}`);
          isWaiting = true;
          break;
        }
      }

      if (!isWaiting) session.status = 'active';
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        if (session.status !== 'waiting') {
          session.status = 'idle';
          sendNotification(session, 'idle', `"${session.name}" — Claude appears to be done`);
        }
      }, IDLE_NOTIFY_MS);
    }
  });

  term.onExit(() => {
    console.log(`[${new Date().toISOString()}] Session ${id} shell exited`);
    for (const client of session.clients) {
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(4000, 'Session ended'); } catch (e) {}
    }
    sessions.delete(id);
    deleteScrollback(id);
    saveSessionConfigs();
  });

  // Auto-run command after shell is ready
  if (autoCommand) {
    setTimeout(() => {
      term.write(autoCommand + '\n');
      console.log(`[${new Date().toISOString()}] Session ${id} auto-command: ${autoCommand}`);
    }, 1500); // wait for shell prompt
  }

  console.log(`[${new Date().toISOString()}] Session ${id} created (PID ${term.pid}, cwd: ${session.cwd}${autoCommand ? ', cmd: ' + autoCommand : ''})`);
  saveSessionConfigs();
  return session;
}

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
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) { return false; }
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

function authenticateWs(ws, req) {
  const cookies = parseCookies(req.headers.cookie);
  // Try cookie auth first, then Bearer token
  if (verifySessionToken(cookies[COOKIE_NAME])) return true;
  // Check for token in query string (express-ws may use req.query or req.url)
  const token = req.query?.token
    || new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  if (token && verifyApiToken(token)) return true;
  ws.close(1008, 'Unauthorized');
  return false;
}

// --- API Token auth (for cluster inter-server communication) ---
const API_TOKENS_FILE = path.join(__dirname, 'api-tokens.json');

function loadApiTokens() {
  try {
    if (fs.existsSync(API_TOKENS_FILE)) return JSON.parse(fs.readFileSync(API_TOKENS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveApiTokens(tokens) {
  fs.writeFileSync(API_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
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
function loadClusterTokens() {
  try {
    if (fs.existsSync(CLUSTER_TOKENS_FILE)) return JSON.parse(fs.readFileSync(CLUSTER_TOKENS_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveClusterTokens(tokens) {
  fs.writeFileSync(CLUSTER_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}

// Read cluster config live from disk (no restart needed)
function getClusterConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return cfg.cluster || [];
    }
  } catch (e) {}
  return [];
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
const RATE_LIMIT_BLOCK = 5 * 60 * 1000; // 5 minutes

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

// --- Security headers ---
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data:");
  next();
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
    return next();
  }
  // Try Bearer token auth (for cluster/API access)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (verifyApiToken(token)) return next();
  }
  // Try query-string token (for WebSocket upgrades through cluster proxy)
  const qToken = req.query?.token;
  if (qToken && verifyApiToken(qToken)) return next();
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
  let cfg = {};
  try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  cfg.user = user.trim();
  cfg.password = hashed;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');

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
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'scrollbackReplayLimit', 'cluster', 'publicUrl'];

app.put('/api/config', express.json({ limit: '16kb' }), (req, res) => {
  try {
    // Only allow known config keys
    const sanitized = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }
    // If password is masked, preserve existing password; otherwise hash the new one
    if (sanitized.password === '***' || !sanitized.password) {
      let existing = {};
      try { if (fs.existsSync(CONFIG_FILE)) existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
      sanitized.password = existing.password || PASS;
    } else if (!sanitized.password.startsWith('$scrypt$')) {
      sanitized.password = hashPassword(sanitized.password);
    }
    // Basic type validation
    if (sanitized.port !== undefined) sanitized.port = parseInt(sanitized.port) || 7681;
    if (sanitized.scanFolders && !Array.isArray(sanitized.scanFolders)) sanitized.scanFolders = [String(sanitized.scanFolders)];
    if (sanitized.openInNewTab !== undefined) sanitized.openInNewTab = !!sanitized.openInNewTab;
    if (sanitized.scrollbackReplayLimit !== undefined) sanitized.scrollbackReplayLimit = Math.max(10240, parseInt(sanitized.scrollbackReplayLimit) || 102400);
    // Compare restart-sensitive keys against running values
    const RESTART_KEYS = { port: PORT, host: config.host || '127.0.0.1', shell: SHELL };
    const needsRestart = Object.entries(RESTART_KEYS).some(
      ([k, running]) => sanitized[k] !== undefined && String(sanitized[k]) !== String(running)
    );
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
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
  let cfg = {};
  try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  if (!cfg.cluster) cfg.cluster = [];
  if (!cfg.cluster.find(s => s.url === url)) {
    cfg.cluster.push({ name, url });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
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

  // Local sessions
  for (const [id, s] of sessions) {
    result.push({
      id, name: s.name, cwd: s.cwd, status: s.status,
      clients: s.clients.size, pid: s.term.pid,
      lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
      server: getServerName(), serverUrl: null // null = local
    });
  }

  // Remote sessions (parallel, with timeout) — skip self-reference
  const clusterTokens = loadClusterTokens();
  const publicUrl = liveConfig('publicUrl', null);
  const remoteServers = getClusterConfig().filter(server => !publicUrl || server.url !== publicUrl);
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
      return {
        server: server.name, url: server.url, online: true, needsAuth: false,
        sessions: remoteSessions.map(s => ({ ...s, server: server.name, serverUrl: server.url }))
      };
    } catch (e) {
      return { server: server.name, url: server.url, online: false, sessions: [] };
    }
  });

  const remotes = await Promise.all(remotePromises);
  for (const r of remotes) {
    result.push(...r.sessions);
  }

  res.json({
    sessions: result,
    servers: [
      { name: getServerName(), url: null, online: true, needsAuth: false },
      ...remotes.map(r => ({ name: r.server, url: r.url, online: r.online, needsAuth: r.needsAuth }))
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

// Proxy WebSocket to remote server
app.ws('/cluster/:serverUrl/ws/:id', (localWs, req) => {
  if (!authenticateWs(localWs, req)) return;

  const serverUrl = decodeURIComponent(req.params.serverUrl);
  const clusterTokens = loadClusterTokens();
  const tokenEntry = clusterTokens[serverUrl];
  if (!tokenEntry) { localWs.close(1008, 'Not authenticated to remote'); return; }

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/' + req.params.id + '?token=' + tokenEntry.token;
  const WebSocket = require('ws');
  const remoteWs = new WebSocket(wsUrl, { rejectUnauthorized: false });

  // Buffer local messages until remote is open
  const buffered = [];
  remoteWs.on('open', () => {
    console.log(`[${new Date().toISOString()}] Cluster WS proxy connected to ${serverUrl}/ws/${req.params.id}`);
    for (const b of buffered) {
      try { remoteWs.send(b.msg, { binary: b.isBinary }); } catch (e) {}
    }
    buffered.length = 0;
  });
  remoteWs.on('message', (data, isBinary) => {
    try { localWs.send(data, { binary: isBinary }); } catch (e) {}
  });
  remoteWs.on('close', (code, reason) => {
    console.log(`[${new Date().toISOString()}] Cluster WS proxy closed: ${code} ${reason}`);
    try { localWs.close(); } catch (e) {}
  });
  remoteWs.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Cluster WS proxy error: ${err.message}`);
    try { localWs.close(); } catch (e) {}
  });
  localWs._wtAlive = true;
  localWs.on('pong', () => { localWs._wtAlive = true; });
  localWs.on('message', (msg, isBinary) => {
    // Absorb client heartbeats — don't forward to remote PTY
    const str = Buffer.isBuffer(msg) ? msg.toString() : msg;
    if (typeof str === 'string' && str.startsWith('{"heartbeat":')) { localWs._wtAlive = true; return; }
    if (remoteWs.readyState === WebSocket.OPEN) {
      try { remoteWs.send(msg, { binary: isBinary }); } catch (e) {}
    } else {
      buffered.push({ msg, isBinary });
    }
  });
  localWs.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Cluster WS local error: ${err.message}`);
    try { remoteWs.close(); } catch (e) {}
  });
  localWs.on('close', () => { try { remoteWs.close(); } catch (e) {} });
});

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
app.get('/api/version', (req, res) => {
  try {
    const { execSync } = require('child_process');
    const hash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
    const date = execSync('git log -1 --format=%ci', { cwd: __dirname, encoding: 'utf8' }).trim();
    const behind = (() => {
      try {
        execSync('git fetch --dry-run 2>&1', { cwd: __dirname, encoding: 'utf8', timeout: 5000 });
        const count = execSync('git rev-list HEAD..@{u} --count', { cwd: __dirname, encoding: 'utf8' }).trim();
        return parseInt(count) || 0;
      } catch (e) { return -1; } // -1 = unknown
    })();
    const dirty = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8' }).trim().length > 0;
    res.json({ version: SERVER_VERSION, hash, date, behind, dirty, serverName: getServerName() });
  } catch (e) {
    res.json({ version: SERVER_VERSION, hash: 'unknown', date: '', behind: -1, dirty: false, serverName: getServerName() });
  }
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
    execFile('powershell', ['-NoProfile', '-Command', ps], (err) => {
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
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, name: s.name, cwd: s.cwd, clients: s.clients.size, pid: s.term.pid, status: s.status, lastActivity: s.lastActivity, autoCommand: s.autoCommand || '' });
  }
  res.json(list);
});

// --- API: execute command and return output ---
app.post('/api/exec', express.json({ limit: '64kb' }), (req, res) => {
  const command = req.body?.command;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command is required' });
  }
  if (command.length > 4096) {
    return res.status(400).json({ error: 'command too long (max 4096 chars)' });
  }
  const cwd = req.body?.cwd ? String(req.body.cwd).substring(0, 260) : undefined;
  const timeout = Math.min(Math.max(parseInt(req.body?.timeout) || 30000, 1000), 120000);

  const child = execFile(SHELL, ['-c', command], {
    cwd: cwd || DEFAULT_CWD,
    timeout,
    maxBuffer: 1024 * 1024,
    env: config.passAllEnv ? Object.assign({}, process.env) : {
      HOME: process.env.USERPROFILE || os.homedir(),
      USERPROFILE: process.env.USERPROFILE,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SystemDrive: process.env.SystemDrive,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG || 'en_US.UTF-8',
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    }
  }, (err, stdout, stderr) => {
    const exitCode = err ? (err.code === 'ETIMEDOUT' ? -1 : (err.code || 1)) : 0;
    res.json({ stdout, stderr, exitCode });
  });
});

// --- API: create session ---
const MAX_SESSIONS = config.maxSessions || 10;
app.post('/api/sessions', express.json({ limit: '16kb' }), (req, res) => {
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: `Session limit reached (max ${MAX_SESSIONS})` });
  }
  const id = crypto.randomUUID();
  const liveCwd = getDefaultCwd();
  let cwd = String(req.body?.cwd || liveCwd).substring(0, 260);
  const name = String(req.body?.name || `Session ${sessions.size + 1}`).substring(0, 100).replace(/[\x00-\x1f]/g, '');
  const autoCommand = String(req.body?.autoCommand || '').substring(0, 500);
  // Verify cwd exists — return error if user specified a bad path
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      if (req.body?.cwd) {
        return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
      }
      cwd = liveCwd;
    }
  } catch (e) {
    if (req.body?.cwd) {
      return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
    }
    cwd = liveCwd;
  }
  try {
    createSession(id, cwd, name, autoCommand);
    saveFolder(cwd);
    res.json({ id, name });
  } catch (e) {
    console.error(`Failed to create session: ${e.message}`);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// --- API: update session (rename, change autoCommand) ---
app.patch('/api/sessions/:id', express.json({ limit: '16kb' }), (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  if (req.body?.name) session.name = String(req.body.name).substring(0, 100).replace(/[\x00-\x1f]/g, '');
  if (req.body?.autoCommand !== undefined) session.autoCommand = String(req.body.autoCommand).substring(0, 500);
  saveSessionConfigs();
  res.json({ id: req.params.id, name: session.name, autoCommand: session.autoCommand });
});

// --- API: kill session ---
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.term.kill();
  sessions.delete(req.params.id);
  saveSessionConfigs();
  res.json({ ok: true });
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
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return res.json([]);

    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const allSessions = [];
    for (const project of projects) {
      const projectDir = path.join(CLAUDE_PROJECTS_DIR, project);
      // Decode project path: C--dev-AM8-Core -> C:\dev\AM8_Core
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
        try {
          const lines = fs.readFileSync(path.join(projectDir, f.file), 'utf8').split('\n');
          for (const line of lines.slice(0, 40)) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.permissionMode && !permissionMode) permissionMode = obj.permissionMode;
            if (obj.type === 'user' && obj.message?.content && !hasUserMessage) {
              hasUserMessage = true;
              summary = typeof obj.message.content === 'string'
                ? obj.message.content.substring(0, 120)
                : JSON.stringify(obj.message.content).substring(0, 120);
            }
            if (obj.type === 'assistant') hasAssistantResponse = true;
            if (hasUserMessage && hasAssistantResponse && permissionMode) break;
          }
        } catch (e) {}

        // Skip sessions with no real conversation
        if (!hasUserMessage || !hasAssistantResponse) continue;

        allSessions.push({
          id: f.id,
          project,
          projectPath,
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
  const file = path.join(CLAUDE_PROJECTS_DIR, project, id + '.jsonl');
  // Verify the resolved path is still under CLAUDE_PROJECTS_DIR
  if (!path.resolve(file).startsWith(path.resolve(CLAUDE_PROJECTS_DIR))) {
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

// --- API: export a claude session file (for transfer) ---
app.get('/api/claude-sessions/:project/:id/export', (req, res) => {
  const project = path.basename(req.params.project);
  const id = path.basename(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(CLAUDE_PROJECTS_DIR, project, id + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(CLAUDE_PROJECTS_DIR))) {
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
app.post('/api/claude-sessions/import', express.json({ limit: '50mb' }), (req, res) => {
  const { project, id, content, autoResume, name, skipPermissions } = req.body || {};
  if (!project || !id || !content) {
    return res.status(400).json({ error: 'Missing project, id, or content' });
  }
  const safeProject = path.basename(String(project));
  const safeId = path.basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, safeProject);
  const file = path.join(projectDir, safeId + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(CLAUDE_PROJECTS_DIR))) {
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
      createSession(sessionId, cwd, sessionName.substring(0, 100), cmd);
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
  setTimeout(() => {
    saveSessionConfigs();
    saveAllScrollback();
    const { execSync, spawn } = require('child_process');
    // Pull latest code before restarting
    try { execSync('git pull --ff-only', { cwd: __dirname, timeout: 15000 }); } catch (e) {
      console.error(`[${new Date().toISOString()}] git pull failed: ${e.message}`);
    }
    const child = spawn(process.argv[0], process.argv.slice(1), {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    process.exit(0);
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
app.get('/s/:id', (req, res) => {
  if (!sessions.has(req.params.id)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'terminal.html'));
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
  if (!authenticateWs(ws, req)) return;
  const session = sessions.get(req.params.id);
  if (!session) { ws.close(4000, 'Session ended'); return; }

  // Send scrollback as a single chunk, trimmed to replay limit
  try {
    if (session.scrollback.length) {
      let full = session.scrollback.join('');
      const limit = getScrollbackReplayLimit();
      if (full.length > limit) full = full.slice(-limit);
      // Strip sequences that create empty pages in scrollback replay:
      // - \x1b[2J / \x1b[3J (clear screen) — creates blank pages
      // - \x1b[?1049h/l (alt screen buffer) — loses scrollback in xterm.js
      full = full.replace(/\x1b\[[23]J/g, '').replace(/\x1b\[\?1049[hl]/g, '');
      ws.send(full);
    }
  } catch (e) {}

  // Exclusive viewer: kick existing viewers before adding the new one
  if (session.clients.size > 0) {
    const kickMsg = JSON.stringify({ sessionTaken: getServerName() });
    for (const existing of session.clients) {
      try { existing.send(kickMsg); } catch (e) {}
      try { existing.close(4001, 'Session opened elsewhere'); } catch (e) {}
    }
    session.clients.clear();
    console.log(`[${new Date().toISOString()}] Kicked previous viewers from session ${req.params.id}`);
  }

  session.clients.add(ws);
  ws._wtAlive = true;
  ws.on('pong', () => { ws._wtAlive = true; });
  ws.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] WS error session ${req.params.id}: ${err.message}`);
  });
  console.log(`[${new Date().toISOString()}] Client joined session ${req.params.id} (1 client, exclusive)`);

  ws.on('message', msg => {
    if (Buffer.isBuffer(msg)) msg = msg.toString();
    // Reject oversized messages (64KB)
    if (typeof msg === 'string' && msg.length > 65536) return;
    // Heartbeat from client — just mark alive, don't forward to PTY
    if (typeof msg === 'string' && msg.startsWith('{"heartbeat":')) { ws._wtAlive = true; return; }
    if (msg.startsWith('{"resize":')) {
      try {
        const { resize } = JSON.parse(msg);
        const cols = Math.max(1, Math.min(500, parseInt(resize.cols) || 80));
        const rows = Math.max(1, Math.min(200, parseInt(resize.rows) || 24));
        session.term.resize(cols, rows);
        session.lastUserInput = Date.now(); // resize redraws produce PTY output — ignore for status
      } catch (e) {}
      return;
    }
    session.lastUserInput = Date.now();
    session.term.write(msg);
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[${new Date().toISOString()}] Client left session ${req.params.id} (${session.clients.size} clients)`);
  });
});

// --- Restore sessions from disk or create default ---
const savedSessions = loadSessionConfigs();
if (savedSessions.length > 0) {
  console.log(`Restoring ${savedSessions.length} session(s) from sessions.json...`);
  for (const cfg of savedSessions) {
    let cmd = cfg.autoCommand || '';
    // Auto-add --continue when restoring claude sessions so they resume instead of starting fresh
    if (cmd && /\bclaude\b/i.test(cmd) && !/(--continue|--resume)\b/.test(cmd)) {
      cmd = cmd.trimEnd() + ' --continue';
      console.log(`Session ${cfg.id}: auto-added --continue to resume claude`);
    }
    const savedScrollback = loadScrollback(cfg.id);
    createSession(cfg.id, cfg.cwd, cfg.name, cmd, savedScrollback);
  }
} else {
  createSession(crypto.randomUUID(), DEFAULT_CWD, 'Default', '');
}

// --- Periodic scrollback save (every 30s) ---
setInterval(saveAllScrollback, 30000);

// --- Graceful shutdown: save everything before exit ---
function gracefulShutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received — saving state...`);
  saveSessionConfigs();
  saveAllScrollback();
  console.log(`[${new Date().toISOString()}] State saved. Exiting.`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
// Windows: handle Ctrl+C and process kill
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}
// Last resort — save on uncaught exit
process.on('exit', () => {
  try { saveSessionConfigs(); saveAllScrollback(); } catch (e) {}
});

const HOST = process.env.WT_HOST || config.host || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Web Terminal running at http://${HOST}:${PORT}`);
  console.log(`Sessions: http://${HOST}:${PORT}/`);
  console.log(`Auth: ${_USER}:***`);
  if (needsPasswordChange()) {
    console.log('\x1b[33m⚠  DEFAULT PASSWORD IN USE — you will be prompted to change it on first login\x1b[0m');
  }
});
