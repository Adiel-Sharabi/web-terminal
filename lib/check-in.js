'use strict';
// --- Check in on a session whose self-wait nothing can keep (#443) ------------------
//
// A session that reported "I will resume on my own" (wait: self) can lose the thing
// that was meant to wake it - a background shell, a Monitor, a wake-up, a child session -
// to a restart, a compaction, or a watcher that never existed. It then sits idle for hours
// with work still to do, and from the list it looks exactly like a session that finished.
//
// Milestone 1 made `backgroundTasks` count every waker, so #437's isStaleSelf
// (lib/handoff.js) now means "nothing alive can wake this session". This module asks such
// a session, ONCE per idle period, whether it is finished or should resume. The answer is
// STATE, not prose: the next wait the session reports (done / self with a live waker /
// you / external), read off its brief after the check-in's own turn ends.
//
// This file owns every RULE: when a check-in may be typed, the prompt, what counts as
// delivery and as the answer, and the field the session row publishes. server.js owns
// the I/O (the scan, the PTY write, the store, the log). Pure: no I/O, every clock is
// `now`. The timer lives in server.js, beside the hand-off's, so nothing here needs the
// worker and a deploy is a hot reload.

const { isStaleSelf, isActive, turnEndedAt, handoffConfig } = require('./handoff');
const { CHECKIN_PROMPT_TAG: TAG } = require('./user-turn');

const DEFAULTS = Object.freeze({
  // How long AFTER the session became stale (idle `handoff.staleSelfMin`, default 30,
  // with a reported self-wait and nothing alive) the check-in goes out. So the default
  // asks at 90 min idle. The reasoning (docs/findings/agents-codex.md #443): every waker
  // is now live work, so a stale-self has nothing that can wake it and every minute is
  // lost; but each check-in re-reads the whole context (~350k tokens on a big session),
  // and liveness still has blind spots (a child on another machine), so it is not asked
  // the moment it goes stale. The owner's own nudges came after a median of 2.6-6 h.
  afterMin: 60,
  // #456 - the backstop: a reported self-wait idle this long is asked EVEN WITH live work.
  // Live work is a process or a launch with no end yet, not proof it will ever wake the
  // session: a watcher whose filter swallows every event runs forever (7.5 h on 2026-11-09).
  // Legitimate waits reach 2.6-5.8 h at p90, so this asks some of them - one turn, and they
  // answer "self" - against hours lost when the waker is blind. Owner's choice: 3 h.
  withLiveWorkMin: 180,
  // How often the server looks. At most ONE check-in per scan, so a fleet that comes
  // back from an outage with many stale sessions is asked one a minute, not all at once.
  everyMs: 60 * 1000,
  // Never while someone is at the keyboard: keystrokes reach the PTY with no hook, so a
  // half-typed line is invisible to every other gate and would be submitted WITH the
  // check-in (the hand-off's 'typing' rule, #345).
  typingQuietMin: 10,
  // A check-in that started no turn within this is reported as not delivered.
  deliverMs: 3 * 60 * 1000,
  // Delivered, then idle with no Stop for this long: interrupted (an Esc).
  interruptGraceMs: 30 * 1000,
});

/// `liveConfig('checkIn')` over the defaults. Default ON (the owner's call); `enabled:
/// false` is the fleet off switch. Bad values fall back to the default.
function checkInConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (k) => (typeof c[k] === 'number' && Number.isFinite(c[k]) && c[k] > 0 ? c[k] : DEFAULTS[k]);
  return { enabled: c.enabled !== false, afterMin: num('afterMin'), withLiveWorkMin: num('withLiveWorkMin'), everyMs: num('everyMs'),
    typingQuietMin: num('typingQuietMin'), deliverMs: num('deliverMs'), interruptGraceMs: num('interruptGraceMs') };
}

