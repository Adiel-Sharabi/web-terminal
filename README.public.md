<p align="center">
  <img src="icon.svg" width="80" alt="Web Terminal">
</p>

<h1 align="center">Web Terminal</h1>

<p align="center">
  Browser-based terminal manager for Windows.<br>
  Run, monitor, and control multiple CLI sessions from any device.
</p>

<p align="center">
  <strong>Built for <a href="https://claude.ai/claude-code">Claude Code</a></strong> &mdash; but works with any CLI tool.
</p>

---

> **Platform note:** Web Terminal is designed for Windows, where browser-based terminal solutions are scarce. Linux and macOS users have excellent alternatives like [ttyd](https://github.com/tsl0922/ttyd), [gotty](https://github.com/sorenisanerd/gotty), and [code-server](https://github.com/coder/code-server).

## Why?

Running Claude Code (or any long-running CLI) on a remote Windows machine? You need to:
- Check on it from your phone while away from the desk
- Run multiple sessions across multiple machines
- Get notified when something needs your attention
- Resume conversations without SSH or RDP

Web Terminal solves all of this with a single `node server.js`.

## Features

### Terminal
- **Multiple sessions** in parallel, each with its own shell
- **Shared sessions** &mdash; open the same terminal from multiple devices simultaneously
- **Instant session switching** without page reload
- **Session persistence** &mdash; sessions survive server restarts with auto-command replay
- **Clipboard image paste** &mdash; Alt+V uploads images to server clipboard (for Claude Code)
- **Smart scrollback** &mdash; configurable replay limit, instant load on connect

### Monitoring
- **Live status** &mdash; green (Running), yellow (Idle), red (Needs Input)
- **Smart detection** &mdash; distinguishes AI output from user typing
- **Browser notifications** &mdash; alerts when any session needs attention
- **Cross-session** &mdash; get notified about session B while viewing session A

### Multi-Server
- **Cluster mode** &mdash; connect multiple machines, manage all sessions from one window
- **Auto-sync** &mdash; authenticate once, both servers discover each other
- **Per-server credentials** &mdash; no shared secrets, independent auth
- **Offline resilience** &mdash; any server can be the hub, offline servers shown greyed out
- **Create sessions** on any connected server from the sidebar

### Claude Code Integration
- **Session browser** &mdash; scan and resume Claude Code conversations across all servers
- **Auto-command** &mdash; configure `claude --dangerously-skip-permissions` per session
- **Resume on restart** &mdash; sessions auto-resume with `--continue` after server restart

### Platform
- **PWA** &mdash; install as standalone app on desktop, Android, or iOS
- **Mobile friendly** &mdash; responsive layout, touch scroll
- **Live config** &mdash; most settings apply instantly without restart
- **Secure** &mdash; cookie + token auth, scrypt hashing, rate limiting, CSP headers, localhost binding
- **Tailscale ready** &mdash; HTTPS with real TLS certificates over your mesh VPN

## Quick Start

**Requirements:** [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```powershell
git clone https://github.com/user/web-terminal.git C:\tools\web-terminal
cd C:\tools\web-terminal
npm install
node server.js
```

Open [http://localhost:7681](http://localhost:7681) &mdash; login with `admin` / `admin` (you'll be prompted to change it).

### Automated Install

```powershell
# Run as Administrator (sets up auto-start + Tailscale HTTPS)
powershell -ExecutionPolicy Bypass -File C:\tools\web-terminal\install.ps1
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-Port` | 7681 | HTTP port |
| `-User` | admin | Login username |
| `-Password` | admin | Login password (forced change on first use) |
| `-Shell` | Git Bash | Shell executable path |
| `-DefaultCwd` | C:\dev | Default working directory |
| `-SkipTailscale` | false | Skip Tailscale HTTPS setup |

## Configuration

Use the in-app **Settings** panel, or edit `config.json` directly:

```json
{
  "port": 7681,
  "user": "admin",
  "password": "my-strong-password",
  "shell": "C:\\Program Files\\Git\\bin\\bash.exe",
  "defaultCwd": "D:\\projects",
  "scanFolders": ["D:\\projects", "C:\\work"],
  "serverName": "My-PC",
  "defaultCommand": "claude --dangerously-skip-permissions"
}
```

Most settings are **live** &mdash; changes take effect immediately. Only `port`, `host`, and `shell` require a restart.

<details>
<summary>Full config reference</summary>

| Key | Live | Description |
|-----|------|-------------|
| `port` | No | HTTP port |
| `host` | No | Bind address (default: `127.0.0.1`) |
| `shell` | No | Shell executable |
| `user` / `password` | Partial | Login credentials (password change needs restart) |
| `serverName` | Yes | Display name for this server |
| `defaultCwd` | Yes | Default working directory for new sessions |
| `scanFolders` | Yes | Directories to scan for folder suggestions |
| `defaultCommand` | Yes | Pre-filled command for new sessions |
| `scrollbackReplayLimit` | Yes | Max bytes sent on session connect (default: 100KB) |
| `publicUrl` | Yes | This server's public URL (for cluster auto-sync) |
| `cluster` | Yes | Remote servers list: `[{ "name": "...", "url": "..." }]` |

</details>

## Remote Access

Web Terminal binds to `127.0.0.1` by default &mdash; only accessible locally. For remote access, use [Tailscale](https://tailscale.com):

```powershell
# One-time setup per machine
tailscale serve --https=443 localhost:7681
```

Then access from any device on your tailnet:
```
https://my-pc.tailnet.ts.net
```

Four layers of security:
1. **WireGuard encryption** (Tailscale) &mdash; only your devices can connect
2. **TLS/HTTPS** &mdash; real certificates, no browser warnings
3. **Login credentials** &mdash; scrypt-hashed, rate-limited
4. **Localhost binding** &mdash; not exposed on LAN

## Multi-Server Cluster

Manage sessions across multiple machines from a single browser tab.

**Setup:**
1. Set **Public URL** on each server (Settings &rarr; Public URL)
2. Add a remote server on any one machine (Settings &rarr; Cluster &rarr; Add)
3. Click **Login** next to the remote server in the sidebar
4. Done &mdash; both servers automatically discover each other

**How it works:**
- Each server maintains independent credentials
- Inter-server auth via API tokens (90-day expiry, individually revokable)
- All traffic proxied through your current server (no CORS)
- Offline servers shown greyed out, come back automatically
- Create sessions on any server, resume Claude conversations from any server

## PWA

Install Web Terminal as a standalone app:

1. Open in Chrome/Edge
2. Click the install icon in the address bar
3. Runs in its own window without browser chrome

Works on desktop, Android (Chrome), and iOS (Add to Home Screen).

## Security

- **Authentication:** Cookie-based sessions + API token auth for cluster
- **Passwords:** scrypt-hashed, forced change from default on first login
- **Rate limiting:** Login attempts throttled (5 attempts / 60s, 5-minute lockout)
- **Headers:** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- **Binding:** Localhost only by default (remote access only through Tailscale tunnel)
- **XSS prevention:** All dynamic content escaped via textContent
- **Path traversal protection:** Sanitized file operations with path validation
- **Session persistence:** Cryptographic session secret persisted across restarts
- **Cluster auth:** Per-server tokens, no shared secrets, Bearer token validation
- **Test suite:** 37 automated tests covering auth, CRUD, XSS, cluster security

## Update

```powershell
cd C:\tools\web-terminal
git pull
npm install --production
# Restart the server (or use the Restart button in Settings)
```

Your config, sessions, and history are gitignored &mdash; updates won't overwrite them.

## Architecture

```
Phone/Tablet ──> Tailscale VPN ──> Web Terminal ──> Git Bash ──> Claude Code
                                        |
PC Browser ────> localhost:7681 ────────┘
                                        |
                          ┌─────────────┘
                          v
                   Remote Servers (cluster proxy)
```

<details>
<summary>File structure</summary>

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, auth, session management, cluster proxy |
| `app.html` | Unified single-page app (terminal + sidebar + settings) |
| `sw.js` | Service worker for PWA |
| `manifest.json` | PWA manifest |
| `icon.svg` | App icon |
| `install.ps1` | Automated installer (Windows) |
| `config.default.json` | Default config template |
| `tests/` | Playwright test suite (security, cluster, UI) |

</details>

## License

MIT
