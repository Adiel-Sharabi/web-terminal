'use strict';
// What every agent-side dashboard script needs: read the JSON on stdin, find this
// session and its credential, POST it to this server. ONE copy, shared by
// scripts/wt-report.js (#298) and scripts/wt-handoff.js (#340).
//
// Identity and credential come from the env the worker injects into every PTY:
// WT_SESSION_ID, WT_SESSION_PORT, WT_HOOK_TOKEN. The routes take the hook token and
// NOTHING else — not "it came from localhost" (#297: behind tailscale serve every
// caller does). The JSON goes on STDIN, never in argv: it carries quotes and
// apostrophes, and a quoted heredoc is the one shell form that passes them untouched.

const fs = require('fs');
const path = require('path');
const http = require('http');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

function hookToken() {
  if (process.env.WT_HOOK_TOKEN) return process.env.WT_HOOK_TOKEN;
  // A PTY that predates the token (H1) has no env var; the file beside the server is
  // the same secret.
  try { return fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim(); } catch { return ''; }
}

/// Read stdin as JSON and POST it to `/api/session/<id>/<route>`. Resolves to an exit
/// code; `onOk(json)` prints the success line. Every failure is printed for the AGENT
/// to read, prefixed with [name].
async function postFromStdin(name, route, onOk) {
  const id = process.env.WT_SESSION_ID;
  if (!id) {
    console.error(`${name}: not inside a web-terminal session (WT_SESSION_ID is not set) - nothing to send to.`);
    return 2;
  }
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error(`${name}: nothing on stdin. Pipe the JSON in with a heredoc.`);
    return 2;
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    console.error(`${name}: the input is not valid JSON (${e.message}).`);
    return 2;
  }
  const port = parseInt(process.env.WT_SESSION_PORT || '7681', 10);
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', timeout: 5000,
      path: `/api/session/${encodeURIComponent(id)}/${route}`,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-wt-hook-token': hookToken() },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(s); } catch { /* not JSON */ }
        if (res.statusCode === 200) {
          onOk(j);
          resolve(0);
        } else {
          console.error(`${name}: the server refused it (HTTP ${res.statusCode}): ${j.error || s.slice(0, 200)}`);
          resolve(1);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { console.error(`${name}: cannot reach the server on port ${port}: ${e.message}`); resolve(1); });
    req.end(data);
  });
}

module.exports = { readStdin, hookToken, postFromStdin };
