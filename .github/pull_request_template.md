## Description

<!-- What this PR changes and why. Reference the issue with "Fixes #N" / "Closes #N". -->

## Root cause

<!-- Bug fixes only. One sentence: "X happens because Y." If you cannot write it, the cause has not been found yet. -->

## How this was verified

<!-- The commands you ran and what you observed — plus any manual steps beyond the automated suite.
     "Tests pass" and "I observed it working" are different claims; make the one that is true. -->

## Deployment note

<!-- Does this touch pty-worker.js or a lib/ module the worker loads? Those need a COLD restart —
     a hot server.js-only reload leaves the old behaviour running. Write "none" if not applicable. -->

## PR gate checklist

All items must be checked before requesting review. Full rules in [CONTRIBUTING.md](../CONTRIBUTING.md#pull-request-gate).

**Automated (CI blocks the merge):**

- [ ] **Tests pass** — `npx playwright test` runs clean with no failures.
- [ ] **Lint clean** — `npx eslint .` reports 0 errors (warnings tolerated).
- [ ] **Syntax check** — `node -c server.js && node -c monitor.js && node -c pty-worker.js` exits 0.

**Mechanical:**

- [ ] **Version bumped** — `SERVER_VERSION` in `server.js` incremented (patch / minor / major as appropriate).
- [ ] **One logical change** — no refactor smuggled into a fix, no unrelated changes bundled.
- [ ] **README updated** — user-facing changes documented (features list, config table, architecture table).
- [ ] **No secrets committed** — checked across the whole branch (`git diff master...HEAD`), not just the last commit.
- [ ] **No personal data** — machine-specific paths, hostnames, private IPs, internal project names, and real transcript captures are absent from tracked files.
- [ ] **`windowsHide: true`** on any new `execFile` / `execSync` / `spawn` call.

**Quality:**

- [ ] **Regression test fails without the fix** — verified by reverting the fix and watching it go red (bug fixes).
- [ ] **Security reviewed** — changed files checked for injection, XSS, auth bypass, path traversal, secret exposure; new API routes are behind auth middleware.
- [ ] **Single source of truth** — no rule, constant, or type duplicated to make this work.
- [ ] **No agent branching** — no `if (agent === 'codex')` in `server.js`, `pty-worker.js`, `app.html`, or the companion; agent-specific behaviour is a field in `lib/agents.js`.
