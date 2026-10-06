'use strict';
// --- Is this request really from THIS host? (#297) ---------------------------
//
// A handful of routes (`/api/hook`, `/api/claude-status`, `/api/codex-session`,
// `/api/relay/*`) trust "came from loopback" in place of a credential, because
// their callers are processes on the same box: Claude's own hooks, the status-line
// pusher, an agent's curl.
//
// THE SOCKET ADDRESS ALONE CANNOT ANSWER THAT. `tailscale serve` publishes this
// server by reverse-proxying to 127.0.0.1:7681, so EVERY tailnet caller arrives on
// a loopback socket. Measured 2026-10-06 through a serve mount, from a peer:
// `remoteAddress` 127.0.0.1, plus `x-forwarded-for: <peer tailnet IP>`,
// `x-forwarded-host`, `x-forwarded-proto` and `tailscale-user-login` /
// `tailscale-headers-info`. Unauthenticated `GET /api/relay/status` answered 200
// from the tailnet while `/api/sessions` answered 401.
//
// The rule: loopback AND not relayed. A proxy announces itself in its forwarding
// headers; a local hook, curl or script sends none. A local process that fakes one
// only refuses itself, so the check cannot be used to gain anything. The list is
// deliberately broader than what tailscale sends today — any reverse proxy put in
// front of this server later must not reopen the hole.
//
// Pure: `server.js` exports nothing, so a rule left inline is reachable by no test.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/// Headers whose presence means a proxy relayed the request on someone's behalf.
const FORWARDING_HEADERS = Object.freeze([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'tailscale-user-login',
  'tailscale-headers-info',
]);

function isRelayed(headers) {
  if (!headers) return false;
  return FORWARDING_HEADERS.some((h) => headers[h] !== undefined);
}

/// True only for a request made directly by a process on this host.
function isDirectLocalRequest(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  return LOOPBACK.has(ip) && !isRelayed(req?.headers);
}

module.exports = { FORWARDING_HEADERS, isRelayed, isDirectLocalRequest };
