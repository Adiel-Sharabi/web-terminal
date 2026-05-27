## Description

<!-- Describe what this PR changes and why. Reference any related issues with "Fixes #N" or "Closes #N". -->

## Pre-commit checklist

All items must be checked before requesting review. See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

- [ ] **Security review** — changed files reviewed for OWASP Top 10 (injection, XSS, auth bypass, path traversal, secret exposure). All new API routes are behind auth middleware.
- [ ] **Tests pass** — `npx playwright test` runs clean with no failures.
- [ ] **Syntax check** — `node -c server.js && node -c monitor.js && node -c pty-worker.js` exits 0.
- [ ] **Version bumped** — `SERVER_VERSION` in `server.js` incremented (patch / minor / major as appropriate).
- [ ] **README updated** — new user-facing features documented in `README.md` (features list, config docs, architecture table).
- [ ] **No secrets committed** — passwords, tokens, API keys, private keys, and `.env` files are absent from this diff.
- [ ] **No personal paths** — machine-specific paths and user-identifying info are absent from tracked files.

## Testing notes

<!-- Describe how you tested this change. Include any manual steps needed to verify behaviour beyond the automated suite. -->
