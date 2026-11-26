'use strict';
// --- Replicating the fleet usage ledger between machines (#529) ------------------------
//
// Full mesh, gossip style. Every machine holds a copy of EVERY machine's ledger file
// (lib/usage-store.js), so no single machine's failure loses anything and any machine can
// answer a report. A machine asks each peer for its `heads` (origin -> highest seq) and, for
// every origin where the peer is ahead, pages that origin's feed from where its own copy
// stops. It is the same for the machine's OWN origin: after a disk was wiped, the first pull
// brings its own history back from whoever holds it, and new records continue after it.
//
// This file is the pure part: the pull loop over an injected `getJson(peer, path)`, and the
// two answers a machine serves (`serveHeads`, `serveFeed`). server.js owns the transport
// (the cluster token, the timeout) and the routes.
//
// Rules: a peer too old to have the routes answers 404 and is skipped quietly; a failing peer
// is skipped for this round and asked again at the next (no retry loop); a page that adds
// nothing ends that origin for the round; at most MAX_ORIGINS origins are ever held, so a peer
// cannot make this machine create files without bound.

const { isOrigin } = require('./usage-store');

const PAGE = 500;
const MAX_PAGES_PER_ORIGIN = 40;
const MAX_ORIGINS = 64;

/** What GET /api/usage/heads answers. */
function serveHeads(store, machine) {
  return { machine, origin: store.origin, heads: store.heads() };
}

/** What GET /api/usage/feed answers: `{status, body}`. */
function serveFeed(store, query) {
  const origin = query && query.origin;
  if (!isOrigin(origin)) return { status: 400, body: { error: 'origin is required (letters, digits, . _ -)' } };
  const after = query.after === undefined || query.after === '' ? 0 : Number(query.after);
  const limit = query.limit === undefined || query.limit === '' ? PAGE : Number(query.limit);
  if (!Number.isInteger(after) || after < 0) return { status: 400, body: { error: 'after must be a whole number >= 0' } };
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { status: 400, body: { error: 'limit must be a whole number from 1 to 1000' } };
  return { status: 200, body: { origin, after, head: store.head(origin), records: store.feed(origin, after, limit) } };
}

/** One pull round over [peers] (`[{name, url}]`).
 *  @param {object} o
 *  @param {object} o.store               lib/usage-store.js
 *  @param {Array<{name: string, url: string}>} o.peers
 *  @param {(peer: object, path: string) => Promise<{status: number, json: any}>} o.getJson
 *      resolves with the status and parsed body; REJECTS when the peer cannot be reached.
 *  @param {string} [o.only]              pull this origin only (the recovery pull of the machine's own)
 *  @returns {Promise<{answered: number, old: number, ownTheirs: number, pulled: number, peers: object[]}>}
 *      `answered` counts peers that answered 200 (they run this feature); `old` the 404s (an older server: it
 *      holds nothing of ours); `ownTheirs` the highest head of THIS machine's own origin a 200 peer reported. */
async function pullRound({ store, peers, getJson, only }) {
  const report = { answered: 0, old: 0, ownTheirs: 0, pulled: 0, peers: [] };
  for (const peer of peers) {
    const row = { name: peer.name, status: 'down', pulled: 0 };
    report.peers.push(row);
    let heads;
    try {
      const r = await getJson(peer, '/api/usage/heads');
      if (r.status === 404) { row.status = 'old'; row.reached = true; report.old++; continue; }
      if (r.status !== 200 || !r.json || typeof r.json.heads !== 'object' || !r.json.heads) { row.status = `http-${r.status}`; continue; }
      heads = r.json.heads;
      row.status = 'ok';
      row.reached = true;
      report.answered++;
      // our own origin as the peer spells it (file names are case-insensitive, so a peer may hold it in another case)
      const mine = Object.keys(heads).find((k) => k.toLowerCase() === store.origin.toLowerCase());
      if (mine && Number.isInteger(heads[mine])) report.ownTheirs = Math.max(report.ownTheirs, heads[mine]);
    } catch { continue; }
    for (const [origin, theirs] of Object.entries(heads)) {
      if (only && origin !== only) continue;
      if (!isOrigin(origin) || !Number.isInteger(theirs)) continue;
      if (store.head(origin) === 0 && origin !== store.origin && Object.keys(store.heads()).length >= MAX_ORIGINS) continue;
      for (let page = 0; page < MAX_PAGES_PER_ORIGIN && store.head(origin) < theirs; page++) {
        let r;
        try { r = await getJson(peer, `/api/usage/feed?origin=${encodeURIComponent(origin)}&after=${store.head(origin)}&limit=${PAGE}`); } catch { row.status = 'partial'; break; }
        if (r.status !== 200 || !r.json || !Array.isArray(r.json.records)) { row.status = `http-${r.status}`; break; }
        const n = store.appendReplica(origin, r.json.records);
        row.pulled += n; report.pulled += n;
        if (n === 0) break;
      }
    }
  }
  return report;
}

/** May this machine append to its OWN ledger (the collector, a classify)? A fork - two different records
 *  with one seq - is what must never happen, and it happens when this machine writes while a peer holds
 *  records of this machine's own that it does not (a wiped disk, a file cut at load, a recovery pull that
 *  stopped partway). So:
 *   - `behind`: a peer once reported a head of our own origin above the one we hold now - pull first, write
 *     nothing (a high-water mark: a later round with that peer unreachable does not clear it);
 *   - no peer configured: stand-alone, write;
 *   - an empty file or one that was cut at load cannot show that it is complete, so it waits until EVERY
 *     configured peer has answered at least once (200, or 404 from an older server that holds nothing of
 *     ours): any one that has not might hold the records we lack;
 *   - an intact, non-empty file goes on writing while peers are unreachable. */
function mayCollect({ ownHead, peerCount, repaired = false, behind = false, allReached = false }) {
  if (behind) return false;
  if (peerCount === 0) return true;
  if (ownHead === 0 || repaired) return allReached;
  return true;
}

module.exports = { PAGE, MAX_PAGES_PER_ORIGIN, MAX_ORIGINS, serveHeads, serveFeed, pullRound, mayCollect };
