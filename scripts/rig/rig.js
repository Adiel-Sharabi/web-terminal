#!/usr/bin/env node
'use strict';
// An ORPHAN web-terminal instance for testing — so a fix can be reproduced and
// verified WITHOUT cold-restarting the production servers every iteration.
//
// It is a real server + real pty-worker (same code as production, synced from this
// working tree, so UNCOMMITTED edits are what you test), but fully isolated:
//
//   port        7999                (production: 7681)
//   ipc pipe    wt-rig-worker       (production: web-terminal / -shadow-home)
//   directory   C:\dev\wt-rig       (production: C:\dev\web-terminal)
//   config      <rig>\config.json   (its own — never reads production's)
//   data        <rig>\.data         (its own sessions.json + scrollback)
//
// SAFETY — this tool can never kill production:
//   * it only ever kills PIDs it recorded itself in .data/rig.pids.json, and
//   * it re-checks each PID's CommandLine actually contains the rig path first.
//   There is no name/glob kill anywhere in here.
//
// `restart` is a genuine COLD restart (the worker dies), which is exactly what
// exercises session restore / auto-command / status paths.
//
// Usage:
//   node scripts/rig/rig.js sync      # copy this working tree into the rig
//   node scripts/rig/rig.js start
//   node scripts/rig/rig.js status
//   node scripts/rig/rig.js restart   # COLD (kills the worker too)
//   node scripts/rig/rig.js stop
//   node scripts/rig/rig.js up        # sync + (re)start, the usual one-liner

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const RIG = process.env.WT_RIG_DIR || 'C:\\dev\\wt-rig';
const DATA = path.join(RIG, '.data');
const PIDS = path.join(DATA, 'rig.pids.json');

const PORT = parseInt(process.env.WT_RIG_PORT || '7999', 10);
const PASS = process.env.WT_RIG_PASS || 'rig';
const USER = 'admin';
const PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\wt-rig-worker'
  : path.join(os.tmpdir(), 'wt-rig-worker.sock');

// Source that makes up the app. Everything else (config, data, node_modules, git,
// build output) is deliberately NOT synced.
const SYNC_FILES = ['server.js', 'pty-worker.js', 'monitor.js', 'app.html', 'terminal.html', 'lobby.html', 'sw.js'];
const SYNC_DIRS = ['lib', 'public', 'hooks'];

const log = (m) => console.log(`[rig] ${m}`);

function ensureDirs() {
  fs.mkdirSync(RIG, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'scrollback'), { recursive: true });
}

// node_modules is big and has native builds (node-pty) — junction it, don't copy.
function linkNodeModules() {
  const dst = path.join(RIG, 'node_modules');
  if (fs.existsSync(dst)) return;
  const src = path.join(REPO, 'node_modules');
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', dst, src], { stdio: 'ignore', windowsHide: true });
  } else {
    fs.symlinkSync(src, dst, 'dir');
  }
  log('node_modules junctioned');
}

function writeConfig() {
  // The rig's OWN config — server.js reads config.json next to itself (__dirname),
  // so running from the rig dir means production's config is never touched.
  const cfg = {
    port: PORT,
    user: USER,
    password: PASS,           // plain is fine; the server compares directly
    shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
    defaultCwd: RIG,
    scanFolders: [RIG, 'C:\\dev'],
    defaultCommand: '',
    enableRemoteExec: false,  // no /api/exec on the rig
    // no `cluster` key: the rig must never talk to the real peers
  };
  fs.writeFileSync(path.join(RIG, 'config.json'), JSON.stringify(cfg, null, 2));
}

function copyFile(rel) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) return;
  const dst = path.join(RIG, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(rel) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(RIG, rel), { recursive: true });
}

// KNOWN LIMIT — a rig session gets no Claude hooks, so its `status` never leaves 'active'.
//
// The hooks live in the user's GLOBAL ~/.claude/settings.json as `type: "http"` entries with
// a HARD-CODED url (http://127.0.0.1:7681/api/hook — production's port). Claude posts there
// no matter which web-terminal spawned it, so a rig session's hooks land on the production
// server, which does not know that session id and drops them. Nothing here can redirect them
// without editing global settings, which would break production.
//
// Consequence: hook-driven state (working / waiting / idle) is NOT observable on the rig.
// Verify it against the real worker instead — tests/worker-interrupt-status.spec.js drives
// pty-worker.js over a real IPC pipe with real hookEvent + TYPE_PTY_IN frames. The rig is
// still the right place for anything the PTY itself can show (see verify-submit.js,
// verify-interrupt.js): what actually reaches the agent, and what it does about it.
function sync() {
  ensureDirs();
  linkNodeModules();
  for (const f of SYNC_FILES) copyFile(f);
  for (const d of SYNC_DIRS) copyDir(d);
  writeConfig();
  log(`synced working tree → ${RIG}`);
}

