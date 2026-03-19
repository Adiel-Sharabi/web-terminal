const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = parseInt(process.env.WT_PORT || '7681');
const USER = process.env.WT_USER || 'admin';
const PASS = process.env.WT_PASS || 'admin';
const SHELL = process.env.WT_SHELL || 'C:\\Program Files\\Git\\bin\\bash.exe';
const DEFAULT_CWD = process.env.WT_CWD || 'C:\\dev';
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

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
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', HOME: process.env.USERPROFILE || 'C:\\Users\\yourname' })
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

// --- Auth middleware ---
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Web Terminal"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user !== USER || pass !== PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Web Terminal"');
    return res.status(401).send('Invalid credentials');
  }
  next();
});

// --- API: hostname ---
app.get('/api/hostname', (req, res) => {
  res.json({ hostname: os.hostname() });
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
  const id = Date.now().toString(36);
  const cwd = req.body?.cwd || DEFAULT_CWD;
  const name = req.body?.name || `Session ${sessions.size + 1}`;
  const autoCommand = req.body?.autoCommand || '';
  createSession(id, cwd, name, autoCommand);
  res.json({ id, name });
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
  notifyClients.add(ws);
  ws.on('close', () => notifyClients.delete(ws));
});

// --- WebSocket: attach to session ---
app.ws('/ws/:id', (ws, req) => {
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
    createSession(cfg.id, cfg.cwd, cfg.name, cfg.autoCommand);
  }
} else {
  createSession('1', DEFAULT_CWD, 'Default', '');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal running at http://0.0.0.0:${PORT}`);
  console.log(`Sessions: http://0.0.0.0:${PORT}/`);
  console.log(`Auth: ${USER}:***`);
});
