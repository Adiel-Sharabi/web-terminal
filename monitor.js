#!/usr/bin/env node
/**
 * Web Terminal Server Monitor (Phase 5: worker + web supervisor)
 *
 * Supervises TWO children independently:
 *   - pty-worker.js (owns PTY state — must survive web.js restarts)
 *   - server.js / web.js (HTTP + WS front end — reloadable)
 *
 * Features:
 *   - Log files with rotation (stdout + stderr per child)
 *   - Independent crash detection and restart with backoff per child
 *   - Crash budget per child (stops that child after N crashes in window)
 *   - Status file showing both processes (PIDs, uptimes, restart counts)
 *   - Crash diagnostics saved to logs/crashes.json
 *   - Graceful shutdown: stops web first, then worker
 *
 * Policy:
 *   - Worker crashes → kill web (stale IPC), respawn worker, then respawn web
 *   - Web crashes   → respawn web only; PTYs keep running in the worker
 *
 * Usage: node monitor.js   (preferred via start-server.vbs)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const ipc = require('./lib/ipc');

// --- Config ---
const WORKER_SCRIPT = path.join(__dirname, 'pty-worker.js');
const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const LOG_DIR = path.join(__dirname, 'logs');
const STATUS_FILE = process.env.WT_MONITOR_STATUS_FILE || path.join(__dirname, 'monitor-status.json');
const CRASH_LOG = path.join(LOG_DIR, 'crashes.json');
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_LOG_FILES = 3;
const HEALTH_CHECK_INTERVAL = 30000;
const HEALTH_CHECK_TIMEOUT = 5000;
const CRASH_BUDGET_WINDOW = 5 * 60 * 1000; // 5 minutes
const CRASH_BUDGET_MAX = parseInt(process.env.WT_MONITOR_CRASH_BUDGET) || 5;
// Backoff can be tuned for tests via env vars.
const BACKOFF_INITIAL = parseInt(process.env.WT_MONITOR_BACKOFF_INITIAL) || 2000;
const BACKOFF_MAX = parseInt(process.env.WT_MONITOR_BACKOFF_MAX) || 30000;
const BACKOFF_MULTIPLIER = parseFloat(process.env.WT_MONITOR_BACKOFF_MULT) || 2;
const WORKER_READY_TIMEOUT = 20000;        // wait up to 20s for pipe to accept a connection
const WORKER_READY_RETRY_MS = 150;

const WORKER_PIPE = process.env.WT_WORKER_PIPE || (
  process.platform === 'win32'
    ? '\\\\.\\pipe\\web-terminal-pty'
    : '/tmp/web-terminal-pty.sock'
);

// Issue #18: generate a random shared-secret token for the worker/web IPC
// handshake (defense in depth on top of OS ACLs). Monitor generates once,
// both children inherit via env var. If an outer process already exported
// WT_IPC_TOKEN (unusual — only tests do this), preserve it so inter-process
// coordination keeps working. Never log the token.
const WORKER_IPC_TOKEN = process.env[ipc.ENV_TOKEN_VAR] || ipc.generateToken();

// --- State: per-child bookkeeping --------------------------------------------
function makeChildState(name, logFile) {
  return {
    name,
    logFile,
    proc: null,
    startedAt: null,           // last start time
    restarts: 0,
    totalCrashes: 0,
    lastCrash: null,           // { time, exitCode, signal, error }
    crashTimestamps: [],       // for budget
    backoffDelay: BACKOFF_INITIAL,
    recentStderr: '',
    stoppedForever: false,     // crash budget exceeded or port-in-use
    stoppedReason: null,
    // Used to coordinate restarts: when worker crashes, web's exit is an expected
    // consequence, not a crash. This flag suppresses web's crash handling for one exit.
    expectedExit: false,
  };
}

const worker = makeChildState('worker', path.join(LOG_DIR, 'worker.log'));
const web = makeChildState('web', path.join(LOG_DIR, 'server.log'));

let stopping = false;
let startedAt = Date.now();
let healthTimer = null;

// --- Ensure log directory ----------------------------------------------------
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// --- Log rotation ------------------------------------------------------------
function rotateLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return;
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? logPath : `${logPath}.${i}`;
      const to = `${logPath}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > MAX_LOG_FILES) fs.unlinkSync(from);
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (e) {
    console.error(`[monitor] Log rotation failed: ${e.message}`);
  }
}

function appendLog(logPath, data) {
  rotateLog(logPath);
  const timestamp = new Date().toISOString();
  const lines = data.toString().split('\n').filter(l => l.trim());
  const stamped = lines.map(l => `[${timestamp}] ${l}`).join('\n') + '\n';
  try { fs.appendFileSync(logPath, stamped, 'utf8'); } catch {}
}

function monitorLog(msg) {
  console.log(`[monitor] ${msg}`);
  appendLog(path.join(LOG_DIR, 'monitor.log'), msg);
}

// --- Crash log ---------------------------------------------------------------
function saveCrash(child, exitCode, signal, errorOutput) {
  const crashes = loadCrashes();
  crashes.push({
    time: new Date().toISOString(),
    child: child.name,
    exitCode,
    signal,
    error: (errorOutput || '').slice(-2000),
    uptime: child.startedAt ? Date.now() - child.startedAt : 0,
    restartCount: child.restarts,
  });
  while (crashes.length > 40) crashes.shift();
  try { fs.writeFileSync(CRASH_LOG, JSON.stringify(crashes, null, 2), 'utf8'); } catch {}
}

function loadCrashes() {
  try {
    if (fs.existsSync(CRASH_LOG)) return JSON.parse(fs.readFileSync(CRASH_LOG, 'utf8'));
  } catch {}
  return [];
}

// --- Status file -------------------------------------------------------------
function serializeChild(c) {
  return {
    pid: c.proc?.pid || null,
    startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null,
    uptime: c.startedAt ? Date.now() - c.startedAt : 0,
    restarts: c.restarts,
    totalCrashes: c.totalCrashes,
    lastCrash: c.lastCrash ? {
      time: new Date(c.lastCrash.time).toISOString(),
      exitCode: c.lastCrash.exitCode,
      signal: c.lastCrash.signal,
      error: (c.lastCrash.error || '').slice(-500),
    } : null,
    stoppedForever: c.stoppedForever,
    stoppedReason: c.stoppedReason,
  };
}

function writeStatus(overallStatus, extra) {
  const data = {
    status: overallStatus,
    monitorStartedAt: new Date(startedAt).toISOString(),
    monitorUptime: Date.now() - startedAt,
    workerPipe: WORKER_PIPE,
    worker: serializeChild(worker),
    web: serializeChild(web),
    // Back-compat (legacy single-child fields): mirror web's state so existing
    // consumers keep working.
    pid: web.proc?.pid || null,
    startedAt: web.startedAt ? new Date(web.startedAt).toISOString() : null,
    uptime: web.startedAt ? Date.now() - web.startedAt : 0,
    totalRestarts: web.restarts,
    lastCrash: web.lastCrash ? {
      time: new Date(web.lastCrash.time).toISOString(),
      exitCode: web.lastCrash.exitCode,
      error: (web.lastCrash.error || '').slice(-500),
    } : null,
    ...(extra || {}),
  };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// --- Worker readiness probe --------------------------------------------------
// Resolve as soon as the pipe accepts a connection (we don't hold it open).
function waitForPipeReady(pipe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (stopping) return reject(new Error('stopping'));
      if (!worker.proc || worker.proc.exitCode !== null) {
        return reject(new Error('worker process exited before pipe came up'));
      }
      const sock = net.createConnection(pipe);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch {}
        if (err) {
          if (Date.now() > deadline) return reject(new Error(`worker pipe not ready after ${timeoutMs}ms: ${err.message}`));
          setTimeout(attempt, WORKER_READY_RETRY_MS);
        } else {
          resolve();
        }
      };
      sock.once('connect', () => done());
      sock.once('error', (e) => done(e));
    };
    attempt();
  });
}

// --- Spawn helpers -----------------------------------------------------------
function spawnWorker() {
  if (stopping || worker.stoppedForever) return;
  worker.startedAt = Date.now();
  worker.recentStderr = '';
  monitorLog(`starting worker (restart #${worker.restarts}) pipe=${WORKER_PIPE}`);

  const proc = spawn(process.execPath, [WORKER_SCRIPT], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WT_WORKER_PIPE: WORKER_PIPE,
      // Issue #18: share the handshake token with the worker. Never logged.
      [ipc.ENV_TOKEN_VAR]: WORKER_IPC_TOKEN,
    },
    windowsHide: true,
  });
  worker.proc = proc;

  proc.stdout.on('data', (data) => {
    process.stdout.write(data);
    appendLog(worker.logFile, data);
  });
  proc.stderr.on('data', (data) => {
    process.stderr.write(data);
    appendLog(path.join(LOG_DIR, 'error.log'), `[worker] ` + data);
    worker.recentStderr += data.toString();
    if (worker.recentStderr.length > 5000) worker.recentStderr = worker.recentStderr.slice(-5000);
  });

  proc.on('exit', (code, signal) => {
    const uptime = Date.now() - worker.startedAt;
    const msg = `worker exited: code=${code} signal=${signal} uptime=${Math.round(uptime / 1000)}s`;
    monitorLog(msg);
    worker.proc = null;

    if (stopping) {
      writeStatus('stopped');
      return;
    }

    // Worker died unexpectedly — web's IPC is broken; kill web so we can cleanly
    // respawn both in order. Web will likely already be exiting on its own
    // (onExit handler) but we force the issue to avoid a long race.
    if (web.proc) {
      web.expectedExit = true;
      monitorLog('killing web because worker is gone (IPC dead)');
      try { web.proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (web.proc) web.proc.kill('SIGKILL'); } catch {} }, 2500).unref();
    }

    // Clean exit code 0 → intentional restart
    if (code === 0) {
      worker.backoffDelay = BACKOFF_INITIAL;
      worker.restarts++;
      writeStatus('restarting', { reason: 'worker clean restart' });
      setTimeout(() => { spawnWorker(); scheduleWebAfterWorker(); }, BACKOFF_INITIAL);
      return;
    }

    // Crash
    worker.totalCrashes++;
    worker.restarts++;
    worker.lastCrash = { time: Date.now(), exitCode: code, signal, error: worker.recentStderr };
    saveCrash(worker, code, signal, worker.recentStderr);
    worker.crashTimestamps.push(Date.now());
    worker.crashTimestamps = worker.crashTimestamps.filter(t => Date.now() - t < CRASH_BUDGET_WINDOW);

    if (worker.crashTimestamps.length >= CRASH_BUDGET_MAX) {
      monitorLog(`worker crash budget exceeded (${CRASH_BUDGET_MAX} in ${CRASH_BUDGET_WINDOW/1000}s) — stopping`);
      worker.stoppedForever = true;
      worker.stoppedReason = `${CRASH_BUDGET_MAX} crashes in ${CRASH_BUDGET_WINDOW/1000}s`;
      writeStatus('crashed', { reason: 'worker crash budget exceeded' });
      stopping = true;
      // Also kill web if alive
      if (web.proc) { try { web.proc.kill('SIGTERM'); } catch {} }
      return;
    }

    const delay = worker.backoffDelay;
    worker.backoffDelay = Math.min(worker.backoffDelay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
    writeStatus('restarting', { reason: `worker crash (code ${code})`, nextAttemptIn: delay });
    monitorLog(`worker crash restart in ${delay}ms (crash ${worker.crashTimestamps.length}/${CRASH_BUDGET_MAX})`);
    setTimeout(() => { spawnWorker(); scheduleWebAfterWorker(); }, delay);
  });
}

// Spawn web once worker is ready. Used after worker (re)starts.
async function scheduleWebAfterWorker() {
  if (stopping) return;
  try {
    await waitForPipeReady(WORKER_PIPE, WORKER_READY_TIMEOUT);
  } catch (err) {
    monitorLog(`worker pipe wait failed: ${err.message}`);
    // If worker died before pipe came up its exit handler will recover.
    return;
  }
  if (stopping) return;
  // Ensure any previous web process has fully exited before spawning a new one.
  // (On worker crash we kill web; its exit event is asynchronous.)
  const waitForPrior = async () => {
    const deadline = Date.now() + 5000;
    while (web.proc && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
  };
  await waitForPrior();
  if (stopping) return;
  spawnWeb();
}

function spawnWeb() {
  if (stopping || web.stoppedForever) return;
  if (web.proc) return; // already running
  web.startedAt = Date.now();
  web.recentStderr = '';
  web.expectedExit = false;
  monitorLog(`starting web (restart #${web.restarts})`);

  const proc = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WT_WORKER_PIPE: WORKER_PIPE,
      // Issue #18: same handshake token as the worker.
      [ipc.ENV_TOKEN_VAR]: WORKER_IPC_TOKEN,
      // Make sure server.js does NOT also spawn its own worker — we own it.
      WT_SPAWN_WORKER: '',
    },
    windowsHide: true,
  });
  web.proc = proc;
  writeStatus('running');

  proc.stdout.on('data', (data) => {
    process.stdout.write(data);
    appendLog(web.logFile, data);
  });
  proc.stderr.on('data', (data) => {
    process.stderr.write(data);
    appendLog(path.join(LOG_DIR, 'error.log'), data);
    web.recentStderr += data.toString();
    if (web.recentStderr.length > 5000) web.recentStderr = web.recentStderr.slice(-5000);
  });

  proc.on('exit', (code, signal) => {
    const uptime = Date.now() - web.startedAt;
    const msg = `web exited: code=${code} signal=${signal} uptime=${Math.round(uptime / 1000)}s`;
    monitorLog(msg);
    web.proc = null;

    if (stopping) {
      writeStatus('stopped');
      return;
    }

    // Expected exit (worker crash is triggering the restart cycle) — skip crash
    // accounting. Worker's exit handler already scheduled scheduleWebAfterWorker.
    if (web.expectedExit) {
      web.expectedExit = false;
      monitorLog('web exit was expected (worker crash) — not counting as crash');
      return;
    }

    // Clean exit (restart via /api/restart) → start back up quickly
    if (code === 0) {
      web.backoffDelay = BACKOFF_INITIAL;
      web.restarts++;
      writeStatus('restarting', { reason: 'web clean restart' });
      setTimeout(spawnWeb, BACKOFF_INITIAL);
      return;
    }

    // Port conflict — another instance is running
    if (code === 2) {
      monitorLog('web: port in use — stopping');
      web.stoppedForever = true;
      web.stoppedReason = 'port in use';
      writeStatus('stopped', { reason: 'port in use — another instance running' });
      stopping = true;
      return;
    }

    // Crash
    web.totalCrashes++;
    web.restarts++;
    web.lastCrash = { time: Date.now(), exitCode: code, signal, error: web.recentStderr };
    saveCrash(web, code, signal, web.recentStderr);
    web.crashTimestamps.push(Date.now());
    web.crashTimestamps = web.crashTimestamps.filter(t => Date.now() - t < CRASH_BUDGET_WINDOW);

    if (web.crashTimestamps.length >= CRASH_BUDGET_MAX) {
      monitorLog(`web crash budget exceeded (${CRASH_BUDGET_MAX} in ${CRASH_BUDGET_WINDOW/1000}s) — stopping`);
      web.stoppedForever = true;
      web.stoppedReason = `${CRASH_BUDGET_MAX} crashes in ${CRASH_BUDGET_WINDOW/1000}s`;
      writeStatus('crashed', { reason: 'web crash budget exceeded' });
      // Do NOT stop the monitor — worker keeps running so PTYs survive.
      return;
    }

    const delay = web.backoffDelay;
    web.backoffDelay = Math.min(web.backoffDelay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
    writeStatus('restarting', { reason: `web crash (code ${code})`, nextAttemptIn: delay });
    monitorLog(`web crash restart in ${delay}ms (crash ${web.crashTimestamps.length}/${CRASH_BUDGET_MAX})`);
    setTimeout(spawnWeb, delay);
  });
}

// --- Health check (web only) -------------------------------------------------
function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    if (!web.proc || stopping) return;
    let port = 7681;
    try {
      const cfgFile = process.env.WT_TEST ? path.join(__dirname, 'config.test.json') : path.join(__dirname, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      port = parseInt(process.env.WT_PORT) || cfg.port || 7681;
    } catch {}
    const req = http.get(`http://127.0.0.1:${port}/api/hostname`, { timeout: HEALTH_CHECK_TIMEOUT }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {});
    });
    req.on('error', (e) => {
      monitorLog(`health check failed: ${e.message}`);
    });
    req.on('timeout', () => {
      req.destroy();
      monitorLog('health check timed out');
    });
  }, HEALTH_CHECK_INTERVAL);
  healthTimer.unref?.();
}

// --- Graceful shutdown -------------------------------------------------------
function shutdown(signal) {
  if (stopping) return;
  monitorLog(`received ${signal}, shutting down...`);
  stopping = true;
  if (healthTimer) clearInterval(healthTimer);

  const killTree = async () => {
    // 1) Stop web first so it can flush session state to worker
    if (web.proc) {
      try { web.proc.kill('SIGTERM'); } catch {}
      await waitForExit(web.proc, 5000);
      if (web.proc) { try { web.proc.kill('SIGKILL'); } catch {} }
    }
    // 2) Then stop worker
    if (worker.proc) {
      try { worker.proc.kill('SIGTERM'); } catch {}
      await waitForExit(worker.proc, 5000);
      if (worker.proc) { try { worker.proc.kill('SIGKILL'); } catch {} }
    }
    writeStatus('stopped');
    process.exit(0);
  };
  killTree().catch(() => process.exit(0));
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
    proc.once('exit', () => { if (!done) { done = true; clearTimeout(t); resolve(); } });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

// Windows-friendly shutdown channel: a parent process (tests, CLI) can write
// `shutdown\n` to the monitor's stdin to trigger a graceful stop, since
// `proc.kill('SIGTERM')` on Windows forcefully terminates instead of invoking
// the SIGTERM handler. Enabled only when WT_MONITOR_STDIN_SHUTDOWN=1 so the
// VBS launcher (which redirects stdin from NUL) isn't affected.
if (process.env.WT_MONITOR_STDIN_SHUTDOWN === '1' && process.stdin) {
  let stdinBuf = '';
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk.toString('utf8');
    if (/\b(shutdown|stop|quit)\b/i.test(stdinBuf)) {
      stdinBuf = '';
      shutdown('stdin-shutdown');
    }
  });
  process.stdin.on('end', () => shutdown('stdin-closed'));
  try { process.stdin.resume(); } catch {}
}

// --- Capture monitor's own death so the next launch has a tombstone ---------
// Without these handlers an uncaughtException/unhandledRejection prints to a
// stderr the VBS launcher discards, leaving zero evidence of why the supervisor
// died. We log a final line to monitor.log + crashes.json before exiting.
function logMonitorDeath(reason, err) {
  try {
    const detail = err ? (err.stack || err.message || String(err)) : '';
    monitorLog(`MONITOR DYING (${reason})${detail ? ': ' + detail : ''}`);
    const crashes = loadCrashes();
    crashes.push({
      time: new Date().toISOString(),
      child: 'monitor',
      exitCode: typeof process.exitCode === 'number' ? process.exitCode : null,
      signal: null,
      error: (detail || reason).slice(-2000),
      uptime: Date.now() - startedAt,
      restartCount: 0,
    });
    while (crashes.length > 40) crashes.shift();
    fs.writeFileSync(CRASH_LOG, JSON.stringify(crashes, null, 2), 'utf8');
    try { writeStatus('crashed', { reason: `monitor: ${reason}` }); } catch {}
  } catch {}
}

process.on('uncaughtException', (err) => {
  logMonitorDeath('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logMonitorDeath('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});
process.on('exit', (code) => {
  try { monitorLog(`monitor exit code=${code} uptime=${Math.round((Date.now() - startedAt) / 1000)}s`); } catch {}
});

// --- Periodic status refresh (so uptime stays current) -----------------------
const statusRefresh = setInterval(() => {
  if (!stopping) writeStatus('running');
}, 5000);
statusRefresh.unref?.();

// --- Start -------------------------------------------------------------------
console.log('[monitor] Web Terminal Monitor starting...');
console.log(`[monitor] Logs: ${LOG_DIR}`);
console.log(`[monitor] Status: ${STATUS_FILE}`);
console.log(`[monitor] Worker pipe: ${WORKER_PIPE}`);
console.log(`[monitor] Crash budget (per child): ${CRASH_BUDGET_MAX} crashes per ${CRASH_BUDGET_WINDOW / 1000}s`);
writeStatus('starting');
spawnWorker();
scheduleWebAfterWorker();
startHealthCheck();
