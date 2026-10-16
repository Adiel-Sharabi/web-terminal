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

// Verdict states. READY and GONE are the only ones that let a restart go ahead.
const STATES = Object.freeze({
  READY: 'ready',          // told (or not an agent), turn over, nothing running
  GONE: 'gone',            // closed since the hold started
  NOT_TOLD: 'not-told',    // the wrap-up prompt has not been delivered yet
  ANSWERING: 'answering',  // told, its turn has not ended yet
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

const clip = (s, n) => {
  const t = typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/// A new hold over the sessions listed now. Every session is tracked (a plain shell can
/// still be running a build); only an agent session is told.
function startHold({ reason, now, bootAt, sessions }) {
  const tracked = {};
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.id !== 'string') continue;
    tracked[s.id] = {
      name: clip(s.name, 100) || null,
      pid: Number.isFinite(s.pid) ? s.pid : null,
      agent: s.agent || null,
      promptedAt: null,
      answeredAt: null,
      sawWorking: false,
    };
  }
  return { reason: clip(reason, 200) || 'restart', startedAt: now, bootAt, sessions: tracked };
}

/// The prompt every agent session gets. One line: typePrompt flattens newlines anyway.
function wrapUpPrompt(reason) {
  return `${TAG} This machine is about to restart (${clip(reason, 200) || 'restart'}). `
    + 'Bring your current step to a safe stop: commit and push what is finished, write down where you are, '
    + 'let a build or test run that is already going finish, and do not start new work, new sessions or new subagents. '
    + 'Then end your turn. You will get a notice when the machine is back, and can carry on from there.';
}

/// The notice for a session the hold had told, once the machine is back.
function backPrompt(reason) {
  return `${TAG} The machine is back after the restart (${clip(reason, 200) || 'restart'}). `
    + 'Check that what you left is intact (branches, running jobs, open PRs), then carry on where you stopped.';
}

/// May the wrap-up prompt be typed into this session NOW? Text typed into a permission
/// selector or a menu would ANSWER it, so a session parked on one is told later, once it
/// is back at its composer. A booting agent (#147) is told once its composer is up.
function canPrompt(row) {
  if (!row || !row.agent) return false;
  if (row.agentReady === false) return false;
  if (row.status !== 'idle' && row.status !== 'working') return false;
  if (row.inMenu || row.blockedPrompt || row.waitingFor) return false;
  return true;
}

/// Fold a hook into the hold. The MAIN agent's Stop after the prompt is the answer; a
/// subagent's events carry `agent_id` and say nothing about the main turn.
function noteHook(hold, id, event, body, now) {
  const e = hold && hold.sessions && hold.sessions[id];
  if (!e || !e.promptedAt || e.answeredAt || event !== 'Stop') return hold;
  if (body && body.agent_id) return hold;
  if (now < e.promptedAt) return hold;
  return { ...hold, sessions: { ...hold.sessions, [id]: { ...e, answeredAt: now } } };
}

/// Fold an observed status into the hold: the answer for an agent whose turn end is not
/// reported by a hook. Working after the prompt, then idle, is a turn that ended.
function noteStatus(hold, row, now) {
  const e = row && hold && hold.sessions && hold.sessions[row.id];
  if (!e || !e.promptedAt || e.answeredAt) return hold;
  if (row.status === 'working' && !e.sawWorking) {
    return { ...hold, sessions: { ...hold.sessions, [row.id]: { ...e, sawWorking: true } } };
  }
  if (row.status === 'idle' && e.sawWorking) {
    return { ...hold, sessions: { ...hold.sessions, [row.id]: { ...e, answeredAt: now } } };
  }
  return hold;
}

function workLabel(w) {
  if (!w || typeof w !== 'object') return 'a background task';
  return clip(w.description || w.command || w.name || w.label || '', 60) || 'a background task';
}

/// One session's verdict. `row` is the worker's row (null when the session is gone),
/// `work` what is running under it: an array, or null when it could not be read.
function verdict(entry, row, work) {
  if (!row) return { state: STATES.GONE, why: 'closed' };
  if (row.status === 'waiting' || row.inMenu || row.blockedPrompt || row.waitingFor) {
    const what = row.inMenu ? 'a menu' : row.waitingFor === 'question' ? 'a question' : row.blockedPrompt ? 'a prompt' : 'a permission';
    return { state: STATES.NEEDS_YOU, why: `waiting for you: ${what}` };
  }
  if (row.status === 'working') {
    const n = Number.isFinite(row.subagents) ? row.subagents : 0;
    return { state: STATES.WORKING, why: n ? `working, waiting on ${n} subagent${n === 1 ? '' : 's'}` : 'working' };
  }
  if (row.agent && entry && !entry.promptedAt) return { state: STATES.NOT_TOLD, why: 'wrap-up prompt not delivered yet' };
  if (row.agent && entry && !entry.answeredAt) return { state: STATES.ANSWERING, why: 'told; its turn has not ended yet' };
  if (work === null) return { state: STATES.UNKNOWN, why: 'could not read what is running - ask again' };
  if (Array.isArray(work) && work.length) {
    const names = work.slice(0, 3).map(workLabel).join(', ');
    return { state: STATES.BUSY, why: `still running: ${names}${work.length > 3 ? ` +${work.length - 3}` : ''}` };
  }
  return { state: STATES.READY, why: row.agent ? 'wrapped up' : 'nothing running' };
}

/// The whole answer. `rows` maps session id -> worker row for every session that exists
/// now; `works` maps id -> running work. A session started AFTER the hold (with `force`)
/// is judged too: it is running on the machine about to restart.
function status(hold, rows, works) {
  if (!hold) return { hold: null, safeToRestart: null, sessions: [] };
  const ids = new Set([...Object.keys(hold.sessions || {}), ...Object.keys(rows || {})]);
  const sessions = [];
  for (const id of ids) {
    const entry = (hold.sessions || {})[id] || null;
    const row = (rows || {})[id] || null;
    const v = verdict(entry, row, (works || {})[id] === undefined ? null : works[id]);
    sessions.push({
      id, name: (row && row.name) || (entry && entry.name) || null, agent: (row && row.agent) || (entry && entry.agent) || null,
      ...v, promptedAt: entry ? entry.promptedAt : null, answeredAt: entry ? entry.answeredAt : null,
      startedDuringHold: !entry,
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
/// closed by hand prove nothing, so they leave the hold in place.
function restarted(hold, rows, bootAt) {
  if (!hold) return false;
  if (Number.isFinite(hold.bootAt) && Number.isFinite(bootAt) && Math.abs(bootAt - hold.bootAt) > BOOT_SLACK_MS) return true;
  const alive = Object.entries(hold.sessions || {}).filter(([id, e]) => e.pid !== null && rows && rows[id] && Number.isFinite(rows[id].pid));
  return alive.length > 0 && alive.every(([id, e]) => rows[id].pid !== e.pid);
}

/// Who gets the "back" notice: the sessions the hold actually told.
function backList(hold, now) {
  const ids = Object.entries((hold && hold.sessions) || {}).filter(([, e]) => e.promptedAt).map(([id]) => id);
  return ids.length ? { reason: hold.reason, since: now, pending: ids } : null;
}

/// May the "back" notice be typed now? The restored agent must be up and at its composer.
function canSendBack(row) {
  return canPrompt(row) && row.status === 'idle';
}

module.exports = {
  STATES, BOOT_SLACK_MS, BACK_TIMEOUT_MS,
  startHold, wrapUpPrompt, backPrompt, canPrompt, noteHook, noteStatus, verdict, status,
  restarted, backList, canSendBack,
};
