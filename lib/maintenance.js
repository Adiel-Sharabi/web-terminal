'use strict';
// --- Prepare this machine for a restart (#359) -------------------------------------
//
// "Tell every session to finish up, and say when I can restart" was done by hand on
// 2026-10-16, and every step of it went wrong in a way the server could have prevented:
// a socket that never opened, so one session was never told; readiness guessed from the
// agents' prose ("READY FOR RESTART", "Ready for restart: everything is merged...", or no
// keyword at all), which both missed ready sessions and passed busy ones; a new session
// started on the box by an orchestrator 36 minutes into the window; "blocked, a few
// minutes" that was a subagent running for 50; and after the reboot nobody was told.
//
// So the server owns it, as a HOLD:
//   - prepare  -> one wrap-up prompt to every agent session, typed through the same path
//                 a compose submit takes, and only once the session can take it;
//   - status   -> a verdict per session from state the server already has: the worker's
//                 status, what is running under the PTY (#351's liveWorkUnder), and
//                 whether the session's turn ENDED after it was told. Never its prose;
//   - the hold refuses new sessions until the restart, and clears itself when the
//     restart has happened, telling the sessions it had told that the machine is back.
//
// This file owns every RULE and is pure (every clock is `now`). server.js owns the I/O:
// the store, the PTY writes, the session list and the process snapshot.

const { MAINTENANCE_PROMPT_TAG: TAG } = require('./user-turn');
const { sessionReason } = require('./session-reason');

// TOLD AND ANSWERED ARE VERIFIED, NOT PREDICTED (#179's rule). Review of the first cut:
// stamping "told" when the prompt was typed, and "answered" on any later Stop or on
// working-then-idle, let a session read as ready that never saw the prompt - typed behind
// a running turn, then the person pressed Esc (idle, no Stop). So:
//   - the prompt is typed only into a session IDLE at its composer, never queued;
//   - "delivered" is the agent's own UserPromptSubmit carrying the tagged prompt;
//   - "answered" is a turn END after the prompt: the main agent's Stop after delivery,
//     or the worker's `lastTurnEndAt` (applyIdle, Stop only - an Esc never sets it),
//     which also covers an agent with no Stop hook (Codex reports turns by OSC 9);
//   - a prompt the worker reports as not taken (submitUnconfirmed) is typed again, at
//     most MAX_TRIES times.
const MAX_TRIES = 3;

// THE HOLD ASKS, IT DOES NOT ORDER (#407). The owner's rule: a cold restart is fine only
// when every running session AGREES; "no" and "later" are accepted answers. The agent
// reports its answer as STATE (`wt-maintenance.js answer`, then POST /api/maintenance/answer),
// never as prose we would have to read:
//   - yes   -> may become READY once its turn ended and nothing runs;
//   - no    -> DECLINED: blocks SAFE until the hold is cancelled or a new prepare;
//   - later -> DEFERRED until the time passes, then asked again (at most MAX_ASKS asks);
//   - told, turn over, no answer -> stays ANSWERING, never ready.
// A plain shell is never asked and keeps the "nothing running" rule.
const MAX_ASKS = 4;
const MINUTES_DEFAULT = 30;
const MINUTES_MIN = 5;
const MINUTES_MAX = 240;
const ANSWERS = Object.freeze(['yes', 'no', 'later']);

// Verdict states. READY and GONE are the only ones that let a restart go ahead.
const STATES = Object.freeze({
  READY: 'ready',          // told (or not an agent), said yes, turn over, nothing running
  GONE: 'gone',            // closed since the hold started
  NOT_TOLD: 'not-told',    // the question has not been delivered yet
  ANSWERING: 'answering',  // asked, and it has not said yes/no/later with its turn over
  DECLINED: 'declined',    // said no: the restart waits until the hold is cancelled
  DEFERRED: 'deferred',    // said later: asked again when the time is up
  WORKING: 'working',      // the agent is mid-turn
  NEEDS_YOU: 'needs-you',  // parked on a permission, a question or a menu
  BUSY: 'busy',            // a build, a test run or a background task is still running
  UNKNOWN: 'unknown',      // could not read what is running
});
const CLEAR = new Set([STATES.READY, STATES.GONE]);

