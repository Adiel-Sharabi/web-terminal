#!/usr/bin/env node
'use strict';
// The Supervisor dispatcher's verbs (#468, docs/SUPERVISOR-DESIGN.md section 9). Run from
// the dispatcher session on the lease authority; every verb is re-checked by the server.
//
//   node scripts/wt-supervise.js sessions
//   node scripts/wt-supervise.js cases
//   node scripts/wt-supervise.js case <case>
//   node scripts/wt-supervise.js tail <session> [turns]
//   node scripts/wt-supervise.js wake|coach|lead <session> "<text>" [--case <case>]
//   node scripts/wt-supervise.js answer <session> "<text>" --undo "<how>" [--case <case>]
//   node scripts/wt-supervise.js ask-owner <case> "<question>" [--propose <session> "<text>"]
//   node scripts/wt-supervise.js resolve <case> "<what was done>"
//   node scripts/wt-supervise.js close <session> [--case <case>]   (#469: an agent's, after a clean close-out)
//
// A session is named by its id or the first 8 characters of it. --server <url|name> talks to
// another server than this machine's (scripts/wt-api.js). Exit: 0 ok, 1 refused, 2 error.

const api = require('./wt-api');

const args = process.argv.slice(2);
const VALUE_FLAGS = ['--case', '--undo', '--propose', '--server'];
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])));
const [cmd, a1, a2] = positional;
const t = () => api.target(flag('--server'));

function usage() {
  console.error('usage: wt-supervise.js sessions | cases | case <id> | tail <session> [n] | wake|coach|lead <session> "<text>" [--case <id>]'
    + ' | answer <session> "<text>" --undo "<how>" | ask-owner <case> "<question>" [--propose <session> "<text>"] | resolve <case> "<what>"'
    + ' | close <session> [--case <id>]');
  process.exit(2);
}

const ago = (at) => (Number.isFinite(at) ? `${Math.round((Date.now() - at) / 60000)}m` : '-');

async function main() {
  if (!cmd) usage();
  let r;
  if (cmd === 'sessions') {
    r = await api.call(t(), 'GET', '/api/supervisor/state');
    if (r.status !== 200 || r.json.role !== 'authority') { console.error(r.json.error || `not the authority (${r.json.role || r.status})`); process.exit(2); }
    for (const n of r.json.sessions || []) {
      const w = n.wait ? `${n.wait.on}${n.wait.what ? ` "${n.wait.what}"` : ''}${n.wait.target ? ` [${n.wait.target.kind}]` : ''} ${ago(n.wait.at)}` : '-';
      console.log(`${n.id.slice(0, 8)} ${n.server} ${n.status || '?'} "${n.name || ''}" wait: ${w}${n.orphan && n.orphan.state === 'orphan' ? ' ORPHAN' : ''}${n.role ? ` (${n.role})` : ''}`);
    }
    return;
  }
  if (cmd === 'cases') {
    r = await api.call(t(), 'GET', '/api/supervisor/cases');
    if (r.status !== 200) { console.error(r.json.error || `HTTP ${r.status}`); process.exit(2); }
    if (!(r.json.cases || []).length) console.log('no open cases');
    for (const c of r.json.cases || []) console.log(`${c.id} ${c.rule} ${ago(c.openedAt)}${c.escalated ? ' (with the owner)' : ''}: ${c.line}`);
    return;
  }
  if (!a1) usage();
  if (cmd === 'case') r = await api.call(t(), 'GET', `/api/supervisor/cases/${encodeURIComponent(a1)}`);
  else if (cmd === 'tail') r = await api.call(t(), 'GET', `/api/supervisor/tail/${encodeURIComponent(a1)}${a2 ? `?turns=${encodeURIComponent(a2)}` : ''}`);
  else if (['wake', 'coach', 'lead', 'answer'].includes(cmd)) {
    if (!a2) usage();
    r = await api.call(t(), 'POST', '/api/supervisor/act', { verb: cmd, session: a1, text: a2, undo: flag('--undo'), case: flag('--case') });
  } else if (cmd === 'ask-owner') {
    if (!a2) usage();
    const pi = args.indexOf('--propose');
    const propose = pi >= 0 ? { session: args[pi + 1], text: args[pi + 2] } : undefined;
    r = await api.call(t(), 'POST', `/api/supervisor/cases/${encodeURIComponent(a1)}`, { action: 'ask-owner', question: a2, propose });
  } else if (cmd === 'close') {
    r = await api.call(t(), 'POST', '/api/supervisor/close', { session: a1, case: flag('--case') });
  } else if (cmd === 'resolve') {
    if (!a2) usage();
    r = await api.call(t(), 'POST', `/api/supervisor/cases/${encodeURIComponent(a1)}`, { action: 'resolve', how: a2 });
  } else usage();
  console.log(JSON.stringify(r.json, null, 2));
  if (r.status >= 500 || r.status === 400 || r.status === 404) process.exit(2);
  if (r.status !== 200 || r.json.refused) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
