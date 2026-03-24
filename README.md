# Web Terminal

Browser-based terminal for Windows. Monitor and control CLI sessions (including Claude Code) remotely from any device — phone, tablet, or another PC. Manage multiple servers from a single window.

## Features

- **Unified single-page app** — terminal, session management, and settings in one screen
- **Multi-server cluster** — connect multiple machines and manage all sessions from one window
- **Auto-sync cluster** — authenticate once and both servers discover each other automatically
- **PWA (Progressive Web App)** — install as a standalone app on any device
- **Shared sessions** — open the same terminal from multiple devices simultaneously
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **In-place session switching** — switch between sessions without page reload (WebSocket swap)
- **Session persistence** — sessions survive server restarts (saved to `sessions.json`)
- **Auto-command** — configure a command per session that runs on start/restart (e.g., `claude --dangerously-skip-permissions`)
- **Claude sessions browser** — scan and resume Claude Code conversations started from any terminal
- **Clipboard image paste** — paste images via Alt+V (uploads to server clipboard for Claude)
- **Folder history** — remembers working directories, auto-scans configured base folders
- **Smart status monitoring** — detects Claude activity vs user typing (Active / Idle / Needs Input)
- **Cross-session notifications** — browser notifications from any session, even if you're viewing a different one
- **Live config** — most settings take effect immediately without restart
- **Secure by default** — cookie + token auth, scrypt-hashed passwords, rate limiting, CSP headers, localhost binding
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN
- **Mobile friendly** — responsive layout, touch scroll, works on phone browsers

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

Settings are managed via the in-app Settings panel (gear icon). Most changes take effect immediately — only port, host, and shell require a restart.

You can also edit `config.json` directly:

```json
{
  "port": 7681,
  "user": "admin",
  "password": "my-strong-password",
  "shell": "C:\\Program Files\\Git\\bin\\bash.exe",
  "defaultCwd": "D:\\projects",
  "scanFolders": ["D:\\projects", "C:\\work"],
  "serverName": "My-PC",
  "publicUrl": "https://my-pc.tailnet.ts.net",
  "scrollbackReplayLimit": 102400,
  "cluster": [
    { "name": "Office", "url": "https://office.tailnet.ts.net" }
  ]
}
```

| Key | Live | Description |
|-----|------|-------------|
| `port` | No | HTTP port |
| `host` | No | Bind address (default: 127.0.0.1) |
| `shell` | No | Shell executable (Git Bash, PowerShell, cmd) |
| `user` / `password` | Yes* | Login credentials (*password change requires restart) |
| `serverName` | Yes | Display name for this server |
| `defaultCwd` | Yes | Default working directory for new sessions |
| `scanFolders` | Yes | Directories to scan for folder suggestions |
| `defaultCommand` | Yes | Pre-filled auto-command for new sessions |
| `scrollbackReplayLimit` | Yes | Max bytes sent on session connect (default 100KB) |
| `publicUrl` | Yes | This server's Tailscale URL (for cluster auto-sync) |
| `cluster` | Yes | Remote servers list |

`config.json` is gitignored — your settings stay local.

## Usage

### Open the app

```
https://<server-name>.<tailnet>.ts.net   # via Tailscale (recommended)
http://localhost:7681                     # local
```

Login with your credentials. The unified app shows:
- **Sidebar** — all sessions across all connected servers, grouped by server
- **Terminal** — full xterm.js terminal with the selected session
- **Settings** — server config, cluster management

### Create a session

1. Open the sidebar (hamburger menu)
2. Click **+ New**
3. Fill in name, working directory, and auto-command
4. Click **Create** — terminal connects instantly

### Switch sessions

Click any session in the sidebar — switches instantly without page reload.

### Clipboard image paste

Press **Alt+V** to paste an image from your clipboard into the terminal. The image is uploaded to the server and made available to Claude Code.

### Resume a Claude session

1. Open the sidebar
2. Expand **Claude Sessions** section
3. Click a previous conversation to resume it in a new terminal

### Status monitoring

Each session shows a colored dot:
- **Green (Running)** — Claude is actively producing output
- **Yellow (Idle)** — no Claude output for 10+ seconds (user typing doesn't trigger Active)
- **Red (Waiting)** — Claude needs permission or confirmation

Notifications work cross-session: you'll be alerted about any session needing input.

## Multi-Server Cluster

Connect multiple web-terminal instances and manage all sessions from one window.

### Setup

1. **Set Public URL** on each server: Settings → Public URL → `https://server-name.tailnet.ts.net`
2. **Add remote server** on any one server: Settings → Cluster → add name + URL → Save
3. **Login to remote**: click **Login** next to the remote server in the sidebar
4. **Auto-sync**: the remote server automatically discovers and connects back

That's it — both servers can now see each other's sessions. Repeat for additional servers.

### How it works

- Each server has independent credentials (no shared secrets)
- Inter-server auth uses API tokens (90-day expiry, revokable)
- All proxied through the server you're connected to (no CORS, single origin)
- Offline servers show greyed out, reconnect automatically
- Any server can be the hub — if one goes down, connect to another

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across all your devices.

### Setup

**On each server** (one-time per machine):

1. **Install Tailscale**: https://tailscale.com/download/windows
2. **Sign in** with your Tailscale account
3. **Enable HTTPS**:
   ```powershell
   tailscale serve --https=443 localhost:7681
   ```
4. **Verify**:
   ```powershell
   tailscale serve status
   ```

**On client devices** — just install Tailscale and sign in. No other setup needed.

### Security

Four layers of protection:
1. **Tailscale WireGuard encryption** — only your devices can reach the server
2. **TLS (HTTPS)** — real Let's Encrypt certificate, no browser warnings
3. **Tailscale identity** — tied to your account
4. **Login credentials** — username/password with scrypt-hashed storage, rate limiting

### Troubleshooting

- **Can't reach the page**: Ensure Tailscale is connected on both devices (`tailscale status`)
- **Check what's being served**: `tailscale serve status`
- **Remove HTTPS proxy**: `tailscale serve --https=443 off`
- **Certificate issues**: Tailscale auto-provisions certs — ensure HTTPS is enabled on your tailnet (admin console)

## PWA (Install as App)

Web Terminal can be installed as a standalone app:

1. Open the app in Chrome/Edge
2. Click the install icon in the address bar (or menu → "Install app")
3. The app opens in its own window without browser chrome

Works on desktop, Android, and iOS (Add to Home Screen).

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
                                        |
                          ┌─────────────┘
                          v
                   Remote Servers (cluster proxy via Tailscale)
```

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, session management, auth, cluster proxy |
| `app.html` | Unified single-page app (terminal + sidebar + settings) |
| `terminal.html` | Legacy terminal-only page (served at /s/:id) |
| `lobby.html` | Legacy lobby page (served at /lobby) |
| `sw.js` | Service worker for PWA caching |
| `manifest.json` | PWA manifest (app name, icon, standalone mode) |
| `icon.svg` | App icon |
| `config.default.json` | Default configuration template |
| `config.json` | Your local config (gitignored) |
| `sessions.json` | Persisted session configs (gitignored) |
| `api-tokens.json` | API auth tokens for cluster (gitignored) |
| `cluster-tokens.json` | Stored tokens for remote servers (gitignored) |
| `tests/security.spec.js` | Auth, session CRUD, XSS, config security tests |
| `tests/cluster.spec.js` | Token auth, cluster API, proxy security tests |
