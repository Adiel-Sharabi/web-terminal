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
  <br>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
</p>

---

> **Platform note:** Web Terminal is designed for Windows, where browser-based terminal solutions are scarce. Linux and macOS users have excellent alternatives like [ttyd](https://github.com/tsl0922/ttyd), [gotty](https://github.com/sorenisanerd/gotty), and [code-server](https://github.com/coder/code-server).

## Why?

Running Claude Code (or any long-running CLI) on a remote Windows machine? You need to:

- Check on it from your phone while away from the desk
- Run multiple sessions across multiple machines
- Get notified when something needs your attention
- Resume conversations without SSH or RDP

Web Terminal solves all of this, running as a single `node monitor.js` on each host.

## Features

### Terminal & Sessions
- **Multiple sessions** — run several terminals in parallel, each with its own shell
- **In-place switching** — switch between sessions without page reload
- **Instant switching** — optional `keepSessionsOpen` mode keeps background WebSocket connections to all sessions, caches scrollback in memory, and switches instantly without re-downloading data
- **Session persistence** — sessions survive server restarts with scrollback replay
- **Lazy scrollback** — initial attach replays a small chunk (default 32 KB) for fast first paint; scrolling xterm to the top fetches older bytes on demand from `/api/sessions/:id/scrollback`, up to the worker's stored history
- **Auto-command** — startup command per session, waits for shell prompt before executing
- **Fork session** — duplicate a Claude session with `--fork-session` from the sidebar
- **Exclusive viewer** — one device per session prevents display corruption from mixed screen sizes
- **Drag-reorder sessions** — drag a session row in the sidebar to change its order within the same server (cross-server reorder is disallowed). Order persists on disk and survives restarts
- **Collapsible server groups** — click a server header in the sidebar to fold its session list away. State is per-browser (localStorage) and persists across reloads
- **Favorite sessions** — click the star on any session row to pin it to a **Favorites** group at the top of the sidebar, spanning all servers. Each favorite is badged with the server it lives on (Home / Office / …) so you always know where it is. Per-browser (localStorage), collapsible, and click-to-switch like any session row. **Reorderable** — drag to reorder on desktop, or long-press then drag on mobile; the order persists per-browser

### Multi-Server Cluster
- **Unified dashboard** — see and manage sessions across all servers in one sidebar
- **Auto-sync** — authenticate once and both servers discover each other automatically
- **Cluster proxy** — all remote traffic routed through your connected server (no CORS)
- **Direct terminal mode** (opt-in) — for peers flagged `directConnect: true`, the browser's terminal WebSocket connects straight to the peer using a short-lived HMAC-signed token, skipping the proxy hop. Roughly 14x faster at p50 when your browser is closer to the target server than to the server you logged in through
- **API tokens** — inter-server auth with 90-day expiry
- **Remote exec** — run commands on any server via `/api/exec`

### AI Agent Integration (Claude Code + Codex)
- **Multi-agent sessions** — a session knows *which* AI CLI agent it runs. Pick it in the new-session form ("AI agent": Auto / Claude Code / Codex) or let the server infer it from the launch command; a plain shell has no agent and is never mislabelled. Each row is tinted with its agent's colour. The agent is persisted on the session (`sessions.json`) and returned as `agent` on `/api/sessions`, `/api/cluster/sessions` and the transcript response (`null` = plain shell). An **explicit** choice is authoritative — a session declared Claude is never served a Codex transcript; only a session with no recorded agent falls back to cross-provider discovery.
- **One provider registry** — everything agent-specific (transcript parser, transcript root, how a transcript is located, subagent-trace support, label + colour) lives in `lib/agents.js`. **Adding another CLI agent is one parser module + one registry entry** — no branching in `server.js`, `pty-worker.js`, or either client. `GET /api/agents` serves the catalogue, so the web + companion pickers and the per-agent tint pick up a new agent with no client release.
- **Codex transcripts** — the chat view renders Codex conversations exactly like Claude's. `lib/transcript-codex.js` parses Codex's rollout JSONL into the same typed turn shape (`shell_command`, `apply_patch` and `web_search` become rich tool cards, paired with their output). Codex keys rollouts by date + uuid rather than by cwd, so `lib/codex-sessions.js` finds a session's rollout by reading each candidate's `session_meta` head line, newest-first and bounded. One backward paginator, one cursor codec and one set of size caps serve every agent.
- **Session intelligence** — real-time status tracking via Claude Code hooks: Working (orange), Idle (green), Waiting for input (red)
- **Rich tool cards in chat** — the companion app's chat view reflects what the terminal shows: shells (Bash command + output), subagents (Task description / subagent type + its report), and file ops (Read/Edit/Write with a diff), each a compact card that expands to the detail. `GET /api/sessions/:id/transcript` exposes, per `tool_use`, its `id`, a per-field-capped structured `input`, and the paired tool_result `result` (output); `lib/transcript.js` pairs results to their tool call by id. Backward-compatible (`name`/`inputPreview` unchanged)
- **Drill into a running subagent (chat-mode parity with the terminal's subagent panel)** — a `Task` tool card that spawned a subagent shows a live **running dot** and taps to expand into the subagent's *own* nested tool calls (Bash/Read/Edit…), lazily loaded and re-polled every 4s while it runs, so you can watch it work — the chat-native equivalent of the terminal's arrow-navigable subagent view. A nested `Task` keeps its own panel, so you can drill to any depth. Powered by two additions: `/api/sessions/:id/transcript` now stamps each `Task` tool_use that left a subagent transcript on disk with a `{ agentType, description, running }` stub (linked via the `agent-*.meta.json` sidecar's `toolUseId`), and `GET /api/sessions/:id/subagent/:toolUseId` pages that subagent's own transcript with the *same* backward-cursor parser (the sidechain `.jsonl` shares the main turn shape — one parser). Advertised via the `subagent-trace` capability; additive + backward-compatible
- **Status-line metrics** — the companion app's chat view mirrors the Claude Code status line: context-window %, and the 5-hour / 7-day rate-limit usage %. The global status-line script POSTs these to `POST /api/claude-status` (localhost-only, throttled ~5s, safe-fail); the server holds them in memory keyed by Claude session id and exposes `metrics: { ctx, fiveH, sevenD, model, effort }` on each `/api/sessions` entry (advertised via the `status-metrics` capability). Ephemeral by design — reposted continuously, so they self-heal after a restart
- **API-error auto-recovery** — detects `API Error: …` (including rate-limit / "temporarily limiting requests") in a Claude session's output, flags the session with a **pulsing red** highlight in the sidebar and fires a notification so you know to pay attention. On a transient/overload error (529, 500, rate-limit, timeouts, etc.) it auto-recovers: sends `continue` twice, then `/compact` and replays your last prompt — up to 3 attempts per error, then leaves it highlighted for you. Submissions are sent as a real carriage-return Enter so Claude's TUI actually receives them. Toggle with `autoContinueOnApiError` (Settings → "Auto-recover from Claude API errors", default on). Non-transient errors (400/401) only highlight + notify.
- **Smart notifications** — urgent alerts for permission prompts (always shown), quiet notifications for idle sessions (background only)
- **Phone push (ntfy)** — get pushed to your phone even when the app is closed. Tap the 🔔 bell on a session row to open a picker and set that session's level: **off**, **important** (default — Claude needs approval + a *stuck* API error that didn't auto-recover), or **all** (+ finished/idle once it settles). Anti-flood by design: API-error pushes only fire if the error persists ~25s, idle only after ~2 min settled, approvals are debounced. Each push leads with **which server + which session**, quotes **Claude's last message** (pulled from the session transcript, so you see *what* it said/asked, not just that it wants attention), and taps through to it. Configure per server in `config.json` under `ntfy` (`{ enabled, server, topic }`); subscribe the [ntfy](https://ntfy.sh) app to the topic. `POST /api/notify-test` sends a probe. Levels persist server-side in `notify-prefs.json` (gitignored) — no worker restart to change
- **Mute button** — toggle notifications while keeping sidebar status dots live
- **Claude sessions browser** — scan, resume, and transfer Claude Code conversations across servers
- **Session names** — auto-extracted from Claude conversation titles, synced via `/rename` on sidebar rename
- **Clipboard image paste** — Alt+V to paste images directly into Claude Code
- **Drag-and-drop images** — drop an image file on the terminal to upload it (same path as Alt+V)
- **Peer relay** — two agents running side-by-side (e.g. Claude + Codex) can ask each other for a second opinion via a localhost-only message bus at `/api/relay/{send,recv,status}`. Supports batched messages (`more:true` buffers, `more:false` flushes so the peer answers once). Hard rate limits (default: 6 turns per conversation, 50 messages per day, 16 KB per message — overridable via `WT_RELAY_*` env vars) stop runaway loops from burning the token budget overnight. Contract for both agents lives in [PEER_PROTOCOL.md](PEER_PROTOCOL.md).

