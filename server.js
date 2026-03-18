const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');

const PORT = parseInt(process.env.WT_PORT || '7681');
const USER = process.env.WT_USER || 'admin';
const PASS = process.env.WT_PASS || 'admin';
const SHELL = process.env.WT_SHELL || 'C:\\Program Files\\Git\\bin\\bash.exe';
const DEFAULT_CWD = process.env.WT_CWD || 'C:\\dev';

const app = express();
expressWs(app);

// --- Session manager ---
const sessions = new Map(); // id -> { term, clients: Set<ws>, scrollback: string[], name: string }
const MAX_SCROLLBACK = 5000; // lines to replay on reconnect

function createSession(id, cwd, name) {
  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || DEFAULT_CWD,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', HOME: process.env.USERPROFILE || 'C:\\Users\\adiel' })
  });

  const session = { term, clients: new Set(), scrollback: [], name: name || `Session ${id}`, cwd: cwd || DEFAULT_CWD };
  sessions.set(id, session);

  term.onData(data => {
    // Buffer scrollback for replay
    session.scrollback.push(data);
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback.splice(0, session.scrollback.length - MAX_SCROLLBACK);
    }
    // Broadcast to all connected clients
    for (const client of session.clients) {
      try { client.send(data); } catch (e) { /* disconnected */ }
    }
  });

  term.onExit(() => {
    console.log(`[${new Date().toISOString()}] Session ${id} shell exited`);
    for (const client of session.clients) {
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(); } catch (e) {}
    }
    sessions.delete(id);
  });

  console.log(`[${new Date().toISOString()}] Session ${id} created (PID ${term.pid}, cwd: ${session.cwd})`);
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

// --- API: list sessions ---
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, name: s.name, cwd: s.cwd, clients: s.clients.size, pid: s.term.pid });
  }
  res.json(list);
});

// --- API: create session ---
app.post('/api/sessions', express.json(), (req, res) => {
  const id = Date.now().toString(36);
  const cwd = req.body?.cwd || DEFAULT_CWD;
  const name = req.body?.name || `Session ${sessions.size + 1}`;
  createSession(id, cwd, name);
  res.json({ id, name });
});

// --- API: rename session ---
app.patch('/api/sessions/:id', express.json(), (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  if (req.body?.name) session.name = req.body.name;
  res.json({ id: req.params.id, name: session.name });
});

// --- API: kill session ---
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.term.kill();
  sessions.delete(req.params.id);
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

// --- WebSocket: attach to session ---
app.ws('/ws/:id', (ws, req) => {
  const session = sessions.get(req.params.id);
  if (!session) { ws.close(); return; }

  // Replay scrollback so reconnecting client sees history
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
    // Shell stays alive — no kill on disconnect!
  });
});

// --- Auto-create session 1 on startup ---
createSession('1', DEFAULT_CWD, 'Default');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web Terminal running at http://0.0.0.0:${PORT}`);
  console.log(`Sessions: http://0.0.0.0:${PORT}/`);
  console.log(`Auth: ${USER}:***`);
});
