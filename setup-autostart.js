#!/usr/bin/env node
/**
 * Setup web-terminal auto-start for Windows.
 *
 * Creates a Startup folder shortcut that launches start-server.vbs
 * when the user logs in. This ensures the server runs in the user's
 * desktop session (SI=1+), NOT Session 0 — which is critical because
 * ConPTY has severe output buffering (~1-2s delays) in Session 0.
 *
 * Also removes any old scheduled tasks that used S4U (Session 0).
 *
 * Usage: node setup-autostart.js [--remove]
 *   --remove   Remove auto-start (delete shortcut and scheduled tasks)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = __dirname;
const VBS_PATH = path.join(PROJECT_DIR, 'start-server.vbs');
const STARTUP_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const SHORTCUT_NAME = 'WebTerminal.lnk';
const SHORTCUT_PATH = path.join(STARTUP_DIR, SHORTCUT_NAME);
const OLD_TASK_NAMES = ['WebTerminal-7681', 'web-terminal', 'WebTerminal'];

const removing = process.argv.includes('--remove');

function log(msg) { console.log(`[setup] ${msg}`); }

// --- Remove old scheduled tasks (S4U / Session 0) ---
function removeOldTasks() {
  for (const name of OLD_TASK_NAMES) {
    try {
      // Check if task exists
      execSync(`schtasks /query /TN "${name}" >nul 2>&1`, { windowsHide: true });
      log(`Removing scheduled task: ${name}`);
      execSync(`schtasks /delete /TN "${name}" /F`, { windowsHide: true });
      log(`  Removed.`);
    } catch {
      // Task doesn't exist — fine
    }
  }
}

// --- Create Startup shortcut ---
function createShortcut() {
  if (!fs.existsSync(VBS_PATH)) {
    log(`ERROR: ${VBS_PATH} not found. Cannot create shortcut.`);
    process.exit(1);
  }

  // Write a temp PowerShell script to create the shortcut (avoids escaping issues)
  const psScript = path.join(PROJECT_DIR, '_create-shortcut.ps1');
  const psContent = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut("${SHORTCUT_PATH}")`,
    `$sc.TargetPath = "${process.env.SystemRoot}\\System32\\wscript.exe"`,
    `$sc.Arguments = '""${VBS_PATH}""'`,
    `$sc.WorkingDirectory = "${PROJECT_DIR}"`,
    `$sc.Description = "Web Terminal Server (auto-start)"`,
    `$sc.WindowStyle = 7`,
    `$sc.Save()`,
  ].join('\r\n');

  try {
    fs.writeFileSync(psScript, psContent, 'utf8');
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, { windowsHide: true });
    log(`Created Startup shortcut: ${SHORTCUT_PATH}`);
  } catch (e) {
    log(`ERROR creating shortcut: ${e.message}`);
    process.exit(1);
  } finally {
    try { fs.unlinkSync(psScript); } catch {}
  }
}

// --- Remove shortcut ---
function removeShortcut() {
  if (fs.existsSync(SHORTCUT_PATH)) {
    fs.unlinkSync(SHORTCUT_PATH);
    log(`Removed Startup shortcut: ${SHORTCUT_PATH}`);
  } else {
    log(`No shortcut to remove.`);
  }
}

// --- Verify ---
function verify() {
  const exists = fs.existsSync(SHORTCUT_PATH);
  log(`Startup shortcut: ${exists ? 'OK' : 'MISSING'} (${SHORTCUT_PATH})`);

  // Check if any Session 0 tasks remain
  let hasOldTask = false;
  for (const name of OLD_TASK_NAMES) {
    try {
      execSync(`schtasks /query /TN "${name}" >nul 2>&1`, { windowsHide: true });
      log(`WARNING: Scheduled task "${name}" still exists — may cause Session 0 startup`);
      hasOldTask = true;
    } catch {}
  }
  if (!hasOldTask) {
    log(`No Session 0 scheduled tasks found. Good.`);
  }

  // Check current session
  try {
    const result = execSync('powershell -NoProfile -Command "(Get-Process -Id $PID).SessionId"', { windowsHide: true }).toString().trim();
    log(`Current process session: SI=${result} (${result === '0' ? 'Session 0 — BAD for ConPTY' : 'user session — OK'})`);
  } catch {}
}

// --- Main ---
log(`Web Terminal auto-start setup`);
log(`Project: ${PROJECT_DIR}`);
log(`Mode: ${removing ? 'REMOVE' : 'INSTALL'}`);
log('');

if (removing) {
  removeOldTasks();
  removeShortcut();
} else {
  removeOldTasks();
  createShortcut();
}

log('');
verify();
log('Done.');
