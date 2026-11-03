'use strict';
// The one way a script in scripts/ reaches a web-terminal server: which url, which bearer
// token, one JSON call. Used by wt-maintenance.js (#359) and wt-lease.js (#412).
//
// target(want): `want` is a cluster peer's URL or its name in cluster-tokens.json (that
// peer's bearer token is used); without it, this machine's own server, with the newest
// unexpired token from its api-tokens.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** { url, token } for [want] (a peer url or name), or for this machine. */
function target(want) {
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

/** One call. -> { status, json } (json is {} when the body was not JSON). */
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

module.exports = { ROOT, readJson, target, call };
