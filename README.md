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
git clone https://github.com/Adiel-Sharabi/web-terminal.git C:\tools\web-terminal

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

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across all your devices. Once set up, you can access Web Terminal from your phone, tablet, or another PC — anywhere in the world.

### Setup (one-time per device)

1. **Install Tailscale** on every device you want to connect (PC, phone, tablet)
   - Windows: https://tailscale.com/download/windows
   - Android: Google Play Store → "Tailscale"
   - iOS: App Store → "Tailscale"

2. **Sign in** with the same account on all devices

3. **Find your machine's Tailscale IP** (run on the PC):
   ```powershell
   tailscale ip -4
   # Example output: 100.79.226.100
   ```

4. **Expose Web Terminal** through Tailscale:
   ```powershell
   tailscale serve --bg 7681
   ```
   The installer does this automatically if Tailscale is detected.

### Access from your phone

1. Open Tailscale app on your phone — make sure it's connected
2. Open browser and go to: `http://<tailscale-ip>:7681`
   - Example: `http://100.79.226.100:7681`
3. Login with your Web Terminal credentials
4. You're in — full terminal access from your phone

### Security

Three layers of protection:
1. **Tailscale WireGuard encryption** — only your devices can reach the IP
2. **Tailscale identity** — tied to your account
3. **Basic auth** — username/password on the web terminal

### Multiple machines

Install Web Terminal + Tailscale on each machine. Access any machine by its Tailscale IP:
- `http://100.x.x.x:7681` — Home PC
- `http://100.y.y.y:7681` — Office PC
- `http://100.z.z.z:7681` — Laptop

### Troubleshooting

- **Can't reach the page**: Make sure Tailscale is connected on both devices (`tailscale status`)
- **DNS name not working**: Use the IP address directly instead (more reliable)
- **Check what's being served**: `tailscale serve status`
- **Remove Tailscale proxy**: `tailscale serve --https=443 off`

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