/// Is the idle period the last check-in was sent in still the current one? It ends when
/// a turn starts AFTER the check-in's own (a person's prompt, a task notification, a
/// wake-up firing): the session was active again. The check-in's turn does not end it -
/// that would re-ask a session that answered "self" with nothing running, every period.
/// Not delivered (no turn started): the period lasts until any turn starts.
function periodOpen(rec, turnAt) {
  if (!rec || !Number.isFinite(rec.sentAt)) return false;
  const own = Number.isFinite(rec.deliveredAt) ? rec.deliveredAt : rec.sentAt;
  return !(Number.isFinite(turnAt) && turnAt > own);
}

/// Why the server may NOT type a check-in into this session now, or null when it may.
/// Reads ONLY published row fields (the same row the hand-off rule reads), plus what the
/// row cannot carry: whether someone is typing, and whether a restart hold is on.
/// Every SAFETY gate (mid-turn, asking you something, compacting, booting, capped, in a
/// menu) is the same set the restart hold and the hand-off refuse on: text typed there
/// would answer a selector, queue behind a turn, or be lost. A gate that says "not now"
/// is retried by the next scan - deferred, never skipped: nothing is consumed until the
/// prompt is actually typed.
/// @param {object} row  a shaped row: { agent, status, waitingFor, compacting, agentReady,
///        blockedPrompt, inMenu, capBlocked, autoResumeArmed, usageLimit, backgroundTasks,
///        reason, brief: { turnAt, stoppedAt, wait, handoff, checkIn, checkInOff } }
/// @param {{now:number, cfg?:object, hcfg?:object, supported:boolean, inputAt?:number,
///        hold?:boolean, children?:Array<{live:boolean, endedAt:?number}>}} opts
///        `supported` is the registry's answer (lib/agents.js checksIn), asked by the
///        caller so this module stays free of the registry. `children`: the session's
///        DIRECT child sessions (lib/background-tasks.js childVerdicts) and when each one's
///        latest turn ended; absent = none.
function checkInBlock(row, { now, cfg, hcfg, supported, inputAt, startedAt, hold, liveKnown = true, children } = {}) {
  const c = cfg || checkInConfig(null);
  const h = hcfg || handoffConfig(null);
  const r = row || {};
  const b = r.brief || {};
  if (!c.enabled) return 'disabled';
  if (!supported) return 'unsupported';
  if (b.checkInOff) return 'off';
  // Both type their own prompts into the session; a third would land in their turn.
  if (hold) return 'restart-hold';
  if (isActive(b.handoff)) return 'handoff';
  // A hand-off that ended `kept` left a successor doing the work: "pick it back up" would
  // be wrong until the session has been active again (a turn after the run ended). So
  // would a `failed` one: its wrap-up either started a turn (it was told to stop) or may
  // still sit unsubmitted in the composer (a lost CR, #404), where a check-in's CR would
  // submit both as one prompt. Only a run whose prompt the worker link REFUSED
  // (`typed: false`, nothing written) blocks nothing. A missing time blocks (fail closed).
  const ho = b.handoff;
  if (ho && (ho.state === 'kept' || (ho.state === 'failed' && ho.typed !== false))
      && !(Number.isFinite(ho.at) && Number.isFinite(b.turnAt) && b.turnAt > ho.at)) return 'handed-off';
  if (r.status !== 'idle') return 'not-idle';
  if (r.waitingFor) return 'waiting';
  if (r.compacting) return 'compacting';
  if (r.agentReady === false || r.blockedPrompt) return 'not-ready';
  if (r.inMenu) return 'menu';
  if (r.capBlocked || r.autoResumeArmed || (r.usageLimit && r.usageLimit.waiting)) return 'capped';
  // An API error has its own owner (the worker's auto-continue) and is not a lost waker.
  if (r.apiError) return 'api-error';
  if (periodOpen(b.checkIn, b.turnAt)) return 'asked';
  // Keystrokes are remembered in memory only: after a reload or restart nobody can say
  // whether a person typed just before it, so the quiet period counts from the start.
  const typed = Math.max(Number.isFinite(inputAt) ? inputAt : -Infinity, Number.isFinite(startedAt) ? startedAt : -Infinity);
  if (Number.isFinite(typed) && Number.isFinite(now) && now - typed < c.typingQuietMin * 60 * 1000) return 'typing';
  // Fail CLOSED: "nothing alive" must be a reading, never a read that failed (a
  // transcript that cannot be found or read, no process snapshot yet).
  if (!liveKnown) return 'cannot-tell';
  if (checkInReading(r, { now, cfg: c, hcfg: h, children })) return null;
  // Stale by the hand-off's predicate but not yet past afterMin: 'recent'. Anything else
  // (you / external / done, no report, live work not yet past a reading) is not stale.
  return isStaleSelf(r, turnEndedAt(b), now, h) ? 'recent' : 'not-stale';
}

