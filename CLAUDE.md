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
- `lib/agents.js` — **AI-agent provider registry. The single source of truth for anything agent-specific.** See "Multi-Agent Support" below
- `lib/transcript.js` / `lib/transcript-codex.js` — per-agent transcript parsers emitting one shared typed turn shape
- `lib/codex-sessions.js` — resolves a Codex rollout by cwd; `lib/metrics-codex.js` — parses Codex usage from its rollout; `lib/submit-frames.js` — the pure submit-CR split rule
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
- Multi-agent sessions — Claude Code or Codex behind one provider registry (see "Multi-Agent Support")
- Optional latency instrumentation: `WT_LATENCY_DEBUG=1` env (server + worker) and `?rtt=1` query (browser overlay)
- Dev tooling under `scripts/` — typing probe, WS latency harnesses (do not edit without coordinating; sanitisation workstream owns these)

## Multi-Agent Support (Claude Code + Codex)

A session knows *which* AI CLI agent it runs. `agent` is a real, persisted session field: `'claude'`, `'codex'`, or `null` for a plain shell. **`null` is never coerced to `'claude'`.**

### The rule: one registry, no branching
Everything agent-specific lives in **`lib/agents.js`** — parser, transcript root, transcript-resolution strategy, subagent-trace support, label, colour, and submit policy. **Adding a CLI agent is one parser module + one registry entry.** If you find yourself writing `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion, you are in the wrong file — add a field to the provider instead.

`GET /api/agents` serves the catalogue, so both clients render the picker and the per-agent tint with **no client release** when an agent is added or renamed. The companion holds no agent table (`AgentCatalog`); neither does `app.html`.

An **explicit** agent is authoritative: a session declared `claude` is never served a Codex transcript. Only a session with no recorded agent falls back to cross-provider discovery.

### Codex facts (verified empirically against codex-cli 0.144.0 — do not trust the docs)

**Submit is CR, never LF — for every agent.** Both TUIs read raw mode where Enter is `\r` (0x0D); an `\n` inserts a newline in the prompt box and submits nothing. Android soft keyboards commit Enter as literal `"\n"` *text* (not a key event), so the companion funnels every terminal keystroke through `terminalOutputToPty()` and maps a **lone** LF to CR (interior newlines of a paste must survive verbatim). Two separate bugs have worn the sentence "Enter doesn't run it": that soft-keyboard LF (phone-only), and the Codex burst below (all platforms). Diagnose which byte, and when, before touching either.

**Submitting a prompt to Codex.** Codex's TUI (`paste_burst.rs`) folds every byte of ONE read into a *paste*, so an atomic `text\r` frame types the text and inserts a **newline** — it never submits. Claude Code has no such detector. This is why each provider declares `submit: { gapMs, crBurstsAsPaste }` and `pty-worker.js` withholds a trailing CR for the agents that need it. Measured: gap ≤30ms is still absorbed, ≥60ms submits; bracketed paste does **not** exempt the CR, and LF is not a submit key. **Only a real temporal gap works.** Never "fix" a submit problem by changing the bytes.

**Rollout transcripts** live at `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl` and are **not cwd-keyed** — `cwd` appears only in the first `session_meta` line (which is ~8 KB; a naive 4 KB read truncates it mid-JSON). `session_id` **is** the rollout UUID. Tool calls are **one line each**, `function_call.arguments` is a JSON **string**, `custom_tool_call_output.output` is a JSON envelope `{output, metadata}` needing unwrap, and `event_msg` lines restate `response_item` text — parse one or every turn doubles.

**Usage metrics.** Claude *pushes* its status line to `POST /api/claude-status`; Codex *records* the same numbers in its rollout, so a provider may expose `readMetrics(tail)` and the server fills the identical `metrics` shape. Three traps: `total_token_usage.total_tokens` is the session's **cumulative** spend (millions — using it reports thousands of percent), so context occupancy is `last_token_usage.input_tokens`; `cached_input_tokens` is a **subset** of `input_tokens`, not an addition; and the 5h/7d windows are matched by **`window_minutes` (300 / 10080)**, never by `primary`/`secondary` order. `turn_context` (model/effort) is written once per **user** turn, so a long agent turn buries it above the tail — the server reads head+tail.

**Hooks (not yet implemented).** Codex cloned Claude's hook protocol (same event names, payload fields, `exit 2 = block`), but: hooks are **PascalCase TOML in `config.toml`** (camelCase keys are silently ignored); **only `managed` hooks run unattended** — user-level and `-c`-injected hooks load as `trust=untrusted` and never execute; trust is bound to a **sha256 of the hook definition**, so changing the command string re-prompts on every machine (freeze the launcher path, put logic in the script); and **`codex exec` runs no hooks at all** — only the interactive TUI / `app-server`. `SubagentStop` carries `agent_transcript_path` directly, which is easier than Claude's `agent-*.meta.json` → `toolUseId` link.

**NEVER copy `~/.codex/auth.json` into a second `CODEX_HOME`.** Codex refreshes on start and the refresh token rotates; the copy triggers "refresh token was already used", and reuse-detection can revoke the whole token family. Use a stub provider (`model_providers.<name>` with `base_url`, `wire_api="responses"` — `"chat"` was removed) and no auth file.

### How to verify Codex behaviour (methods that work)
- **The rollout is ground truth; the screen lies.** Codex writes a user message to its rollout only when a turn actually *starts*. Scraping the TUI cannot distinguish "text sitting in the composer" from "submitted" — reading the rollout can. Assert on the rollout.
- **Probe in an already-trusted cwd that no live session uses.** A fresh directory triggers Codex's trust prompt. A probe run in a live session's cwd writes a *newer* rollout and will hijack that session's Chat lens via `findRolloutForCwd`. Clean up probe rollouts afterwards.
- **Drive the real path, not a reimplementation.** Worker behaviour is testable by spawning `pty-worker.js` on an isolated pipe and sending a real `TYPE_PTY_IN` frame (see `tests/worker-submit-cr.spec.js`); `__testGetWrites` returns the exact bytes written to the PTY.
- **A regression test must fail without the fix.** Flip the registry flag off and confirm the new specs go red before believing them.

### Deployment consequence
Anything touching `pty-worker.js` (including `lib/agents.js` fields the worker reads) needs a **COLD restart** — a hot `server.js`-only reload leaves the old worker running with the old behaviour. See "Deployment & Operations".

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
- GitHub repo: `Adiel-Sharabi/web-agent-terminal`

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

## Engineering Standards (shared, non-negotiable)
@ENGINEERING_STANDARDS.md
