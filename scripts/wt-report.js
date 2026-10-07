#!/usr/bin/env node
'use strict';
// Report this session's work to the web-terminal sessions dashboard (#298).
//
// Run by the AGENT inside a web-terminal session; the exact command is handed to it
// on every prompt (lib/session-brief.js reportCommand), so nobody types this by hand:
//
//   node scripts/wt-report.js <<'EOF'
//   {"items":[{"ref":"#123","title":"short title","state":"in-progress","note":"optional"}],"headline":"optional"}
//   EOF
//
// The JSON goes on STDIN, never in argv: titles carry quotes and apostrophes, and a
// quoted heredoc is the one shell form that passes them through untouched.
//
// Identity and credential come from the env the worker injects into every PTY:
// WT_SESSION_ID, WT_SESSION_PORT, WT_HOOK_TOKEN. The report route takes the hook token
// and NOTHING else — not "it came from localhost" (#297: behind tailscale serve every
// caller does). A validation error is printed as the server wrote it, for the agent
// to read and fix; the exit code says whether the dashboard took the report.

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

async function main() {
  const id = process.env.WT_SESSION_ID;
  if (!id) {
    console.error('wt-report: not inside a web-terminal session (WT_SESSION_ID is not set) - nothing to report to.');
    return 2;
  }
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('wt-report: no report on stdin. Pipe the JSON in with a heredoc.');
    return 2;
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    console.error(`wt-report: the report is not valid JSON (${e.message}).`);
    return 2;
  }
  const port = parseInt(process.env.WT_SESSION_PORT || '7681', 10);
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', timeout: 5000,
      path: `/api/session/${encodeURIComponent(id)}/report`,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-wt-hook-token': hookToken() },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(s); } catch { /* not JSON */ }
        if (res.statusCode === 200) {
          const n = (j.brief && j.brief.items && j.brief.items.length) || 0;
          const w = j.brief && j.brief.wait;
          console.log(`dashboard updated: ${n} work item${n === 1 ? '' : 's'}${w ? `; waiting on ${w.on}${w.what ? `: ${w.what}` : ''}` : ''}`);
          resolve(0);
        } else {
          console.error(`wt-report: the dashboard refused the report (HTTP ${res.statusCode}): ${j.error || s.slice(0, 200)}`);
          resolve(1);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { console.error(`wt-report: cannot reach the server on port ${port}: ${e.message}`); resolve(1); });
    req.end(data);
  });
}

main().then((c) => process.exit(c));
