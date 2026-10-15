'use strict';
// #351 - the state behind the spawn reaper: WHO STARTED each session this server created
// with POST /api/sessions, and when a person last looked at it. The rules that read it are
// lib/spawn-reaper.js; this is only the book-keeping, with its file injected so it can be
// driven against a scratch path (server.js gives it the real one).
//
//   { "<id>": { by: 'agent'|'human', createdAt, spawnedBy: string|null, lastViewedAt: number|null } }
//
// A session is PENDING (memory only) from creation until its classify window has passed or an
// active viewer has attached. Pending is deliberately never written: a restart inside the
// window leaves the session with NO verdict, which the reaper never closes - the fail-safe
// direction. Same shape as favorites.json: a small gitignored file beside server.js, keyed by
// session id, pruned when the session goes.

const fs = require('fs');
const R = require('./spawn-reaper');

/**
 * @param {object} o
 * @param {string} o.file         where verdicts persist
 * @param {number} [o.classifyMs] the window in which an active viewer makes a session a person's
 * @param {(id:string)=>boolean} [o.isId] accepts a session id as a key (a UUID in production)
 * @param {()=>number} [o.now]
 * @param {(msg:string)=>void} [o.log]
 */
function createSpawnStore({ file, classifyMs = R.CLASSIFY_MS, isId = () => true, now = Date.now, log = console.error }) {
  let spawned = null;
  /** id -> { createdAt, spawnedBy, firstViewedAt, lastViewedAt } */
  const pending = new Map();

  function load() {
    if (spawned) return spawned;
    spawned = {};
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: nothing recorded yet */ }
    if (raw === null) return spawned;
    try {
      const j = JSON.parse(raw);
      for (const [id, m] of Object.entries(j && typeof j === 'object' ? j : {})) {
        // An entry that is not a clean verdict is dropped: that session becomes `unknown`,
        // which is never closed.
        if (isId(id) && m && (m.by === 'agent' || m.by === 'human') && Number.isFinite(m.createdAt)) {
          spawned[id] = {
            by: m.by, createdAt: m.createdAt,
            spawnedBy: R.spawnedByLabel(m.spawnedBy),
            lastViewedAt: Number.isFinite(m.lastViewedAt) ? m.lastViewedAt : null,
          };
        }
      }
    } catch (e) { log(`spawned-sessions unreadable, ignoring it: ${e.message}`); }
    return spawned;
  }

  function write() {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { log(`spawned-sessions write failed: ${e.message}`); }
  }

  /** POST /api/sessions made [id]: start its classify window. */
  function created(id, spawnedBy) {
    pending.set(id, { createdAt: now(), spawnedBy: R.spawnedByLabel(spawnedBy), firstViewedAt: null, lastViewedAt: null });
  }

  /** An ACTIVE viewer is, or just stopped being, on [id]: it counts as viewed now. Called the
   *  moment the viewer's `active` frame ARRIVES - not when the worker attach it queued behind
   *  completes, which on a slow companion is tens of seconds into the window. */
  function noteViewed(id) {
    const t = now();
    const p = pending.get(id);
    if (p) { if (p.firstViewedAt === null) p.firstViewedAt = t; p.lastViewedAt = t; return; }
    const m = load()[id];
    // Only an agent-started session's clock is ever read, so only its writes are worth a disk write.
    if (m && m.by === 'agent') { m.lastViewedAt = t; write(); }
  }

  /** The verdict for [id], promoting a pending one to disk once its window has decided it.
   *  `{by:'pending'|'agent'|'human', createdAt, spawnedBy, lastViewedAt}` or null (no verdict). */
  function metaOf(id, at = now()) {
    const p = pending.get(id);
    if (p) {
      const by = R.classifySpawn({ createdAt: p.createdAt, firstViewedAt: p.firstViewedAt, now: at, classifyMs });
      if (by === 'pending') return { by, createdAt: p.createdAt, spawnedBy: p.spawnedBy, lastViewedAt: p.lastViewedAt };
      pending.delete(id);
      if (by === 'unknown') return null;
      load()[id] = { by, createdAt: p.createdAt, spawnedBy: p.spawnedBy, lastViewedAt: p.lastViewedAt };
      write();
    }
    return load()[id] || null;
  }

  /** The `spawn` field on a session row: additive, null for a session with no verdict. */
  function field(id) {
    const m = metaOf(id);
    return m ? { by: m.by, spawnedBy: m.spawnedBy, createdAt: m.createdAt } : null;
  }

  /** [toId] was made FOR [fromId] (a hand-off successor): an agent-started session's successor
   *  is agent-started too, clock starting now. Anything else gives no verdict, as before. */
  function inherit(fromId, toId) {
    const v = R.successorVerdict(metaOf(fromId), now());
    if (!v) return null;
    load()[toId] = v;
    write();
    return v;
  }

  /** TEST LEVER (server.js exposes it only under WT_TEST): move [id]'s verdict clock back by [ms]
   *  - creation, first view, last view - as if that much time had passed since each. A spec that
   *  needs "past the classify window" or "idle for hours" says so instead of sleeping for it: a
   *  wall-clock bet loses on a host whose processes stall for seconds. Returns false when [id]
   *  has no verdict to move. */
  function shift(id, ms) {
    if (!Number.isFinite(ms)) return false;
    const back = (v) => (Number.isFinite(v) ? v - ms : v);
    const p = pending.get(id);
    if (p) {
      p.createdAt = back(p.createdAt); p.firstViewedAt = back(p.firstViewedAt); p.lastViewedAt = back(p.lastViewedAt);
      return true;
    }
    const m = load()[id];
    if (!m) return false;
    m.createdAt = back(m.createdAt); m.lastViewedAt = back(m.lastViewedAt);
    write();
    return true;
  }

  /** The session is gone. */
  function forget(id) {
    pending.delete(id);
    if (Object.prototype.hasOwnProperty.call(load(), id)) { delete load()[id]; write(); }
  }

  /** Drop verdicts for sessions the worker no longer lists (ended while we were down). Only
   *  entries made BEFORE [listedAt] can be judged by that list: a session created after it
   *  was fetched is simply not in it. */
  function prune(liveIds, listedAt) {
    const all = load();
    let dirty = false;
    for (const [id, m] of Object.entries(all)) {
      if (!liveIds.has(id) && m.createdAt < listedAt) { delete all[id]; dirty = true; }
    }
    if (dirty) write();
  }

  return { created, noteViewed, metaOf, field, inherit, shift, forget, prune, load };
}

module.exports = { createSpawnStore };
