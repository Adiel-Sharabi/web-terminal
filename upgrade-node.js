#!/usr/bin/env node
// Upgrade node.exe on this machine from a pre-downloaded zip
// Usage: node upgrade-node.js <path-to-extracted-node.exe> [--go]
// Without --go, just shows what it would do (dry run)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const newNodeExe = process.argv[2];
const dryRun = !process.argv.includes('--go');

if (!newNodeExe || !fs.existsSync(newNodeExe)) {
  console.log('Usage: node upgrade-node.js <path-to-new-node.exe> [--go]');
  console.log('  Downloads: https://nodejs.org/dist/v22.17.1/node-v22.17.1-win-x64.zip');
  console.log('  Extract node.exe, then run this script pointing to it.');
  process.exit(1);
}

const currentNode = process.execPath;
const nodeDir = path.dirname(currentNode);
const backupPath = path.join(nodeDir, 'node-v' + process.version + '.exe.bak');

console.log('Current node:', currentNode);
console.log('Current version:', process.version);
console.log('New node.exe:', newNodeExe);
console.log('Backup to:', backupPath);
console.log('Mode:', dryRun ? 'DRY RUN' : 'LIVE');

if (dryRun) {
  console.log('\nRe-run with --go to execute. This will:');
  console.log('  1. Create a scheduled task to run the upgrade');
  console.log('  2. The task will: kill all node, backup old exe, copy new exe, start server');
  process.exit(0);
}

// Write a PowerShell script that does the upgrade after we exit
const psScript = path.join(require('os').tmpdir(), 'node-upgrade.ps1');
const vbsPath = path.join(__dirname, 'start-server.vbs');
const ps = `
Start-Sleep -Seconds 3
Write-Host "Killing node processes..."
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "Backing up ${currentNode} -> ${backupPath}"
Copy-Item "${currentNode}" "${backupPath}" -Force
Write-Host "Installing new node.exe..."
Copy-Item "${newNodeExe}" "${currentNode}" -Force
$v = & "${currentNode}" --version 2>&1
Write-Host "New version: $v"
Write-Host "Starting web-terminal..."
Set-Location "${__dirname}"
& wscript.exe "${vbsPath}"
Write-Host "Done. Server starting."
`.trim();

fs.writeFileSync(psScript, ps, 'utf8');
console.log('Wrote upgrade script:', psScript);

// Create a scheduled task that runs the PS script immediately (interactive session)
console.log('Creating upgrade task...');
execSync(
  `schtasks /create /TN "NodeUpgrade" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File ${psScript}" /SC ONCE /ST 00:00 /F /RL HIGHEST`,
  { windowsHide: true, shell: 'cmd.exe' }
);
execSync('schtasks /run /TN "NodeUpgrade"', { windowsHide: true, shell: 'cmd.exe' });
console.log('Upgrade task started. Server will restart in ~5 seconds with new Node version.');
console.log('Clean up: schtasks /delete /TN "NodeUpgrade" /F');
