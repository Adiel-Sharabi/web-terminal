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

Supporting modules live in `lib/` (`ipc.js`, `worker-client.js`, `cluster-token.js`). The full file-by-file map and a technical walkthrough are both in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**`lib/agents.js` is the one place that knows anything agent-specific** — parser, transcript root and resolution strategy, submit policy, interrupt policy, label and colour. Adding a CLI agent is one parser module plus one registry entry. If a change has you writing `if (agent === 'codex')` anywhere else, it belongs in the registry instead; see the PR gate below.

`ai-terminal/` holds **AiTerminal**, the native Flutter companion client (Android + Windows). It is a separate toolchain with its own tests (`flutter test`) and its own build docs ([`ai-terminal/WINDOWS-BUILD.md`](ai-terminal/WINDOWS-BUILD.md), [`ai-terminal/README.md`](ai-terminal/README.md)) — the Playwright suite does not cover it. Server changes that alter an API shape must keep the companion working; prefer additive fields over renames.

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

### 5. Update the docs

`README.md` is deliberately short — it is the shop window, not the manual. Put detail in
the topic doc it belongs to, and touch the README only if the change alters the pitch:

| If the change… | Update |
|---|---|
| adds or alters a user-facing feature | [`docs/FEATURES.md`](docs/FEATURES.md) |
| adds or changes a setting or env var | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) |
| affects install, auto-start or updating | [`docs/INSTALL.md`](docs/INSTALL.md) |
| changes what an agent supports | [`docs/AI-AGENTS.md`](docs/AI-AGENTS.md) — **including its support matrix** |
| adds a file or moves a responsibility | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) file map |
| changes how the server is installed or operated by an agent | [`AGENTS.md`](AGENTS.md) |

**The support matrix in `docs/AI-AGENTS.md` is load-bearing.** It is the one place that
states plainly which agent gets which feature, and a change that quietly widens or narrows
that without updating it turns the project's clearest promise into a lie.

---

## Testing

Tests run against a dedicated server instance on port **17681** with credentials `testuser` / `testpass:colon`. The test server is started automatically by Playwright via `playwright.config.js` — you do not need to start it manually.

Key notes:
- Tests run **serially** (`workers: 1`). The max-session limit (10) causes flaky failures when tests run in parallel.
- `diagnostic.spec.js`, `mobile-debug.spec.js`, and `paste-diag.spec.js` are excluded from the default run (see `testIgnore` in `playwright.config.js`). They require special environment variables or extra setup — see the comment header at the top of each spec file.
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

## Pull Request Gate

**A PR is merged only when every gate below is green.** They are listed in the order they are checked, cheapest first — a PR that fails an early gate is returned without the later ones being reviewed. None of them is waived for a "small" change; small changes are exactly where the skipped gate bites.

### Gate 1 — Automated (CI must be green)

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR against `master` and is **blocking**:

| Check | Command | Passes when |
|---|---|---|
| Syntax | `node -c server.js && node -c monitor.js && node -c pty-worker.js` | exit 0 |
| Lint | `npx eslint .` | **0 errors** (warnings are tolerated — `eslint.config.js` downgrades domain-intentional rules) |
| Tests | `npx playwright test` | every spec passes |

Run all three locally before opening the PR — CI is the backstop, not your test runner. **A red CI is not negotiable and never merged "because it's unrelated".** If a failure genuinely predates your branch, say so in the PR and link the failing run on `master`; otherwise it is yours to fix.

### Gate 2 — Mechanical, checked by review

Each of these is a yes/no with no judgement involved, and each has a line in the [PR template](.github/pull_request_template.md):

- [ ] **`SERVER_VERSION` bumped** in `server.js` — patch for a fix, minor for a feature, major for a break. A PR without a bump cannot be deployed or rolled back cleanly, so it is returned unread.
- [ ] **One logical change.** One bug fix or one feature per PR. A refactor smuggled inside a fix makes the diff unreviewable and will be asked to split.
- [ ] **No secrets in the diff** — passwords, tokens, API keys, private keys, `.env`, service-account JSON. Check the whole branch, not just the last commit: `git diff master...HEAD`.
- [ ] **No personal or machine-specific data** — absolute paths from your machine, hostnames, private IPs, internal project names, real transcript captures.
- [ ] **README updated** if user-facing behavior changed — features list, config table, architecture table.
- [ ] **`windowsHide: true`** on every new `execFile` / `execSync` / `spawn` call.

### Gate 3 — Tests that actually prove the change

Coverage is not counted; what is checked is whether a test would have **caught the bug**:

- **A bug fix ships with a regression test that fails without the fix.** Verify that literally: stash the fix, watch the new test go red, restore it, watch it go green. State in the PR that you did.
- **A feature ships with tests for its rules**, not just a smoke test that it renders.
- **A pure rule belongs in a pure module** (`lib/*.js`) with unit tests, not inline in `server.js` where only an integration test can reach it.
- **Don't assert on the screen when the ground truth is on disk.** For agent behaviour, the transcript/rollout says whether a turn started; the terminal output cannot distinguish "typed into the prompt box" from "submitted".

### Gate 4 — Design review (where a PR is most often returned)

This is judgement, and it is where quality is actually kept. Reviewed against [ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md):

1. **Root cause, stated in one sentence.** "X happens because Y." A fix that suppresses a symptom — a special-case `if`, a `try/catch` that swallows instead of prevents, a retry around a race — is rejected even when it makes the report go away. If the same class of bug is being fixed in a second place, the cause is upstream of both.
2. **Single source of truth.** A value, rule or type gets exactly one owner and everyone else imports it. "Keep these two in sync" is a rejection, not a caveat. If your change adds a second copy of an existing rule, consolidate first in its own PR.
3. **No agent branching.** `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html` or the companion means the change is in the wrong file — add a field to the provider registry in `lib/agents.js` instead. This one is absolute; the registry exists precisely so agent support stays additive.
4. **Layer boundaries hold.** Session state lives in `pty-worker.js`; HTTP/WS lives in `server.js`; clients render what the server derived and re-derive nothing. A client that computes an answer the server already publishes is guaranteed drift.
5. **Smallest change that fully solves it.** Note unrelated problems in an issue; don't fold them in. Broad rewrites need sign-off *before* you write them.
6. **Verified end-to-end, not just compiled.** Say what you ran and what you saw. "Should work" and "tests pass" are different claims from "I observed it working".

### Gate 5 — What the PR itself must say

The description is part of the deliverable. Required:

- **What** changed and **why** — link the issue (`Fixes #N`).
- **Root cause** for a fix, in one sentence.
- **How it was verified** — the commands run and what was observed, including any manual steps beyond the suite.
- **Blast radius** — which callers of a shared function are affected, if you touched one.
- **Deployment note** — if the change touches `pty-worker.js` or a `lib/` module the worker loads, say so: those need a **cold restart**, and a hot `server.js`-only reload silently leaves the old behaviour running.

### Automatic rejection

A PR is closed or returned without detailed review if it: is generated wholesale without the author being able to explain the root cause; breaks Windows-first behavior or adds a hard Linux/macOS runtime dependency; contains a secret (revoke it, then re-open a clean branch — force-pushing over it does not remove it from the fork's history); bundles unrelated changes; or disables, deletes, or `.skip`s a failing test instead of fixing what it caught.

### Scope

Bug fixes and focused improvements are welcome without asking first. **Open an issue before building a large feature** — this is a single-maintainer project with a strong opinion about its architecture, and a rejected 2,000-line PR wastes far more of your time than a five-minute conversation would have.

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
