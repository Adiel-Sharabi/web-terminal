#!/usr/bin/env node
'use strict';
// Does a LONG prompt survive the CLUSTER PROXY? (The gap verify-long-prompt.js leaves.)
//
// That verifier proves the DIRECT path — client -> /ws/:id -> worker -> PTY — carries
// 1582 bytes whole. But the companion talks to a remote session through the PROXY by
// default (`directConnect` is opt-in), so a phone answering a session on another machine
// takes a path nothing has ever measured:
//
//     client -> /cluster/:serverUrl/ws/:id -> ws client -> peer /ws/:id -> worker -> PTY
//
// and that relay has two places input can vanish without a trace (server.js):
//     try { remoteWs.send(msg, ...) } catch (e) {}        // a throw is swallowed
//     } else if (buffered.length < MAX_BUFFER_SIZE) {     // full buffer: no else, no log
//
// The rig proxies TO ITSELF. One instance is enough because the code under test is the
// relay, not the peer: `/cluster/:serverUrl/ws/:id` dials `serverUrl + '/ws/' + id`, so
// pointing serverUrl at the rig exercises the identical handler, buffer and send path.
//
// Method is inherited wholesale from verify-long-prompt.js, including both traps it paid
// for: the evidence is the shell COUNTING bytes (`printf '%s' '<text>' | wc -c`), never the
// echo — readline reflows a wrapped line and a contiguous compare then fails while every
// marker is present — and the count is matched on ANSI-STRIPPED text.
//
// Each length is run DIRECT and PROXIED against the same live session, so a difference is
// attributable to the relay alone rather than to the length.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/verify-long-prompt-proxy.js
//
// Nothing here touches production.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { login, api, WS_BASE } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const PORT = parseInt(process.env.WT_RIG_PORT || '7999', 10);
const SELF = `http://127.0.0.1:${PORT}`;
const LENGTHS = (process.env.WT_PROBE_LENGTHS || '1582,4096,8192,16384')
  .split(',').map((n) => parseInt(n, 10)).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `total` chars; each 50-char block labelled with its own offset, so a cut names itself. */