// The machine's boot moves a little between reads (uptime is whole seconds, the clock
// drifts); two boots inside this window are the same boot.
const BOOT_SLACK_MS = 120000;
// How long the "back" notice keeps trying to reach a restored session that is still
// booting before it gives up on it.
const BACK_TIMEOUT_MS = 15 * 60 * 1000;

// C0, DEL and C1 controls (U+0080-U+009F) out of any text we store or type; written as
// escapes so this source stays ASCII.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const clip = (s, n) => {
  const t = typeof s === 'string' ? s.replace(CONTROLS, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const entryOf = (s) => ({
  name: clip(s.name, 100) || null,
  pid: Number.isFinite(s.pid) ? s.pid : null,
  agent: s.agent || null,
  promptedAt: null,
  deliveredAt: null,
  answeredAt: null, // the turn that ended after the question (NOT the answer to it)
  tries: 0,
  asks: 0,          // how many times it was asked (a "later" is asked again)
  answer: null,     // 'yes' | 'no' | 'later', as the agent reported it
  answerAt: null,
  answerReason: null,
  until: null,      // a "later": when it is asked again
  // #410: said yes, turn over, but work still runs. Since when it has read BUSY, and the ONE
  // follow-up asking about it (typed, delivered, and how many times it was typed).
  busySince: null,
  nudgedAt: null,
  nudgeDeliveredAt: null,
  nudgeTries: 0,
});

// #410: a yes whose work outlives the turn blocked the hold forever and nobody was told. After
// this long BUSY the session gets ONE follow-up naming what runs (a new job later earns none).
const NUDGE_AFTER_MS = 5 * 60 * 1000;

/// Local HH:MM, for the times status and the follow-up name ('' when unknown).
function clockOf(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/// The worker's identity as the hold records it: a worker restart is a restart (#406).
const workerOf = (w) => (w && Number.isFinite(w.startedAt) ? { pid: Number.isFinite(w.pid) ? w.pid : null, startedAt: w.startedAt } : null);

/// A new hold over the sessions listed now. Every session is tracked (a plain shell can
/// still be running a build); only an agent session is asked.
function startHold({ reason, now, bootAt, sessions, worker }) {
  const tracked = {};
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && typeof s.id === 'string') tracked[s.id] = entryOf(s);
  }
  return { reason: clip(reason, 200) || 'restart', startedAt: now, bootAt, worker: workerOf(worker), sessions: tracked };
}

/// Track a session created DURING the hold (with `force`): it is running on the machine
/// about to restart, so it is told and judged like the rest. Its pid is not known at
/// create time, so it never votes in `restarted()`; the boot signal and the original
/// sessions do.
function trackSession(hold, s) {
  if (!hold || !s || typeof s.id !== 'string' || (hold.sessions || {})[s.id]) return hold;
  return { ...hold, sessions: { ...hold.sessions, [s.id]: entryOf(s) } };
}

const withEntry = (hold, id, patch) => ({ ...hold, sessions: { ...hold.sessions, [id]: { ...hold.sessions[id], ...patch } } });

/// Should the tick type the wrap-up prompt into this tracked session now?
function shouldPrompt(entry, row, now) {
  if (!entry || !canPrompt(row)) return false;
  if (!entry.promptedAt) return (entry.tries || 0) < MAX_TRIES;
  // A "later" whose time is up is asked again (bounded), once the session is idle.
  return entry.answer === 'later' && Number.isFinite(entry.until) && now >= entry.until && (entry.asks || 0) < MAX_ASKS;
}

const scriptArg = (p) => String(p || 'scripts/wt-maintenance.js').replace(/\\/g, '/');

// Claude brackets (pastes) any submit over 512 BYTES (#213), and delivery then depends on the
// UserPromptSubmit prompt still starting with the tag. Keep every hold prompt well under it:
// the reason is shown clipped to PROMPT_REASON_MAX (the full one stays in the hold).
const PROMPT_REASON_MAX = 30;
const promptReason = (reason) => clip(reason, PROMPT_REASON_MAX) || 'restart';

