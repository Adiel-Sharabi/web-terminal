#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install Web Terminal on a Windows machine.
.DESCRIPTION
    Clones the repo, installs dependencies, configures auto-start via Scheduled Task,
    and optionally exposes via Tailscale.
.EXAMPLE
    # Fresh install:
    powershell -ExecutionPolicy Bypass -File install.ps1

    # Custom settings:
    powershell -ExecutionPolicy Bypass -File install.ps1 -Port 7681 -Password "mypass"
#>
param(
    [string]$InstallDir = "C:\tools\web-terminal",
    [int]$Port = 7681,
    [string]$User = "admin",
    [string]$Password = "admin",
    [string]$Shell = "C:\Program Files\Git\bin\bash.exe",
    [string]$DefaultCwd = "$env:USERPROFILE",
    [switch]$SkipTailscale,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "WebTerminal-$Port"

# --- Uninstall ---
if ($Uninstall) {
    Write-Host "Uninstalling Web Terminal..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    # Kill any running instance on this port
    $procs = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not $SkipTailscale) {
        tailscale serve --https=443 off 2>$null
    }
    Write-Host "Done. Files left in $InstallDir (delete manually if needed)." -ForegroundColor Green
    exit 0
}

# --- Pre-checks ---
Write-Host "=== Web Terminal Installer ===" -ForegroundColor Cyan

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Node.js $(node --version)" -ForegroundColor Green

# Git Bash
if (-not (Test-Path $Shell)) {
    Write-Host "ERROR: Git Bash not found at $Shell" -ForegroundColor Red
    Write-Host "       Install Git for Windows or pass -Shell parameter" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Git Bash found" -ForegroundColor Green

# --- Install ---
Write-Host "`nInstalling to $InstallDir ..." -ForegroundColor Cyan

if (Test-Path "$InstallDir\.git") {
    Write-Host "Existing install found, pulling updates..."
    Push-Location $InstallDir
    git pull 2>&1
    Pop-Location
} elseif (Test-Path "$InstallDir\package.json") {
    Write-Host "Existing install found (no git), updating files..."
} else {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # If running from a cloned repo, copy files
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    Copy-Item "$scriptDir\server.js" $InstallDir -Force
    Copy-Item "$scriptDir\lobby.html" $InstallDir -Force
    Copy-Item "$scriptDir\terminal.html" $InstallDir -Force
    Copy-Item "$scriptDir\package.json" $InstallDir -Force
}

# npm install
Write-Host "Installing dependencies..."
Push-Location $InstallDir
npm install --production 2>&1 | Out-Null
Pop-Location
Write-Host "[OK] Dependencies installed" -ForegroundColor Green

# --- Create Scheduled Task (auto-start on logon) ---
Write-Host "`nConfiguring auto-start..." -ForegroundColor Cyan

# Remove existing task
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "node.exe" `
    -Argument "server.js" `
    -WorkingDirectory $InstallDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Set environment variables for the task
$envVars = @(
    "WT_PORT=$Port",
    "WT_USER=$User",
    "WT_PASS=$Password",
    "WT_SHELL=$Shell",
    "WT_CWD=$DefaultCwd"
)

# Create a wrapper script that sets env vars and starts the server
$wrapperContent = @"
`$env:WT_PORT = "$Port"
`$env:WT_USER = "$User"
`$env:WT_PASS = "$Password"
`$env:WT_SHELL = "$Shell"
`$env:WT_CWD = "$DefaultCwd"
Set-Location "$InstallDir"
node server.js
"@
$wrapperPath = Join-Path $InstallDir "start.ps1"
Set-Content -Path $wrapperPath -Value $wrapperContent -Encoding UTF8

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperPath`"" `
    -WorkingDirectory $InstallDir

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Web Terminal on port $Port" | Out-Null
Write-Host "[OK] Scheduled task '$TaskName' created (starts on logon)" -ForegroundColor Green

# --- Start now ---
Write-Host "`nStarting Web Terminal..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "[OK] Running on port $Port" -ForegroundColor Green
} else {
    Write-Host "[WARN] May not have started yet. Check: Get-ScheduledTask -TaskName $TaskName" -ForegroundColor Yellow
}

# --- Tailscale ---
if (-not $SkipTailscale) {
    if (Get-Command tailscale -ErrorAction SilentlyContinue) {
        Write-Host "`nExposing via Tailscale..." -ForegroundColor Cyan
        tailscale serve --bg $Port 2>&1
        $tsStatus = tailscale status --json 2>$null | ConvertFrom-Json
        $machineName = $tsStatus.Self.HostName
        $ip = (tailscale ip -4 2>$null).Trim()
        Write-Host "[OK] Tailscale configured" -ForegroundColor Green
        Write-Host ""
        Write-Host "=== Access URLs ===" -ForegroundColor Cyan
        Write-Host "  Local:     http://localhost:$Port" -ForegroundColor White
        Write-Host "  Tailscale: http://${ip}:$Port" -ForegroundColor White
    } else {
        Write-Host "`n[SKIP] Tailscale not found. Install from https://tailscale.com/download" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "=== Access URL ===" -ForegroundColor Cyan
    Write-Host "  Local: http://localhost:$Port" -ForegroundColor White
}

Write-Host ""
Write-Host "Login: $User / $Password" -ForegroundColor Yellow
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
