'use strict';
// #351 - an agent in one session creates helper sessions with POST /api/sessions
// (often on a cluster peer) and never closes them. Every machine has a session cap, and an
// orphan held a slot for 21 hours. The owner's rule: close an AGENT-STARTED session once its
// turn has ended and nobody has looked at it for hours.
//
// ## Who started it is decided by BEHAVIOUR, not by credentials
//
// Auth mode cannot tell a person from an agent: the companion app uses `Authorization:
// Bearer`, the cluster proxy forwards Bearer, and an agent in a session uses Bearer too.
// What does differ is what happens next. A person who creates a session opens it at once;
// an agent's API call never does. So a session created by POST here is `agent`-started
// unless an ACTIVE viewer (lib/terminal-size.js isActiveViewer - a background socket is a
// phone in a pocket, not a person) attaches within CLASSIFY_MS of creation.
//
// A session this server did not create through that POST (restored, pre-existing, created
// before a restart that landed inside the window) has no verdict at all - `unknown` - and
// is NEVER closed. Every gate below fails CLOSED for the same reason: a wrong close ends a
// person's work, a wrong keep costs one slot until the next sweep.
//
// This module is the pure rule. server.js owns the sockets, the state file and the kill.

const { isActiveViewer } = require('./terminal-size');

/** How long after creation a viewer still makes the session a person's. Generous on purpose: the
 *  companion refreshes its list (up to 20 s) and reads scrollback (up to 20 s) before it declares
 *  itself active, and a person who is slow to open a session must not be mistaken for an agent. */
const CLASSIFY_MS = 120 * 1000;
/** `spawnedSessionIdleCloseHours` when the config does not say. 0 disables. */
const DEFAULT_IDLE_HOURS = 6;
/** How often the server looks. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;
/** The spawner's label is display text from an untrusted caller. */
const SPAWNED_BY_MAX = 120;

const HOUR_MS = 60 * 60 * 1000;