/// The question every agent session gets. One line: typePrompt flattens newlines anyway.
/// A QUESTION, not an order (#407): "no" and "later" are fine, and the answer is the
/// command - sessions run in any cwd, so the script path is absolute.
function wrapUpPrompt(reason, scriptPath) {
  return `${TAG} A question, not an order: web-terminal would like to restart (${promptReason(reason)}). `
    + 'Is now OK? "no" or "later" is fine (long build, unpushed work). '
    + 'If OK, reach a safe stop (commit, push, note where you are, start nothing new), then answer yes. '
    + `Run: node "${scriptArg(scriptPath)}" answer yes|no|later [--minutes N] [--reason "why"] (chat is not read)`;
}

// Every hold prompt is typed as one line plus CR; it stays at or under this many bytes (#213).
const PROMPT_BYTES_MAX = 511;

/// The longest prefix of [s] (by characters) that fits [max] UTF-8 bytes, with an ellipsis
/// when it was cut.
function fitBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  const chars = Array.from(s);
  while (chars.length && Buffer.byteLength(`${chars.join('')}…`) > max) chars.pop();
  return chars.length ? `${chars.join('')}…` : '';
}

/// The work list as one phrase that fits [max] bytes: up to three labels, then "+N more";
/// fewer labels, then a shortened one, when it does not fit.
function workPhrase(work, max) {
  const labels = (Array.isArray(work) ? work : []).map(workLabel);
  for (let n = Math.min(3, labels.length); n >= 1; n--) {
    const text = labels.slice(0, n).join(', ') + (labels.length > n ? ` +${labels.length - n} more` : '');
    if (Buffer.byteLength(text) <= max) return text;
  }
  return fitBytes(labels[0] || 'a background task', max) || 'work';
}

/// #410: the ONE follow-up to a session that said yes but still runs work. It names the work
/// (a shell with its pid, so the agent can find it) and since when, and asks: stop it, or
/// answer later / no. Stopping it needs no answer: the hold sees the work end.
function busyPrompt(reason, work, since, scriptPath) {
  const head = `${TAG} Restart (${promptReason(reason)}): you said yes, but this session still runs `;
  const tail = `${Number.isFinite(since) ? ` (since ${clockOf(since)})` : ''}, which holds it up. Can you stop it now? `
    + 'If it must finish: answer later --minutes N; if it must not stop: answer no. '
    + `Run: node "${scriptArg(scriptPath)}" answer later|no [--minutes N] [--reason "why"]`;
  return head + workPhrase(work, PROMPT_BYTES_MAX - Buffer.byteLength(head + tail)) + tail;
}

/// The notice for a session the hold had told, once the machine is back.
function backPrompt(reason) {
  return `${TAG} The machine is back after the restart (${promptReason(reason)}). `
    + 'Check that what you left is intact (branches, running jobs, open PRs), then carry on where you stopped.';
}

/// The notice for a session the hold had asked, when the hold is cancelled.
function calledOffPrompt(reason) {
  return `${TAG} The restart (${promptReason(reason)}) is called off. Carry on as normal; nothing more to answer.`;
}

/// May the wrap-up prompt be typed into this session NOW? Only an agent IDLE at its
/// composer: text typed into a permission selector or a menu would ANSWER it, a booting
/// agent (#147) would lose it, and one typed behind a running turn is queued where an Esc
/// leaves it unsent while the turn still ends - the very case review found.
function canPrompt(row) {
  if (!row || !row.agent) return false;
  if (row.agentReady === false) return false;
  if (row.status !== 'idle') return false;
  if (row.inMenu || row.blockedPrompt || row.waitingFor) return false;
  // #129: Claude reports idle part-way through a /compact, which runs on for minutes.
  if (row.compacting) return false;
  return true;
}

