# Web Terminal

Browser-based terminal for Windows. Monitor and control CLI sessions (including Claude Code) from any device — phone, tablet, or another PC.

## Features

- **Shared sessions** — open the same terminal from multiple devices simultaneously
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **Session persistence** — closing the browser doesn't kill the shell; reconnect and see scrollback history
- **Basic auth** — password-protected access
- **Tailscale ready** — secure remote access over your private mesh VPN
- **Mobile friendly** — works on phone browsers

## Quick Install

**Prerequisites**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win), (optional) [Tailscale](https://tailscale.com/download)

```powershell
# Clone
git clone https://github.com/AdiSharabi/web-terminal.git C:\tools\web-terminal

# Install and start (run as Administrator)
powershell -ExecutionPolicy Bypass -File C:\tools\web-terminal\install.ps1
```

That's it. The installer will:
1. Install Node.js dependencies
2. Create a Windows Scheduled Task (auto-starts on logon)
3. Expose via Tailscale (if installed)
4. Print access URLs

### Custom settings

```powershell
install.ps1 -Port 7682 -Password "my-secret" -DefaultCwd "C:\dev\myproject"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password |
| `-Shell` | Git Bash | Shell executable path |
| `-DefaultCwd` | User home | Default working directory for new sessions |
| `-SkipTailscale` | false | Don't configure Tailscale |

## Usage

### Open the lobby

```
http://localhost:7681          # local
http://<tailscale-ip>:7681    # remote (Tailscale)
```

Login with your credentials. You'll see a session lobby where you can:
- **Open** an existing session
- **Create** a new session (with custom name and working directory)
- **Kill** a session

### Run Claude Code remotely

1. Open a session from your phone
2. Type:
   ```bash
   cd /c/dev/my-project && claude
   ```
3. Work as if you were at the local console

### Multiple sessions

Create sessions for different projects:
- Session 1: `C:\dev\project-a`
- Session 2: `C:\dev\project-b`
- Session 3: general purpose

Each session runs independently. Multiple viewers can watch the same session.

## Update

```powershell
cd C:\tools\web-terminal
git pull
npm install --production

# Restart the service
Get-ScheduledTask -TaskName "WebTerminal-7681" | Stop-ScheduledTask
Start-ScheduledTask -TaskName "WebTerminal-7681"
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File C:\tools\web-terminal\install.ps1 -Uninstall
```

## Architecture

```
Phone/Tablet ──► Tailscale VPN ──► Web Terminal (Node.js) ──► Git Bash ──► Claude Code
                                        │
PC Browser ────► localhost:7681 ────────┘
```

- **server.js** — Express + WebSocket server, session management, basic auth
- **lobby.html** — Session list UI (create/open/kill sessions)
- **terminal.html** — xterm.js terminal with shared session support
- **install.ps1** — One-command installer (deps, scheduled task, Tailscale)
