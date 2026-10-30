# Operations, gates, architecture, security and tests — the full text

Until 2026-10-26 these sections were `CLAUDE.md` itself. When `CLAUDE.md` became a
one-line-per-rule digest they were moved here **verbatim**, so nothing in them was
summarised away. The digest in `CLAUDE.md` is the current law; read the section here
for the reasoning behind a line, or before changing the gate, deploy path or security
rule it describes.

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

Bump the version of **whichever artifact the change touches** — this repo ships two, and the PR gate checks per-area:

| The change touches | Bump |
|---|---|
| anything outside `ai-terminal/` | `SERVER_VERSION` in `server.js` |
| anything under `ai-terminal/` | `version:` in `ai-terminal/pubspec.yaml` |
| both | both |

- Patch bump (1.0.x) for bug fixes
- Minor bump (1.x.0) for new features
- Major bump (x.0.0) for breaking changes

Docs- and CI-only changes still bump `SERVER_VERSION` — the gate deliberately keeps no list of "paths belonging to neither artifact", because such a list rots until it lets a real server change through unbumped. **Never bump `SERVER_VERSION` to satisfy a companion-only PR:** it publishes a server version whose server bytes are identical to the one before it, which destroys the identity the version exists to carry.

### 5. Update README.md

If new user-facing features were added, update `README.md`:
- Add to the Features list
- Add configuration docs for new settings
- Update the Architecture table if new files were created
- Keep the Multi-Server Cluster and PWA sections current

## Architecture

Three supervised Node.js processes. See `docs/ARCHITECTURE.md` for the full walkthrough.