### Mobile & PWA
- **Progressive Web App** — install as standalone app; name reflects server name
- **Compose input bar** — on mobile, type into a normal text field with full native keyboard behaviour (autocomplete, swipe, predictive text), then **Send** (or Enter) to flush the whole buffer to the terminal. Sidesteps the duplication / lag / broken autocomplete that comes from streaming every keystroke of a composition-oriented mobile keyboard into a terminal. Shift+Enter inserts a newline; multi-line buffers are sent as a bracketed paste. ↑/↓ on the touch toolbar walk send-history, ←/→ move the caret. A line starting with `/` streams live so Claude's own slash-command menu renders and narrows as you type.
- **Compose / Raw toggle** — a button in the touch toolbar switches between compose mode (default on mobile) and raw per-keystroke passthrough for full-screen TUIs (vim, htop, less). The choice persists per browser.
- **Touch toolbar** — compose/raw toggle, Esc, Ctrl, Alt, Shift (sticky), Tab, arrows, plus `/`, `|`, `-`, `~`
- **Long-press context menu** — Copy, Paste, Paste Image, Select, Select All
- **Drag-to-select** — character count shown, floating Copy/Done bar
- **IME deduplication & autocorrect** — in raw mode, handles Android keyboard (SwiftKey, Gboard) composition re-sends without duplication; autocorrect changes are transparently applied via backspace rewrite so the corrected word reaches the shell once
- **Instant reconnect on app-switch** — a backgrounded mobile browser/PWA is suspended by the OS (timers freeze, the WebSocket is dropped), so returning to the app used to mean waiting out a stale exponential-backoff timer. The terminal now reconnects the moment the page returns to the foreground (`visibilitychange` / `pageshow` / `focus` / `online`), so switching back feels seamless. A still-open socket is just kept warm rather than needlessly torn down
- **Responsive layout** — adapts to phone, tablet, and desktop