/// WHY this session's self-wait may be asked about, or null. Only a REPORTED self-wait,
/// and only after the turn that reported it ended; every safety gate is checkInBlock's.
///   stale-self       #443: nothing alive can wake it (the hand-off's isStaleSelf), idle
///                    staleSelfMin + afterMin.
///   children-parked  #456: it has child sessions and NONE is live (all idle with nothing
///                    running - finished, or waiting on someone, often on this lead), the
///                    last of them stopped and the session itself both idle staleSelfMin +
///                    afterMin. Its own watchers are ignored: whatever they watch, nothing
///                    is left to report to it. A child whose end is unknown fails closed.
///   long-self        #456 backstop: idle withLiveWorkMin, whatever is still listed as running.
function checkInReading(row, { now, cfg, hcfg, children } = {}) {
  const c = cfg || checkInConfig(null);
  const h = hcfg || handoffConfig(null);
  const r = row || {};
  const b = r.brief || {};
  const stopped = turnEndedAt(b);
  if (stopped === null || !Number.isFinite(now)) return null;
  const idle = now - stopped;
  const settle = (h.staleSelfMin + c.afterMin) * 60 * 1000;
  if (isStaleSelf(r, stopped, now, h) && idle >= settle) return 'stale-self';
  if (!(b.wait && b.wait.on === 'self')) return null;
  const kids = Array.isArray(children) ? children : [];
  if (kids.length && idle >= settle && kids.every((k) => k && k.live === false && Number.isFinite(k.endedAt))
      && now - Math.max(...kids.map((k) => k.endedAt)) >= settle) return 'children-parked';
  if (idle >= c.withLiveWorkMin * 60 * 1000) return 'long-self';
  return null;
}

// Claude brackets (pastes) any submit over 512 BYTES (#213), and the check-in is
// recognised by its tag on the UserPromptSubmit prompt, so it stays at or under this.
const PROMPT_BYTES_MAX = 511;
const WHAT_MAX = 60;

function idlePhrase(min) {
  const m = Math.max(1, Math.round(Number(min) || 0));
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
}