/// Fold a hook into the hold (subagent events carry `agent_id` and are ignored): the
/// agent's UserPromptSubmit carrying the tagged prompt is DELIVERY; its Stop after
/// delivery is the ANSWER.
function noteHook(hold, id, event, body, now) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e || !e.promptedAt) return hold;
  if (body && body.agent_id) return hold;
  const tagged = event === 'UserPromptSubmit' && typeof (body && body.prompt) === 'string' && body.prompt.trimStart().startsWith(TAG);
  // #410: the follow-up goes only to a session that answered, so it is checked before the
  // answered early return - and it delivers the follow-up, never a new question or answer.
  if (e.nudgedAt && !e.nudgeDeliveredAt) return tagged ? withEntry(hold, id, { nudgeDeliveredAt: now }) : hold;
  if (e.answeredAt) return hold;
  if (tagged && !e.deliveredAt) return withEntry(hold, id, { deliveredAt: now });
  if (event === 'Stop' && e.deliveredAt && now >= e.deliveredAt) return withEntry(hold, id, { answeredAt: now });
  return hold;
}

/// Fold the worker's row into the hold: a turn that ENDED after the prompt was typed is
/// the answer, whatever channel the agent reports its turns on. The prompt went only into
/// an idle session, so a later turn end is the turn it started. Absent on a worker older
/// than this field: the Stop hook above still answers for Claude.
function noteStatus(hold, row) {
  const e = row && hold && hold.sessions && hold.sessions[row.id];
  if (!e || !e.promptedAt || e.answeredAt) return hold;
  // An agent that reports through hooks must show DELIVERY first, exactly as noteHook
  // demands: the worker stamps a Stop even on an already-idle session, so its clock alone
  // would accept a stray Stop that the prompt never caused (second review). An agent that
  // has never hooked (Codex reports turns by OSC 9) has only the worker's clock.
  if (row.hookStatus && !e.deliveredAt) return hold;
  if (Number.isFinite(row.lastTurnEndAt) && row.lastTurnEndAt > e.promptedAt) return withEntry(hold, row.id, { answeredAt: row.lastTurnEndAt });
  return hold;
}

/// The worker says a submit was not taken (#179): forget the prompt so the tick types it
/// again once the session can take it - at most MAX_TRIES times in all. A UserPromptSubmit
/// hook delayed past the worker's 8s window (Home stalls process spawns for seconds) can
/// make a prompt that DID land be typed once more; MAX_TRIES bounds that, and a duplicate
/// "wrap up" is harmless.
function noteUnconfirmed(hold, id) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e) return hold;
  // #410: a follow-up not taken is typed again (shouldNudge bounds it by nudgeTries).
  if (e.nudgedAt && !e.nudgeDeliveredAt) return withEntry(hold, id, { nudgedAt: null });
  if (!e.promptedAt || e.deliveredAt || e.answeredAt) return hold;
  return withEntry(hold, id, { promptedAt: null });
}

/// #410: fold what runs under a session into `busySince` - stamped when it first reads BUSY,
/// cleared when it reads anything else (ready, working, declined...). `null` work (could not
/// tell) changes nothing. The state is verdict()'s, never a second copy of its rules.
function noteWork(hold, id, row, work, now) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e || work === null || work === undefined) return hold;
  const busy = verdict(e, row, work, now).state === STATES.BUSY;
  if (busy) return Number.isFinite(e.busySince) ? hold : withEntry(hold, id, { busySince: now });
  return e.busySince === null || e.busySince === undefined ? hold : withEntry(hold, id, { busySince: null });
}

/// #410: does what runs under this session decide its verdict now - would it be READY if
/// nothing ran? Only then is the work worth reading on the tick (every other state ignores it).
function workDecides(entry, row, now) {
  return !!row && verdict(entry, row, [], now).state === STATES.READY;
}

/// #410: should the tick type the follow-up now? An agent that said yes, whose turn ended, that
/// has read BUSY for NUDGE_AFTER_MS, is idle at its composer, and has not had it yet. For an
/// agent, verdict() reaches BUSY only after a yes and an ended turn - its rule, not a copy here.
function shouldNudge(entry, row, work, now) {
  if (!entry || !canPrompt(row)) return false;
  if (entry.nudgedAt || (entry.nudgeTries || 0) >= MAX_TRIES) return false;
  if (!Number.isFinite(entry.busySince) || now - entry.busySince < NUDGE_AFTER_MS) return false;
  return verdict(entry, row, work, now).state === STATES.BUSY;
}

/// The tick typed the follow-up.
function noteNudged(hold, id, now) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e) return hold;
  return withEntry(hold, id, { nudgedAt: now, nudgeDeliveredAt: null, nudgeTries: (e.nudgeTries || 0) + 1 });
}

