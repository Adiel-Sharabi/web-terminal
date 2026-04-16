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
- `server.js` — Express server, WebSocket, session management, auth, cluster proxy
- `app.html` — Unified single-page app (terminal + session management + settings)
- `terminal.html` — Legacy terminal-only page (served at /s/:id)
- `lobby.html` — Legacy lobby page (served at /lobby)
- `sw.js` — Service worker for PWA caching
- `tests/security.spec.js` — Auth, session CRUD, XSS, config security tests
- `tests/cluster.spec.js` — Token auth, cluster API, proxy security tests

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
- **To restart manually:** `taskkill /F /IM node.exe` then `wscript start-server.vbs` from the project directory
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
