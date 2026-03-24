const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

// --- Config: config.json > env vars > defaults ---
const CONFIG_FILE = path.join(__dirname, 'config.json');
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
const DEFAULT_CWD = process.env.WT_CWD || config.defaultCwd || 'C:\\dev';
const SCAN_FOLDERS = config.scanFolders || [DEFAULT_CWD];
const DEFAULT_COMMAND = config.defaultCommand || '';
const OPEN_IN_NEW_TAB = config.openInNewTab !== undefined ? config.openInNewTab : true;
const SERVER_NAME = config.serverName || os.hostname();
const SCROLLBACK_REPLAY_LIMIT = parseInt(config.scrollbackReplayLimit) || 102400; // 100KB default
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SCROLLBACK_DIR = path.join(__dirname, 'scrollback');
const CLIPBOARD_DIR = path.join(__dirname, 'clipboard-images');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'projects');

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
if (PASS && !DEFAULT_PASSWORDS.includes(PASS) && !PASS.startsWith('$scrypt$')) {
  const hashed = hashPassword(PASS);
  let cfg = {};
  try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
  cfg.password = hashed;
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    PASS = hashed;
    console.log('Password auto-hashed in config.json');
  } catch (e) { console.error('Failed to auto-hash password:', e.message); }
}

const app = express();
expressWs(app);

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
const MAX_SCROLLBACK = 5000;

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

  const session = {
    term, clients: new Set(), scrollback, name: name || `Session ${id}`,
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
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback.splice(0, session.scrollback.length - MAX_SCROLLBACK);
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
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(); } catch (e) {}
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
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'wt_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  res.set('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE / 1000}`);
}

function authenticateWs(ws, req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!verifySessionToken(cookies[COOKIE_NAME])) {
    ws.close(1008, 'Unauthorized');
    return false;
  }
  return true;
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
  res.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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

// --- Auth middleware ---
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  if (!verifySessionToken(cookies[COOKIE_NAME])) {
    return res.redirect('/login');
  }

  // Force password change if still using default
  if (needsPasswordChange() && req.path !== '/api/setup') {
    return res.send(SETUP_PAGE);
  }

  next();
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
  current.defaultCwd = current.defaultCwd || DEFAULT_CWD;
  current.scanFolders = current.scanFolders || SCAN_FOLDERS;
  current.defaultCommand = current.defaultCommand || DEFAULT_COMMAND;
  current.openInNewTab = current.openInNewTab !== undefined ? current.openInNewTab : OPEN_IN_NEW_TAB;
  current.serverName = current.serverName || SERVER_NAME;
  current.scrollbackReplayLimit = current.scrollbackReplayLimit || SCROLLBACK_REPLAY_LIMIT;
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'scrollbackReplayLimit'];

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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
    res.json({ ok: true, message: 'Saved. Restart server for changes to take effect.' });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: hostname ---
app.get('/api/hostname', (req, res) => {
  res.json({ hostname: SERVER_NAME });
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

// --- API: create session ---
const MAX_SESSIONS = config.maxSessions || 10;
app.post('/api/sessions', express.json({ limit: '16kb' }), (req, res) => {
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: `Session limit reached (max ${MAX_SESSIONS})` });
  }
  const id = crypto.randomUUID();
  let cwd = String(req.body?.cwd || DEFAULT_CWD).substring(0, 260);
  const name = String(req.body?.name || `Session ${sessions.size + 1}`).substring(0, 100).replace(/[\x00-\x1f]/g, '');
  const autoCommand = String(req.body?.autoCommand || '').substring(0, 500);
  // Verify cwd exists, fall back to default
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      console.warn(`CWD "${cwd}" does not exist, falling back to ${DEFAULT_CWD}`);
      cwd = DEFAULT_CWD;
    }
  } catch (e) {
    cwd = DEFAULT_CWD;
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
  for (const baseDir of SCAN_FOLDERS) {
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
  // First part: drive letter. "C-" at start -> "C:\"
  const driveMatch = project.match(/^([A-Z])-(.*)$/);
  if (!driveMatch) return project.replace(/-/g, '\\');

  const drive = driveMatch[1] + ':\\';
  const rest = driveMatch[2]; // e.g. "-dev-web-terminal" -> "dev-web-terminal"
  const cleanRest = rest.replace(/^-/, ''); // remove leading dash after drive

  // Split on dashes — each could be a path separator or part of a folder name
  const parts = cleanRest.split('-');

  // Try to greedily build the path by checking which directories exist
  let current = drive;
  let i = 0;
  while (i < parts.length) {
    // Try joining increasingly more parts (to handle hyphens in folder names)
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join('-');
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
    if (!found) {
      // No match found — just use single part as directory name
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
  const file = path.join(CLAUDE_PROJECTS_DIR, req.params.project, req.params.id + '.jsonl');
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

// --- API: restart server ---
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Restarting...' });
  console.log(`[${new Date().toISOString()}] Restart requested via API`);
  setTimeout(() => {
    saveSessionConfigs();
    saveAllScrollback();
    const { spawn } = require('child_process');
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
  ws.on('close', () => notifyClients.delete(ws));
});

// --- WebSocket: attach to session ---
app.ws('/ws/:id', (ws, req) => {
  if (!authenticateWs(ws, req)) return;
  const session = sessions.get(req.params.id);
  if (!session) { ws.close(); return; }

  // Send scrollback as a single chunk, trimmed to replay limit
  try {
    if (session.scrollback.length) {
      const full = session.scrollback.join('');
      ws.send(full.length > SCROLLBACK_REPLAY_LIMIT ? full.slice(-SCROLLBACK_REPLAY_LIMIT) : full);
    }
  } catch (e) {}

  session.clients.add(ws);
  console.log(`[${new Date().toISOString()}] Client joined session ${req.params.id} (${session.clients.size} clients)`);

  ws.on('message', msg => {
    // Reject oversized messages (64KB)
    if (msg.length > 65536) return;
    if (typeof msg === 'string' && msg.startsWith('{"resize":')) {
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
