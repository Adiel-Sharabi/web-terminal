# Web Terminal — Claude Code Instructions

## Project Overview
Browser-based terminal manager with multi-server cluster support, WebSocket sessions, and PWA. Runs on Node.js + Express + node-pty.

## Pre-Commit Gates (MANDATORY)

Before EVERY commit, you MUST complete these checks in order:

### 1. Security Review
- Review all changed files for OWASP Top 10 vulnerabilities
- Check for: command injection, XSS, auth bypass, path traversal, secret exposure
- Verify no secrets (passwords, tokens, API keys) are committed
- Verify auth middleware covers all new routes
- Verify Bearer token endpoints validate tokens properly
- Check that user input is sanitized before use in shell commands, HTML, or file paths

### 2. Run Tests
```bash
npx playwright test
```
- ALL tests must pass before committing
- If tests fail, fix the issue first
- If new functionality was added, verify relevant test coverage exists

### 3. Syntax Check
```bash
node -c server.js
```

### 4. Bump Version
Before every commit that will be pushed, bump `SERVER_VERSION` in `server.js` (line 10):
- Patch bump (1.0.x) for bug fixes
- Minor bump (1.x.0) for new features
- Major bump (x.0.0) for breaking changes

### 5. Update README.md
If new user-facing features were added, update `README.md`:
- Add to the Features list
- Add configuration docs for new settings
- Update the Architecture table if new files were created
- Keep the Multi-Server Cluster and PWA sections current

## Architecture
Three supervised Node.js processes. See `ARCHITECTURE.md` for the full walkthrough.

- `monitor.js` — supervisor. Mints the IPC handshake token (`WT_IPC_TOKEN`), spawns worker + web, restarts on crash with exponential backoff, rotates logs
- `pty-worker.js` — owns all `node-pty` sessions (binary mode), scrollback buffers, session persistence, Claude hook state. Survives `server.js` restarts
- `server.js` — Express + WebSocket, auth, cluster proxy, REST API. Stateless with respect to PTYs — all session state goes through IPC
- `lib/ipc.js` — framing + named-pipe / unix-socket transport for worker <-> web IPC (JSON control + binary PTY frames), handshake auth, backpressure (`WT_IPC_MAX_INFLIGHT`)
- `lib/worker-client.js` — high-level RPC/event client used by `server.js` to talk to the worker
- `lib/cluster-token.js` — pure HMAC-SHA256 mint/verify for direct terminal mode tokens (60s TTL, signed with the shared cluster bearer token)
- `app.html` — unified single-page app (terminal + sidebar + settings). Polyfills `crypto.randomUUID` for plain-HTTP contexts. `?rtt=1` enables the per-keystroke RTT overlay
- `terminal.html` — legacy terminal-only page (served at `/s/:id`)
- `lobby.html` — legacy lobby page (served at `/lobby`)
- `sw.js` — service worker for PWA caching
- `tests/security.spec.js` — auth, session CRUD, XSS, config security
- `tests/cluster.spec.js` / `tests/cluster-direct-mode.spec.js` / `tests/cluster-token.spec.js` — token auth, cluster API, proxy security, direct mode
- `tests/ipc*.spec.js` + `tests/worker-*.spec.js` + `tests/hot-reload.spec.js` — IPC, worker internals, hot-reload

## Features (high-level)
- Multiple terminal sessions, in-place switching, optional instant-switch (`keepSessionsOpen`)
- Session persistence across server + worker restarts (scrollback replay, binary-safe)
- Multi-server cluster (proxy by default; `directConnect: true` enables direct-terminal mode with signed short-lived tokens)
- Hot reload: killing only `server.js` leaves PTYs running; the new `server.js` reattaches over IPC
- PWA with mobile toolbar, IME-aware input, long-press menu
- Claude Code hook integration (status dots, notifications, session browser, image paste)
- Optional latency instrumentation: `WT_LATENCY_DEBUG=1` env (server + worker) and `?rtt=1` query (browser overlay)
- Dev tooling under `scripts/` — typing probe, WS latency harnesses (do not edit without coordinating; sanitisation workstream owns these)

## Auth System
- Cookie-based session auth (primary, for browser users)
- Bearer token auth (for cluster inter-server communication)
- Tokens stored in `api-tokens.json` (gitignored)
- Cluster remote tokens stored in `cluster-tokens.json` (gitignored)
- Each server in cluster has independent credentials

## Key Security Rules
- Never expose passwords in API responses (always mask as `***`)
- API tokens have 90-day expiry
- Rate limiting on login attempts
- All new API routes MUST be behind auth middleware
- WebSocket auth supports both cookie and query-string token
- Cluster proxy MUST validate stored token exists before forwarding
- Never pass unsanitized user input to `term.write()`, `execFile()`, or HTML

## Test Config
- Tests run on port 17681 with credentials: testuser / testpass:colon
- Uses Playwright for both API and browser tests
- Test config in `playwright.config.js`
- Tests backup/restore config.json but overwrite the password hash — re-apply the correct password after running tests

