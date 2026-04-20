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
const pty = require('node-pty');
const ipc = require('./lib/ipc');

const WORKER_VERSION = '0.4.0';
const STALE_STATUS_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024;

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

function buildSafeEnv() {
  if (liveConfig('passAllEnv', false)) return Object.assign({}, process.env, { TERM: 'xterm-256color' });
  return {
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

const log = (...args) => {
  if (process.env.WT_WORKER_QUIET) return;
  console.log(`[pty-worker ${new Date().toISOString()}]`, ...args);
};

// --- Claude session helpers -----------------------------------------------
let _claudeHome = null;

function detectClaudeHome() {
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
  } catch {}
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
  try { fs.writeFileSync(CLAUDE_SESSION_NAMES_FILE, JSON.stringify(names, null, 2)); } catch {}
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

function saveScrollback(id, session, sync) {
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    const data = JSON.stringify(session.scrollback);
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
  try {
    const file = path.join(SCROLLBACK_DIR, id + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return [];
}

function deleteScrollback(id) {
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
  // Snapshot entries so concurrent session mutation during await points
  // doesn't trip the iterator. A session deleted mid-loop will still get
  // its stale scrollback written — harmless; the next tick overwrites or
  // deleteScrollback cleans up.
  const entries = Array.from(sessions);
  for (let i = 0; i < entries.length; i++) {
    const [id, session] = entries[i];
    if (force || session.dirty) {
      saveScrollback(id, session, sync);
    }
    // Yield after each session except the last to release the event loop.
    if (i < entries.length - 1) {
      await new Promise(r => setImmediate(r));
    }
  }
}

// Synchronous-only save — for the `process.on('exit')` handler, which runs
// after the event loop has stopped and cannot await. Normal shutdown paths
// already flushed via the async version; this is a last-resort safety net.
// Always saves every session (force=true semantics) — we can't risk losing
// scrollback on final exit.
function saveAllScrollbackSync() {
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

// Route binary PTY output only to connections subscribed to that session.
function broadcastPtyOut(sessionId, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let frame = null;
  for (const conn of attachedConnections) {
    const subs = connSubs.get(conn);
    if (!subs || !subs.has(sessionId)) continue;
    if (!frame) frame = ipc.encodePtyOut(sessionId, buf);
    try { conn.send(frame); } catch {}
  }
}

function correctStaleStatus(session) {
  if ((session.status === 'working' || session.status === 'waiting') &&
      session.lastHookActivity && (Date.now() - session.lastHookActivity) > STALE_STATUS_TIMEOUT_MS) {
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
    claudeSessionId = extractClaudeSessionIdFromCmd(s.autoCommand)
      || detectClaudeSessionIdFromDir(s.cwd);
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
  };
}

function createSession(id, cwd, name, autoCommand, savedScrollback, claudeSessionId) {
  const sessionEnv = buildSafeEnv();
  sessionEnv.WT_SESSION_ID = id;
  sessionEnv.WT_SESSION_PORT = String(PORT_HINT);
  const spawnShell = SHELL.replace(/\\/g, '/');
  const spawnCwd = (cwd || getDefaultCwd()).replace(/\\/g, '/');
  const term = pty.spawn(spawnShell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: spawnCwd,
    env: sessionEnv,
    useConptyDll: liveConfig('useConptyDll', true),
  });

  const scrollback = [];
  if (savedScrollback && savedScrollback.length > 0) {
    scrollback.push(...savedScrollback);
    scrollback.push('\r\n\x1b[33m--- server restarted ---\x1b[0m\r\n\r\n');
  }
  const scrollbackSize = scrollback.reduce((sum, s) => sum + s.length, 0);

  const session = {
    id,
    term,
    scrollback,
    scrollbackSize,
    name: name || `Session ${id}`,
    cwd: cwd || getDefaultCwd(),
    idleTimer: null,
    lastActivity: Date.now(),
    lastUserInput: 0,
    status: 'active',
    hookStatus: false,
    lastHookActivity: 0,
    autoCommand: autoCommand || '',
    claudeSessionId: claudeSessionId || null,
    clientCount: 0,
    // Issue #10: set to true whenever scrollback is mutated (term.onData,
    // test injection). Cleared by saveScrollback on successful save. The
    // periodic saveAllScrollback(sync=false, force=false) skips sessions
    // with !dirty to avoid writing ~MB of unchanged data every 30s.
    // Initialize to true if we have carry-over scrollback from restore
    // (the "--- server restarted ---" banner needs to be persisted so a
    // second restart-without-output doesn't silently drop it).
    dirty: (scrollback.length > 0),
  };
  sessions.set(id, session);

  term.onData((data) => {
    session.scrollback.push(data);
    session.scrollbackSize = (session.scrollbackSize || 0) + data.length;
    while (session.scrollbackSize > MAX_SCROLLBACK_SIZE && session.scrollback.length > 1) {
      session.scrollbackSize -= session.scrollback.shift().length;
    }
    // Issue #10: mark dirty so the next periodic save writes this session.
    session.dirty = true;
    session.lastActivity = Date.now();
    // Stream PTY data as binary TYPE_PTY_OUT frames to subscribed connections only.
    // (fan-out to browser WS is done server-side.)
    if (session.clientCount > 0) {
      broadcastPtyOut(id, data);
    }
  });

  term.onExit(() => {
    log(`session ${id} shell exited`);
    if (session.autoCommand && /\bclaude\b/i.test(session.autoCommand)) {
      const claudeId = session.claudeSessionId
        || extractClaudeSessionIdFromCmd(session.autoCommand)
        || detectClaudeSessionIdFromDir(session.cwd);
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

  // Auto-command
  if (autoCommand) {
    let autoFired = false;
    const autoListener = term.onData((data) => {
      if (autoFired) return;
      if (/[$#>]\s*$/.test(data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''))) {
        autoFired = true;
        autoListener.dispose();
        setTimeout(() => {
          term.write(autoCommand + '\n');
          log(`session ${id} auto-command: ${autoCommand}`);
        }, 100);
      }
    });
    setTimeout(() => {
      if (!autoFired) {
        autoFired = true;
        autoListener.dispose();
        term.write(autoCommand + '\n');
        log(`session ${id} auto-command (fallback): ${autoCommand}`);
      }
    }, 5000);
  }

  // Claude session ID detection
  if (autoCommand && /\bclaude\b/i.test(autoCommand)) {
    const cmdClaudeId = extractClaudeSessionIdFromCmd(autoCommand);
    if (cmdClaudeId) {
      session.claudeSessionId = cmdClaudeId;
    } else {
      setTimeout(() => {
        if (!session.claudeSessionId) {
          const detected = detectClaudeSessionIdFromDir(session.cwd);
          if (detected) {
            session.claudeSessionId = detected;
            log(`session ${id} detected Claude session: ${detected}`);
            saveSessionConfigs();
          }
        }
      }, 15000);
    }
  }

  log(`session ${id} created (pid ${term.pid}, cwd ${session.cwd}${autoCommand ? ', cmd ' + autoCommand : ''})`);
  saveSessionConfigs();
  return session;
}

// --- Hook handling --------------------------------------------------------
function handleHook(session, event) {
  if (!event) throw new Error('event required');
  const prevStatus = session.status;
  let notifyType = null, notifyMsg = null;
  session.hookStatus = true;

  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
      session.status = 'working';
      if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
      break;
    case 'Notification':
    case 'Stop':
      session.status = 'idle';
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
      const claudeId = session.claudeSessionId
        || extractClaudeSessionIdFromCmd(session.autoCommand)
        || detectClaudeSessionIdFromDir(session.cwd);
      if (claudeId) {
        session.claudeSessionId = claudeId;
        const names = loadClaudeSessionNames();
        names[claudeId] = newName;
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
    let full = session.scrollback.join('');
    if (full.length > limit) full = full.slice(-limit);
    return { data: full };
  },

  hookEvent: async (params) => {
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    return handleHook(session, params.event);
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
    let full = session.scrollback.join('');
    if (full.length > limit) full = full.slice(-limit);
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
  __testInjectScrollback: async (params) => {
    if (!process.env.WT_TEST) throw new Error('test-only RPC');
    const session = sessions.get(requireUuid(params.id));
    if (!session) throw new Error('session not found');
    const bytes = Math.max(0, parseInt(params.bytes) || 0);
    if (bytes > 0) {
      const chunk = 'x'.repeat(1024);
      let written = 0;
      while (written < bytes) {
        const take = Math.min(chunk.length, bytes - written);
        const piece = take === chunk.length ? chunk : chunk.slice(0, take);
        session.scrollback.push(piece);
        session.scrollbackSize = (session.scrollbackSize || 0) + piece.length;
        written += take;
      }
      // Issue #10: mimic term.onData's dirty marking so tests exercise the
      // same code path real PTY output takes.
      session.dirty = true;
    }
    return { size: session.scrollbackSize || 0, chunks: session.scrollback.length };
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
    let cmd = cfg.autoCommand || '';
    if (cmd && /\bclaude\b/i.test(cmd) && !/(--continue|--resume)\b/.test(cmd)) {
      if (cfg.claudeSessionId) {
        cmd = cmd.trimEnd() + ' --resume ' + cfg.claudeSessionId;
      } else {
        cmd = cmd.trimEnd() + ' --continue';
      }
    }
    const savedScrollback = loadScrollback(cfg.id);
    try {
      createSession(cfg.id, cfg.cwd, cfg.name, cmd, savedScrollback, cfg.claudeSessionId || null);
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