### Security
- **Scrypt password hashing** with timing-safe comparison
- **Rate limiting** — 5 failed logins per minute, 5-minute lockout
- **CSP headers** — Content-Security-Policy, X-Frame-Options, X-Content-Type-Options
- **Cookie + token auth** — HttpOnly SameSite=Lax cookies (90-day) with server-side expiry enforcement, Bearer tokens for API/cluster
- **Path traversal protection** on all file operations
- **Input length limits** on all user-facing inputs
- **Authenticated worker IPC** — named-pipe / unix-socket between `server.js` and `pty-worker.js` is gated by a per-process handshake token generated by `monitor.js` and shared via `WT_IPC_TOKEN` env var; unix socket is `chmod 0600` to the owning uid
- **Signed direct-terminal tokens** — when direct terminal mode is enabled, the browser receives a per-session HMAC-SHA256 token with a 60s TTL, bound to the session id and the authenticated user. The HMAC key is the bearer token already shared between the cluster peers — no new secret distribution
- **`/api/exec` is opt-in** — remote command execution is disabled by default. Set `"enableRemoteExec": true` in `config.json` to enable it. Enabling it gives any holder of a valid bearer token the ability to run arbitrary shell commands on the server — treat it like SSH. When enabled, calls are rate-limited to 30/min/token and audited to `logs/exec-audit.log` (timestamp, token label, command SHA-256, client IP, exit code, duration). When disabled, the route returns 404.

