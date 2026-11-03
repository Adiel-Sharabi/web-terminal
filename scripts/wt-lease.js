#!/usr/bin/env node
'use strict';
// Cluster resource leases (#412), from a shell or an agent. Always talk to YOUR OWN
// machine's server (the default): it forwards to the lease authority and tells it which
// machine you are on, which is what lets the authority see your session end.
//
//   node scripts/wt-lease.js acquire vm:AM8-SanityVM [--role release] [--ttl 3600]
//        [--heartbeat 60] [--meta '{"wi":25309}'] [--mem 8 --disk 40 --drive C:]
//        [--wait [minutes]] [--no-session] [--json]
//   node scripts/wt-lease.js heartbeat <id> [--ttl 3600]
//   node scripts/wt-lease.js release <id>
//   node scripts/wt-lease.js list [--json]
//   node scripts/wt-lease.js record <id> --pid 1234 [--pid ...] [--path C:\dev\wt-1 ...]
//   node scripts/wt-lease.js admission [--mem 8] [--disk 40] [--drive C:]
//
// `acquire` holds the lease for THIS session ($WT_SESSION_ID): it ends when the session
// does (closed, reaped, crashed), at its TTL, or on `release`, and needs no heartbeat.
// `--no-session` (a script outside any session) makes it a heartbeat lease: run
// `heartbeat <id>` at least every --heartbeat seconds or it is released after three
// misses. `--wait` keeps a queued request in line until granted (exit 0) or the minutes
// run out; without it, or when the minutes run out, a queued request leaves the queue (exit 1).
//
// `record` lists what the lease started on this machine - pids, temp dirs, worktrees -
// for release to clean up: a pid only while it is still the same process (creation time),
// a folder without following junctions, and only inside leases.cleanupRoots.
//
// Exit code: 0 = granted / done, 1 = queued / not admitted, 2 = error.

const { target, call } = require('./wt-api');

const args = process.argv.slice(2);
const VALUED = ['--server', '--role', '--ttl', '--heartbeat', '--meta', '--mem', '--disk', '--drive', '--wait', '--pid', '--path', '--session'];
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const flags = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1])));
const [cmd, arg] = positional;
const asJson = args.includes('--json');