/// The tick typed the prompt.
function notePrompted(hold, id, now) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e) return hold;
  // Asking again after a "later": a fresh question, so last time's answer and turn end are void.
  if (e.answer === 'later') {
    return withEntry(hold, id, {
      promptedAt: now, tries: 1, asks: (e.asks || 0) + 1, deliveredAt: null, answeredAt: null, answer: null, answerAt: null, answerReason: null, until: null,
      busySince: null, nudgedAt: null, nudgeDeliveredAt: null, nudgeTries: 0,
    });
  }
  return withEntry(hold, id, { promptedAt: now, tries: (e.tries || 0) + 1, asks: Math.max(1, e.asks || 0) });
}

/// Validate an answer body. The answer is STATE the agent reports, so it is checked as
/// strictly as any input: an enum, an integer clamped to a sane range, and a reason that
/// is untrusted text (control characters out, clipped).
function parseAnswer(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.sessionId !== 'string' || !b.sessionId) return { ok: false, status: 400, error: 'sessionId is required' };
  if (!ANSWERS.includes(b.answer)) return { ok: false, status: 400, error: `answer must be one of ${ANSWERS.join(', ')}` };
  let minutes = MINUTES_DEFAULT;
  if (b.minutes !== undefined && b.minutes !== null) {
    if (typeof b.minutes !== 'number' || !Number.isFinite(b.minutes)) return { ok: false, status: 400, error: 'minutes must be a number' };
    minutes = Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(b.minutes)));
  }
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') return { ok: false, status: 400, error: 'reason must be text' };
  return { ok: true, sessionId: b.sessionId, answer: b.answer, minutes, reason: clip(b.reason, 200) || null };
}

/// The agent's answer. Only a session this hold tracked AND asked can answer; the answer
/// replaces an earlier one (it may change its mind). `{ hold, status }`: `status` is the
/// HTTP code the route answers with, and `hold` the new hold when it changed.
function noteAnswer(hold, body, now) {
  if (!hold) return { status: 409, error: 'no restart hold is on' };
  const p = parseAnswer(body);
  if (!p.ok) return p;
  const e = (hold.sessions || {})[p.sessionId];
  if (!e) return { status: 404, error: 'this session is not part of the restart hold' };
  if (!e.promptedAt) return { status: 409, error: 'this session has not been asked yet' };
  const patch = { answer: p.answer, answerAt: now, answerReason: p.answer === 'yes' ? null : p.reason, until: p.answer === 'later' ? now + p.minutes * 60000 : null };
  return { status: 200, hold: withEntry(hold, p.sessionId, patch), answer: p.answer, minutes: p.minutes };
}

function workLabel(w) {
  if (!w || typeof w !== 'object') return 'a background task';
  const said = clip(w.description || w.command || '', 60);
  if (said) return said;
  // #410: a bare "cmd.exe" tells nobody which one; its pid lets the agent find it.
  const name = clip(w.name || w.label || '', 40);
  if (name) return Number.isFinite(w.pid) ? `${name} pid ${w.pid}` : name;
  return 'a background task';
}

/// #410: since when the work has run - its own oldest start, else when the hold saw it busy.
function workSince(entry, work) {
  const starts = (Array.isArray(work) ? work : [])
    .map((w) => (w && Number.isFinite(w.startMs) ? w.startMs : w && Number.isFinite(w.startedAt) ? w.startedAt : null))
    .filter((t) => t !== null);
  if (starts.length) return Math.min(...starts);
  return entry && Number.isFinite(entry.busySince) ? entry.busySince : null;
}

