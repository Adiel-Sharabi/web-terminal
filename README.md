# Web Terminal

Browser-based terminal for Windows. Monitor and control CLI sessions (including Claude Code) remotely from any device — phone, tablet, or another PC. Manage multiple servers from a single window.

## Features

- **Unified single-page app** — terminal, session management, and settings in one screen
- **Multi-server cluster** — connect multiple machines and manage all sessions from one window
- **Auto-sync cluster** — authenticate once and both servers discover each other automatically
- **Exclusive viewer** — one device per session, no display corruption from mixed screen sizes
- **PWA (Progressive Web App)** — install as a standalone app on any device
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **In-place session switching** — switch between sessions without page reload
- **Session persistence** — sessions survive server restarts (saved to `sessions.json`)
- **Auto-command** — configure a startup command per session (e.g., `claude --dangerously-skip-permissions`)
- **Claude sessions browser** — scan and resume Claude Code conversations across all servers
- **Session transfer** — move Claude sessions between servers
- **Clipboard image paste** — Alt+V to paste images for Claude Code
- **Folder history** — remembers working directories, auto-scans configured folders
- **Smart status monitoring** — detects Active / Idle / Waiting states per session
- **Cross-session notifications** — browser alerts from any session needing input
- **Mobile support** — responsive layout, touch toolbar (Esc, Ctrl, Alt, Shift, Tab, arrows), long-press copy/paste
- **Live config** — most settings apply immediately without restart
- **Secure by default** — scrypt passwords, rate limiting, CSP headers, cookie + token auth
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN

## Quick Start

**Requirements**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```bash
git clone https://github.com/Adiel-Sharabi/web-terminal.git
cd web-terminal
npm install
node server.js
```

Open http://localhost:7681 — default login is `admin` / `admin`.

### Automated Install (Windows service)

```powershell
# Run as Administrator
powershell -ExecutionPolicy Bypass -File install.ps1
```

This creates a scheduled task that starts the server on boot. Options:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password |
| `-Shell` | Git Bash | Shell executable |
| `-DefaultCwd` | C:\dev | Default working directory |
| `-SkipTailscale` | false | Skip Tailscale configuration |

## Configuration

Use the in-app Settings panel (gear icon). Most changes apply instantly — only port, host, and shell need a restart.

Config is stored in `config.json` (gitignored):

| Key | Live Reload | Description |
|-----|:-----------:|-------------|
| `port` | No | HTTP port |
| `host` | No | Bind address (`0.0.0.0` for all interfaces, `127.0.0.1` for local only) |
| `shell` | No | Shell path (Git Bash, PowerShell, cmd) |
| `user` / `password` | Partial | Username is live, password change needs restart |
| `serverName` | Yes | Display name for this server |
| `defaultCwd` | Yes | Default working directory for new sessions |
| `scanFolders` | Yes | Directories to scan for folder suggestions |
| `defaultCommand` | Yes | Pre-filled auto-command for new sessions |
| `scrollbackReplayLimit` | Yes | Max bytes replayed on connect (default 1MB) |
| `publicUrl` | Yes | This server's URL for cluster auto-sync |
| `cluster` | Yes | Remote servers list |

## Multi-Server Cluster

1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). All traffic proxies through your connected server — no CORS issues.

## Remote Access via Tailscale

[Tailscale](https://tailscale.com/download) creates a secure mesh VPN across your devices.

On each server (one-time):
```powershell
tailscale serve --https=443 localhost:7681
```

Then access from any device on your tailnet: `https://server-name.tailnet.ts.net`

## Architecture

```
Phone/Tablet ──> Tailscale VPN ──> Web Terminal (Node.js) ──> Shell ──> Claude Code
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
| `sw.js` | Service worker for PWA caching |
| `terminal.html` | Legacy standalone terminal page |
| `tests/` | Playwright tests (security, cluster, exclusive viewer) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed technical walkthrough.

## Update

```bash
cd web-terminal
git pull
npm install --production
# Restart the server (or use the in-app Restart button in Settings)
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```
