#!/usr/bin/env node
'use strict';
// #558 - move sessions in the session family (who is whose child), from a shell or an agent.
//
//   node scripts/wt-family.js parent <session|me> <parent|me|none>
//       move one session under another (none = out from under any parent)
//   node scripts/wt-family.js move-children <from|me> <to|me|none> [--only <id>,<id>...]
//       hand every child of <from> (or just the ones named) to <to>
//   node scripts/wt-family.js show [<session|me>]
//       print a session's parent and children
//
// `me` is this session ($WT_SESSION_ID). A session may live on any cluster machine: the
// script finds its owner in this server's cluster view and asks THAT server (the one that
// stores the session's parent), with the token from cluster-tokens.json. A hand-over can be
// asked of any server: it forwards each child's move to the child's own server.
// Transport and credential: scripts/wt-api.js.

const { target, call } = require('./wt-api');
const { familyOf } = require('../lib/session-family'); // the ONE family rule (aliases, loops)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(msg) {
  if (msg) console.error(`wt-family: ${msg}`);
  console.error('usage: wt-family.js parent <session|me> <parent|me|none>\n'
    + '       wt-family.js move-children <from|me> <to|me|none> [--only <id>,<id>...]\n'
    + '       wt-family.js show [<session|me>]');
  process.exit(2);
}

/** A session id argument: `me`, an id, or (where allowed) `none` -> null. */
function idArg(raw, { allowNone = false } = {}) {
  if (raw === undefined) usage('missing a session id');
  if (raw === 'me') {
    const me = process.env.WT_SESSION_ID;
    if (!me || !UUID_RE.test(me)) usage('`me` needs $WT_SESSION_ID (run it inside a web-terminal session)');
    return me.toLowerCase();
  }
  if (allowNone && raw === 'none') return null;
  if (!UUID_RE.test(raw)) usage(`not a session id: ${raw}`);
  return raw.toLowerCase();
}

const short = (id) => (id ? id.substring(0, 8) : '-');

async function clusterRows(local) {
  const r = await call(local, 'GET', '/api/cluster/sessions');
  if (r.status !== 200) throw new Error(`cluster list failed: HTTP ${r.status} ${r.json.error || ''}`);
  return r.json.sessions || [];
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const local = target();
  if (verb === 'parent') {
    const id = idArg(rest[0]);
    const parentId = idArg(rest[1], { allowNone: true });
    const row = (await clusterRows(local)).find((s) => s.id === id);
    if (!row) throw new Error(`no live session ${id} on any reachable server`);
    const owner = row.serverUrl ? target(row.serverUrl) : local;
    const r = await call(owner, 'PATCH', `/api/sessions/${id}/parent`, { parentId });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.json.error || 'refused'}`);
    console.log(`${row.name || short(id)} (${row.server || 'here'}) is now ${r.json.parentId ? `under ${short(r.json.parentId)}` : 'a top-level session'}`);
    return 0;
  }
  if (verb === 'move-children') {
    const from = idArg(rest[0]);
    const to = idArg(rest[1], { allowNone: true });
    const i = rest.indexOf('--only');
    const children = i >= 0 ? String(rest[i + 1] || '').split(',').filter(Boolean).map((x) => idArg(x)) : undefined;
    const r = await call(local, 'POST', `/api/sessions/${from}/children/move`, { to, ...(children ? { children } : {}) });
    if (!Array.isArray(r.json.moved)) throw new Error(`HTTP ${r.status}: ${r.json.error || 'refused'}`);
    for (const m of r.json.moved) console.log(`moved   ${m.name || short(m.id)} (${m.server || 'here'})`);
    for (const f of r.json.failed) console.log(`FAILED  ${f.name || short(f.id)} (${f.server || 'here'}): ${f.error}`);
    const unseen = r.json.unreachable || [];
    if (unseen.length) console.log(`NOT SEEN: ${unseen.join(', ')} (unreachable: any children there were not moved)`);
    if (!r.json.moved.length && !r.json.failed.length && !unseen.length) console.log('no children to move');
    return r.json.failed.length || unseen.length ? 1 : 0;
  }
  if (verb === 'show') {
    const id = idArg(rest[0] === undefined ? 'me' : rest[0]);
    const rows = await clusterRows(local);
    const tree = familyOf(rows);
    const node = tree.resolve(id);
    if (!node) throw new Error(`no live session ${id} on any reachable server`);
    const row = node.row;
    const pid = row.spawn && row.spawn.parentId;
    const up = tree.parentOf(node);
    const parent = up && up.row;
    const kids = tree.childrenOf(node).map((n) => n.row);
    console.log(`${row.name} (${short(id)}, ${row.server || 'here'})`);
    console.log(`  parent:   ${parent ? `${parent.name} (${short(parent.id)}, ${parent.server})` : pid ? `${short(pid)} (not live)` : 'none'}`);
    console.log(`  children: ${kids.length ? '' : 'none'}`);
    for (const k of kids) console.log(`    ${k.name} (${short(k.id)}, ${k.server})`);
    return 0;
  }
  usage(verb ? `unknown command: ${verb}` : null);
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(`wt-family: ${e.message}`); process.exit(1); });