/// One session's verdict. `row` is the worker's row (null when the session is gone),
/// `work` what is running under it: an array, or null when it could not be read.
function verdict(entry, row, work, now) {
  if (!row) return { state: STATES.GONE, why: 'closed' };
  // "Waiting on the person" is lib/session-reason.js's answer, not a second copy of it.
  const reason = sessionReason({ status: row.status, waitingFor: row.waitingFor, inMenu: row.inMenu });
  if (row.blockedPrompt) return { state: STATES.NEEDS_YOU, why: 'waiting for you: a startup prompt' };
  if (reason && reason.kind === 'menu') return { state: STATES.NEEDS_YOU, why: 'waiting for you: a menu is open (Esc)' };
  if (reason && reason.kind === 'you' && row.status === 'waiting') return { state: STATES.NEEDS_YOU, why: `waiting for you: ${reason.text}` };
  if (row.agent && entry && entry.answer === 'no') {
    return { state: STATES.DECLINED, why: `said no${entry.answerReason ? `: ${entry.answerReason}` : ''} - the restart waits until you cancel the hold` };
  }
  if (row.agent && entry && entry.answer === 'later') return deferred(entry, now);
  if (row.status === 'working') {
    const n = Number.isFinite(row.subagents) ? row.subagents : 0;
    return { state: STATES.WORKING, why: n ? `working, waiting on ${n} subagent${n === 1 ? '' : 's'}` : 'working' };
  }
  if (row.compacting) return { state: STATES.WORKING, why: 'compacting its context' };
  // An agent the hold does not track (made while the hold was starting) is never ready: it
  // has not been asked, whatever it looks like. The tick starts tracking it.
  if (row.agent && !entry) return { state: STATES.NOT_TOLD, why: 'not asked yet: the hold has not registered it' };
  if (row.agent && entry && !entry.promptedAt) {
    return { state: STATES.NOT_TOLD, why: (entry.tries || 0) >= MAX_TRIES ? `the wrap-up prompt did not land after ${MAX_TRIES} tries` : 'not told yet: it is told once idle at its composer' };
  }
  if (row.agent && entry && !entry.answeredAt) {
    // A capped agent refuses the prompt with an idle notice and no Stop (#227), so it
    // stays here until the reset: say so rather than look stuck.
    if (row.capBlocked) return { state: STATES.ANSWERING, why: 'told, but capped at its usage limit until the reset' };
    if (entry.answer === 'yes') return { state: STATES.ANSWERING, why: 'said yes; its turn has not ended yet' };
    return { state: STATES.ANSWERING, why: entry.deliveredAt ? 'told; its turn has not ended yet' : 'prompt typed; waiting for the agent to take it' };
  }
  // Its turn ended, and it never said yes: a silent session has not agreed (#407).
  if (row.agent && entry && entry.answer !== 'yes') return { state: STATES.ANSWERING, why: 'told; has not answered (yes, no or later)' };
  if (work === null) return { state: STATES.UNKNOWN, why: 'could not read what is running - ask again' };
  if (Array.isArray(work) && work.length) {
    const names = work.slice(0, 3).map(workLabel).join(', ');
    const start = workSince(entry, work);
    const running = `still running: ${names}${work.length > 3 ? ` +${work.length - 3}` : ''}${start !== null ? ` since ${clockOf(start)}` : ''}`;
    // #410: an agent here said yes (every other answer returned above); say when it was asked.
    if (!row.agent) return { state: STATES.BUSY, why: running };
    const asked = entry && Number.isFinite(entry.nudgedAt) ? `; asked about it at ${clockOf(entry.nudgedAt)}` : '';
    return { state: STATES.BUSY, why: `said yes, but ${running}${asked}` };
  }
  return { state: STATES.READY, why: row.agent ? 'said yes; wrapped up' : 'nothing running' };
}

/// A "later": when it is asked again, or why it no longer will be.
function deferred(entry, now) {
  const said = `said later${entry.answerReason ? ` (${entry.answerReason})` : ''}`;
  if ((entry.asks || 0) >= MAX_ASKS) return { state: STATES.DEFERRED, why: `${said}; asked ${entry.asks} times and it keeps deferring` };
  if (Number.isFinite(entry.until) && Number.isFinite(now) && now < entry.until) {
    return { state: STATES.DEFERRED, why: `${said}; asked again in ${Math.max(1, Math.ceil((entry.until - now) / 60000))} min` };
  }
  return { state: STATES.DEFERRED, why: `${said}; time is up - asked again once it is idle` };
}

