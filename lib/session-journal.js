'use strict';
// --- #466 The sessions journal (docs/SUPERVISOR-DESIGN.md §6b) -----------------------
//
// Every server appends one line per LIFECYCLE event of its own sessions to its own
// `sessions-journal.jsonl` (server.js owns the file; lib/work-item-log.js the append):
//
//   opened    a session was created: by POST /api/sessions, as a hand-off successor, or
//             by an import. Who asked (spawnedBy / parentId) and what for (goal).
//   hand-off  a session's successor was created: `id` hands its work to `to`.
//   closed    a session ended, and WHY (lib/work-items.js endEvent: closed, reaped,
//             handed-off, exited, lost), with the last thing it reported.
//
// The lead (lib/supervisor.js, on the lease authority) merges every server's lines into
// one entry per session, so a session that lived for less than a minute between two polls
// is still recorded. This file owns the record shapes and the fold; it never reads a file.
//
// Pure: no I/O, no clock (every function takes `at`/`now`).

const { clipAtWord } = require('./clip-text');
const { spawnedByLabel } = require('./spawn-reaper');

const VERSION = 1;
const EVENTS = Object.freeze(['opened', 'hand-off', 'closed']);
const LIMITS = Object.freeze({ name: 100, cwd: 260, goal: 300, spawnedBy: 80, headline: 160, did: 300, items: 6, what: 80 });
/** How many events one GET /api/journal answer carries at most. */
const PAGE_MAX = 1000;
/** Journal file size before it rotates (one older generation is kept). */
const MAX_BYTES = 2 * 1024 * 1024;

const _str = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);
const _id = (s) => (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s) ? s.toLowerCase() : null);

/// `opened`. [via] says which path created it: 'api' (POST /api/sessions), 'hand-off', 'import',
/// 'supervisor' (#468: the server started its own dispatcher session).
function openedRecord({ id, at, via, name, cwd, agent, spawnedBy, parentId, goal, replaces }) {
  return {
    v: VERSION, event: 'opened', at, id, via: ['api', 'hand-off', 'import', 'supervisor'].includes(via) ? via : 'api',
    name: _str(name, LIMITS.name), cwd: _str(cwd, LIMITS.cwd), agent: _str(agent, 20),
    spawnedBy: _str(spawnedByLabel(spawnedBy), LIMITS.spawnedBy), parentId: _id(parentId),
    goal: _str(goal, LIMITS.goal),
    ...(Array.isArray(replaces) && replaces.length ? { replaces: replaces.map(_id).filter(Boolean).slice(0, 8) } : {}),
  };
}

/// `hand-off`: [id] handed its work to the new session [to]. [trigger] is the server's own
/// (`auto` / `manual`) or `agent` (#472: the session opened its successor itself).
function handoffRecord({ id, to, at, trigger }) {
  return { v: VERSION, event: 'hand-off', at, id, to: _id(to), trigger: ['auto', 'agent', 'supervisor'].includes(trigger) ? trigger : 'manual' };
}

/// `closed`. [why] is lib/work-items.js endEvent's answer. [brief] is a buildBrief() of the
/// session's dashboard entry (or null): the journal keeps what it last said it was doing.
/// [by] is the #351 verdict ('agent' | 'human' | null), read before the store forgets it.
function closedRecord({ id, at, endedAt, why, name, brief, by, successorId }) {
  const b = brief || {};
  const items = Array.isArray(b.items) ? b.items.slice(0, LIMITS.items).map((i) => ({ ref: _str(i.ref, 60), state: _str(i.state, 20) })) : [];
  const w = b.wait && typeof b.wait.on === 'string' ? { on: b.wait.on, what: _str(b.wait.what, LIMITS.what) || '' } : null;
  return {
    v: VERSION, event: 'closed', at, id, why: _str(why, 20) || 'exited',
    name: _str(name, LIMITS.name), by: by === 'agent' || by === 'human' ? by : null,
    headline: _str(b.headline, LIMITS.headline),
    did: typeof b.did === 'string' && b.did ? clipAtWord(b.did, LIMITS.did) : null,
    items, wait: w, successorId: _id(successorId),
    // When it ENDED, when that is earlier than when the line was written (a session lost while
    // the server was down). `at` stays the write time: a reader's cursor runs on `at`.
    ...(Number.isFinite(endedAt) && endedAt < at ? { endedAt } : {}),
  };
}

/// Lines worth keeping from a journal read (a peer's answer included): known events with an
/// id and a time, each REBUILT by its own record builder, so a peer's line carries only the
/// fields and lengths this server would have written (validated, never trusted verbatim - the
/// #152 rule for everything a peer hands us). Anything else is dropped, never repaired.
function cleanEvents(lines) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || typeof l !== 'object' || !EVENTS.includes(l.event) || !_id(l.id) || !Number.isFinite(l.at)) continue;
    const id = _id(l.id);
    if (l.event === 'opened') out.push(openedRecord({ ...l, id }));
    else if (l.event === 'hand-off') out.push(handoffRecord({ ...l, id }));
    else {
      out.push(closedRecord({ id, at: l.at, endedAt: l.endedAt, why: l.why, name: l.name, by: l.by, successorId: l.successorId,
        brief: { headline: l.headline, did: l.did, items: Array.isArray(l.items) ? l.items.filter((i) => i && typeof i === 'object') : [], wait: l.wait } }));
    }
  }
  return out;
}