## Deployment & Operations
- Server auto-starts on boot via scheduled task or Startup shortcut — both use `wscript.exe` + `start-server.vbs` to run hidden (no console window flashing)
- **Cold-restart practice — always drive the restart from a different server than the one being restarted.** This isolates the kill logic from the process being killed, so a bug in the kill script can't silently leave the target offline.
  - **Office** — driven from the local canary at `C:\dev\web-terminal-canary` (git worktree of master, port 7683, pipe `\\.\pipe\web-terminal-canary`, creds `canary`/`canary-local-only`). Start via `wscript C:\dev\web-terminal-canary\start-canary.vbs`. Get a bearer token: `POST http://localhost:7683/api/auth/token` with JSON `{user,password,label}`. Then POST the restart payload to `http://localhost:7683/api/exec`.
  - **Home** — driven from Office via `https://adiel-home.braid-mintaka.ts.net/api/exec` + Home's bearer token from `cluster-tokens.json`.
  - **XPS** — driven from Office via `https://adiel-xps.braid-mintaka.ts.net/api/exec` + XPS's bearer token.
  - **Two phases**: (1) `git fetch --all && git pull --ff-only` first and verify the new SERVER_VERSION on disk — non-disruptive, safe to retry; (2) then a detached PS1 that kills monitor+worker+server and relaunches `start-server.vbs`.
  - **PS1 kill filter** — match `*C:\dev\web-terminal\server.js*` and `*C:\dev\web-terminal\pty-worker.js*` with `-like` (NOT `-match` — `\p` in `pty-worker.js` breaks PowerShell regex as a malformed `\p{X}` Unicode class). For `monitor.js` (no path in CommandLine), add `-notlike` excludes for `*MSSQLMCP*`, `*UsbCam*`, `*vite*`, `*web-terminal-canary*`, `*web-terminal-v2*`. Use the ParentProcessId of the matched server/worker to identify the matching monitor.
  - **Detach pattern** — the /api/exec request runs in the server being killed, so it dies mid-response (curl returns empty). Write the PS1 to `C:\temp\wt-restart-*.ps1` via base64-decode in bash (avoids JSON-escape hell), then `cmd //c start "" //b powershell -NoProfile -WindowStyle Hidden -File ...` to detach.
  - **Reference payloads**: see `.tmp-restart-remote.ps1` (canonical PS1) and `.tmp-make-remote-payload.js` (builds pull + restart JSON for /api/exec).
- **To restart manually without a driver (last resort only):**
  1. Identify the monitor and server PIDs:
     `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap"`
  2. Kill ONLY the monitor.js and server.js PIDs (do NOT use blanket `taskkill /F /IM node.exe` — it kills MCP servers, PM2, and other unrelated node processes, and may fail to kill the monitor before the new one starts):
     `powershell -NoProfile -Command "Stop-Process -Id <monitor_pid>,<server_pid> -Force"`
  3. Wait 2-3 seconds for ports to release, then start fresh:
     `wscript start-server.vbs`
- **NEVER use `taskkill /F /IM node.exe` to restart** — this is a blanket kill that races with the VBS launcher and can leave an old monitor alive while starting a new one, causing a dual-monitor crash loop (both monitors fight over port 7681, each restart spawns pty sessions that flash console windows)
- **Bash shell flag escaping:** In Git Bash, Windows flags like `/F` are interpreted as Unix paths. Use double slashes: `taskkill //F //IM node.exe`. Or use PowerShell commands instead.
- **NEVER run `node server.js` or `node monitor.js` directly** — console-subsystem executables flash windows on Windows. Always use the VBS launcher
- Session 0 (scheduled task with S4U) may have a stale PATH — if CLI tools aren't found in spawned terminals, kill node.exe and run `wscript start-server.vbs` from a user session instead
- Server listens on port 7681, config in `config.json` (gitignored password hashes)

### Windows Console Flashing Prevention
Three layers prevent console window flashing on Windows:
1. **VBS launcher** (`start-server.vbs`) — `wscript.exe` is a GUI-subsystem exe, launches node hidden (window style 0)
2. **`useConptyDll: true`** in `pty.spawn` — uses the bundled `OpenConsole.exe` instead of the system ConPTY API (which on Windows 11 delegates to Windows Terminal, causing visible flashes)
3. **`windowsHide: true`** on all `execFile`/`execSync` calls — prevents git, powershell, and other child processes from creating console windows

## Development Rules
- **Every code change must be backed by tests** — write failing tests first, then fix, then verify all tests pass
- **Never stop or restart the production server** without explicit user permission
- **All tests must pass before committing** — no exceptions
- **No secrets in commits** — passwords, tokens, API keys must never appear in tracked files
- **No personal info in tracked git** — personal data, machine-specific paths, and user-identifying info must stay out of version control

## Testing Notes
- `diagnostic.spec.js` and `mobile-debug.spec.js` require special env vars/setup and are excluded from default `npx playwright test` runs
- `diagnostic.spec.js` needs `DIAG_PASS` env var and its own config: `DIAG_PASS=yourpass npx playwright test tests/diagnostic.spec.js --config playwright.diag.config.js`
- Tests run serially (`workers: 1`) because the max session limit (10) causes flaky failures when tests create sessions in parallel
- The `conpty_console_list_agent.js: AttachConsole failed` errors in test output are harmless node-pty warnings when killing sessions in Session 0 / test environment
- GitHub repo: `Adiel-Sharabi/web-terminal`

## Issue Workflow
When working through GitHub issues, use this process:
1. `gh issue list --state open` to check for new issues
2. Read each issue, assess clarity — comment if unclear
3. Reproduce the bug before fixing (do not fix what you can't reproduce)
4. Write tests first, then fix, then verify all tests pass
5. Use sub-agents for individual issue fixes to keep the orchestrator context clean
6. Commit and push when all tests pass

## Cluster
- `config.json` has a `cluster` array of `{name, url}` servers and a `publicUrl` for the local server
- `/api/cluster/sessions` merges local + remote sessions — must skip fetching from servers whose URL matches `publicUrl` to avoid session duplication
- Cluster auth tokens stored in `cluster-tokens.json`
- `passAllEnv` config option (default false) controls whether spawned shells get full or limited environment variables
