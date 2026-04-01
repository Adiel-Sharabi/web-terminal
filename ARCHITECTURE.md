# Web Terminal — Architecture Guide

A quick overview for anyone new to the codebase (no deep Node.js knowledge needed).

## What Is This?

A browser-based terminal manager. You open a webpage, get a real Linux/Windows shell, and can manage multiple terminal sessions from any device — phone, tablet, or PC. Think of it like SSH, but in your browser, with a nice UI.

## Tech Stack

| Technology | What It Does | Why It's Here |
|-----------|-------------|---------------|
| **Node.js** | Runs the server | Lightweight runtime for JavaScript on the server side |
| **Express** | Web framework | Handles HTTP routes (login, API, serving pages) |
| **WebSocket** (via `express-ws` + `ws`) | Real-time connection | Streams terminal I/O between browser and server instantly |
| **node-pty** | Pseudo-terminal | Spawns real shell processes (Git Bash, PowerShell, cmd) |
| **xterm.js** (v5.5.0) | Terminal emulator | Renders the terminal in the browser — handles colors, cursor, scrolling |
| **Tailscale** (optional) | VPN mesh | Secure remote access with real HTTPS certificates |
| **Playwright** | Testing | Browser-based tests for auth, sessions, and security |

No React, no Next.js, no build step. The frontend is plain HTML + vanilla JavaScript served directly by Express. One HTML file = one page.

## How It Works

```
 Your Browser                    Server (Node.js)                Shell
+-------------+    WebSocket    +------------------+    PTY     +----------+
|  xterm.js   | <============> |   server.js      | <========> | Git Bash |
|  (terminal  |   (real-time   |   (Express +     |  (node-pty |  or cmd  |
|   in HTML)  |    bidirect.)  |    WebSocket)    |   spawn)   |          |
+-------------+                +------------------+            +----------+
       |                              |
       | HTTP (login, API)            | Cluster proxy
       +----------------------------->| (WebSocket forwarding
                                      |  to remote servers)
```

**The flow:**
1. You open the page in a browser → Express serves `app.html`
2. `app.html` creates an xterm.js terminal and opens a WebSocket to `/ws/:sessionId`
3. The server creates a PTY (pseudo-terminal) via `node-pty` — this is a real shell process
4. Everything you type goes: **browser → WebSocket → server → PTY → shell**
5. Shell output goes back: **shell → PTY → server → WebSocket → browser → xterm.js**

## File Map

### Core (3 files do 95% of the work)

| File | What | Lines |
|------|------|-------|
| `server.js` | The entire backend — Express routes, WebSocket handlers, session management, auth, cluster proxy | ~1600 |
| `app.html` | The entire frontend — terminal UI, sidebar, settings panel, all in one file | ~1700 |
| `sw.js` | Service worker for PWA caching (makes it installable as an app) | ~30 |

### Supporting Files

| File | Purpose |
|------|---------|
| `terminal.html` | Legacy standalone terminal page (served at `/s/:id`) |
| `lobby.html` | Legacy session list page (served at `/lobby`) |
| `manifest.json` | PWA manifest — app name, icon, standalone mode |
| `icon.svg` | App icon |
| `config.default.json` | Default config template |
| `install.ps1` | Windows installer (creates scheduled task, configures Tailscale) |

### Data Files (gitignored, local only)

| File | Purpose |
|------|---------|
| `config.json` | Your settings (port, password, cluster, etc.) |
| `sessions.json` | Saved session configs (survive server restarts) |
| `api-tokens.json` | API auth tokens for cluster communication |
| `cluster-tokens.json` | Stored tokens for remote servers you've authenticated to |
| `history.json` | Folder history for the "New Session" dialog |

### Tests

| File | What It Tests |
|------|--------------|
| `tests/security.spec.js` | Auth, session CRUD, XSS prevention, config security |
| `tests/cluster.spec.js` | Token auth, cluster API, proxy security |
| `tests/exclusive-viewer.spec.js` | Single-viewer enforcement across devices |

## Key Concepts

### Sessions
A "session" is a running shell process (PTY) plus its metadata (name, working directory, auto-command). Sessions persist across server restarts — the PTY is re-spawned and the scrollback buffer is replayed.

### Exclusive Viewer
Only one device can view a session at a time. Opening a session on your phone disconnects it from your desktop. This prevents display corruption from different screen sizes fighting over the PTY dimensions.

### Cluster
Multiple web-terminal servers can form a cluster. Each server is independent (own credentials, own sessions). When you add a remote server, you authenticate once, and both servers discover each other. All remote traffic is proxied through WebSocket forwarding — your browser talks to one server, which relays to the others.

### Auth
Two auth mechanisms:
- **Cookie auth** — for browser users (login form → session cookie)
- **Bearer token auth** — for inter-server cluster communication (API tokens with 90-day expiry)

Passwords are hashed with scrypt. Login is rate-limited.

### Mobile Input
Android keyboards (SwiftKey, Gboard) use IME composition which fires different events than desktop keyboards. The code lets xterm.js handle IME events natively and deduplicates rapid double-fires for punctuation at the `onData` level.

## Dependencies

Only **3 production dependencies**:

```json
{
  "express": "^4.21.0",       // Web framework
  "express-ws": "^5.0.2",     // WebSocket support for Express
  "node-pty": "^1.0.0"        // Pseudo-terminal (spawns real shells)
}
```

Everything else (xterm.js, fit addon, web-links addon) is loaded from CDN in the browser. No build step, no bundler, no transpiler.
