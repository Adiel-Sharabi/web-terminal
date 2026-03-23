# Web Terminal

Browser-based terminal for Windows. Monitor and control CLI sessions (including Claude Code) remotely from any device — phone, tablet, or another PC.

## Features

- **Shared sessions** — open the same terminal from multiple devices simultaneously
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **Session persistence** — sessions survive server restarts (saved to `sessions.json`)
- **Auto-command** — configure a command per session that runs on start/restart (e.g., `claude --dangerously-skip-permissions`)
- **Claude sessions browser** — scan and resume Claude Code conversations started from any terminal
- **Folder history** — remembers working directories, auto-scans configured base folders
- **Status monitoring** — live status badges (Active / Idle / Needs Input) per session
- **Cross-session notifications** — browser notifications from any session, even if you're viewing a different one
- **Secure by default** — cookie-based login, scrypt-hashed passwords, forced password change on first use, rate limiting, CSP headers, localhost-only binding
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN
- **Mobile friendly** — works on phone browsers

## Quick Install

**Prerequisites**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win), (optional) [Tailscale](https://tailscale.com/download)

```powershell
# Clone
git clone https://github.com/Adiel-Sharabi/web-terminal.git C:\tools\web-terminal

# Install and start (run as Administrator)
powershell -ExecutionPolicy Bypass -File C:\tools\web-terminal\install.ps1
```

The installer handles: dependencies, auto-start (Scheduled Task), and Tailscale exposure.

### Custom install

```powershell
install.ps1 -Port 7682 -Password "my-secret" -DefaultCwd "D:\projects"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password (you'll be prompted to change on first use) |
| `-Shell` | Git Bash | Shell executable path |
| `-DefaultCwd` | C:\dev | Default working directory for new sessions |
| `-SkipTailscale` | false | Don't configure Tailscale |

## Configuration

Copy `config.default.json` to `config.json` and edit:

```json
{
  "port": 7681,
  "user": "admin",
  "password": "my-strong-password",
  "shell": "C:\\Program Files\\Git\\bin\\bash.exe",
  "defaultCwd": "D:\\projects",
  "scanFolders": ["D:\\projects", "C:\\work", "C:\\dev"]
}
```

| Key | Description |
|-----|-------------|
| `port` | HTTP port |
| `user` / `password` | Login credentials |
| `shell` | Shell executable (Git Bash, PowerShell, cmd) |
| `defaultCwd` | Default working directory for new sessions |
| `scanFolders` | Directories to scan for folder suggestions (subdirs auto-discovered) |

`config.json` is gitignored — your settings stay local. Environment variables (`WT_PORT`, `WT_USER`, etc.) override config file values.

## Usage

### Open the lobby

```
http://localhost:7681          # local
http://<tailscale-ip>:7681    # remote
```

Login with your credentials. The lobby shows:
- **Active sessions** with live status (Active / Done / Needs Input)
- **New Session** button with folder suggestions and auto-command
- **Recent Claude Sessions** — browse and resume conversations from any terminal

### Create a session

1. Click **+ New Session**
2. Name it (e.g., "AM8 Core")
3. Pick a working directory from the dropdown (auto-scanned from your configured folders)
4. Auto-command defaults to `claude --dangerously-skip-permissions` — change or clear as needed
5. Click **Create** — opens the terminal

### Resume a Claude session from regular CLI

If you started Claude in a regular terminal (not web terminal), you can continue it:

1. Open the lobby
2. Click **Show / Hide** under "Recent Claude Sessions"
3. Find your conversation (shows project, first message, time)
4. Click **Resume** — creates a web terminal with `claude --resume <id> --dangerously-skip-permissions`

### Session persistence

Sessions are saved to `sessions.json`. When the server restarts:
- All sessions are recreated (same name, cwd, auto-command)
- Auto-commands run automatically (e.g., Claude resumes where it left off)

### Status monitoring

Each session card shows:
- **Active** (green) — output is flowing
- **Done / Idle** (yellow) — no output for 10+ seconds
- **Needs Input** (red, pulsing) — Claude is waiting for permission or confirmation

Notifications are **cross-session**: viewing session A will still alert you about session B.

### Rename sessions

Click the session name — in the lobby or terminal toolbar — to rename it.

### Auto-command

Set a command that runs when the session starts (or restarts). Use the **Auto-cmd** button on any session card, or set it when creating a new session.

Examples:
- `claude --dangerously-skip-permissions` — start Claude with auto-approve
- `claude --continue --dangerously-skip-permissions` — resume last conversation
- `cd /c/dev/my-project && claude` — navigate and start

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across all your devices.

### Setup

**On each server** (one-time per machine running web-terminal):

1. **Install Tailscale**: https://tailscale.com/download/windows
2. **Sign in** with your Tailscale account
3. **Enable HTTPS** (provisions a real TLS certificate automatically):
   ```powershell
   tailscale serve --https=443 localhost:7681
   ```
4. **Verify**:
   ```powershell
   tailscale serve status
   ```

**On client devices** (phone, tablet, other PCs) — just install Tailscale and sign in. No other setup needed.

### Access from any device

1. Open Tailscale app — make sure it's connected
2. Browse to `https://<server-name>.<tailnet>.ts.net`
3. Login with your Web Terminal credentials

The server binds to `127.0.0.1` by default — it's only reachable through Tailscale's encrypted tunnel. Port 7681 is not exposed on your LAN.

### Security

Four layers of protection:
1. **Tailscale WireGuard encryption** — only your devices can reach the server
2. **TLS (HTTPS)** — real Let's Encrypt certificate, no browser warnings
3. **Tailscale identity** — tied to your account
4. **Login credentials** — username/password with scrypt-hashed storage

### Multiple machines

Run the setup on each server. Access any by its Tailscale DNS name:
- `https://home-pc.<tailnet>.ts.net` — Home PC
- `https://office-pc.<tailnet>.ts.net` — Office PC

### Troubleshooting

- **Can't reach the page**: Ensure Tailscale is connected on both devices (`tailscale status`)
- **Check what's being served**: `tailscale serve status`
- **Remove HTTPS proxy**: `tailscale serve --https=443 off`
- **Certificate issues**: Tailscale auto-provisions certs — ensure HTTPS is enabled on your tailnet (admin console)

## Update

```powershell
cd C:\tools\web-terminal
git pull
npm install --production

# Restart
Get-ScheduledTask -TaskName "WebTerminal-7681" | Stop-ScheduledTask
Start-ScheduledTask -TaskName "WebTerminal-7681"
```

Your `config.json`, `sessions.json`, and `history.json` are gitignored — they won't be overwritten.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File C:\tools\web-terminal\install.ps1 -Uninstall
```

## Architecture

```
Phone/Tablet ──> Tailscale VPN ──> Web Terminal (Node.js) ──> Git Bash ──> Claude Code
                                        |
PC Browser ────> localhost:7681 ────────┘
```

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, session management, auth, Claude scanner |
| `lobby.html` | Session list, create/rename/kill, folder history, Claude sessions |
| `terminal.html` | xterm.js terminal with shared sessions, notifications |
| `config.default.json` | Default configuration template (copy to `config.json`) |
| `config.json` | Your local config (gitignored) |
| `sessions.json` | Persisted session configs (gitignored) |
| `history.json` | Folder history (gitignored) |
| `install.ps1` | One-command installer |