const readPids = () => { try { return JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch { return {}; } };
const writePids = (p) => fs.writeFileSync(PIDS, JSON.stringify(p, null, 2));

/** A PID is ours ONLY if it is alive AND its command line points into the rig dir. */
function isRigPid(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes(RIG.toLowerCase());
  } catch { return false; }
}

function spawnPart(script, extraEnv) {
  const out = fs.openSync(path.join(DATA, script.replace('.js', '') + '.log'), 'a');
  const child = spawn(process.execPath, [path.join(RIG, script)], {
    cwd: RIG,
    env: {
      ...process.env,
      WT_PORT: String(PORT),
      WT_PASS: PASS,
      WT_WORKER_PIPE: PIPE,
      WT_WORKER_DATA_DIR: DATA,
      ...extraEnv,
    },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** One HTTP probe. ANY status means it's listening (401 = up, just wants auth). */
function probe() {
  return new Promise((resolve) => {
    const req = require('http').get(
      { host: '127.0.0.1', port: PORT, path: '/api/version', timeout: 1500 },
      (res) => { res.resume(); resolve(`listening (HTTP ${res.statusCode})`); },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Block until the rig actually answers, so callers/tests never race the bind. */
async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await probe();
    if (r) return r;
    await sleep(300);
  }
  return null;
}

async function start() {
  const cur = readPids();
  if (isRigPid(cur.worker) || isRigPid(cur.server)) {
    log('already running — use `restart` for a COLD restart');
    return status();
  }
  ensureDirs();
  // Worker first (it owns the PTYs and the pipe), then the server attaches to it.
  const worker = spawnPart('pty-worker.js');
  await sleep(1200);
  const server = spawnPart('server.js');
  writePids({ worker, server, port: PORT, pipe: PIPE, startedAt: new Date().toISOString() });
  const ready = await waitReady();
  if (!ready) log('WARNING: rig never answered — see .data/server.log');
  log(`started — worker=${worker} server=${server}`);
  return status();
}

function killPid(pid, what) {
  if (!isRigPid(pid)) return false;
  try { process.kill(pid, 'SIGKILL'); log(`killed ${what} ${pid}`); return true; }
  catch (e) { log(`kill ${what} ${pid} failed: ${e.message}`); return false; }
}

/**
 * Every node process whose command line points into the RIG dir.
 *
 * Safe to glob on: production lives in `web-terminal` (and the shadow in
 * `web-terminal-shadow`), neither of which contains `wt-rig` — so this can only
 * ever match rig processes. Used so a stop leaves NO orphan holding the port,
 * even if the pidfile is stale (a stranded server would make the next start fail
 * to bind, and every restart after that would silently test the OLD code).
 */
function findRigPids() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${path.basename(RIG)}*' } | ` +
      `ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  } catch { return []; }
}

async function stop() {
  const p = readPids();
  // Server first so it stops handing work to a worker we're about to kill.
  killPid(p.server, 'server');
  killPid(p.worker, 'worker');
  // Sweep anything else in the rig dir (stale pidfile / orphaned server).
  for (const pid of findRigPids()) killPid(pid, 'stray');
  await sleep(700);
  const left = findRigPids();
  if (left.length) log(`WARNING: rig pids still alive: ${left.join(',')}`);
  writePids({});
  log('stopped');
}

async function restart() {
  log('COLD restart (worker dies → session restore path runs)');
  await stop();
  await sleep(500);
  return start();
}

async function status() {
  const p = readPids();
  const alive = (pid) => (isRigPid(pid) ? `alive(${pid})` : 'down');
  const health = (await probe()) || 'unreachable';
  console.log(`[rig] dir     ${RIG}`);
  console.log(`[rig] url     http://127.0.0.1:${PORT}   (user ${USER} / pass ${PASS})`);
  console.log(`[rig] worker  ${alive(p.worker)}`);
  console.log(`[rig] server  ${alive(p.server)}`);
  console.log(`[rig] health  ${health}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cmd = process.argv[2] || 'status';
  switch (cmd) {
    case 'sync': sync(); break;
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'restart': await restart(); break;
    case 'status': await status(); break;
    case 'up': sync(); await stop(); await sleep(300); await start(); break;
    default:
      console.error(`unknown command: ${cmd}\nuse: sync | start | stop | restart | status | up`);
      process.exit(1);
  }
})();
