#!/usr/bin/env node
'use strict';
// Find, and with --apply re-link, every broken machine->peer link of the cluster (#415).
//
//   node scripts/cluster-relink.js            # report every link: ok / broken / offline, days left
//   node scripts/cluster-relink.js --apply    # mint a fresh token on each broken link's target and
//                                             # install it on its source - no password typed
//   node scripts/cluster-relink.js --json     # the same, machine-readable
//
// Run it on any machine whose server still has working links (one is enough when it reaches
// both ends of each broken link, directly or one hop through a peer). Its own server is used
// with a token from api-tokens.json; its peers with the tokens in cluster-tokens.json. The
// rules are lib/cluster-relink.js's; docs/CLUSTER.md says when to reach for this. No token is
// ever printed.
//
// Exit code: 0 = every reachable link works, 1 = some link is still broken, 2 = error.

const os = require('os');
const path = require('path');
const api = require('./wt-api');
const { relink } = require('../lib/cluster-relink');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');

async function request(base, token, method, route, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(base.replace(/\/+$/, '') + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (r.status === 429) { await new Promise(res => setTimeout(res, 15000)); continue; }
    return { status: r.status, body: text };
  }
  return { status: 429, body: '' };
}

(async () => {
  const cfg = api.readJson(process.env.WT_CONFIG_FILE || path.join(api.ROOT, 'config.json')) || {};
  if (!cfg.publicUrl) throw new Error('config.json has no publicUrl, so this machine cannot tell which peer entry is itself');
  const local = api.target();
  const tokensFile = process.env.WT_CLUSTER_TOKENS_FILE || path.join(api.ROOT, 'cluster-tokens.json');
  const out = await relink({
    self: { name: cfg.serverName || os.hostname(), url: cfg.publicUrl, base: local.url, token: local.token },
    selfTokens: () => api.readJson(tokensFile) || {},
    request,
    apply: APPLY,
  });
  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const a of out.actions) console.log(`${a.from} -> ${a.to}: ${a.action}${a.detail ? ` (${a.detail})` : ''}`);
    if (out.actions.length) console.log('');
    for (const l of out.links) {
      const days = l.daysLeft === null ? '' : `, ${l.daysLeft} days left${l.expiring ? ' - EXPIRING' : ''}`;
      console.log(`${l.from} -> ${l.to}: ${l.state}${days}`);
    }
    if (out.unreachable.length) console.log(`\nno view of: ${out.unreachable.join(', ')} (offline, or no working path from here)`);
    if (out.broken && !APPLY) console.log(`\n${out.broken} broken link(s); run again with --apply to re-link them.`);
  }
  process.exit(out.broken ? 1 : 0);
})().catch((e) => { console.error(`cluster-relink: ${e.message}`); process.exit(2); });
