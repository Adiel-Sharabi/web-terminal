#!/usr/bin/env node
'use strict';
// Prepare a web-terminal machine for a restart (#359), from a shell or an agent.
//
//   node scripts/wt-maintenance.js prepare "Windows update"   [--server <url|name>]
//   node scripts/wt-maintenance.js status [--wait [minutes]]  [--server <url|name>] [--json]
//   node scripts/wt-maintenance.js cancel                     [--server <url|name>]
//
// `prepare` sets the restart hold: every agent session is told to wrap up, and new
// sessions are refused until the restart. `status` is the server's own answer to "can I
// restart now?", one verdict per session, decided from state and never from what the
// agents wrote; `--wait` polls until it is yes. The hold clears itself once the restart
// has happened, and the sessions it told get a "machine is back" notice.
//
// --server picks a cluster peer by URL or by its name in cluster-tokens.json, and uses
// that peer's bearer token. Without it, this machine's own server is used, with a token
// from its api-tokens.json.
//
// Exit code: 0 = safe to restart (or the command succeeded), 1 = not yet, 2 = error /
// no hold.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--server', '--wait'].includes(args[i - 1])));
const [cmd, ...rest] = positional;
const asJson = args.includes('--json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** { url, token } for --server, or for this machine. */
function target() {
  const want = flag('--server');
  if (want && want !== true) {
    const peers = readJson(process.env.WT_CLUSTER_TOKENS_FILE || path.join(ROOT, 'cluster-tokens.json')) || {};
    const norm = (u) => String(u).replace(/\/+$/, '').toLowerCase();
    const hit = Object.entries(peers).find(([u, v]) => norm(u) === norm(want) || (v && typeof v === 'object' && String(v.name || '').toLowerCase() === String(want).toLowerCase()));
    if (!hit) throw new Error(`no cluster peer "${want}" in cluster-tokens.json`);
    return { url: hit[0].replace(/\/+$/, ''), token: typeof hit[1] === 'string' ? hit[1] : hit[1].token };
  }
  const tokens = readJson(process.env.WT_API_TOKENS_FILE || path.join(ROOT, 'api-tokens.json')) || {};
  const now = Date.now();
  const live = Object.entries(tokens)
    .filter(([, v]) => v && (!v.expires || new Date(v.expires).getTime() > now))
    .sort((a, b) => new Date(b[1].expires || 0) - new Date(a[1].expires || 0));
  if (!live.length) throw new Error('no unexpired API token in api-tokens.json for the local server');
  return { url: `http://127.0.0.1:${process.env.WT_SESSION_PORT || 7681}`, token: live[0][0] };
}

async function call(t, method, route, body) {
  const r = await fetch(t.url + route, {
    method,
    headers: { Authorization: `Bearer ${t.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

function render(t, s) {
  if (!s.hold) {
    const back = s.back ? ` - telling ${s.back.pending} restored session(s) the machine is back` : '';
    return `${t.url}: no restart hold${back}`;
  }
  const lines = [`${t.url}: restart hold "${s.hold.reason}" since ${new Date(s.hold.startedAt).toLocaleTimeString()} - ${s.safeToRestart ? 'SAFE TO RESTART' : 'NOT YET'}`];
  for (const v of s.sessions) {
    lines.push(`  ${v.state.padEnd(10)} ${String(v.name || v.id).slice(0, 40).padEnd(40)} ${v.why}${v.startedDuringHold ? ' (started during the hold)' : ''}`);
    if (v.reply) lines.push(`             said: ${String(v.reply).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

async function main() {
  const t = target();
  if (cmd === 'prepare') {
    const reason = rest.join(' ').trim();
    if (!reason) throw new Error('prepare needs a reason: wt-maintenance.js prepare "Windows update"');
    const r = await call(t, 'POST', '/api/maintenance/prepare', { reason });
    if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); if (r.json.hold) console.log(render(t, r.json)); return 2; }
    console.log(asJson ? JSON.stringify(r.json, null, 2) : render(t, r.json));
    return 0;
  }
  if (cmd === 'cancel') {
    const r = await call(t, 'DELETE', '/api/maintenance');
    if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); return 2; }
    console.log(`${t.url}: ${r.json.cancelled ? 'restart hold cancelled' : 'there was no restart hold'}`);
    return 0;
  }
  if (cmd === 'status') {
    const w = flag('--wait');
    const until = w ? Date.now() + (w === true ? 60 : Number(w)) * 60000 : 0;
    let last = '';
    for (;;) {
      const r = await call(t, 'GET', '/api/maintenance/status');
      if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); return 2; }
      const out = asJson ? JSON.stringify(r.json, null, 2) : render(t, r.json);
      if (out !== last) { console.log(out); last = out; }
      if (!r.json.hold) return 2;
      if (r.json.safeToRestart) return 0;
      if (!until || Date.now() > until) return 1;
      await new Promise((res) => setTimeout(res, 15000));
    }
  }
  console.error('usage: wt-maintenance.js prepare "<reason>" | status [--wait [minutes]] | cancel   [--server <url|name>] [--json]');
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(`wt-maintenance: ${e.message}`); process.exit(2); });
