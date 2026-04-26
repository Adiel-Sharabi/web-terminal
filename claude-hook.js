// Claude Code hook for web-terminal session status.
// Only fires when running inside a web-terminal PTY (WT_SESSION_ID is set).
// Uses Node.js instead of bash to avoid console window flash on Windows.
const id = process.env.WT_SESSION_ID;
if (!id) process.exit(0);

const port = process.env.WT_SESSION_PORT || '7681';

// H1: read the per-process hook token from .hook-token alongside server.js.
// The file is written by server.js on startup (chmod 0600 on unix).
const fs = require('fs');
const path = require('path');
let hookToken = '';
try {
  hookToken = fs.readFileSync(path.join(__dirname, '.hook-token'), 'utf8').trim();
} catch (e) {
  // No token file -> silently exit (server may not be up, or this isn't the
  // web-terminal hook install). Don't break Claude if the hook can't authenticate.
  process.exit(0);
}
if (!hookToken) process.exit(0);

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let event = '', sessionId = '';
  try {
    const parsed = JSON.parse(input);
    event = parsed.hook_event_name;
    sessionId = parsed.session_id;
  } catch (e) {}
  if (!event) process.exit(0);

  const http = require('http');
  // Forward Claude's own session UUID alongside the event so the worker can
  // pin it to this terminal — disambiguates two web-terminal sessions sharing
  // a cwd (filesystem-mtime detection collides; the hook payload is per-run
  // authoritative).
  const body = JSON.stringify(sessionId ? { event, session_id: sessionId } : { event });
  const req = http.request({
    hostname: '127.0.0.1', port, method: 'POST',
    path: `/api/session/${id}/hook`,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'X-WT-Hook-Token': hookToken,
    }
  });
  req.on('error', () => {});
  req.end(body);
  // Don't wait for response — fire and forget
  setTimeout(() => process.exit(0), 500);
});
