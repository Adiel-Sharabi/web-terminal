#!/usr/bin/env node
/**
 * Web Terminal Server Monitor
 *
 * Wraps server.js as a child process with:
 * - Log files with rotation (stdout + stderr)
 * - Smart restart with exponential backoff
 * - Crash budget (stops after repeated crashes)
 * - Health check (HTTP ping)
 * - Status file for dashboard visibility
 * - Crash diagnostics saved to logs/crashes.json
 *
 * Usage: node monitor.js
 * Instead of: node server.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// --- Config ---
const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const LOG_DIR = path.join(__dirname, 'logs');
const STATUS_FILE = path.join(__dirname, 'monitor-status.json');
const CRASH_LOG = path.join(LOG_DIR, 'crashes.json');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per log file
const MAX_LOG_FILES = 3; // keep 3 rotated copies
const HEALTH_CHECK_INTERVAL = 30000; // 30s
const HEALTH_CHECK_TIMEOUT = 5000; // 5s
const CRASH_BUDGET_WINDOW = 5 * 60 * 1000; // 5 minutes
const CRASH_BUDGET_MAX = 5; // max crashes in window before stopping
const BACKOFF_INITIAL = 2000; // 2s
const BACKOFF_MAX = 30000; // 30s
const BACKOFF_MULTIPLIER = 2;

// --- State ---
let serverProcess = null;
let restartCount = 0;
let totalRestarts = 0;
let lastStartTime = null;
let lastCrashTime = null;
let lastCrashCode = null;
let lastCrashError = '';
let backoffDelay = BACKOFF_INITIAL;
let crashTimestamps = [];
let healthTimer = null;
let stopping = false;
let startedAt = Date.now();

// --- Ensure log directory ---
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// --- Log rotation ---
function rotateLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return;

    // Shift old logs: .2 -> .3, .1 -> .2, current -> .1
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
  fs.appendFileSync(logPath, stamped, 'utf8');
}

// --- Crash log ---
function saveCrash(exitCode, signal, errorOutput) {
  const crashes = loadCrashes();
  crashes.push({
    time: new Date().toISOString(),
    exitCode,
    signal,
    error: errorOutput.slice(-2000), // last 2KB of stderr
    uptime: lastStartTime ? Date.now() - lastStartTime : 0,
    restartCount: totalRestarts
  });
  // Keep last 20 crashes
  while (crashes.length > 20) crashes.shift();
  try {
    fs.writeFileSync(CRASH_LOG, JSON.stringify(crashes, null, 2), 'utf8');
  } catch (e) {}
}

function loadCrashes() {
  try {
    if (fs.existsSync(CRASH_LOG)) return JSON.parse(fs.readFileSync(CRASH_LOG, 'utf8'));
  } catch (e) {}
  return [];
}

// --- Status file ---
function writeStatus(status, extra) {
  const data = {
    status,
    pid: serverProcess?.pid || null,
    startedAt: new Date(startedAt).toISOString(),
    uptime: lastStartTime ? Date.now() - lastStartTime : 0,
    totalRestarts,
    lastCrash: lastCrashTime ? {
      time: new Date(lastCrashTime).toISOString(),
      exitCode: lastCrashCode,
      error: lastCrashError.slice(-500)
    } : null,
    ...extra
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

// --- Health check ---
function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    if (!serverProcess || stopping) return;

    // Read port from config
    let port = 7681;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      port = cfg.port || 7681;
    } catch (e) {}

    const req = http.get(`http://127.0.0.1:${port}/api/hostname`, { timeout: HEALTH_CHECK_TIMEOUT }, (res) => {
      // Server responded — healthy
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {});
    });

    req.on('error', (e) => {
      console.error(`[monitor] Health check failed: ${e.message}`);
      appendLog(path.join(LOG_DIR, 'monitor.log'), `Health check failed: ${e.message}`);
      // Don't auto-restart on health check failure — could be temporary
      // Just log it for diagnostics
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[monitor] Health check timed out');
      appendLog(path.join(LOG_DIR, 'monitor.log'), 'Health check timed out');
    });
  }, HEALTH_CHECK_INTERVAL);
}

// --- Server process management ---
function startServer() {
  if (stopping) return;

  lastStartTime = Date.now();
  let recentStderr = '';

  console.log(`[monitor] Starting server (restart #${totalRestarts})...`);
  appendLog(path.join(LOG_DIR, 'monitor.log'), `Starting server (restart #${totalRestarts})`);

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  });

  writeStatus('running');

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(data); // mirror to console
    appendLog(path.join(LOG_DIR, 'server.log'), data);
  });

  serverProcess.stderr.on('data', (data) => {
    process.stderr.write(data); // mirror to console
    appendLog(path.join(LOG_DIR, 'error.log'), data);
    recentStderr += data.toString();
    if (recentStderr.length > 5000) recentStderr = recentStderr.slice(-5000);
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    const uptime = Date.now() - lastStartTime;
    const msg = `Server exited: code=${code} signal=${signal} uptime=${Math.round(uptime / 1000)}s`;
    console.log(`[monitor] ${msg}`);
    appendLog(path.join(LOG_DIR, 'monitor.log'), msg);

    if (stopping) {
      writeStatus('stopped');
      return;
    }

    // Clean exit (code 0) = intentional restart (API restart)
    if (code === 0) {
      backoffDelay = BACKOFF_INITIAL;
      totalRestarts++;
      writeStatus('restarting', { reason: 'clean restart' });
      console.log(`[monitor] Clean restart in ${BACKOFF_INITIAL}ms...`);
      setTimeout(startServer, BACKOFF_INITIAL);
      return;
    }

    // Port conflict — another instance is running, don't restart
    if (code === 2) {
      console.error('[monitor] Port already in use — another instance is running. Stopping.');
      appendLog(path.join(LOG_DIR, 'monitor.log'), 'Port in use — stopping (another instance is running).');
      writeStatus('stopped', { reason: 'port in use — another instance running' });
      stopping = true;
      return;
    }

    // Crash
    lastCrashTime = Date.now();
    lastCrashCode = code;
    lastCrashError = recentStderr;
    totalRestarts++;
    saveCrash(code, signal, recentStderr);

    // Check crash budget
    crashTimestamps.push(Date.now());
    crashTimestamps = crashTimestamps.filter(t => Date.now() - t < CRASH_BUDGET_WINDOW);

    if (crashTimestamps.length >= CRASH_BUDGET_MAX) {
      console.error(`[monitor] Crash budget exceeded (${CRASH_BUDGET_MAX} crashes in ${CRASH_BUDGET_WINDOW / 1000}s). Stopping.`);
      appendLog(path.join(LOG_DIR, 'monitor.log'), `CRASH BUDGET EXCEEDED — stopping. Fix the code and restart manually.`);
      writeStatus('crashed', { reason: `${CRASH_BUDGET_MAX} crashes in ${CRASH_BUDGET_WINDOW / 1000}s` });
      stopping = true;
      return;
    }

    writeStatus('restarting', { reason: `crash (code ${code})`, nextAttemptIn: backoffDelay });
    console.log(`[monitor] Crash restart in ${backoffDelay}ms (attempt ${crashTimestamps.length}/${CRASH_BUDGET_MAX})...`);
    setTimeout(startServer, backoffDelay);
    backoffDelay = Math.min(backoffDelay * BACKOFF_MULTIPLIER, BACKOFF_MAX);
  });

  startHealthCheck();
}

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[monitor] Received ${signal}, shutting down...`);
  stopping = true;
  if (healthTimer) clearInterval(healthTimer);
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess) {
        console.log('[monitor] Force killing server...');
        serverProcess.kill('SIGKILL');
      }
      writeStatus('stopped');
      process.exit(0);
    }, 5000);
  } else {
    writeStatus('stopped');
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Start ---
console.log('[monitor] Web Terminal Monitor starting...');
console.log(`[monitor] Logs: ${LOG_DIR}`);
console.log(`[monitor] Status: ${STATUS_FILE}`);
console.log(`[monitor] Crash budget: ${CRASH_BUDGET_MAX} crashes per ${CRASH_BUDGET_WINDOW / 1000}s`);
startServer();
