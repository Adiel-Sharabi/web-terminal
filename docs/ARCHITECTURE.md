# Web Terminal — Architecture Guide

A quick overview for anyone new to the codebase (no deep Node.js knowledge needed).

## What Is This?

A browser-based terminal manager. You open a webpage, get a real Linux/Windows shell, and can manage multiple terminal sessions from any device — phone, tablet, or PC. Think of it like SSH, but in your browser, with a nice UI and a cluster mode so one page can see sessions on several machines.

## Tech Stack

| Technology | What It Does | Why It's Here |
|-----------|-------------|---------------|
| **Node.js** | Runs the server | Lightweight runtime for JavaScript on the server side |
| **Express** | Web framework | Handles HTTP routes (login, API, serving pages) |
| **WebSocket** (via `express-ws` + `ws`) | Real-time connection | Streams terminal I/O between browser and server instantly |
| **node-pty** | Pseudo-terminal | Spawns real shell processes (Git Bash, PowerShell, cmd) in binary mode |
| **xterm.js** (v5.5.0) | Terminal emulator | Renders the terminal in the browser — handles colors, cursor, scrolling |
| **Tailscale** (optional) | VPN mesh | Secure remote access with real HTTPS certificates |
| **Playwright** | Testing | Browser-based tests for auth, sessions, IPC, and hot reload |

No React, no Next.js, no build step. The frontend is plain HTML + vanilla JavaScript served directly by Express. One HTML file = one page.

## Process Model

The server is split into three Node.js processes supervised by a monitor:

```
         +----------------+
         |  monitor.js    |   parent — mints IPC token, supervises children,
         | (supervisor)   |   restarts on crash with exponential backoff
         +-------+--------+
                 |
         spawn   |   spawn
        +--------+--------+
        |                 |
        v                 v
+---------------+   +---------------+
| pty-worker.js |<->|  server.js    |   IPC over named pipe (Windows) or
| (owns PTYs    |   | (Express + WS |   unix socket (Unix), authenticated
|  + scrollback)|   |  + auth + API)|   via WT_IPC_TOKEN handshake
+-------+-------+   +-------+-------+
        |                   |
        | node-pty          | HTTP + WebSocket
        v                   v
   +---------+        +-----------+
   |  Shell  |        |  Browser  |
   +---------+        +-----------+
```

Why three processes instead of one?

1. **Hot reload of the web layer.** `server.js` is stateless — you can kill and restart it without losing shell sessions. The worker keeps the PTY processes alive and the scrollback buffers in memory; when the new `server.js` connects to the IPC pipe, clients reattach and replay scrollback as if nothing happened.
2. **Fault isolation.** A crash in the WebSocket handler doesn't take down your running TUI apps. A crash in the worker restarts only the PTY layer.
3. **Simpler security boundary.** The IPC pipe is the only trust relationship between the two children. It's gated by a handshake token the monitor mints and passes into both via `WT_IPC_TOKEN` (and the unix socket is `chmod 0600`).

## Data Flow — A Single Keystroke

1. You press `a` in the browser. `app.html` / xterm.js fires `onData("a")`.
2. The browser sends a text WebSocket frame to `server.js` on `/ws/:sessionId`.
3. `server.js` (via `lib/worker-client.js`) encodes a binary PTY_IN frame with the session UUID + payload and writes it to the IPC pipe.
4. `pty-worker.js` receives the frame, looks up the session by id, and writes `"a"` to the underlying `node-pty` process.
5. The shell echoes the byte; `node-pty` emits it on the `data` event.
6. The worker writes a PTY_OUT frame down the IPC pipe (backpressure-aware — drops frames for a stalled peer rather than OOMing).
7. `server.js` fans the bytes out to every connected WebSocket for that session.
8. The browser receives the WS frame and feeds it into xterm.js, which renders it.

Everything after step 3 is binary — there is no UTF-8 round-trip inside the server, so TUI apps that emit non-UTF-8 byte sequences render correctly.

## Frame Formats

The IPC pipe carries length-prefixed frames. Two kinds:

