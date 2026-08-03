# Installation & Operations

Getting Web Terminal running on a Windows host, keeping it running, and updating it.
For an agent-driven install see [AGENTS.md](../AGENTS.md).

## Quick Start

**Requirements**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```bash
git clone https://github.com/Adiel-Sharabi/web-terminal.git
cd web-terminal
npm install
node monitor.js
```

Open http://localhost:7681 — default login is `admin` / `admin`. You'll be prompted to change the password on first login.

## Production Setup

Use the monitor for crash recovery and logging:

```bash
node monitor.js          # recommended — auto-restart, logs, health checks
node server.js           # direct — no crash recovery
```

> **Important:** Do not run both `monitor.js` and `server.js` at the same time. `monitor.js` spawns `server.js` as a child process — running `server.js` separately will cause a port conflict and rapid console window flashing on Windows. If the port is already in use, the server exits with code 2 and the monitor stops gracefully.

For auto-start on Windows boot:

```powershell
# Option 1: Scheduled task (run as Administrator) — starts on boot even without login
powershell -ExecutionPolicy Bypass -File register-task.ps1

# Option 2: Startup shortcut — starts when user logs in
powershell -ExecutionPolicy Bypass -File create-startup.ps1
```

Both options use `wscript.exe` with `start-server.vbs` to launch the server hidden — no console window flashing.

To restart the server manually (without flashing), identify and kill only the monitor + worker + `server.js` PIDs — do not blanket-kill node.exe, that races with the VBS launcher and can leave a dual-monitor crash loop:

```powershell
# 1. List node processes and find the monitor.js, pty-worker.js, server.js PIDs
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap

# 2. Kill only those PIDs
Stop-Process -Id <monitor_pid>,<worker_pid>,<server_pid> -Force

# 3. Wait 2-3 seconds for ports to release, then start fresh
wscript start-server.vbs
```

For a quicker lifecycle without restarting the worker, you can kill just `server.js`. The monitor will respawn the web layer and the PTY sessions keep running — browsers reattach and replay scrollback automatically.

> **Never run `node server.js` or `node monitor.js` directly on Windows** — they are console applications and will flash terminal windows. Always use the VBS launcher.

**How flashing is prevented** (three layers):
1. **VBS launcher** — `wscript.exe` is a GUI-subsystem executable, so launching node through it creates no visible console window
2. **`useConptyDll: true`** — terminal sessions use the bundled `OpenConsole.exe` instead of the system ConPTY API, which on Windows 11 delegates to Windows Terminal and causes visible flashes
3. **`windowsHide: true`** — all child process calls (git, powershell, etc.) use this flag to suppress console windows

## Automated Install

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File install.ps1
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password |
| `-Shell` | Git Bash | Shell executable |
| `-DefaultCwd` | C:\dev | Default working directory |
| `-SkipTailscale` | false | Skip Tailscale configuration |

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across your devices.

On each server (one-time):
```powershell
tailscale serve --https=443 localhost:7681
```

Then access from any device on your tailnet: `https://server-name.tailnet.ts.net`

## Update

```bash
cd web-terminal
git pull
npm install --production
# Restart via Settings button, or:
# node monitor.js (if using monitor)
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```