- `monitor.js` — supervisor. Mints the IPC handshake token (`WT_IPC_TOKEN`), spawns worker + web, restarts on crash with exponential backoff, rotates logs
- `pty-worker.js` — owns all `node-pty` sessions (binary mode), scrollback buffers, session persistence, Claude hook state. Survives `server.js` restarts
- `server.js` — Express + WebSocket, auth, cluster proxy, REST API. Stateless with respect to PTYs — all session state goes through IPC
- `lib/ipc.js` — framing + named-pipe / unix-socket transport for worker <-> web IPC (JSON control + binary PTY frames), handshake auth, backpressure (`WT_IPC_MAX_INFLIGHT`)
- `lib/worker-client.js` — high-level RPC/event client used by `server.js` to talk to the worker
- `lib/cluster-token.js` — pure HMAC-SHA256 mint/verify for direct terminal mode tokens (60s TTL, signed with the shared cluster bearer token)
- `lib/agents.js` — **AI-agent provider registry. The single source of truth for anything agent-specific.** See "Multi-Agent Support" below
- `lib/transcript.js` / `lib/transcript-codex.js` — per-agent transcript parsers emitting one shared typed turn shape
- `lib/codex-sessions.js` — resolves a Codex rollout by cwd; `lib/metrics-codex.js` — parses Codex usage from its rollout; `lib/submit-frames.js` — the pure submit-CR split rule
- `lib/submit-confirm.js` — the pure rules for VERIFYING that a submit reached the agent (#179): the gates deciding whether a submit is watched at all, and the line tracker that tells a prompt from a slash command. Its header carries the measurement that ruled alt-screen OUT as a blocked-state marker
- `lib/terminal-size.js` — the pure shared-PTY size rule (#146/#59): one PTY, many viewers, and the SMALLEST ACTIVE viewer wins. Applied in `server.js`, which owns the sockets (the worker only ever sees a count), so it hot-reloads
- `lib/scrollback-window.js` — the pure content-anchored scrollback walk (#178). **Served to `app.html` at `/lib/scrollback-window.js`** so the browser runs the same bytes `tests/scrollback-window.spec.js` pins, rather than a pasted copy. A port of the companion's `ai-terminal/lib/util/scrollback_window.dart` (#167), which stays the canonical write-up of the rule
- `lib/task-list.js` — the pure task-list rules (#73): status normalisation, the Claude delta fold, the Codex plan snapshot. See "The agent task list" below
- `lib/user-turn.js` — **the one owner of what a `role:user` turn IS**: `classifyUserTurn` (which turns a human actually TYPED) and `typedTextOf` (the characters they typed, which the chat lens's Queued echo matches on, #149). Its only import is the leaf `lib/ansi.js`, so `lib/transcript.js` can still use it without a require cycle
- `lib/ansi.js` — **the one owner of the escape-stripping rule** (`ANSI_RE`, `stripAnsi`), imported by `lib/transcript.js` (which re-exports it for `lib/speech.js` and `lib/transcript-codex.js`) and by `lib/user-turn.js`. A leaf: it requires nothing, so it cannot reintroduce a cycle. It exists because #192 briefly added a THIRD copy that had already drifted — `[0-9;?]` params instead of ECMA-48's `[0-?]`, letting a colon-form `ESC[38:5:196m` through a strip that claimed to remove it
- `lib/recap.js` — the pure session-recap rules: `condense`, `toolTally`, `summariseTasks`, plus a re-export of `lib/user-turn.js`'s `classifyUserTurn` for its existing importers — **change the rule in `lib/user-turn.js`, never here**. Serves `GET /api/sessions/:id/recap`. See "The session recap" below
- `lib/notification-shape.js` — the pure rules for a Claude `Notification` hook (#194 Gap 1): `classifyNotification` (permission / idle / **benign** / **unknown** — the last two were one silent `drop`), plus the redaction and rate rule for logging an unknown one. **Instrumentation only — it deliberately changes no behaviour**: `correctStaleStatus` never times out a `waiting` session at all since #230, against 5m for a `working` one, so promoting an unrecognised notification to a permission ask on a guess would park a session on a false "waiting" INDEFINITELY - the cost of that mistake went UP when the backstop went away, which is the one place #230 makes another rule stricter rather than looser
- `app.html` — unified single-page app (terminal + sidebar + settings). Polyfills `crypto.randomUUID` for plain-HTTP contexts. `?rtt=1` enables the per-keystroke RTT overlay
- `terminal.html` — legacy terminal-only page. **No longer served** (#218): `/s/:id` redirects to `/app/:id`, because this page neither gated input at `WS_INPUT_MAX` nor could render an `inputDropped` notice
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
- Multi-agent sessions — Claude Code or Codex behind one provider registry (see "Multi-Agent Support")
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
- **A route that WRITES config must first prove it could READ it** (#257, #264). A
  `config.json` that exists but will not parse throws inside the *first* branch of the
  startup load, so the `config.default.json` fallback is never reached, `config` stays `{}`
  and `PASS` lands on the `'admin'` literal — which makes `needsPasswordChange()` true on an
  **established** server and opens `POST /api/setup`. Read-mutate-write over that `{}` then
  *replaces* the file: `/api/setup` leaves `{user, password}` and the cluster is gone,
  `/api/cluster/register` leaves `{cluster:[…]}` and the **credentials** are gone, so the
  next restart boots on the default password. `readConfigResult()` separates ABSENT from
  UNREADABLE; absent still writes (a real first run, and every CI checkout), unreadable is
  refused with the file byte-identical on disk. The refusal names no server path — the log
  does, the response does not. Gated against the SOURCE, not just per route, because #264 IS
  #257 found again four weeks later on two routes no behavioural test could have covered:
  `tests/issue264-config-write-paths.spec.js` fails on any `writeConfig()` inside a route
  handler that has no `readConfigResult()` guard above it.
  - **Still open, and it is the more serious half:** whether a corrupt `config.json` should
    be allowed to drop a running server to the default password *at all*. That is a startup
    question, not a write-path one. Note `/api/setup` is **not** literally unauthenticated —
    the middleware exempts it only after a session cookie verifies, or a valid API token
    passes the `Bearer` / `?token=` branches beside it — but the corruption is what hands
    out the credentials to get in: `PASS` **and** `_USER` both fall back to `admin`, and the
    startup banner prints `Auth: admin:***`.

## Test Config

- Tests run on port 17681 with credentials: testuser / testpass:colon
- Uses Playwright for both API and browser tests
- Test config in `playwright.config.js`
- Tests backup/restore config.json but overwrite the password hash — re-apply the correct password after running tests
- **`WT_CONFIG_FILE` redirects the config path outright**, for all three supervised
  processes — `server.js`, `pty-worker.js` and `monitor.js` derive that path independently,
  so an override honoured by only some of them would not isolate a test, it would split one
  live setting across the tree. Same shape and same reason as `WT_CLUSTER_TOKENS_FILE` and
  `WT_CLAUDE_METRICS_FILE`: a test that has to
  drive a *destructive* config path needs a file of its own, and redirecting is stronger
  than backing the real one up, because an interrupted run never reaches its restore.
  `tests/issue264-config-write-paths.spec.js` needs it — `POST /api/setup` opens only on a
  server whose PASS is the default, which the suite's own server is not and must not become,
  so that half spawns an isolated `server.js` with its own config, port, pipe and data dir.
- **`config.test.json` is DELETED at the start of every run** (`playwright.config.js`, #240).
  It is gitignored, so it is per-machine state no checkout restores and `global-teardown.js`
  does not cover it — whatever the last run left was what the next one started from, forever,
  on that machine alone. Deleting puts each run in the state a fresh CI checkout is already
  proven green from. It cannot live in `global-setup.js`: Playwright runs plugin setup, where
  `webServer` lives, BEFORE globalSetup, so `server.js` would already have read the poisoned
  file — and `_refreshLiveConfig` skips a file that is missing, which would pin the stale
  values in cache for the whole run instead of clearing them.

## Deployment & Operations

- Server auto-starts on boot via scheduled task or Startup shortcut — both use `wscript.exe` + `start-server.vbs` to run hidden (no console window flashing)
- **A cold restart is gated on the runtime deps loading — and that gate exists because it once turned a wedge into an outage.** `scripts/cold-restart.ps1` runs `scripts/check-deps.js` (it *loads* `node-pty` / `express` / `express-ws`, since `require.resolve` succeeds on a package whose native binding is broken) **before the first kill**, and aborts without touching anything if they fail. Rationale: a running Node process serves already-loaded modules from **memory**, so a box whose `node_modules` was destroyed hours ago still answers HTTP 200 and still streams PTYs — while a fresh worker cannot even start (`Cannot find module 'node-pty'`, exit 1), the monitor burns its 5-crash budget and exits, and `server.js` goes with it. **A wedged worker still owns live PTYs; a monitor that gave up owns nothing.** Use `scripts/cold-restart.ps1 -CheckOnly` to audit a peer's tree over `/api/exec` without disturbing it.
  - **NEVER junction or symlink `node_modules` into a git worktree.** `rmdir /s`, `Remove-Item -Recurse` and `git worktree remove --force` all **follow a directory junction and delete the target**. On 2026-07-30 a session did exactly that — `mklink /J <worktree>\node_modules C:\dev\web-terminal\node_modules`, then tore the worktree down — which gutted production (`express` gone, `node-pty` left without `package.json`/`lib`), stalling on the files the live worker held open. Give a worktree its own copy, or invoke the real path (`node ../../node_modules/@playwright/test/cli.js`). To remove an existing junction, delete the **link** with bare `cmd /c rmdir <link>` (no `/s`).
  - **Symptom to recognise:** `/login` returns 200 while everything stateful times out, `error.log` floods with `RPC listSessions timed out after 30000ms` whose *first* entry is `Failed to create session`, `worker.log` stops dead at that instant, and the worker sits at **0% CPU** with a child `OpenConsole.exe` that has no `bash.exe` sibling. That is a blocked worker event loop, not a network or auth fault. Recovery: stop the worker (that releases the lock), `npm install`, relaunch — killing the stillborn `OpenConsole.exe` does **not** help.
- **Cold-restart practice — when running a cluster, drive a server's restart from a *different* server via its `/api/exec` endpoint** (authenticated with that peer's bearer token). This isolates the kill logic from the process being killed, so a bug in the kill script can't silently leave the target offline. Do it in two phases: (1) `git fetch --all && git pull --ff-only` and verify the new `SERVER_VERSION` on disk (non-disruptive, safe to retry); (2) a detached PowerShell script that kills monitor + worker + server and relaunches `start-server.vbs`.
  - The kill filter must match `server.js` / `pty-worker.js` by their full path with `-like` (NOT `-match` — the `\p` in `pty-worker.js` is read as a malformed `\p{...}` regex Unicode class). `monitor.js` has no path in its CommandLine, so identify it by the ParentProcessId of the matched server/worker rather than by name.
  - Because the `/api/exec` request runs *inside* the server being killed, the request dies mid-response. Write the kill script to a temp file and launch it detached (`start /b powershell -WindowStyle Hidden -File ...`) so it survives the parent's death.
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
- **Restart hold (#359 / #406 / #407)** — `lib/maintenance.js` owns every rule, `server.js` (`_maint`, the 3 s tick, `/api/maintenance/*`) the I/O, `scripts/wt-maintenance.js` the CLI.
  - **It ASKS, never orders (owner, 2026-10-30):** a cold restart without a reboot is fine only when every running session agrees; "no" and "later" are accepted. Evidence: holds set on XPS and Office for the 1.91.2 deploy made every prompted session stop its work, and both were cancelled by hand.
  - **The answer is STATE, never prose:** the session runs `node <abs>/scripts/wt-maintenance.js answer yes|no|later [--minutes N] [--reason ".."]` (its own `$WT_SESSION_ID`), which POSTs `/api/maintenance/answer` behind auth. Body checked strictly (enum; `minutes` clamped 5..240, default 30; `reason` clipped to 200 and stripped of C0/DEL/C1 controls; the session must be tracked AND already asked, else 404/409; no hold -> 409). The reason is shown, never typed into a terminal.
  - **Verdicts:** `ready` = said yes + turn ended after the question + nothing running (a plain shell keeps "nothing running"). `no` -> `declined` until the hold is cancelled or a new prepare. `later` -> `deferred`, re-asked when due and idle, at most `MAX_ASKS` (4) asks. Asked, turn over, no answer -> stays `answering` ("told; has not answered"). An agent the hold does not track is `not-told`, never ready; the tick registers it (`trackSession`) so it is asked like the rest.
  - **Cancel tells the sessions:** `DELETE /api/maintenance` types a "called off" notice into every session the hold had asked, once idle at its composer (`_maint.off`, 15 min bound like `back`). A second cancel with no hold keeps the notices still owed.
  - **Prompts stay under 512 BYTES** (Claude's `submit.bracketAbove`, #213; over it the text is a bracketed paste and delivery hangs on the hook prompt still starting with the tag). The typed reason is clipped to 30 chars; the hold keeps the full one. The script path is absolute with forward slashes.
  - **#406:** the hold records the worker (`ping` -> `pid`, `startedAt`; `lib/worker-client.js` `workerIdentity()`); a different worker is a restart even with no sessions to vote, a hot reload keeps the worker. A hold made against an older worker (no field) clears when the worker now running started after it. `pty-worker.js` 0.9.0: COLD restart.
  - **Deploy note:** a hold already open under the OLD wording reads `answering` forever after the hot reload (its sessions were ordered, not asked) — cancel it and prepare a new one.

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
- **The suite is NOT flaky — it was a real bug, now fixed.** The server binds `127.0.0.1` while the suite addressed `localhost`, which resolves to `::1` first; the first connection of a run surfaced `ECONNREFUSED ::1:17681` on whichever spec sorted first, so a *different* spec failed each run. Everything in `tests/` and `playwright.config.js` now uses `127.0.0.1` and an explicit `url:` readiness probe. If a spec fails intermittently, look for a real cause — do not write it off as flake
- A one-off subset run (`npx playwright test a.spec.js b.spec.js`) can still hit a `webServer` startup race that the full suite does not. Confirm any single failure by re-running that spec alone before investigating it
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