- **JSON control frames** — session create/destroy/resize, status updates, Claude hook events, list/save RPCs.
- **Binary PTY frames** — 16-byte session UUID prefix + raw bytes. No UTF-8 decode, no JSON escaping.

The decoder (`lib/ipc.js`) accumulates incoming bytes as a list of `Buffer` chunks and only concatenates when it has a full frame. That avoids the quadratic `Buffer.concat` cost that used to show up on multi-MB bursts (issue #14).

## Cluster & Direct Terminal Mode

Each server is independent: its own config, credentials, and session store. Clustering just means server A knows about server B via `config.json` and holds a bearer token that authorises it to call B's API.

Two data paths for a browser talking to a session on a remote server:

**Proxied (default).** Browser -> local server (WS) -> remote server (WS, with bearer token). Simple and CORS-free, but adds a network hop and serialises all traffic through the local server's event loop.

**Direct (opt-in, `directConnect: true` on the peer entry).** When listing sessions, the local server mints a per-session HMAC-SHA256 token (`lib/cluster-token.js`) signed with the bearer token it shares with the peer, and hands it to the browser. The browser opens the WebSocket directly to the peer using that token. The peer verifies the signature, trusts the embedded user/session binding, and attaches to the PTY. Tokens expire after 60s.

The legacy proxy path is always available as fallback — direct mode is purely an optimisation for browsers that already have direct network reachability (e.g. same Tailnet).

## File Map

### The three core processes

| File | Role | Lines (approx.) |
|------|------|-----------------|
| `monitor.js` | Supervisor. Mints the IPC token, spawns worker + web, restarts them on crash, rotates logs. | ~500 |
| `pty-worker.js` | Owns all `node-pty` sessions, scrollback buffers, session persistence, Claude hook state. | ~1200 |
| `server.js` | HTTP, WebSocket, auth, cluster proxy, REST API. Stateless with respect to PTYs — everything goes through IPC. | ~2000 |

### Supporting backend libraries

| File | Purpose |
|------|---------|
| `lib/ipc.js` | Framing + named-pipe / unix-socket server and client, with handshake auth and backpressure |
| `lib/worker-client.js` | High-level RPC / event client used by `server.js` to talk to the worker |
| `lib/cluster-token.js` | Pure-function HMAC-SHA256 mint/verify for direct-mode session tokens |
| `lib/agents.js` | **AI-agent provider registry — the one place that knows anything agent-specific**: parser, transcript root and resolution strategy, subagent-trace support, submit and interrupt policy, label and colour. Adding an agent is one parser module plus one entry here, with no branching anywhere else. See [AI-AGENTS.md](AI-AGENTS.md) |
| `lib/transcript.js` / `lib/transcript-codex.js` | Per-agent transcript parsers, both emitting one shared typed turn shape so every consumer stays agent-agnostic |
| `lib/codex-sessions.js` | Resolves a Codex rollout by cwd — Codex keys rollouts by date + UUID, so the cwd is read from each candidate's `session_meta` head line |
| `lib/submit-frames.js` | The pure byte rules on the PTY input path: `splitTrailingCr` (hold the submit CR back so a TUI that folds a read into a paste sees Enter, not a newline), `endsBracketedPaste`, and `isEscapeKey` (a *lone* `0x1b` is an interrupt; an arrow's `ESC [ A` is not) |
| `lib/osc9-notify.js` | Pure extraction of OSC 9 notification bodies from a PTY stream, buffered across chunk boundaries — how a Codex session reports status without usable hooks. What a body *means* is a registry field, not here |
| `lib/usage-rollup.js` | Pure rule turning per-session metric reports into the per-server usage block: 5h/7d windows are account-wide, so they roll up once per agent and are never merged across agents |
| `lib/resources.js` | #152 (per-server slice) — pure `cpuPercentFromSamples` turns two `os.cpus()` tick snapshots into a utilisation %, since a single read gives average-since-boot, not current load; `Sampler` keeps one warm snapshot on its own timer so a request never pays for the sampling. `sanitizeResources` validates a peer's reading before it is served on |
| `lib/git-safe.js` | Hardened runner for the version/update-check git calls — disables credential prompts and tree-kills on timeout, so a broken HTTPS remote cannot hang `git-credential-manager` and leak process trees |
| `claude-hook.js` / `claude-hook.sh` | Claude Code hook scripts (Node for Windows, bash elsewhere) |
| `scripts/install-codex-notify.js` | Writes the three `[tui]` keys that enable Codex's OSC 9 status channel. Applied by `scripts/cold-restart.ps1` on every deploy; `--check` reports without changing anything |
| `scripts/install-hooks.js` | Owns the Claude Code hook set in `~/.claude/settings.json` — the nine events the server consumes. Adds/corrects only web-terminal's own http entry, so user hooks survive; idempotent, so the deploy path applies it every time. The set had no owner in the repo until 2026-08-12, which is how `SessionStart` came to be missing on every machine |
| `scripts/bump-server-version.js` | Bumps `SERVER_VERSION`, which lives on a ~280KB single line that no reviewer or agent should have to read to change three digits |

### Frontend

| File | What |
|------|------|
| `app.html` | The entire unified frontend — terminal UI, sidebar, settings, all in one file |
| `terminal.html` | Legacy standalone terminal page (served at `/s/:id`) |
| `lobby.html` | Legacy session list page (served at `/lobby`) |
| `sw.js` | Service worker for PWA caching |
| `manifest.json` | PWA manifest — app name, icon, standalone mode |
| `icon.svg` | App icon |

### Installer / platform

| File | Purpose |
|------|---------|
| `install.ps1` | Windows installer (scheduled task, Tailscale, config) |
| `register-task.ps1` | Register the auto-start scheduled task |
| `create-startup.ps1` | Create a Startup-folder shortcut instead |
| `start-server.vbs` | GUI-subsystem launcher — lets `wscript.exe` spawn node without flashing a console |
| `config.default.json` | Default config template |

### Data files (gitignored, local only)

| File | Purpose |
|------|---------|
| `config.json` | Your settings (port, password, cluster, etc.) |
| `sessions.json` | Saved session configs (survive server restarts) |
| `api-tokens.json` | API auth tokens this server has minted for its peers |
| `cluster-tokens.json` | Tokens this server has been issued by its peers |
| `logs/` | Monitor-rotated stdout/stderr from worker + web |

### Tests (Playwright)

| File | Area |
|------|------|
| `tests/security.spec.js` | Auth, session CRUD, XSS, config security |
| `tests/cluster.spec.js` | Token auth, cluster API, proxy security |
| `tests/cluster-direct-mode.spec.js` | End-to-end direct terminal mode + token signing |
| `tests/cluster-token.spec.js` | Unit tests for `lib/cluster-token.js` |
| `tests/resources.spec.js` | Unit tests for `lib/resources.js` — the tick-delta CPU maths and `sanitizeResources` |
| `tests/ipc.spec.js` / `tests/ipc-*.spec.js` | IPC framing, auth handshake, backpressure, chunked decoder |
| `tests/worker-*.spec.js` | Worker behaviour (sessions, binary PTY, dirty-flag saves, scrollback chunks, session-id lookup) |
| `tests/hot-reload.spec.js` | End-to-end hot-reload — kill `server.js`, expect sessions to survive |
| `tests/exclusive-viewer.spec.js` | Single-viewer enforcement across devices |
| `tests/keep-sessions-open.spec.js` | Instant-switch mode |

## Key Concepts

### Sessions

A session is a running shell process (PTY in the worker) plus its metadata (name, working directory, auto-command). Sessions persist across server and worker restarts — when the worker comes back up, it re-spawns the PTY and replays the scrollback buffer up to `scrollbackReplayLimit` bytes.

### Exclusive Viewer

Only one device can view a session at a time. Opening a session on your phone disconnects it from your desktop. This prevents display corruption when different screen sizes fight over PTY dimensions.

### Cluster

Multiple web-terminal servers can form a cluster. Each server is independent (own credentials, own sessions). When you add a remote server, you authenticate once, and both servers discover each other. By default all remote traffic is proxied through the server your browser is connected to; see "Cluster & Direct Terminal Mode" above for the optional direct-connection mode.

### Auth

Two auth mechanisms:
- **Cookie auth** — for browser users (login form -> HttpOnly session cookie, 90 days)
- **Bearer token auth** — for inter-server cluster communication (API tokens with 90-day expiry)

Passwords are hashed with scrypt, compared with timing-safe equality, and login is rate-limited (5 attempts / minute, 5-minute lockout).

### Mobile Input

Android keyboards (SwiftKey, Gboard) use IME composition which fires different events than desktop keyboards. The code lets xterm.js handle IME events natively, deduplicates rapid double-fires for punctuation at the `onData` level, and transparently rewrites autocorrect changes via backspace so the corrected word reaches the shell once.

## Performance Notes

A handful of optimisations shipped along the worker split. In rough order of impact:

- **Cached `/api/version`** — no longer forks `git fetch` per request; p99 typing stalls dropped from ~12s to <400ms.
- **Chunk-list `FrameDecoder`** — about 13x faster on multi-MB bursts by avoiding `Buffer.concat` on every read.
- **Chunk-list scrollback** — store and replay as a list of `Buffer`s, concat once per read, skip unchanged sessions on the 30s periodic save (dirty flag), and yield the event loop between sessions inside the async saver.
- **Binary PTY plane** — node-pty in binary mode; scrollback kept as `Buffer`, no UTF-8 hops in the hot path.
- **Cached UUID bytes + O(1) session id lookup** — per-session id cached on the session object and on the PTY frame encoder.
- **Cached Claude session-id detection** — per-cwd mtime cache keeps hook events O(1).

## Dependencies

Only 3 production dependencies:

```json
{
  "express": "^4.21.0",       // Web framework
  "express-ws": "^5.0.2",     // WebSocket support for Express
  "node-pty": "^1.0.0"        // Pseudo-terminal (spawns real shells, binary mode)
}
```

Everything else (xterm.js, fit addon, web-links addon) is loaded from CDN in the browser. No build step, no bundler, no transpiler.

---

## Generated trees outside the repo (safe to delete)

Some tooling writes to directories **outside** the checkout. They are disposable —
delete any of them and the next run recreates it — and they all live under one
dot-prefixed parent, `C:\dev\.wt-scratch\`, so `C:\dev` shows one entry rather than
four siblings of real repos (#80).

| Path | Written by | What it is |
|---|---|---|
| `.wt-scratch\wt-rig` | `scripts/rig/rig.js` | A complete, isolated web-terminal (port 7999, own worker pipe, own config + data). Cannot touch production |
| `.wt-scratch\ai-terminal-winbuild` | `ai-terminal/scripts/build-windows.sh` | Stripped Flutter tree for the release Windows build (Firebase removed) |
| `.wt-scratch\ai-terminal-probe` | `ai-terminal/scripts/build-probe-windows.sh` | Stripped Flutter tree for the input probe, driven by `scripts/rig/probe-drive-windows.ps1` |

**One place decides where they are: `scripts/scratch-dirs.js`.** JS callers import it; the
bash and PowerShell callers shell out to it (`node scripts/scratch-dirs.js winbuild --posix`)
rather than keeping their own copy of the path. Each entry is individually overridable
(`WT_RIG_DIR`, `WT_WINBUILD_DIR`, `WT_PROBE_DIR`), and `WT_SCRATCH_DIR` moves all three.

**Why they are not simply moved into the repo.** Two deliberate reasons, both load-bearing:
`rig.js` identifies its own stray processes by globbing command lines for the rig
directory's **basename**, which only works while that name cannot appear in a production
command line; and the Flutter build scripts write a *stripped copy* of the tree they were
launched from, which must not land inside the tree being copied.

**Do not "tidy" the basenames** to `rig` / `winbuild` / `probe`. `wt-rig` is what keeps that
process glob specific — a bare `rig` would match any command line containing "rig" and the
orphan sweep could kill unrelated node processes.