### Performance
- **Binary PTY data plane** — node-pty is bound in binary mode end-to-end; scrollback is stored and replayed as `Buffer` chunks, so TUI apps that emit non-UTF8 byte sequences render correctly
- **Chunk-list scrollback** — scrollback is kept as a list of buffers and concatenated once per read; no O(n) re-alloc on every PTY frame
- **Chunk-list frame decoder** — the IPC decoder accumulates bytes as a chunk list and only concatenates when it has a full frame, avoiding the O(n^2) `Buffer.concat` cost on multi-MB bursts (~13x faster in our benchmarks)
- **Cached UUID bytes** — per-session id bytes are cached for PTY frame encoding instead of re-parsed on every write
- **Dirty-flag scrollback save** — the 30s periodic scrollback writer skips unchanged sessions; it is also async and yields the event loop between sessions
- **O(1) session id lookup** — session objects carry their id directly; no linear scan on every frame
- **Claude session-id cache** — per-cwd mtime cache keeps Claude Code hook events O(1)
- **Cached git version info** — `/api/version` does not fork `git fetch` per request; p99 typing stalls dropped from ~12s to <400ms

### Operations
- **Server monitor** (`monitor.js`) — supervises `pty-worker` + `server.js` as separate children, auto-restart with exponential backoff, crash budget, log rotation, health checks
- **Hot reload** — web layer (HTTP/WS) can be restarted without losing PTY sessions. The worker owns session state over a named pipe; killing `server.js` leaves shells running and reattaches on restart
- **IPC backpressure** — the worker drops PTY output frames to a slow connection instead of OOMing; a hard-cap (`WT_IPC_MAX_INFLIGHT`) closes the socket if the queue blows past the limit
- **Live config** — most settings apply immediately without restart
- **Tailscale ready** — HTTPS with real TLS certificates over your private mesh VPN

## Quick Start