// Code-point ranges a label may not contain: C0/C1 controls, soft hyphen, the Arabic letter mark,
// the Mongolian vowel separator, zero-width and directional marks (U+200B-200F), line and
// paragraph separators with the bidi embeddings and overrides (U+2028-202E), word joiner and
// invisible operators (U+2060-2064), bidi isolates (U+2066-2069) and the BOM / zero-width
// no-break space. Ranges rather than a regex: a literal U+2028 in a regex literal is a syntax error.
const UNSAFE_LABEL_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const isUnsafeLabelChar = (ch) => {
  const cp = ch.codePointAt(0);
  return UNSAFE_LABEL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A caller-supplied spawner label: plain text, trimmed, capped at SPAWNED_BY_MAX CODE POINTS.
 *  Null when there is none. Control, bidi and zero-width characters go, so a label can never
 *  break a log line or a one-line row, nor reorder or hide the text around it in a client; the
 *  markup characters stay, because clients render it as text and escaping is theirs to do. */
function spawnedByLabel(raw) {
  if (typeof raw !== 'string') return null;
  const kept = Array.from(raw).filter((ch) => !isUnsafeLabelChar(ch)).join('').trim();
  const s = Array.from(kept).slice(0, SPAWNED_BY_MAX).join('').trim();
  return s || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** #374 - the session that opened this one, as the caller named it (`parentId` on POST
 *  /api/sessions: the caller's own `$WT_SESSION_ID`). `{ok:true, id:null}` when none was named
 *  (absent, null, ''); `{ok:true, id}` for a session id, lower-cased; `{ok:false}` for anything
 *  else, which the route refuses rather than dropping - a typo would otherwise lose the link
 *  with nothing said. Display data only: the parent may live on another machine, so it is
 *  never looked up here. */
function parentIdOf(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, id: null };
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return { ok: false };
  return { ok: true, id: raw.toLowerCase() };
}

/** A stored parent id, re-checked on the way in: a clean id or null, never junk. */
const cleanParentId = (raw) => parentIdOf(raw).id || null;

/** The config knob -> `{enabled, idleMs}`. `hours` must be a finite number >= 0 (fractions allowed);
 *  0 switches the reaper off. ANYTHING else - a string, `true`, `''`, an array, a negative, NaN,
 *  absent - is the default, so a typo can neither disable it silently nor arm it oddly.
 *  `idleMsOverride` is the test-only shortcut (server.js reads it in one place). */
function reaperConfig(hours, idleMsOverride) {
  const h = finite(hours) && hours >= 0 ? hours : DEFAULT_IDLE_HOURS;
  if (!(h > 0)) return { enabled: false, idleMs: 0 };
  const idleMs = finite(idleMsOverride) && idleMsOverride > 0 ? idleMsOverride : h * HOUR_MS;
  return { enabled: true, idleMs };
}

/**
 * What a session created by POST here is, given when it was created, when an ACTIVE viewer
 * first attached (null = never), and what time it is now.
 *
 *   'human'    - a viewer attached inside the window
 *   'pending'  - the window is still open and nobody has attached yet
 *   'agent'    - the window closed with nobody attached
 *   'unknown'  - no usable creation time
 *
 * The window is [createdAt, createdAt + classifyMs): a first view is judged by WHEN IT
 * HAPPENED, not by when this function is asked, so a lazy caller (a list, a sweep) gets
 * the same answer an eager timer would have.
 */
function classifySpawn({ createdAt, firstViewedAt, now, classifyMs = CLASSIFY_MS }) {
  if (!finite(createdAt)) return 'unknown';
  if (finite(firstViewedAt) && firstViewedAt - createdAt < classifyMs) return 'human';
  if (finite(now) && now - createdAt < classifyMs) return 'pending';
  return 'agent';
}

/** How many of [viewers] (`{background}` each, as terminal-size reads them) are active. */
function countActiveViewers(viewers) {
  let n = 0;
  for (const v of viewers || []) if (isActiveViewer(v)) n++;
  return n;
}

/** Is anything still running? Every entry counts: the reaper reads the raw, un-aged lists
 *  (server.js reaperRunningWork), because an age cutoff that equals the idle threshold (both
 *  6 hours) would make this gate dead exactly when it matters. */
function hasLiveWork(tasks) {
  return tasks.length > 0;
}

/** Fold the two sources of "work is running" into the one list the rule reads. Each is an
 *  array (known: maybe empty) or null (UNKNOWN: the read failed or could not be taken). Known
 *  work wins over an unknown source; otherwise any unknown makes the whole answer unknown, and
 *  the rule keeps the session. Only when BOTH are known empty is the answer "nothing running". */
function combineWork(tasks, shells) {
  const t = Array.isArray(tasks) ? tasks : null;
  const s = Array.isArray(shells) ? shells : null;
  const found = [...(t || []), ...(s || [])];
  if (found.length) return found;
  return t && s ? [] : null;
}

/** Is [msg] a viewer declaring itself ACTIVE (the `{"mode":"active"}` frame)? Pure and total:
 *  anything that is not exactly that - another mode, other JSON, binary, a keystroke - is false. */
function isActiveModeFrame(msg) {
  const text = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg;
  if (typeof text !== 'string' || text.length > 2048 || !text.startsWith('{"mode":')) return false;
  try { return JSON.parse(text).mode === 'active'; } catch { return false; }
}

/** The verdict a hand-off successor is born with: an agent-started session's successor is
 *  agent-started too (spawner carried over, clock from [now]); a person's or an unknown
 *  session's gives none, as before. Null in, null out. */
function successorVerdict(meta, now) {
  if (!meta || meta.by !== 'agent' || !finite(now)) return null;
  return { by: 'agent', createdAt: now, spawnedBy: spawnedByLabel(meta.spawnedBy), lastViewedAt: null };
}

/**
 * Should the reaper close this session now?
 *
 * @param row  the session as the server sees it: the worker's fields (`status`,
 *   `compacting`, `lastActivity`) plus `activeViewers` (count), `favorite`, `usageLimit`
 *   and `backgroundTasks`, built by the same helpers the session lists use.
 * @param meta the persisted verdict `{by, createdAt, lastViewedAt}` or null
 * @param cfg  reaperConfig()
 * @returns {{close:boolean, why:string}} `why` names the gate that said no, or 'idle'.
 *
 * Output keeps a session open for as long as it comes: `lastActivity` is bumped by every
 * PTY write, so a build streaming into a helper session holds it, whoever started it.
 */
function shouldClose(row, meta, now, cfg) {
  const no = (why) => ({ close: false, why });
  if (!cfg || !cfg.enabled) return no('disabled');
  if (!meta) return no('unknown');
  if (meta.by === 'human') return no('human');
  if (meta.by !== 'agent') return no('unknown');
  if (!row || !finite(now) || !finite(meta.createdAt)) return no('no-data');
  // Fail CLOSED: a row that did not say how many people are looking is not an empty room.
  if (!finite(row.activeViewers) || row.activeViewers > 0) return no('viewer');
  if (row.status === 'working') return no('working');
  if (row.status === 'waiting') return no('waiting');
  if (row.compacting) return no('compacting');
  // Before the read-dependent gates: inside its idle window a session is "recent" whatever
  // a read said - a fresh server has no process snapshot yet, which is not a reason to name.
  const last = Math.max(
    meta.createdAt,
    finite(meta.lastViewedAt) ? meta.lastViewedAt : 0,
    finite(row.lastActivity) ? row.lastActivity : 0,
  );
  if (!(now - last >= cfg.idleMs)) return no('recent');
  // Fail CLOSED, twice: a read that failed (null) is not an empty list, and neither is a missing one.
  if (!Array.isArray(row.backgroundTasks)) return no('work-unknown');
  if (hasLiveWork(row.backgroundTasks)) return no('background-work');
  if (row.favorite) return no('favorite');
  if (!row.usageLimit || typeof row.usageLimit !== 'object') return no('usage-unknown');
  if (row.usageLimit.waiting) return no('capped');
  return { close: true, why: 'idle', idleMs: now - last };
}

/** The log line for one close (server.js prints it). */
function closeLogLine({ name, id, spawnedBy, idleMs }) {
  const by = spawnedBy ? `, by "${spawnedBy}"` : '';
  const h = Math.round((idleMs / HOUR_MS) * 10) / 10;
  return `spawn-reaper: closed "${name}" (${id}) - agent-started${by}, idle ${h}h`;
}

module.exports = {
  CLASSIFY_MS, DEFAULT_IDLE_HOURS, SWEEP_EVERY_MS, SPAWNED_BY_MAX,
  spawnedByLabel, parentIdOf, cleanParentId, reaperConfig, classifySpawn, countActiveViewers, hasLiveWork, combineWork,
  isActiveModeFrame, successorVerdict, shouldClose, closeLogLine,
};