/// The events after [since] (exclusive), oldest first, at most [limit]. `more` says the page
/// was cut: the caller asks again from the last one's `at`. Events at the cut's exact `at`
/// are never split across pages, so asking "after the last at" loses none.
function pageAfter(lines, since, limit = PAGE_MAX) {
  const s = Number.isFinite(since) ? since : -Infinity;
  const all = cleanEvents(lines).filter((l) => l.at > s).sort((a, b) => a.at - b.at);
  const n = Math.max(1, Math.min(PAGE_MAX, Number.isFinite(limit) ? Math.floor(limit) : PAGE_MAX));
  if (all.length <= n) return { events: all, more: false };
  let cut = n;
  while (cut > 0 && all[cut].at === all[cut - 1].at) cut--;
  if (cut === 0) { cut = n; while (cut < all.length && all[cut].at === all[cut - 1].at) cut++; }
  return { events: all.slice(0, cut), more: true };
}

/// How many pages of a peer's journal one supervisor poll reads (a first poll reads 30 days).
const PEER_PAGES = 5;

/// Read a peer's journal from [cursor] (the last `at` already read; null = never read, start at
/// [fromMs]). [fetchPage](since) resolves `{ ok, status, body }` for GET /api/journal?since=.
/// Each page starts AT the cursor's millisecond, not after it: a line written in that same
/// millisecond after the last read would otherwise never be fetched (mergeEvents dedupes).
/// Reads at most [pages] pages, and only while the page says `more` and the cursor moved -
/// so it cannot spin on a page that ends where it began. Resolves
/// `{ events, cursor, status }`: every cleaned event read, once (oldest first), the cursor to keep,
/// and 'ok' | 'HTTP <n>' | 'unreachable'. What was read before a failure is kept.
async function readPeerJournal({ cursor, fromMs, fetchPage, pages = PEER_PAGES }) {
  let cur = Number.isFinite(cursor) ? cursor : null;
  let events = [];
  let status = null;
  try {
    for (let n = 0; n < pages; n++) {
      const since = cur !== null ? cur : fromMs;
      const r = await fetchPage(since - 1);
      if (!r || !r.ok) { status = `HTTP ${r ? r.status : '?'}`; break; }
      const page = JSON.parse(r.body);
      const got = cleanEvents(page && page.events);
      status = 'ok';
      if (!got.length) { if (cur === null) cur = since; break; }
      events = mergeEvents(events, got);
      const next = got[got.length - 1].at;
      const moved = cur === null || next > cur;
      cur = next;
      if (!(page && page.more) || !moved) break;
    }
  } catch { status = 'unreachable'; }
  return { events, cursor: cur, status };
}

/// Fold every machine's events into one entry per session, newest-opened first.
/// [byMachine]: `{ <machine>: events[] }`. A session is keyed by machine AND id: an id is a
/// UUID, but the key says where to find it. An entry whose `opened` is older than what was
/// kept still gets one from its later events (`openedAt` null).
function foldJournal(byMachine) {
  const out = new Map();
  const entryFor = (machine, id) => {
    const key = `${machine}|${id}`;
    let e = out.get(key);
    if (!e) {
      e = { key, id, machine, name: null, cwd: null, agent: null, via: null, openedAt: null, closedAt: null,
        why: null, by: null, spawnedBy: null, parentId: null, goal: null, replaces: [], successorId: null,
        headline: null, did: null, items: [], wait: null };
      out.set(key, e);
    }
    return e;
  };
  for (const [machine, events] of Object.entries(byMachine || {})) {
    for (const ev of cleanEvents(events).sort((a, b) => a.at - b.at)) {
      const e = entryFor(machine, ev.id.toLowerCase());
      if (ev.event === 'opened') {
        Object.assign(e, {
          openedAt: ev.at, via: ev.via || null, name: ev.name || e.name, cwd: ev.cwd || e.cwd, agent: ev.agent || e.agent,
          spawnedBy: ev.spawnedBy || null, parentId: ev.parentId || null, goal: ev.goal || null,
          replaces: Array.isArray(ev.replaces) ? ev.replaces : [],
        });
      } else if (ev.event === 'hand-off') {
        e.successorId = ev.to || e.successorId;
      } else {
        Object.assign(e, {
          closedAt: Number.isFinite(ev.endedAt) ? ev.endedAt : ev.at, why: ev.why, name: ev.name || e.name, by: ev.by || e.by,
          headline: ev.headline || null, did: ev.did || null, items: ev.items || [], wait: ev.wait || null,
          successorId: ev.successorId || e.successorId,
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => (b.openedAt || b.closedAt || 0) - (a.openedAt || a.closedAt || 0));
}

/// [old] plus [fresh] with every line kept once (a page re-read from the last millisecond
/// repeats lines). Order kept: oldest first.
function mergeEvents(old, fresh) {
  const key = (e) => `${e.event}|${e.id}|${e.at}`;
  const seen = new Set((old || []).map(key));
  const out = [...(old || [])];
  for (const e of fresh || []) { const k = key(e); if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out.sort((a, b) => a.at - b.at);
}

/// Events kept in memory per machine by the lead: the newest [max], none older than [keepMs].
function trimEvents(events, now, { max = 5000, keepMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const fresh = cleanEvents(events).filter((l) => now - l.at <= keepMs);
  return fresh.length > max ? fresh.slice(fresh.length - max) : fresh;
}

module.exports = {
  VERSION, EVENTS, LIMITS, PAGE_MAX, MAX_BYTES, PEER_PAGES,
  openedRecord, handoffRecord, closedRecord, cleanEvents, pageAfter, readPeerJournal, foldJournal, mergeEvents, trimEvents,
};
