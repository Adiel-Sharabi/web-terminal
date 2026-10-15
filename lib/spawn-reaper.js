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

/** How long after creation a viewer still makes the session a person's. */
const CLASSIFY_MS = 60 * 1000;
/** `spawnedSessionIdleCloseHours` when the config does not say. 0 (or false) disables. */
const DEFAULT_IDLE_HOURS = 6;
/** How often the server looks. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;
/** The spawner's label is display text from an untrusted caller. */
const SPAWNED_BY_MAX = 120;

const HOUR_MS = 60 * 60 * 1000;

// C0 and C1 controls, plus U+2028 / U+2029 (built from code points: a literal one in a regex
// literal is a line terminator, i.e. a syntax error).
const UNSAFE_LABEL_CHARS = new RegExp('[\x00-\x1f\x7f-\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A caller-supplied spawner label: plain text, trimmed, capped. Null when there is none.
 *  Control characters and the Unicode line/paragraph separators go, so a label can never
 *  break a log line or a one-line row; the markup characters stay, because clients render
 *  it as text and escaping is theirs to do. */
function spawnedByLabel(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(UNSAFE_LABEL_CHARS, '').trim().slice(0, SPAWNED_BY_MAX).trim();
  return s || null;
}

/** The config knob -> `{enabled, idleMs}`. `hours`: a number of hours (fractions allowed),
 *  0 or false to switch the reaper off, anything unusable (a typo, a negative) = the default.
 *  `idleMsOverride` is the test-only shortcut (server.js reads it in one place). */
function reaperConfig(hours, idleMsOverride) {
  let h = DEFAULT_IDLE_HOURS;
  if (hours === false) h = 0;
  else if (hours !== undefined && hours !== null) {
    const n = typeof hours === 'number' ? hours : Number(hours);
    if (Number.isFinite(n) && n >= 0) h = n;
  }
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

/** Is any background command still running? A task marked `stale` (the badge's own
 *  stuck-process backstop) is not running work. */
function hasLiveWork(tasks) {
  return tasks.some((t) => t && !t.stale);
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
  if (!Array.isArray(row.backgroundTasks)) return no('work-unknown');
  if (hasLiveWork(row.backgroundTasks)) return no('background-work');
  if (row.favorite) return no('favorite');
  if (!row.usageLimit || typeof row.usageLimit !== 'object') return no('no-data');
  if (row.usageLimit.waiting) return no('capped');
  const last = Math.max(
    meta.createdAt,
    finite(meta.lastViewedAt) ? meta.lastViewedAt : 0,
    finite(row.lastActivity) ? row.lastActivity : 0,
  );
  if (!(now - last >= cfg.idleMs)) return no('recent');
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
  spawnedByLabel, reaperConfig, classifySpawn, countActiveViewers, hasLiveWork, shouldClose, closeLogLine,
};
