// Remote shadow-node setup — runs on Home or XPS via /api/exec.
// Usage: node setup-shadow.js <role>   where role ∈ {home,xps}
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROLE = process.argv[2];
if (!ROLE || !['home','xps'].includes(ROLE)) {
  console.error('usage: node setup-shadow.js <home|xps>');
  process.exit(2);
}

const MAIN_DIR   = 'C:\\dev\\web-terminal';
const SHADOW_DIR = 'C:\\dev\\web-terminal-shadow';
const PIPE_SUFFIX = ROLE;

const PORT = ROLE === 'home' ? 7785 : 7786;
const NAME = ROLE === 'home' ? 'ShadowHome' : 'ShadowXps';

// Use tailscale IPs so all 3 shadows can reach each other across machines
const URLS = {
  office: 'http://100.75.82.89:7784',
  home:   'http://100.79.226.100:7785',
  xps:    'http://100.67.238.93:7786',
};
const TOKENS = {
  office: 'ea23ecc31eb999971ad460593a5e5b1f9d4dab9a0da92940037262285f666bbe',
  home:   '8727e858f500927c0dd54968a79d03247ee92aa042bf20a89ad7476f22431fa7',
  xps:    '4a1023df028ef87c7dc508a6d56b7729bc64b1bf40883af6ca6dbd6e9f8a18a5',
};
const PASSHASH = '$scrypt$e06203e93ea0f0290738538434017149$fc18a86f663a202407114e5f8d26aa274a0931ec136b754fe1cb5fe140bc12011432d71481dfcf3075e3e8d00c2555d5dd8790e51aa8149f469711722f595a52';

function run(cmd, opts = {}) {
  console.log('$ ' + cmd);
  return cp.execSync(cmd, { stdio: 'inherit', windowsHide: true, ...opts });
}

// Step 1: git fetch feature branch
try { run(`git -C "${MAIN_DIR}" fetch origin feature/direct-terminal`); }
catch (e) { console.error('fetch failed:', e.message); process.exit(1); }

// Step 2: Create worktree if missing (detached HEAD at branch tip)
if (!fs.existsSync(SHADOW_DIR)) {
  run(`git -C "${MAIN_DIR}" worktree add --detach "${SHADOW_DIR}" origin/feature/direct-terminal`);
} else {
  console.log('(shadow dir already exists, updating to latest commit)');
  run(`git -C "${SHADOW_DIR}" fetch origin feature/direct-terminal`);
  run(`git -C "${SHADOW_DIR}" checkout --detach origin/feature/direct-terminal`);
}

// Step 3: Junction node_modules (so we don't need npm install)
const nmPath = path.join(SHADOW_DIR, 'node_modules');
if (!fs.existsSync(nmPath)) {
  run(`cmd /c mklink /J "${nmPath}" "${path.join(MAIN_DIR, 'node_modules')}"`);
} else {
  console.log('(node_modules already linked)');
}

// Step 4: Write config.json
const cluster = Object.entries(URLS)
  .filter(([k]) => k !== ROLE)
  .map(([k, url]) => ({ name: k === 'office' ? 'ShadowOffice' : (k === 'home' ? 'ShadowHome' : 'ShadowXps'), url }));
const config = {
  port: PORT,
  host: '0.0.0.0',
  user: 'admin',
  password: PASSHASH,
  shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
  defaultCwd: 'C:\\dev',
  scanFolders: ['C:\\dev'],
  defaultCommand: 'claude --dangerously-skip-permissions',
  serverName: NAME,
  scrollbackReplayLimit: 102400,
  cluster,
  publicUrl: URLS[ROLE],
};
fs.writeFileSync(path.join(SHADOW_DIR, 'config.json'), JSON.stringify(config, null, 2));
console.log('wrote config.json');

// Step 5: Write api-tokens.json (our own bearer that peers present)
const now = Date.now();
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const apiTokens = { [TOKENS[ROLE]]: { label: 'shadow-cluster', created: now, expires: now + NINETY_DAYS } };
fs.writeFileSync(path.join(SHADOW_DIR, 'api-tokens.json'), JSON.stringify(apiTokens, null, 2));
console.log('wrote api-tokens.json');

// Step 6: Write cluster-tokens.json (peers' bearers so we can call them)
const clusterTokens = {};
for (const [k, url] of Object.entries(URLS)) {
  if (k === ROLE) continue;
  clusterTokens[url] = { token: TOKENS[k], name: k === 'office' ? 'ShadowOffice' : (k === 'home' ? 'ShadowHome' : 'ShadowXps'), authenticated: now };
}
fs.writeFileSync(path.join(SHADOW_DIR, 'cluster-tokens.json'), JSON.stringify(clusterTokens, null, 2));
console.log('wrote cluster-tokens.json');

// Step 7: Write VBS launcher (with proper \\.\pipe\ escaping)
const vbs = `' Shadow cluster launcher (${ROLE}) — isolated pipe, own config/state.
Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = objFSO.GetParentFolderName(WScript.ScriptFullName)
objShell.Environment("PROCESS")("WT_WORKER_PIPE") = "\\\\.\\pipe\\web-terminal-shadow-${PIPE_SUFFIX}"
objShell.Run "node monitor.js", 0, False
`;
fs.writeFileSync(path.join(SHADOW_DIR, 'start-shadow.vbs'), vbs);
console.log('wrote start-shadow.vbs');

// Step 8: Ensure clean state on launch (kill any prior shadow and clear logs)
try {
  cp.execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*web-terminal-shadow*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'inherit', windowsHide: true });
} catch (e) { /* ignore */ }
cp.execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 3"', { windowsHide: true });
try { fs.rmSync(path.join(SHADOW_DIR, 'logs'), { recursive: true, force: true }); } catch {}
try { fs.unlinkSync(path.join(SHADOW_DIR, 'monitor-status.json')); } catch {}

// Step 9: Launch via wscript detached
cp.spawn('wscript.exe', ['start-shadow.vbs'], { cwd: SHADOW_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();
console.log('launched shadow via wscript');
console.log('shadow config: port=' + PORT + ' pipe=\\\\.\\pipe\\web-terminal-shadow-' + PIPE_SUFFIX + ' url=' + URLS[ROLE]);