**Requirements**: [Node.js](https://nodejs.org) 18+, [Git for Windows](https://git-scm.com/download/win)

```bash
git clone https://github.com/Adiel-Sharabi/web-agent-terminal.git
cd web-agent-terminal
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
| `scrollbackReplayLimit` | Yes | Bytes replayed on initial attach (default 32 KB). Older history is fetched on demand when xterm scrolls to the top. |
| `publicUrl` | Yes | This server's URL for cluster auto-sync |
| `cluster` | Yes | Remote servers list `[{name, url, directConnect?}]`. Set `directConnect: true` on a peer to enable direct-terminal mode (browser WS skips the local proxy hop for that peer's sessions). |
| `claudeHome` | Yes | User profile path for Claude session files (auto-detected if empty) |
| `openInNewTab` | Yes | Whether new sessions open in a new browser tab |
| `keepSessionsOpen` | Yes | Keep background WebSocket connections to all sessions for instant switching (default false) |
| `autoContinueOnApiError` | Yes | Auto-recover from transient Claude API errors: `continue` ×2, then `/compact` + replay your last prompt (up to 3 attempts per error). Default **true**. Highlight + notify happen regardless of this setting. Override per-process with the `WT_AUTO_CONTINUE_API_ERROR` env var (`0`/`1`). |
| `passAllEnv` | Yes | Pass the full parent environment to spawned shells (default false — a limited set of variables is forwarded) |
| `exclusiveViewer` | Yes | Restore single-owner session takeover: opening a session on a second device force-disconnects the first (old behavior). Default **false** — multiple devices now share one PTY (shared input/output), so phone + desktop can view/drive the same session at once. |

### Environment Variables

A few knobs are set via environment variables rather than `config.json`. Put them in `start-server.vbs` (or your service wrapper) so the monitor inherits them.

| Variable | Default | Description |
|----------|---------|-------------|
| `WT_IPC_TOKEN` | auto-generated by `monitor.js` | Shared secret used for the handshake on the worker <-> web named pipe. Normally you don't set this — the monitor mints a fresh 32-byte token per process tree and passes it to both children. Set it yourself only if you run `pty-worker.js` and `server.js` without the monitor |
| `WT_IPC_MAX_INFLIGHT` | `52428800` (50 MB) | Hard cap on bytes queued on a single IPC connection. If a slow browser pushes the queue past this, the worker destroys the socket rather than OOM |
| `WT_LATENCY_DEBUG` | unset | Set to `1` to enable event-loop-lag monitoring and slow-op logging in `server.js` and `pty-worker.js`. Useful for diagnosing typing stalls — see the Dev Tooling section below |

## Multi-Server Cluster

1. **Set Public URL** on each server (Settings → Public URL)
2. **Add a remote server** on any one server (Settings → Cluster → Add)
3. **Login to remote** — click Login next to the server in the sidebar
4. **Done** — both servers auto-discover each other. Repeat for more servers.

Each server keeps its own credentials. Inter-server auth uses API tokens (90-day expiry). By default all traffic proxies through your connected server — no CORS issues.

### Direct Terminal Mode (Optional)

Set `"directConnect": true` on a peer entry in `cluster` to skip the local server's proxy hop for that peer's sessions. The browser WebSocket connects straight to the peer using a short-lived (60 s) HMAC-signed token minted by your local server. Saves one network hop of latency when your browser already has direct network reachability to the peer.

```json
"cluster": [
  { "name": "Home", "url": "https://home.example:7681", "directConnect": true },
  { "name": "XPS",  "url": "https://xps.example:7681" }
]
```

The signing key is the bearer token you already share with the peer (stored in `cluster-tokens.json` locally and `api-tokens.json` on the peer). Disabled by default; the legacy proxy path is always available as fallback.

## Claude Code Hooks Setup

For real-time session status (Working/Idle/Waiting), configure Claude Code hooks. Add to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStart": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Notification": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}],
    "SubagentStop": [{"hooks": [{"type": "http", "url": "http://127.0.0.1:7681/api/hook", "headers": {"X-WT-Session-ID": "$WT_SESSION_ID", "X-WT-Hook-Token": "$WT_HOOK_TOKEN"}, "allowedEnvVars": ["WT_SESSION_ID", "WT_HOOK_TOKEN"]}]}]
  }
}
```

The HTTP hook type sends requests directly — no subprocess, no console window flash on Windows. Sessions started outside the web terminal (regular CLI) don't have `WT_HOOK_TOKEN` set, so their hook requests are rejected with 401 (harmless — status just doesn't update for non-web sessions). The token is auto-generated per install into `.hook-token` (chmod 0600 on unix) and exposed to spawned shells via the `WT_HOOK_TOKEN` env var.

`PreToolUse` / `PostToolUse` are required — they fire on every tool call and act as a heartbeat that keeps the status dot showing **Working** during long Claude turns. Without them, the worker's stale-status guard (5-min timeout) flips long-running sessions to **Idle** even while Claude is actively working. `SubagentStart` is needed for the same reason during subagent runs.

### Hook event transform

Claude's raw hook stream produces noisy status (every `Notification` subtype shares one event name; `Stop` fires between agentic turns even when the next turn starts a few ms later; `Stop` inside a subagent is auto-converted to `SubagentStop`). `server.js` reshapes the events before they hit the worker:

- `Notification` is demuxed by payload (`notification_type` / `message`): permission prompts → **Waiting**, idle prompts → **Idle**, others → dropped.
- `Stop` and idle Notification are debounced (~750ms, override with `WT_HOOK_STOP_DEBOUNCE_MS`). Any working event arriving in the window cancels the idle transition, eliminating the "flash of stopped" between agentic turns.
- `SubagentStop` is dropped — the parent agent is still working and its own events will move status correctly.

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
| `monitor.js` | Process manager — supervises `pty-worker.js` + `server.js` as independent children, mints the IPC handshake token, auto-restart with backoff, log rotation, crash diagnostics |
| `pty-worker.js` | PTY owner — node-pty sessions (binary mode), scrollback, session persistence; survives `server.js` restarts |
| `server.js` | Express + WebSocket server, auth, cluster proxy, hooks — stateless; delegates PTY state to the worker over IPC |
| `lib/ipc.js` | Framing + named-pipe / unix-socket server and client for worker <-> web IPC (JSON control + binary PTY frames), with handshake auth and backpressure |
| `lib/worker-client.js` | High-level RPC/event client used by `server.js` to talk to the worker |
| `lib/agents.js` | AI-agent provider registry — the ONE place that knows anything agent-specific (parser, transcript root + resolution strategy, subagent-trace support, label/colour). Add a CLI agent here, nowhere else |
| `lib/transcript-codex.js` | Parses Codex CLI rollout JSONL into the same typed turn shape as the Claude parser |
| `lib/codex-sessions.js` | Finds a Codex rollout for a cwd (Codex keys rollouts by date+uuid, so the cwd is read from each file's `session_meta` head line) |
| `lib/cluster-token.js` | HMAC-SHA256 mint/verify for the short-lived tokens used by direct terminal mode |
| `lib/git-safe.js` | Hardened runner for the version/update-check git calls — disables credential prompts (`credential.interactive=false`, `GIT_TERMINAL_PROMPT=0`) and tree-kills on timeout so a broken HTTPS remote can't hang `git-credential-manager` and leak process trees |
| `app.html` | Unified single-page app (terminal + sidebar + settings) |
| `sw.js` | Service worker for PWA caching |
| `lobby.html` | Multi-server lobby page |
| `terminal.html` | Legacy standalone terminal page |
| `claude-hook.sh` | Claude Code hook script (bash, for non-Windows) |
| `claude-hook.js` | Claude Code hook script (Node.js, for Windows) |
| `scripts/` | Developer tooling — typing-RTT probe, WS latency harnesses, etc. (see Dev Tooling) |
| `tests/` | Playwright tests (security, cluster, IPC, worker, hot-reload, exclusive viewer) |
| `ai-terminal/` | **AiTerminal** — the native Flutter client (Android + Windows) for this server: chat/terminal lenses, session browser, FCM push, and the interactive-question overlay. Talks to the same REST/WebSocket API; built with `flutter` (see `ai-terminal/WINDOWS-BUILD.md`). Its own Dart tests run via `flutter test`, separate from the Playwright suite |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed technical walkthrough.

## Dev Tooling

All of these are opt-in; none run by default in production.

- **`WT_LATENCY_DEBUG=1`** — enables an event-loop lag monitor (logs every stall >50 ms) and a slow-op wrapper (logs any PTY write / frame decode / scrollback save >30 ms) in both `server.js` and `pty-worker.js`.
- **`?rtt=1` query string** — append to the app URL (e.g. `https://host/app?rtt=1`) to render a small per-keystroke round-trip-time overlay in the browser. Measures time from `keydown` to the corresponding byte echoing back from the PTY.
- **`scripts/typing-probe.js`** — headless typing probe; opens a session, types characters, records round-trip times. Useful for reproducing typing-stall bugs without a browser.
- **`scripts/latency-harness.js` / `scripts/latency-harness-v2.js`** — WebSocket round-trip measurement tools. Compare proxy vs. direct terminal mode, or two servers against each other.

The smoke tests (`smoke-test-hot-reload.js`, `smoke-test-longproc.js`) at the repo root exercise the monitor <-> worker <-> server hot-reload path end-to-end.

## Troubleshooting

- **`crypto.randomUUID is not a function`** — triggered when loading the app over plain HTTP on a LAN/Tailscale IP, because `window.crypto.randomUUID` is only exposed in secure contexts. The client polyfills it automatically; if you still hit this, make sure your browser has loaded the latest `app.html` (force-refresh past the service worker).
- **Dual-monitor crash loop with the console flashing** — caused by `taskkill /F /IM node.exe` races. Follow the manual-restart procedure in the [Production Setup](#production-setup) section and kill the monitor + worker + server PIDs explicitly.
- **`conpty_console_list_agent.js: AttachConsole failed`** in test output — harmless node-pty warning when killing sessions in Session 0 / test environments.
- **CLI tools missing in spawned shells after auto-start** — Session 0 scheduled tasks can have a stale PATH. Kill node and run `wscript start-server.vbs` from your logged-in user session to refresh it.

## Update

```bash
cd web-agent-terminal
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
