'use strict';
// --- WHY a session that is not working is not working (#313) ----------------------
//
// The status dot tracks the agent's TURN. Once a turn ends every session reads the
// same idle green, whether it will wake itself when CI finishes, is waiting for the
// person to do something, is blocked on a third party, or is genuinely done. This
// module is the ONE answer to "why", computed on the server and published on every
// session row as `reason`, so `app.html` and the companion render it and never
// re-derive it.
//
// Sources, strongest first. A mechanical signal always beats what the agent reported,
// because a report is a sentence written at the end of some earlier turn and nothing
// expires it but the next one:
//   1. status `working`              -> working  (a turn is running)
//   2. status `waiting`              -> you      (a question or permission prompt is up)
//   2b. a panel over the composer    -> menu     (#316: /status, /usage, Agent View...;
//                                                 a prompt sent now goes nowhere)
//   3. usage cap in force            -> self     (it resumes at the reset)
//   4. live background work          -> self     (a build/CI shell is running; stale
//                                                 orphans do NOT count)
//   5. the agent's reported `wait`   -> you | self | external | done
//   6. nothing                       -> null: the client renders exactly what it did
//                                       before this existed.
//
// "Parked in a menu" comes from the worker (`inMenu`, lib/menu-state.js), which reads
// the order of the composer marker and a panel footer in the PTY stream. A slash menu
// prints no footer and is not covered.
//
// Pure: no I/O, no clock reads except through `now`.

const REASON_KINDS = Object.freeze(['working', 'you', 'menu', 'self', 'external', 'done']);

/// @param {object} row  a shaped session row: { status, waitingFor, usageLimit,
///                      backgroundTasks, brief }
/// @returns {{kind: string, text: string, since: number|null, source: string}|null}
function sessionReason(row) {
  const r = row || {};
  if (r.status === 'working') return { kind: 'working', text: '', since: null, source: 'status' };
  if (r.status === 'waiting') {
    return {
      kind: 'you',
      text: r.waitingFor === 'question' ? 'answer a question' : 'approve a tool',
      since: null,
      source: 'status',
    };
  }
  if (r.inMenu === true) return { kind: 'menu', text: 'Esc to return', since: null, source: 'screen' };
  const cap = r.usageLimit;
  if (cap && cap.waiting) {
    // Only an ARMED cap resumes by itself (the worker's own answer, #227). A capped
    // session nothing will resume - auto-resume off, or an agent that cannot be resumed
    // - is not "running on its own"; it keeps its plain "Capped" status (null here).
    if (!cap.armed) return null;
    const at = cap.resetAt || cap.resumeAt || null;
    return { kind: 'self', text: 'usage cap', since: null, until: Number.isFinite(at) ? at : null, source: 'usage-limit' };
  }
  const live = (Array.isArray(r.backgroundTasks) ? r.backgroundTasks : []).filter((t) => t && !t.stale);
  if (live.length) {
    const t = live[0];
    const what = typeof t.description === 'string' && t.description.trim() ? t.description.trim() : 'background command';
    return {
      kind: 'self',
      text: live.length > 1 ? `${what} +${live.length - 1}` : what,
      since: Number.isFinite(t.startedAt) ? t.startedAt : null,
      source: 'background',
    };
  }
  const w = r.brief && r.brief.wait;
  if (w && REASON_KINDS.includes(w.on) && w.on !== 'working' && w.on !== 'menu') {
    return { kind: w.on, text: typeof w.what === 'string' ? w.what : '', since: Number.isFinite(w.at) ? w.at : null, source: 'reported' };
  }
  return null;
}

module.exports = { REASON_KINDS, sessionReason };
