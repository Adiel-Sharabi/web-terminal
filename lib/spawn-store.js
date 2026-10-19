'use strict';
// #351 - the state behind the spawn reaper: WHO STARTED each session this server created
// with POST /api/sessions, and when a person last looked at it. The rules that read it are
// lib/spawn-reaper.js; this is only the book-keeping, with its file injected so it can be
// driven against a scratch path (server.js gives it the real one).
//
//   { "<id>": { by: 'agent'|'human', createdAt, spawnedBy: string|null, lastViewedAt: number|null,
//               parentId: string|null } }
//
// `parentId` (#374) is the session that opened this one, when the caller named it: the clients
// draw the session as that one's child. It is recorded with the verdict, so a restart inside the
// classify window loses it along with the verdict; a hand-off successor's parent lives in the
// lineage below instead, which needs no verdict.
//
// LINEAGE (#374), under the reserved key `_lineage`: `{ "<id>": { replaces: [ids], parentId, at } }`
// for a hand-off successor - the sessions it took the place of, newest first, and the parent it
// inherited. Kept apart from the verdict because a successor gets one only from an agent-started
// predecessor (successorVerdict), while every successor replaces someone and keeps its parent.
// `replaces` is what lets a helper that named the OLD id (on any machine) still find its parent:
// the clients treat a replaced id as an alias of the session that replaced it.
//
// A session is PENDING (memory only) from creation until its classify window has passed or an
// active viewer has attached. Pending is deliberately never written: a restart inside the
// window leaves the session with NO verdict, which the reaper never closes - the fail-safe
// direction. Same shape as favorites.json: a small gitignored file beside server.js, keyed by
// session id, pruned when the session goes.

const fs = require('fs');
const R = require('./spawn-reaper');

