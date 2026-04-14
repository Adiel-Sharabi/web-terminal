// Claude Code hook for web-terminal session status.
// Only fires when running inside a web-terminal PTY (WT_SESSION_ID is set).
// Uses Node.js instead of bash to avoid console window flash on Windows.
const id = process.env.WT_SESSION_ID;
if (!id) process.exit(0);

const port = process.env.WT_SESSION_PORT || '7681';
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let event = '';
  try { event = JSON.parse(input).hook_event_name; } catch (e) {}
  if (!event) process.exit(0);

  const http = require('http');
  const body = JSON.stringify({ event });
  const req = http.request({
    hostname: '127.0.0.1', port, method: 'POST',
    path: `/api/session/${id}/hook`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
  });
  req.on('error', () => {});
  req.end(body);
  // Don't wait for response — fire and forget
  setTimeout(() => process.exit(0), 500);
});
