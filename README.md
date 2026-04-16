# Web Terminal

Browser-based terminal manager for Windows. Monitor and control CLI sessions (including AI coding agents like Claude Code) remotely from any device — phone, tablet, or another PC. Manage multiple servers from a single window.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

### Terminal & Sessions
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **In-place switching** — switch between sessions without page reload
- **Session persistence** — sessions survive server restarts with scrollback replay
- **Auto-command** — startup command per session, waits for shell prompt before executing
- **Fork session** — duplicate a Claude session with `--fork-session` from the sidebar
- **Exclusive viewer** — one device per session prevents display corruption from mixed screen sizes

### Multi-Server Cluster
- **Unified dashboard** — see and manage sessions across all servers in one sidebar
- **Auto-sync** — authenticate once and both servers discover each other automatically
- **Cluster proxy** — all remote traffic routed through your connected server (no CORS)
- **API tokens** — inter-server auth with 90-day expiry
- **Remote exec** — run commands on any server via `/api/exec`

### AI Agent Integration (Claude Code)
- **Session intelligence** — real-time status tracking via Claude Code hooks: Working (orange), Idle (green), Waiting for input (red)
- **Smart notifications** — urgent alerts for permission prompts (always shown), quiet notifications for idle sessions (background only)
- **Mute button** — toggle notifications while keeping sidebar status dots live
- **Claude sessions browser** — scan, resume, and transfer Claude Code conversations across servers
- **Session names** — auto-extracted from Claude conversation titles, synced via `/rename` on sidebar rename
- **Clipboard image paste** — Alt+V to paste images directly into Claude Code

### Mobile & PWA
- **Progressive Web App** — install as standalone app; name reflects server name
- **Touch toolbar** — Esc, Ctrl, Alt, Shift (sticky), Tab, arrows, plus `/`, `|`, `-`, `~`
- **Long-press context menu** — Copy, Paste, Paste Image, Select, Select All
- **Drag-to-select** — character count shown, floating Copy/Done bar
- **IME deduplication** — handles Android keyboard (SwiftKey, Gboard) duplicate events
- **Responsive layout** — adapts to phone, tablet, and desktop

### Security
- **Scrypt password hashing** with timing-safe comparison
- **Rate limiting** — 5 failed logins per minute, 5-minute lockout
- **CSP headers** — Content-Security-Policy, X-Frame-Options, X-Content-Type-Options
- **Cookie + token auth** — HttpOnly SameSite=Lax cookies (90-day), Bearer tokens for API/cluster
- **Path traversal protection** on all file operations
- **Input length limits** on all user-facing inputs

### Operations
- **Server monitor** (`monitor.js`) — auto-restart with exponential backoff, crash budget, log rotation, health checks
- **Live config** — most settings apply immediately without restart
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN

## Quick Start

**Requirements**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```bash
git clone https://github.com/Adiel-Sharabi/web-terminal.git
cd web-terminal
npm install
node monitor.js
```

Open http://localhost:7681 — default login is `admin` / `admin`. You'll be prompted to change the password on first login.

### Production Setup

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

To restart the server manually (without flashing):

```bash
taskkill /F /IM node.exe        # stop current instance
wscript start-server.vbs        # start hidden (run from project directory)
```

> **Never run `node server.js` or `node monitor.js` directly on Windows** — they are console applications and will flash terminal windows. Always use the VBS launcher.

**How flashing is prevented** (three layers):
1. **VBS launcher** — `wscript.exe` is a GUI-subsystem executable, so launching node through it creates no visible console window
2. **`useConptyDll: true`** — terminal sessions use the bundled `OpenConsole.exe` instead of the system ConPTY API, which on Windows 11 delegates to Windows Terminal and causes visible flashes
3. **`windowsHide: true`** — all child process calls (git, powershell, etc.) use this flag to suppress console windows

### Automated Install

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

## Configuration

Use the in-app Settings panel (gear icon in sidebar footer). Most changes apply instantly — only port, host, and shell need a restart.

Config is stored in `config.json` (gitignored):

| Key | Live Reload | Description |
|-----|:-----------:|-------------|
| `port` | No | HTTP port (default 7681) |
| `host` | No | Bind address (`0.0.0.0` for all interfaces, `127.0.0.1` for local) |
| `shell` | No | Shell path (Git Bash, PowerShell, cmd) |
| `user` / `password` | Yes | Login credentials (password auto-hashed on startup) |
| `serverName` | Yes | Display name for this server |
| `defaultCwd` | Yes | Default working directory for new sessions |
| `scanFolders` | Yes | Directories to scan for folder autocomplete |
| `defaultCommand` | Yes | Pre-filled auto-command for new sessions |
| `scrollbackReplayLimit` | Yes | Max bytes replayed on reconnect (default 1MB) |
| `publicUrl` | Yes | This server's URL for cluster auto-sync |
| `cluster` | Yes | Remote servers list `[{name, url}]` |
| `claudeHome` | Yes | User profile path for Claude session files (auto-detected if empty) |
| `openInNewTab` | Yes | Whether new sessions open in a new browser tab |

## Multi-Server Cluster

1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). All traffic proxies through your connected server — no CORS issues.

## Claude Code Hooks Setup

For real-time session status (Working/Idle/Waiting), configure Claude Code hooks. Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID"}, "allowedEnvVars": ["WT_SESSION_ID"]}]}],
    "Notification": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID"}, "allowedEnvVars": ["WT_SESSION_ID"]}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID"}, "allowedEnvVars": ["WT_SESSION_ID"]}]}]
  }
}
```

The HTTP hook type sends requests directly — no subprocess, no console window flash on Windows. Sessions started outside the web terminal (regular CLI) are silently ignored.

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
| `server.js` | Express + WebSocket server, session management, auth, cluster proxy, hooks |
| `app.html` | Unified single-page app (terminal + sidebar + settings) |
| `monitor.js` | Process manager — auto-restart, log rotation, crash diagnostics |
| `sw.js` | Service worker for PWA caching |
| `lobby.html` | Multi-server lobby page |
| `terminal.html` | Legacy standalone terminal page |
| `claude-hook.sh` | Claude Code hook script (bash, for non-Windows) |
| `claude-hook.js` | Claude Code hook script (Node.js, for Windows) |
| `tests/` | Playwright tests (security, cluster, API, exclusive viewer) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed technical walkthrough.

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

## License

MIT
