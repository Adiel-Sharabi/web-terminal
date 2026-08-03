# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | Yes (current)      |
| < 1.0   | No                 |

Security fixes land on the `master` branch of the 1.x series. Older
development snapshots are not supported — please upgrade to the latest
1.x tag or `master`.

## Reporting a Vulnerability

Please report vulnerabilities **privately** via GitHub's private
vulnerability reporting:

https://github.com/Adiel-Sharabi/web-terminal/security/advisories/new

Do not open a public issue or discussion for security reports.

This is a small single-maintainer project. Response is best-effort —
expect an acknowledgement within a few days and a fix or mitigation
within a reasonable window for confirmed reports. Please allow
reasonable time to patch before public disclosure.

## In Scope

- Authentication bypass in the HTTP, WebSocket, or cluster-proxy paths.
- Command injection, path traversal, or SSRF in `/api/*` routes.
- Token or cookie forgery that lets an unauthenticated caller read or
  modify session state.
- Privilege escalation between tenants of the same server (e.g. one
  logged-in user affecting another's sessions).
- Vulnerabilities in the IPC handshake between `server.js` and
  `pty-worker.js` that would let a local unprivileged user hijack PTYs.

## Out of Scope / Documented Risk

- **`/api/exec`** — this route is **off by default**. Enabling it via
  `"enableRemoteExec": true` in `config.json` gives any valid bearer
  token the ability to run arbitrary shell commands on the server. Treat
  an enabled `/api/exec` like SSH: protect the bearer tokens accordingly.
  This is documented behaviour, not a vulnerability.
- **Scrollback on disk is plaintext.** Captures of session output live
  in `scrollback/` and will contain anything the user typed or the shell
  printed, including partial secrets. Protect filesystem access
  accordingly.
- Vulnerabilities that require physical access to a logged-in operator
  workstation, malicious browser extensions, or a compromised OS account
  that already has the ability to read `config.json` / `.session-secret`
  / `api-tokens.json`.
- Denial of service from an already-authenticated user against their
  own server.
- Self-XSS in the admin UI that requires the user to paste attacker-
  controlled content into their own browser console.

## Hardening Notes

- Default `host` is `127.0.0.1`. Exposing the server on a public
  interface (including binding `0.0.0.0`) without a reverse proxy /
  firewall / Tailscale gateway is not a supported deployment.
- API bearer tokens expire after 90 days. Session cookies are HMAC-
  signed and server-side expiry is enforced at 90 days.
- The Claude hook endpoints require a per-process token stored in
  `.hook-token` (auto-generated on startup, chmod 0600 on unix).

Thank you for helping keep web-terminal users safe.