/// The whole answer. `rows` maps session id -> worker row for every session that exists
/// now; `works` maps id -> running work. A session the hold does not track (started by a
/// path that did not register it) is still judged, and flagged.
function status(hold, rows, works, now) {
  if (!hold) return { hold: null, safeToRestart: null, sessions: [] };
  const ids = new Set([...Object.keys(hold.sessions || {}), ...Object.keys(rows || {})]);
  const sessions = [];
  for (const id of ids) {
    const entry = (hold.sessions || {})[id] || null;
    const row = (rows || {})[id] || null;
    const v = verdict(entry, row, (works || {})[id] === undefined ? null : works[id], now);
    sessions.push({
      id, name: (row && row.name) || (entry && entry.name) || null, agent: (row && row.agent) || (entry && entry.agent) || null,
      ...v, promptedAt: entry ? entry.promptedAt : null, deliveredAt: entry ? entry.deliveredAt : null,
      answeredAt: entry ? entry.answeredAt : null, untracked: !entry,
      answer: entry ? entry.answer || null : null, answerReason: entry ? entry.answerReason || null : null, until: entry ? entry.until || null : null,
      busySince: entry ? entry.busySince || null : null, nudgedAt: entry ? entry.nudgedAt || null : null,
    });
  }
  const order = (s) => (CLEAR.has(s.state) ? 1 : 0);
  sessions.sort((a, b) => order(a) - order(b) || String(a.name).localeCompare(String(b.name)));
  return {
    hold: { reason: hold.reason, startedAt: hold.startedAt },
    safeToRestart: sessions.every((s) => CLEAR.has(s.state)),
    sessions,
  };
}

/// Has the restart the hold was for happened? Either the machine booted again, or every
/// tracked session that still exists is running in a NEW process (a cold restart of
/// web-terminal respawns them all; a hot reload of server.js touches none). Sessions all
/// closed by hand prove nothing, so they leave the hold in place. A worker CRASH that the
/// monitor restarts also respawns every PTY, and counts: those sessions did lose their
/// processes, so telling them the machine is back is still true of what they lived through.
function restarted(hold, rows, bootAt, worker) {
  if (!hold) return false;
  if (Number.isFinite(hold.bootAt) && Number.isFinite(bootAt) && Math.abs(bootAt - hold.bootAt) > BOOT_SLACK_MS) return true;
  // A different WORKER is a cold restart even when no tracked session can vote (#406: a
  // hold over a machine with no sessions never cleared). A hot reload of server.js keeps
  // the worker, so it never counts. A hold made against a worker that reported nothing
  // (older than the field) still clears when the worker now running started after it.
  const w = workerOf(worker);
  if (w) {
    const was = workerOf(hold.worker);
    if (was ? (was.startedAt !== w.startedAt || was.pid !== w.pid) : w.startedAt > hold.startedAt) return true;
  }
  const alive = Object.entries(hold.sessions || {}).filter(([id, e]) => e.pid !== null && rows && rows[id] && Number.isFinite(rows[id].pid));
  return alive.length > 0 && alive.every(([id, e]) => rows[id].pid !== e.pid);
}

/// Who gets the "back" notice - and, when the hold is cancelled, the "called off" one:
/// the sessions the hold actually told.
function backList(hold, now) {
  const ids = Object.entries((hold && hold.sessions) || {}).filter(([, e]) => e.promptedAt).map(([id]) => id);
  return ids.length ? { reason: hold.reason, since: now, pending: ids } : null;
}

/// May the "back" notice be typed now? The restored agent must be up and at its composer.
function canSendBack(row) {
  return canPrompt(row) && row.status === 'idle';
}

module.exports = {
  STATES, BOOT_SLACK_MS, BACK_TIMEOUT_MS, MAX_TRIES, MAX_ASKS, MINUTES_DEFAULT, MINUTES_MIN, MINUTES_MAX, NUDGE_AFTER_MS,
  startHold, trackSession, wrapUpPrompt, backPrompt, calledOffPrompt, busyPrompt, canPrompt, shouldPrompt,
  noteHook, noteStatus, noteUnconfirmed, notePrompted, parseAnswer, noteAnswer, verdict, status,
  noteWork, workDecides, workSince, shouldNudge, noteNudged, clockOf, restarted, backList, canSendBack,
};