function instrumentedPrompt(total) {
  // Each block is EXACTLY 50 chars: 'M' + 5-digit offset (6) + 44 filler. So the
  // marker at index N*50 literally states its own offset, and a cut is read off
  // the surviving markers rather than eyeballed.
  const filler = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqr'; // 44
  let s = '';
  for (let off = 0; s.length < total; off += 50) {
    s += 'M' + String(off).padStart(5, '0') + filler;
  }
  s = s.slice(0, total);
  // WT_PROBE_MULTILINE turns it into the shape a phone produces: a paragraph break
  // every 80 chars. The body still counts the same, but it now travels as a
  // bracketed paste rather than as a bare line.
  if (process.env.WT_PROBE_MULTILINE === '1') {
    s = s.replace(/(.{80})/g, '$1\n');
  }
  return s;
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/** Open the session socket THROUGH the cluster proxy, as an ACTIVE viewer. */
async function openProxied(cookie, id) {
  const url = `${WS_BASE}/cluster/${encodeURIComponent(SELF)}/ws/${id}`;
  const ws = new WebSocket(url, { headers: { Cookie: cookie } });
  let out = '';
  ws.on('message', (d) => { out += d.toString('utf8'); });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  // Same handshake as the direct probe — a background viewer's input is dropped.
  ws.send(JSON.stringify({ mode: 'active', browserId: 'rig-proxy-probe' }));
  return {
    ws,
    text: () => out,
    send: (s) => ws.send(s),
    close: () => { try { ws.close(); } catch {} },
  };
}

/** Give the proxy a token for the rig's own URL, so /cluster/... authenticates. */
async function ensureSelfClusterToken(cookie) {
  const file = path.join(DIRS.rig, 'cluster-tokens.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (existing[SELF] && existing[SELF].token) return;
  const r = await api(cookie, 'POST', '/api/auth/token', {
    user: process.env.WT_RIG_USER || 'admin',
    password: process.env.WT_RIG_PASS || 'rig',
    label: 'proxy-probe',
  });
  const token = r && (r.token || r.apiToken);
  if (!token) throw new Error('could not mint an API token: ' + JSON.stringify(r));
  existing[SELF] = { token, name: 'self', authenticated: true };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  console.log(`minted a self cluster token -> ${file}`);
}

/**
 * The exact bytes the companion puts on the wire — buildComposeSubmission, ported.
 * A MULTI-LINE prompt takes a different encoding entirely (bracketed paste, newlines
 * carried as CR), and that is the shape a phone actually produces: on mobile Enter
 * inserts a newline (#55), so a long typed prompt is almost never single-line. The
 * single-line ladder above never exercised it.
 */
function composeSubmission(val) {
  if (!val.includes('\n')) return `${val}\r`;
  const inner = val.replace(/\x1b\[2(?:00|01)~/g, '').replace(/\r?\n/g, '\r');
  return `\x1b[200~${inner}\x1b[201~\r`;
}

/**
 * Send `prompt` as ONE frame and return what the shell counted.
 * The shell's integer is the only evidence; the echo cannot forge it.
 */
async function measure(term, prompt) {
  const before = term.text().length;
  term.send(composeSubmission(`printf '%s' '${prompt}' | wc -c`));
  for (let i = 0; i < 320; i++) {
    await sleep(250);
    const hit = stripAnsi(term.text().slice(before)).match(/^[ \t\r]*(\d{2,7})[ \t\r]*$/m);
    if (hit) return parseInt(hit[1], 10);
  }
  return null;
}

async function waitForPrompt(term) {
  for (let i = 0; i < 60 && !/[$#>]/.test(term.text()); i++) await sleep(250);
}

async function main() {
  const cookie = await login();
  await ensureSelfClusterToken(cookie);

  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-long-prompt-proxy',
    cwd: DIRS.rig,
  });
  console.log(`session ${id} created\n`);

  const rows = [];
  try {
    for (const len of LENGTHS) {
      const prompt = instrumentedPrompt(len);
      // Multi-line mode adds newline bytes, and `wc -c` counts them, so the
      // expectation is the prompt's real length — never the requested one.
      const expected = prompt.length;
      const row = { len: expected, direct: null, proxied: null };

      for (const mode of ['direct', 'proxied']) {
        const term = mode === 'direct'
          ? await openTerminal(cookie, id)
          : await openProxied(cookie, id);
        try {
          await waitForPrompt(term);
          // Settle: the previous run's reflow can still be draining.
          await sleep(500);
          row[mode] = await measure(term, prompt);
        } finally {
          term.close();
          await sleep(750); // let the server drop the viewer before the next attaches
        }
      }
      rows.push(row);
      const mark = (got) => (got === expected ? 'OK' : got === null ? 'NO COUNT' : `CUT -> ${got}`);
      console.log(`len=${String(len).padStart(6)}  direct=${String(row.direct).padStart(6)} ${mark(row.direct).padEnd(14)}  proxied=${String(row.proxied).padStart(6)} ${mark(row.proxied)}`);
    }
  } finally {
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch {}
  }

  console.log('\n================ VERDICT ================');
  const bad = rows.filter((r) => r.proxied !== r.len);
  const badDirect = rows.filter((r) => r.direct !== r.len);
  for (const r of rows) {
    console.log(`  ${String(r.len).padStart(6)}  direct ${r.direct === r.len ? 'intact' : r.direct}  |  proxied ${r.proxied === r.len ? 'intact' : r.proxied}`);
  }
  if (bad.length && !badDirect.length) {
    console.log('\nPROXY LOSES BYTES the direct path carries — the relay is the cause.');
    process.exitCode = 1;
  } else if (bad.length && badDirect.length) {
    console.log('\nBOTH paths lose bytes — not proxy-specific; suspect length itself.');
    process.exitCode = 1;
  } else {
    console.log('\nPASS — the proxy carried every length intact.');
  }
}

main().catch((e) => {
  console.error('verify-long-prompt-proxy failed:', e.message);
  process.exitCode = 1;
});