/** The longest hand-off chain a successor remembers. */
const LINEAGE_MAX = 8;

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
  /** id -> { replaces: string[], parentId: string|null, at: number } (see LINEAGE above) */
  let lineage = {};
  /** id -> { createdAt, spawnedBy, parentId, firstViewedAt, lastViewedAt } */
  const pending = new Map();

  function load() {
    if (spawned) return spawned;
    spawned = {};
    lineage = {};
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: nothing recorded yet */ }
    if (raw === null) return spawned;
    try {
      const j = JSON.parse(raw);
      const lin = j && typeof j === 'object' && j._lineage && typeof j._lineage === 'object' ? j._lineage : {};
      for (const [id, l] of Object.entries(lin)) {
        if (!isId(id) || !l || !Array.isArray(l.replaces)) continue;
        const replaces = l.replaces.filter((r) => typeof r === 'string' && isId(r) && r !== id).slice(0, LINEAGE_MAX);
        if (!replaces.length) continue;
        const parentId = R.cleanParentId(l.parentId);
        lineage[id] = { replaces, parentId: parentId === id ? null : parentId, at: Number.isFinite(l.at) ? l.at : 0 };
      }
      for (const [id, m] of Object.entries(j && typeof j === 'object' ? j : {})) {
        // An entry that is not a clean verdict is dropped: that session becomes `unknown`,
        // which is never closed.
        if (isId(id) && m && (m.by === 'agent' || m.by === 'human') && Number.isFinite(m.createdAt)) {
          spawned[id] = {
            by: m.by, createdAt: m.createdAt,
            spawnedBy: R.spawnedByLabel(m.spawnedBy),
            lastViewedAt: Number.isFinite(m.lastViewedAt) ? m.lastViewedAt : null,
            parentId: R.cleanParentId(m.parentId),
          };
        }
      }
    } catch (e) { log(`spawned-sessions unreadable, ignoring it: ${e.message}`); }
    return spawned;
  }

  function write() {
    try {
      const tmp = `${file}.tmp`;
      const all = load();
      fs.writeFileSync(tmp, JSON.stringify(Object.keys(lineage).length ? { ...all, _lineage: lineage } : all, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { log(`spawned-sessions write failed: ${e.message}`); }
  }

  /** POST /api/sessions made [id]: start its classify window. [parentId] is the session that
   *  asked for it (#374), already checked by the route; a session is never its own parent. */
  function created(id, spawnedBy, parentId = null) {
    const parent = R.cleanParentId(parentId);
    pending.set(id, {
      createdAt: now(), spawnedBy: R.spawnedByLabel(spawnedBy), parentId: parent === id ? null : parent,
      firstViewedAt: null, lastViewedAt: null,
    });
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
   *  `{by:'pending'|'agent'|'human', createdAt, spawnedBy, lastViewedAt, parentId}` or null (no verdict). */
  function metaOf(id, at = now()) {
    const p = pending.get(id);
    if (p) {
      const by = R.classifySpawn({ createdAt: p.createdAt, firstViewedAt: p.firstViewedAt, now: at, classifyMs });
      if (by === 'pending') return { by, createdAt: p.createdAt, spawnedBy: p.spawnedBy, lastViewedAt: p.lastViewedAt, parentId: p.parentId };
      pending.delete(id);
      if (by === 'unknown') return null;
      load()[id] = { by, createdAt: p.createdAt, spawnedBy: p.spawnedBy, lastViewedAt: p.lastViewedAt, parentId: p.parentId };
      write();
    }
    return load()[id] || null;
  }

  /** The `spawn` field on a session row: additive, null for a session with neither a verdict
   *  nor a lineage. `by` is null for a successor that replaced someone but has no verdict. */
  function field(id) {
    const m = metaOf(id);
    const l = lineage[id];
    if (!m && !l) return null;
    return {
      by: m ? m.by : null,
      spawnedBy: m ? m.spawnedBy : null,
      createdAt: m ? m.createdAt : null,
      parentId: (m && m.parentId) || (l && l.parentId) || null,
      replaces: l ? l.replaces : [],
    };
  }

  /** #377 - [parentId] was found AFTER [id] was recorded (traced from the calling process),
   *  so the record is written at once and the parent joins it when the trace answers. Fills
   *  only an empty parent: a parent the caller named, or one already set, is never replaced. */
  function setParent(id, parentId) {
    const parent = R.cleanParentId(parentId);
    if (!parent || parent === id) return false;
    const p = pending.get(id);
    if (p) {
      if (p.parentId) return false;
      p.parentId = parent;
      return true;
    }
    const m = load()[id];
    if (!m || m.parentId) return false;
    m.parentId = parent;
    write();
    return true;
  }

  /** [toId] was made FOR [fromId] (a hand-off successor): an agent-started session's successor
   *  is agent-started too, clock starting now. Anything else gives no verdict, as before. Either
   *  way it REPLACES [fromId] and keeps its parent (#374), so the tree survives a hand-off at
   *  both ends - a helper handed off stays under its parent, and a parent handed off keeps its
   *  helpers, which still name the old id. */
  function inherit(fromId, toId) {
    const meta = metaOf(fromId);
    load();
    const prev = lineage[fromId];
    const parentId = (meta && meta.parentId) || (prev && prev.parentId) || null;
    lineage[toId] = {
      replaces: [fromId, ...(prev ? prev.replaces : [])].filter((r) => r !== toId).slice(0, LINEAGE_MAX),
      parentId: parentId === toId ? null : parentId,
      at: now(),
    };
    const v = R.successorVerdict(meta, now());
    if (v) spawned[toId] = v;
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
    let dirty = false;
    if (Object.prototype.hasOwnProperty.call(load(), id)) { delete load()[id]; dirty = true; }
    if (Object.prototype.hasOwnProperty.call(lineage, id)) { delete lineage[id]; dirty = true; }
    if (dirty) write();
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
    for (const [id, l] of Object.entries(lineage)) {
      if (!liveIds.has(id) && l.at < listedAt) { delete lineage[id]; dirty = true; }
    }
    if (dirty) write();
  }

  return { created, setParent, noteViewed, metaOf, field, inherit, shift, forget, prune, load };
}

module.exports = { createSpawnStore };