const num = (name) => {
  const v = flag(name);
  if (v === undefined) return undefined;
  if (v === true || !Number.isFinite(Number(v))) throw new Error(`${name} needs a number`);
  return Number(v);
};
const fail = (t, r) => { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}${r.json.reasons ? ` - ${r.json.reasons.join('; ')}` : ''}`); return r.status === 409 ? 1 : 2; };
const line = (l) => `${l.id}  ${l.resource}  ${l.state === 'held' ? `HELD for ${l.heldForSec}s` : `QUEUED #${l.position} for ${l.waitingForSec}s`}  by ${l.holder.server || '?'}${l.holder.sessionId ? `/${l.holder.sessionId.slice(0, 8)}` : ''}`;

function needsFromFlags() {
  const needs = {};
  if (num('--mem') !== undefined) needs.memGB = num('--mem');
  if (num('--disk') !== undefined) needs.diskGB = num('--disk');
  const d = flag('--drive');
  if (d !== undefined && d !== true) needs.drive = d;
  return Object.keys(needs).length ? needs : undefined;
}

async function main() {
  // acquire and record name THIS machine: its session for the holder, its pids and folders for
  // the cleanup. Sent to another server they would name the wrong machine's.
  if (flag('--server') !== undefined && (cmd === 'acquire' || cmd === 'record')) throw new Error(`${cmd} talks to this machine's own server; --server is only for heartbeat, release, list and admission`);
  const t = target(flag('--server'));
  if (cmd === 'acquire') {
    if (!arg) throw new Error('acquire needs a resource: wt-lease.js acquire vm:NAME');
    const body = { resource: arg };
    const session = flag('--session');
    if (!args.includes('--no-session')) {
      const sid = session && session !== true ? session : process.env.WT_SESSION_ID;
      if (!sid) throw new Error('not inside a web-terminal session ($WT_SESSION_ID is not set); pass --no-session for a heartbeat lease');
      body.holderSessionId = sid;
    }
    if (num('--ttl') !== undefined) body.ttlSec = num('--ttl');
    if (num('--heartbeat') !== undefined) body.heartbeatSec = num('--heartbeat');
    const role = flag('--role');
    if (role !== undefined && role !== true) body.role = role;
    const meta = flag('--meta');
    if (meta !== undefined && meta !== true) body.meta = JSON.parse(meta);
    const needs = needsFromFlags();
    if (needs) body.needs = needs;
    let r = await call(t, 'POST', '/api/leases', body);
    if (r.status !== 200) return fail(t, r);
    let lease = r.json.lease;
    const w = flag('--wait');
    const until = w ? Date.now() + (w === true ? 60 : Number(w)) * 60000 : 0;
    let last = '';
    for (;;) {
      const out = asJson ? JSON.stringify(lease, null, 2) : line(lease);
      if (out !== last) { console.log(out); last = out; }
      if (lease.state === 'held') return 0;
      if (!until) {
        // Nobody will be waiting for it: a request left in line would be granted, later, to an
        // agent that moved on, and hold the resource for its whole TTL.
        await call(t, 'DELETE', `/api/leases/${lease.id}`);
        console.error(`${t.url}: ${lease.resource} is taken; left the queue (use --wait to stay in line)`);
        return 1;
      }
      if (Date.now() > until) {
        await call(t, 'DELETE', `/api/leases/${lease.id}`);
        console.error(`${t.url}: still queued after the wait; left the queue`);
        return 1;
      }
      await new Promise((res) => setTimeout(res, 15000));
      r = await call(t, 'POST', `/api/leases/${lease.id}/heartbeat`, {});
      if (r.status !== 200) return fail(t, r);
      lease = r.json.lease;
    }
  }
  if (cmd === 'heartbeat' || cmd === 'release') {
    if (!arg) throw new Error(`${cmd} needs a lease id`);
    const ttl = num('--ttl');
    const r = cmd === 'release'
      ? await call(t, 'DELETE', `/api/leases/${arg}`)
      : await call(t, 'POST', `/api/leases/${arg}/heartbeat`, ttl === undefined ? {} : { ttlSec: ttl });
    if (r.status !== 200) return fail(t, r);
    console.log(asJson ? JSON.stringify(r.json, null, 2) : (cmd === 'release' ? `released ${arg}` : line(r.json.lease)));
    return 0;
  }
  if (cmd === 'list') {
    const r = await call(t, 'GET', '/api/leases');
    if (r.status !== 200) return fail(t, r);
    if (asJson) { console.log(JSON.stringify(r.json, null, 2)); return 0; }
    console.log(`lease authority: ${r.json.authority}`);
    if (!r.json.resources.length) console.log('  nothing is leased');
    for (const row of r.json.resources) {
      if (row.holder) console.log(`  ${line(row.holder)}`);
      for (const q of row.queue) console.log(`  ${line(q)}`);
    }
    return 0;
  }
  if (cmd === 'record') {
    if (!arg) throw new Error('record needs a lease id');
    const pids = flags('--pid').map((p) => { const n = Number(p); if (!Number.isInteger(n)) throw new Error(`--pid ${p} is not a pid`); return n; });
    const paths = flags('--path');
    const r = await call(t, 'POST', `/api/leases/${arg}/record`, { pids, paths });
    if (r.status !== 200) return fail(t, r);
    console.log(asJson ? JSON.stringify(r.json, null, 2) : `${arg}: ${r.json.items.length} item(s) will be cleaned up on release`);
    return 0;
  }
  if (cmd === 'admission') {
    const n = needsFromFlags() || {};
    const q = new URLSearchParams(Object.entries(n).map(([k, v]) => [k, String(v)])).toString();
    const r = await call(t, 'GET', `/api/admission${q ? `?${q}` : ''}`);
    if (r.status === 200) { console.log(`${t.url}: admitted`); return 0; }
    return fail(t, r);
  }
  console.error('usage: wt-lease.js acquire <resource> [--role R] [--ttl S] [--wait [min]] [--mem GB --disk GB] [--no-session] | heartbeat <id> | release <id> | list | record <id> --pid N --path P | admission [--mem GB] [--disk GB]   [--server <url|name>] [--json]');
  return 2;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`wt-lease: ${e.message}`); process.exitCode = 2; });