/// The check-in, one line (typePrompt flattens newlines anyway). A question, never an
/// order: the session decides, and says so by the wait it reports.
/// [what] is the session's own words for its wait, clipped, quotes softened, and every
/// control character (C0, DEL, C1) made a space: this text goes to the PTY as keystrokes,
/// and an ESC or a bracketed-paste marker in a report must never act as one.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
// What each reading (checkInReading) tells the session. Never "nothing is running" when
// something is listed as running: the session would rightly distrust the whole question.
const PROMPT_TAILS = Object.freeze({
  'stale-self': ', but nothing that could wake you is running (no background shell, subagent, monitor, wake-up, cron or child session). '
    + 'If you are finished, report wait done. If a watcher or timer was lost, pick the work back up. '
    + 'If you need the owner, report wait you.',
  'children-parked': ', but every child session you opened has stopped (finished or waiting on someone, maybe you) and nothing woke you. '
    + 'Check on them and act. If all is finished, report wait done. If you need the owner, report wait you.',
  'long-self': ', but nothing has woken you, though work is still listed as running. '
    + 'If it will still wake you, report wait self. If your watcher is stuck or missed its event, pick the work back up. '
    + 'If you are finished, report wait done. If you need the owner, report wait you.',
});
function checkInPrompt({ idleMin, what, why } = {}) {
  let w = typeof what === 'string' ? what.replace(CONTROL_RE, ' ').replace(/"/g, "'").replace(/ {2,}/g, ' ').trim() : '';
  if (Array.from(w).length > WHAT_MAX) w = `${Array.from(w).slice(0, WHAT_MAX - 1).join('')}…`;
  const head = `${TAG} You have been idle ${idlePhrase(idleMin)}. You last reported you would resume on your own`;
  const tail = PROMPT_TAILS[why] || PROMPT_TAILS['stale-self'];
  const said = w ? ` ("${w}")` : '';
  const full = head + said + tail;
  return Buffer.byteLength(full) <= PROMPT_BYTES_MAX ? full : head + tail;
}

/// The record a sent check-in starts, kept on the session's brief entry.
/// [why] is the reading that allowed it (checkInReading), kept for the log.
function startRecord(now, idleMin, why = 'stale-self') {
  return { sentAt: now, idleMin: Math.round(idleMin), why, deliveredAt: null, endedAt: null, answer: null };
}

const isCheckInPrompt = (p) => typeof p === 'string' && p.trimStart().startsWith(TAG);

/// Fold one hook into the session's check-in record, AFTER lib/session-brief.js foldHook
/// has folded it into [entry] (same `now`), so `turnAt`/`stoppedAt`/`reported` are
/// already this hook's. DELIVERY is the agent's UserPromptSubmit carrying the tagged
/// prompt; the ANSWER is the wait it reported during that turn, read at the turn's Stop.
/// Returns the SAME entry when nothing changed.
function noteHook(entry, event, body, now) {
  const e = entry || {};
  const rec = e.checkIn;
  if (!rec || !Number.isFinite(rec.sentAt)) return e;
  const b = body && typeof body === 'object' ? body : {};
  // Only web-terminal types the tag, and every check-in starts a fresh record, so the
  // first tagged prompt after the send IS this check-in.
  if (event === 'UserPromptSubmit' && !Number.isFinite(rec.deliveredAt) && isCheckInPrompt(b.prompt)) {
    return { ...e, checkIn: { ...rec, deliveredAt: now } };
  }
  if (event === 'Stop' && Number.isFinite(rec.deliveredAt) && !Number.isFinite(rec.endedAt)
      && Number.isFinite(e.stoppedAt) && e.stoppedAt >= rec.deliveredAt && e.turnAt === rec.deliveredAt) {
    const w = e.reported && e.reported.wait;
    const answer = w && typeof w.on === 'string' && Number.isFinite(w.at) && w.at >= rec.deliveredAt
      ? { on: w.on, what: typeof w.what === 'string' ? w.what : '' } : null;
    return { ...e, checkIn: { ...rec, endedAt: now, answer } };
  }
  return e;
}

/// The record as the brief publishes it.
function publicRecord(rec) {
  if (!rec || typeof rec !== 'object' || !Number.isFinite(rec.sentAt)) return null;
  return { sentAt: rec.sentAt, idleMin: Number.isFinite(rec.idleMin) ? rec.idleMin : null,
    deliveredAt: Number.isFinite(rec.deliveredAt) ? rec.deliveredAt : null,
    endedAt: Number.isFinite(rec.endedAt) ? rec.endedAt : null,
    answer: rec.answer && typeof rec.answer.on === 'string' ? { on: rec.answer.on, what: rec.answer.what || '' } : null };
}

/// What came back, as one word:
///   sent        typed, no turn has started yet
///   lost        typed, and no turn started within `deliverMs` (the submit never landed)
///   answering   its turn is running
///   interrupted its turn ended with no Stop (an Esc): no answer will come
///   done | you | external   the wait it reported in that turn
///   resumed     it reported self AND something alive can now wake it
///   stuck       it reported self again with nothing alive, or reported nothing at all
function outcome(rec, row, now, cfg) {
  const c = cfg || checkInConfig(null);
  if (!Number.isFinite(rec.deliveredAt)) return Number.isFinite(now) && now - rec.sentAt > c.deliverMs ? 'lost' : 'sent';
  if (!Number.isFinite(rec.endedAt)) {
    // Delivered, idle again, and no Stop came: an Esc (Claude fires no hook on interrupt;
    // the worker flips it idle at once). The grace covers a Stop whose fold lands just
    // after the worker went idle.
    return row.status === 'idle' && Number.isFinite(now) && now - rec.deliveredAt > c.interruptGraceMs ? 'interrupted' : 'answering';
  }
  const on = rec.answer && rec.answer.on;
  if (on === 'done' || on === 'you' || on === 'external') return on;
  if (on === 'self') {
    const live = (Array.isArray(row.backgroundTasks) ? row.backgroundTasks : []).some((t) => t && !t.stale);
    return live ? 'resumed' : 'stuck';
  }
  return 'stuck';
}

/// The `checkIn` field on a shaped session row: the last check-in and what came back,
/// while the idle period it was sent in lasts (once the session is active again it is
/// history, and the row shows the live state instead). null otherwise, and for an agent
/// that does not support check-ins. Reads ONLY published row fields.
function checkInField(row, { now, cfg, supported } = {}) {
  if (!supported) return null;
  const r = row || {};
  const b = r.brief || {};
  const rec = b.checkIn;
  if (!rec || !periodOpen(rec, b.turnAt)) return null;
  return { sentAt: rec.sentAt, idleMin: rec.idleMin, state: outcome(rec, r, now, cfg),
    answeredAt: rec.endedAt || null };
}

/// Typed but not yet started as a turn: the session still reads idle, so the other
/// writers (the hand-off scan, the restart hold) must not type behind it.
function inFlight(rec, now, cfg) {
  const c = cfg || checkInConfig(null);
  return Boolean(rec && Number.isFinite(rec.sentAt) && !Number.isFinite(rec.deliveredAt)
    && Number.isFinite(now) && now - rec.sentAt <= c.deliverMs);
}

/// Is this session worth reading a full row for? A cheap look at the raw brief entry
/// first, so the scan does not read metrics, transcripts and children for every idle
/// session every minute. Every condition here is one the full rule checks again.
function worthReading(entry, { now, cfg, hcfg } = {}) {
  const c = cfg || checkInConfig(null);
  const h = hcfg || handoffConfig(null);
  const e = entry || {};
  const w = e.reported && e.reported.wait;
  if (e.checkInOff || !(w && w.on === 'self') || periodOpen(e.checkIn, e.turnAt)) return false;
  const stopped = turnEndedAt(e);
  // The earliest any reading can allow: staleSelfMin + afterMin, or the #456 backstop.
  return stopped !== null && now - stopped >= Math.min(h.staleSelfMin + c.afterMin, c.withLiveWorkMin) * 60 * 1000;
}

/// One line of the check-in log (handoffs/check-in-log.jsonl): every check-in sent and
/// every answer, so "how many were really stuck vs done" can be measured afterwards.
function logRecord(event, id, rec, now, extra) {
  const r = rec || {};
  return { at: new Date(now).toISOString(), event, id, sentAt: r.sentAt || null, idleMin: r.idleMin || null,
    why: r.why || null, answer: (r.answer && r.answer.on) || null, ...(extra || {}) };
}

module.exports = {
  DEFAULTS, PROMPT_BYTES_MAX, checkInConfig, periodOpen, checkInBlock, checkInReading, checkInPrompt, startRecord,
  isCheckInPrompt, noteHook, publicRecord, outcome, checkInField, inFlight, worthReading, logRecord,
};
