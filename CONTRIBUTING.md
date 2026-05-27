# Contributing to Web Terminal

Thank you for your interest in contributing. This is a single-maintainer project maintained on a best-effort basis.

**Platform note:** Web Terminal is designed for Windows, where browser-based terminal solutions are scarce. If you are on Linux or macOS, you likely want [ttyd](https://github.com/tsl0922/ttyd), [gotty](https://github.com/sorenisanerd/gotty), or [code-server](https://github.com/coder/code-server) instead. Pull requests that break Windows-first behavior or add hard Linux/macOS runtime dependencies will not be accepted.

---

## Dev Setup

**Requirements:** Node.js 18+, Git for Windows

```bash
git clone https://github.com/Adiel-Sharabi/web-terminal.git
cd web-terminal
npm install
node monitor.js
```

Open http://localhost:7681 (default login: `admin` / `admin`).

**Important — do not run `monitor.js` and `server.js` at the same time.** `monitor.js` spawns `server.js` as a child process. Starting `server.js` separately causes a port conflict and rapid console window flashing on Windows. Always start via `node monitor.js` (or `npm start`), never both at once.

**Never run `node server.js` or `node monitor.js` directly on Windows for production use.** Console-subsystem Node executables flash terminal windows. For production or auto-start, always use the VBS launcher (`wscript start-server.vbs`) as described in the README. During development `node monitor.js` in a terminal window is fine.

---

## Project Layout

The three-process model is the core of the architecture:

| Process | Role |
|---------|------|
| `monitor.js` | Supervisor — spawns and restarts `pty-worker.js` + `server.js`, mints the IPC handshake token, rotates logs |
| `pty-worker.js` | Owns all node-pty sessions, scrollback buffers, and session persistence; survives `server.js` restarts |
| `server.js` | Express + WebSocket, auth, cluster proxy, REST API; stateless — delegates all PTY state to the worker over IPC |

Supporting modules live in `lib/` (`ipc.js`, `worker-client.js`, `cluster-token.js`). The full file-by-file table is in the Architecture section of [README.md](README.md), and a detailed technical walkthrough is in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Mandatory Pre-Commit Gates

Every commit must pass all five gates in order. Do not skip any of them.

### 1. Security Review

Review all changed files for OWASP Top 10 issues:
- Command injection, XSS, auth bypass, path traversal, secret exposure
- All new API routes must be behind auth middleware
- Bearer token endpoints must validate tokens
- User input must be sanitized before use in shell commands, HTML, or file paths
- No passwords, tokens, or API keys in committed files

### 2. Run Tests

```bash
npx playwright test
```

All tests must pass. If you added new functionality, verify that relevant test coverage exists. Do not commit with failing tests.

### 3. Syntax Check & Lint

```bash
npm run syntax-check   # node -c on server.js, monitor.js, pty-worker.js
npm run lint           # eslint . — must report 0 errors (warnings tolerated)
```

### 4. Bump `SERVER_VERSION`

Increment `SERVER_VERSION` in `server.js` (line 10):
- Patch (`1.0.x`) for bug fixes
- Minor (`1.x.0`) for new features
- Major (`x.0.0`) for breaking changes

### 5. Update README

If the change adds or modifies user-facing behavior, update `README.md`:
- Add to the Features list
- Add configuration docs for new settings
- Update the Architecture table if new files were added

---

## Testing

Tests run against a dedicated server instance on port **17681** with credentials `testuser` / `testpass:colon`. The test server is started automatically by Playwright via `playwright.config.js` — you do not need to start it manually.

Key notes:
- Tests run **serially** (`workers: 1`). The max-session limit (10) causes flaky failures when tests run in parallel.
- `diagnostic.spec.js`, `mobile-debug.spec.js`, and `paste-diag.spec.js` are excluded from the default run. They require special env vars or setup — see the CLAUDE.md Testing Notes section.
- The `conpty_console_list_agent.js: AttachConsole failed` warning in test output is **harmless** — it is a node-pty warning that appears when killing sessions in Session 0 or test environments.
- The test run backs up and restores `config.json`, but overwrites the password hash. If you run tests against a local dev instance, re-apply the correct password afterward.

---

## Code Standards

- **Every code change must be backed by tests.** Write the failing test first, then fix, then verify all tests pass.
- **No secrets in commits.** Never commit passwords, tokens, API keys, private keys, `.env` files, or service-account credentials. Store credentials outside the repo and reference them via environment variables.
- **No personal info or machine-specific paths in tracked files.** User-identifying data and absolute paths specific to your machine must not appear in version-controlled files.
- Keep the three-process model intact. Session state belongs in `pty-worker.js`; HTTP/WS handling belongs in `server.js`.
- All child process calls (`execFile`, `execSync`, `spawn`) must include `windowsHide: true` to prevent console window flashing on Windows.

---

## Pull Request Process

1. Fork the repo (or create a branch off `master`).
2. Keep PRs focused — one bug fix or feature per PR.
3. Ensure all five pre-commit gates pass before opening the PR.
4. Describe the change: what it does, why it is needed, and how it was tested.
5. For bug fixes: include a reproduction case (ideally a new or modified test that fails without the fix).

PRs that add features without tests, skip the version bump, or break the Windows-first behavior will be asked to revise before merging.

---

## Bug Reports

Before opening an issue, try to reproduce the bug with a minimal case and note the Node.js version, Windows version, and shell in use. Check open issues first to avoid duplicates.

---

## Security Issues

**Do not open public GitHub issues for security vulnerabilities.**

Report security issues privately via [GitHub's private vulnerability reporting](https://github.com/Adiel-Sharabi/web-terminal/security/advisories/new) or by contacting the maintainer directly through GitHub at https://github.com/Adiel-Sharabi. See [SECURITY.md](SECURITY.md) if present.

---

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
