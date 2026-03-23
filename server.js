const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

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
const USER = process.env.WT_USER || config.user || 'admin';
const PASS = process.env.WT_PASS || config.password || 'admin';
const SHELL = process.env.WT_SHELL || config.shell || 'C:\\Program Files\\Git\\bin\\bash.exe';
const DEFAULT_CWD = process.env.WT_CWD || config.defaultCwd || 'C:\\dev';
const SCAN_FOLDERS = config.scanFolders || [DEFAULT_CWD];
const DEFAULT_COMMAND = config.defaultCommand || '';
const OPEN_IN_NEW_TAB = config.openInNewTab !== undefined ? config.openInNewTab : true;
const SERVER_NAME = config.serverName || os.hostname();
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'projects');

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

function createSession(id, cwd, name, autoCommand) {
  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || DEFAULT_CWD,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', HOME: process.env.USERPROFILE || os.homedir() })
  });

  const session = {
    term, clients: new Set(), scrollback: [], name: name || `Session ${id}`,
    cwd: cwd || DEFAULT_CWD, idleTimer: null, lastActivity: Date.now(),
    status: 'active', autoCommand: autoCommand || ''
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

    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    for (const p of NOTIFY_PATTERNS) {
      if (p.regex.test(clean)) {
        session.status = 'waiting';
        sendNotification(session, 'input_needed', `"${session.name}" — ${p.msg}`);
        break;
      }
    }

    session.lastActivity = Date.now();
    session.status = 'active';
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.status = 'idle';
      sendNotification(session, 'idle', `"${session.name}" — Claude appears to be done`);
    }, IDLE_NOTIFY_MS);
  });

  term.onExit(() => {
    console.log(`[${new Date().toISOString()}] Session ${id} shell exited`);
    for (const client of session.clients) {
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(); } catch (e) {}
    }
    sessions.delete(id);
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
function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return null;
  return { user: decoded.substring(0, colonIndex), pass: decoded.substring(colonIndex + 1) };
}

function checkCredentials(user, pass) {
  if (!user || !pass) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(user), Buffer.from(USER)) &&
           crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(PASS));
  } catch (e) { return false; } // different lengths
}

function authenticateWs(ws, req) {
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds || !checkCredentials(creds.user, creds.pass)) {
    ws.close(1008, 'Unauthorized');
    return false;
  }
  return true;
}

// --- Auth middleware ---
app.use((req, res, next) => {
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds) {
    res.set('WWW-Authenticate', 'Basic realm="Web Terminal"');
    return res.status(401).send('Authentication required');
  }
  if (!checkCredentials(creds.user, creds.pass)) {
    res.set('WWW-Authenticate', 'Basic realm="Web Terminal"');
    return res.status(401).send('Invalid credentials');
  }
  next();
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
  current.user = current.user || USER;
  current.password = current.password || PASS;
  current.shell = current.shell || SHELL;
  current.defaultCwd = current.defaultCwd || DEFAULT_CWD;
  current.scanFolders = current.scanFolders || SCAN_FOLDERS;
  current.defaultCommand = current.defaultCommand || DEFAULT_COMMAND;
  current.openInNewTab = current.openInNewTab !== undefined ? current.openInNewTab : OPEN_IN_NEW_TAB;
  current.serverName = current.serverName || SERVER_NAME;
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName'];

app.put('/api/config', express.json(), (req, res) => {
  try {
    // Only allow known config keys
    const sanitized = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }
    // If password is masked, preserve existing password
    if (sanitized.password === '***' || !sanitized.password) {
      let existing = {};
      try { if (fs.existsSync(CONFIG_FILE)) existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
      sanitized.password = existing.password || PASS;
    }
    // Basic type validation
    if (sanitized.port !== undefined) sanitized.port = parseInt(sanitized.port) || 7681;
    if (sanitized.scanFolders && !Array.isArray(sanitized.scanFolders)) sanitized.scanFolders = [String(sanitized.scanFolders)];
    if (sanitized.openInNewTab !== undefined) sanitized.openInNewTab = !!sanitized.openInNewTab;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2), 'utf8');
    res.json({ ok: true, message: 'Saved. Restart server for changes to take effect.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: hostname ---
app.get('/api/hostname', (req, res) => {
  res.json({ hostname: SERVER_NAME });
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
app.post('/api/sessions', express.json(), (req, res) => {
  const id = crypto.randomUUID();
  let cwd = req.body?.cwd || DEFAULT_CWD;
  const name = req.body?.name || `Session ${sessions.size + 1}`;
  const autoCommand = req.body?.autoCommand || '';
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
    res.status(500).json({ error: e.message });
  }
});

// --- API: update session (rename, change autoCommand) ---
app.patch('/api/sessions/:id', express.json(), (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  if (req.body?.name) session.name = req.body.name;
  if (req.body?.autoCommand !== undefined) session.autoCommand = req.body.autoCommand;
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
        // Read first user message as summary
        let summary = '';
        try {
          const lines = fs.readFileSync(path.join(projectDir, f.file), 'utf8').split('\n');
          for (const line of lines.slice(0, 10)) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.type === 'user' && obj.message?.content) {
              summary = typeof obj.message.content === 'string'
                ? obj.message.content.substring(0, 120)
                : JSON.stringify(obj.message.content).substring(0, 120);
              break;
            }
          }
        } catch (e) {}

        allSessions.push({
          id: f.id,
          project,
          projectPath,
          summary: summary.replace(/[\n\r]+/g, ' ').trim(),
          lastModified: f.mtime,
          sizeKB: Math.round(f.size / 1024)
        });
      }
    }

    // Sort all by last modified, return top 20
    allSessions.sort((a, b) => b.lastModified - a.lastModified);
    res.json(allSessions.slice(0, 20));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Landing page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'lobby.html'));
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

  for (const chunk of session.scrollback) {
    try { ws.send(chunk); } catch (e) { break; }
  }

  session.clients.add(ws);
  console.log(`[${new Date().toISOString()}] Client joined session ${req.params.id} (${session.clients.size} clients)`);

  ws.on('message', msg => {
    if (typeof msg === 'string' && msg.startsWith('{"resize":')) {
      try {
        const { resize } = JSON.parse(msg);
        session.term.resize(resize.cols, resize.rows);
      } catch (e) {}
      return;
    }
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
    createSession(cfg.id, cfg.cwd, cfg.name, cmd);
  }
} else {
  createSession('1', DEFAULT_CWD, 'Default', '');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal running at http://0.0.0.0:${PORT}`);
  console.log(`Sessions: http://0.0.0.0:${PORT}/`);
  console.log(`Auth: ${USER}:***`);
});
