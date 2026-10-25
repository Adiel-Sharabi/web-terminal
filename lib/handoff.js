'use strict';
// --- Hand a long-running session off to a fresh one (#340) -------------------------
//
// A Claude session that has run for days carries hundreds of thousands of tokens of
// context, and every turn re-reads all of it. Measured on this fleet (the #340 issue's
// comments): multi-day sessions are ~80% of main-session spend, and above ~700k the
// agent starts losing track of what it already read (redundant re-reads 16% vs ~5%).
// #393: a 400k auto-compact window is now live on every machine, so compaction (at about
// 367k) bounds every session, and a threshold above it can never be reached - the 500k
// this rule shipped with offered nothing after 2026-10-18. Compaction fires MID-TASK,
// wherever the context happens to fill; this rule is the chance to reset first.
//
// So the reset happens at a TASK BOUNDARY: the session is idle, its own report
// says it is waiting on someone else or done, and it is big. The old session writes a
// brief and says whether anything would be lost by closing it; a successor starts from
// the brief; the old one closes only once the successor is proven up and the verdict is
// clean. Every failure leaves the old session exactly where it was.
//
// This file owns every RULE: who is a candidate, the two prompts, what the agent may
// post back, and the run's transitions and timeouts. server.js owns the I/O (the PTY
// writes, the session create/kill, the store). Pure: no I/O, every clock is `now`.

const { clip } = require('./session-brief');
const { HANDOFF_PROMPT_TAG: TAG } = require('./user-turn');
const { withoutLaunchPrompt } = require('./launch-prompt');
const { occupancy } = require('./context-budget');

// Context OCCUPANCY (tokens) at or above which a session is offered a hand-off has no
// default here (#393): unless `config.handoff.ctxThreshold` sets one, it is the session's
// own context budget (`metrics.budget.handoffAt`, lib/context-budget.js), so it moves
// with the agent's auto-compact window instead of sitting above it.
const DEFAULTS = Object.freeze({
  // How long the agent's turn must have been over: a session that just stopped is
  // often about to be prompted again.
  idleMin: 10,
  // The old session has this long to post its brief and verdict.
  wrapTimeoutMs: 15 * 60 * 1000,
  // The successor has this long, from the first prompt being sent, to start a turn.
  successorTimeoutMs: 3 * 60 * 1000,
  // The successor's composer must come up within this (the worker's own readiness
  // fallback is 45s, so this only trips on a launch that never produced a session).
  readyTimeoutMs: 90 * 1000,
  // Once the successor is up, the old session has this long to finish its own turn
  // before the run gives up on closing it and ends `kept` (still-busy).
  closeTimeoutMs: 15 * 60 * 1000,
  // #345 - how often the server looks for a session to hand off on its own.
  autoEveryMs: 60 * 1000,
});

/// Brief files older than this are removed when a new hand-off starts. The successor
/// reads its brief at once; a week covers a person going back to look at it.
const BRIEF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/// The run's states. In flight: wrapping -> spawning -> verifying -> closing. Terminal:
/// `kept` (the successor is up, the old session stayed because its verdict said
/// something would be lost) and `failed` (with a reason; the old session is untouched).
/// A run that SUCCEEDS has no terminal state on the old entry: the session closes.
const ACTIVE_STATES = Object.freeze(['wrapping', 'spawning', 'verifying', 'closing']);
const TERMINAL_STATES = Object.freeze(['kept', 'failed']);

/// The gates `force` may skip: the ones that are JUDGEMENT (long enough idle, at a
/// boundary, big enough, metrics known). Never the ones that are SAFETY: a session that
/// is mid-turn, asking a question, capped, compacting, booting or parked in a menu would
/// take the wrap-up prompt as navigation or queue it behind work in flight.
const FORCEABLE_GATES = Object.freeze(['recent', 'no-boundary', 'small', 'no-metrics']);

/// Item states that mean "this item needs nothing more from this session".
const FINISHED_ITEM_STATES = Object.freeze(['done', 'committed', 'ready-for-test']);

/// `liveConfig('handoff')` over the defaults. Bad values fall back to the default
/// rather than switching the rule off or making every session a candidate.
function handoffConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (k) => (typeof c[k] === 'number' && Number.isFinite(c[k]) && c[k] > 0 ? c[k] : DEFAULTS[k]);
  return {
    enabled: c.enabled !== false,
    // #345 - start a hand-off without a press when the rule offers one. On unless false.
    auto: c.auto !== false,
    // null = not set: the session's budget decides (handoffCandidate).
    ctxThreshold: num('ctxThreshold') ?? null, idleMin: num('idleMin'),
    wrapTimeoutMs: num('wrapTimeoutMs'), successorTimeoutMs: num('successorTimeoutMs'),
    readyTimeoutMs: num('readyTimeoutMs'), closeTimeoutMs: num('closeTimeoutMs'),
    autoEveryMs: num('autoEveryMs'),
  };
}

/// The occupancy at which [metrics] is big enough: the explicit config, else the
/// session's published budget. null when neither is known.
function ctxThresholdFor(cfg, metrics) {
  if (cfg && Number.isFinite(cfg.ctxThreshold)) return cfg.ctxThreshold;
  const b = metrics && metrics.budget;
  return b && Number.isFinite(b.handoffAt) && b.handoffAt > 0 ? b.handoffAt : null;
}

function isActive(run) { return Boolean(run && ACTIVE_STATES.includes(run.state)); }

/// Is the work at a boundary, by the session's own report? Waiting on a third party
/// (a PR review, a CI run someone else owns) or nothing pending; or every item it names
/// needs nothing more from it.
function atBoundary(brief) {
  const b = brief || {};
  const w = b.wait;
  if (w && (w.on === 'external' || w.on === 'done')) return true;
  const items = Array.isArray(b.items) ? b.items : [];
  return items.length > 0 && items.every((it) => it && FINISHED_ITEM_STATES.includes(it.state));
}

/// The `handoff` field on a shaped session row. Reads ONLY published row fields, so the
/// two row shapers (and a peer's rows) can never disagree. null = this agent does not
/// support hand-off at all (a client offers nothing); otherwise `suggest` says whether
/// to offer it now, `why` names the first gate that said no, and `run` is the hand-off
/// in progress or its terminal outcome.
///
/// @param {object} row  { agent, status, waitingFor, compacting, agentReady, usageLimit,
///                      backgroundTasks, metrics, brief, reason }
/// @param {{now:number, cfg:object, supported:boolean}} opts  `supported` is the
///        registry's answer for row.agent (lib/agents.js handsOff) - asked by the caller
///        so this module stays free of the registry.
function handoffCandidate(row, { now, cfg, supported }) {
  if (!supported) return null;
  const r = row || {};
  const c = cfg || handoffConfig(null);
  const b = r.brief || {};
  const run = b.handoff || null;
  const ctxTokens = occupancy(r.metrics);
  const out = (why) => ({ suggest: !why, why: why || null, ctxTokens, run });
  if (!c.enabled) return out('disabled');
  if (isActive(run)) return out('in-progress');
  if (b.hidden) return out('hidden');
  if (r.status !== 'idle') return out('not-idle');
  if (r.waitingFor) return out('waiting');
  if (r.compacting) return out('compacting');
  if (r.agentReady === false) return out('not-ready');
  if (r.usageLimit && r.usageLimit.waiting) return out('capped');
  if (r.reason && (r.reason.kind === 'self' || r.reason.kind === 'menu' || r.reason.kind === 'you')) return out(`reason-${r.reason.kind}`);
  const stopped = Number.isFinite(b.stoppedAt) && (!Number.isFinite(b.turnAt) || b.stoppedAt >= b.turnAt) ? b.stoppedAt : null;
  if (stopped === null || now - stopped < c.idleMin * 60 * 1000) return out('recent');
  if (!atBoundary(b)) return out('no-boundary');
  const threshold = ctxThresholdFor(c, r.metrics);
  if (ctxTokens === null || threshold === null) return out('no-metrics');
  if (ctxTokens < threshold) return out('small');
  return out(null);
}

/// Why the server may NOT start a hand-off on its own for this session (#345), or null.
/// Whether one is OFFERED is handoffCandidate's; this is whether nobody already said no.
/// A person's Cancel or Dismiss (`handoffDeclinedAt`), and a run that ended kept or
/// failed, stand until a person TYPES into the session again (`prompt.at`; a task
/// notification is not a person). Without that, a wrap-up that fails would be retried
/// every ten minutes forever, and a session kept for unsaved work would grow a new
/// successor on every retry.
/// And never while someone is at the keyboard: keystrokes reach the PTY with no hook, so a
/// half-typed prompt is invisible to every other gate, and the wrap-up typed onto the same
/// line would be submitted WITH it. [inputAt] is the last keystroke any client sent
/// (server.js; in memory, so unknown after a reload, when the hook gates still hold).
/// @param {object} entry  the session's raw brief entry (server.js briefStore)
function autoBlock(entry, cfg, { now, inputAt } = {}) {
  const c = cfg || handoffConfig(null);
  if (!c.enabled || !c.auto) return 'auto-off';
  const e = entry || {};
  const run = e.handoff || null;
  if (isActive(run)) return 'in-progress';
  if (Number.isFinite(inputAt) && Number.isFinite(now) && now - inputAt < c.idleMin * 60 * 1000) return 'typing';
  const typedAt = e.prompt && Number.isFinite(e.prompt.at) ? e.prompt.at : null;
  const since = (t) => Number.isFinite(t) && !(typedAt !== null && typedAt > t);
  if (since(e.handoffDeclinedAt)) return 'declined';
  if (run && TERMINAL_STATES.includes(run.state) && since(run.at)) return 'tried';
  return null;
}

/// One line of the hand-off log (#345): every start and every outcome, so automatic
/// hand-offs can be judged afterwards (and the feature reverted if they are bad).
/// `event` is started | closed | kept | failed | cancelled | dismissed | exited.
function logRecord(event, id, run, now, extra) {
  const r = run || {};
  return {
    at: new Date(now).toISOString(), event, id,
    trigger: r.trigger || null,
    ...(extra || {}),
    state: r.state || null, reason: r.reason || null,
    verdict: r.verdict || null, successorId: r.successorId || null, successorName: r.successorName || null,
    briefFile: r.briefFile || null,
    tookMs: Number.isFinite(r.startedAt) ? now - r.startedAt : null,
  };
}

/// The hand-off brief's file. Named by the server, never by the agent, so a post cannot
/// point the successor at an arbitrary path. One per old session id (a UUID).
function briefFileName(oldId) {
  return `handoff-${oldId}.md`;
}

/// The prompt typed into the OLD session. Single line on purpose: a compose submit with
/// no newline is plain text + CR (the #55 contract), which the worker brackets above
/// 512 bytes for Claude (#213), so it is delivered exactly as a person's dictated prompt.
/// GitHub comments need the owner's approval of the draft, so the wrap-up never posts
/// one: the brief file and the dashboard report carry the state instead.
function wrapUpPrompt({ briefFile, scriptPath }) {
  const s = String(scriptPath).replace(/\\/g, '/');
  return [
    `${TAG} This session is being handed off to a fresh session to save context.`,
    'Do not start new work. Do these four steps, then stop:',
    '(1) Bring the tracker up to date for every work item you are on. Azure DevOps: the usual short comment and notes attachment.',
    'GitHub issues: post NO comment (comments need approval); the brief is enough.',
    `(2) Write a self-contained brief for your successor to ${briefFile} - the goal, where things stand, the exact next steps,`,
    'branches, PRs and worktrees involved, what you are waiting on and how to check it, and the key files. Your successor has none of your context.',
    '(3) Check whether anything would be lost if this session closed now: uncommitted or unpushed changes, a worktree or a background job only you know about.',
    `(4) Post your verdict to node "${s}" exactly as you send a dashboard report (the JSON in a quoted heredoc on stdin):`,
    '{"canClose": true, "why": "one line"} - canClose false if anything would be lost, and say what in why.',
  ].join(' ');
}

/// The first prompt typed into the SUCCESSOR, once its composer is up.
function successorPrompt({ briefFile, oldName }) {
  const n = clip(oldName || 'the previous session', 80).replace(/"/g, "'");
  return `${TAG} You continue the work of the session "${n}", which was handed off to save context. `
    + `Read the brief at ${briefFile} first and carry on from it: it says what is done, what is next, and what to wait on. `
    + 'Then report your work items to the dashboard as usual.';
}

const _escRe = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// The command that starts a FRESH conversation from a session's launch command: every
/// flag that would put it back on an existing conversation is removed. WHICH flags those
/// are is the agent's, declared in the registry (lib/agents.js `handoff.resumeFlags`):
/// `withValue` take an id (`--resume <id>`, `--resume=<id>`), `bare` take none. null when
/// the result does not launch the agent at all (the caller then tries the default
/// command), or when the agent declares no flags (nothing to say what is safe to keep).
/// #360: the OLD session's launch prompt goes too (`grammar` is the registry's
/// `launchGrammar`) - the successor's task is the brief, not the one the old session
/// was started with and has long since worked on.
function freshLaunchCommand(autoCommand, launches, policy, grammar) {
  if (typeof autoCommand !== 'string' || !autoCommand.trim()) return null;
  const flags = policy && policy.resumeFlags;
  if (!flags) return null;
  let cmd = withoutLaunchPrompt(autoCommand, grammar, launches);
  for (const f of flags.withValue || []) {
    cmd = cmd.replace(new RegExp(`\\s+${_escRe(f)}(?=[\\s=]|$)(?:[\\s=]+(?!-)\\S+)?`, 'g'), '');
  }
  for (const f of flags.bare || []) cmd = cmd.replace(new RegExp(`\\s+${_escRe(f)}(?=\\s|$)`, 'g'), '');
  cmd = cmd.replace(/\s+/g, ' ').trim();
  return cmd && launches(cmd) ? cmd : null;
}

/// The successor's name. A second hand-off of "x (2)" names "x (3)", not "x (2) (2)".
function successorName(oldName) {
  const n = typeof oldName === 'string' && oldName.trim() ? oldName.trim() : 'Session';
  const m = n.match(/^(.*) \((\d+)\)$/);
  return clip(m ? `${m[1]} (${Number(m[2]) + 1})` : `${n} (2)`, 100);
}

/// What the old session posts through scripts/wt-handoff.js. Returns `{verdict}` or an
/// `{error}` written for the AGENT to read and fix.
function validateHandoffReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object like {"canClose": true, "why": "one line"}' };
  if (typeof body.canClose !== 'boolean') return { error: '"canClose" must be true or false' };
  const why = clip(body.why, 200);
  if (!body.canClose && !why) return { error: 'canClose is false: say in "why" what would be lost' };
  return { verdict: { canClose: body.canClose, why: why || null } };
}

/// A new run, persisted on the old session's brief entry.
/// `trigger` (#345) says who started it: auto (the server), manual (a press), forced.
function startRun(now, briefFile, trigger) {
  return { state: 'wrapping', startedAt: now, at: now, reason: null, briefFile, verdict: null,
    verdictAt: null, successorId: null, successorName: null, sentAt: null,
    trigger: ['auto', 'manual', 'forced'].includes(trigger) ? trigger : 'manual' };
}

/// Is [cur] still the run [expected] was read as - same run (start time), same state?
/// The server writes a run only when this holds, so a Cancel (or a new run) that landed
/// while it awaited the worker always wins over its stale view.
function sameRun(cur, expected) {
  return Boolean(cur && expected && cur.startedAt === expected.startedAt && cur.state === expected.state);
}

/// What `closing` does now, from the OLD session's live state. The verdict is posted from
/// INSIDE the wrap-up turn, so "the successor is up" alone would kill a session mid-turn.
///   keep  the verdict said something would be lost (unsaved-work); someone prompted it
///         after the verdict (in-use); or it never finished its turn in time (still-busy)
///   kill  its own turn is over and nothing new started since the verdict
///   wait  otherwise
function closeDecision(run, old, now, cfg) {
  const c = cfg || handoffConfig(null);
  const o = old || {};
  if (!(run && run.verdict && run.verdict.canClose)) return { action: 'keep', reason: 'unsaved-work' };
  if (Number.isFinite(o.turnAt) && Number.isFinite(run.verdictAt) && o.turnAt > run.verdictAt) {
    return { action: 'keep', reason: 'in-use' };
  }
  const turnOver = !Number.isFinite(o.turnAt) || (Number.isFinite(o.stoppedAt) && o.stoppedAt >= o.turnAt);
  if (o.status === 'idle' && turnOver) return { action: 'kill' };
  if (now - run.at > c.closeTimeoutMs) return { action: 'keep', reason: 'still-busy' };
  return { action: 'wait' };
}

function transition(run, state, now, extra) {
  return { ...run, ...(extra || {}), state, at: now };
}

function fail(run, reason, now) {
  return transition(run, 'failed', now, { reason });
}

/// The timeout a run has overrun, or null. Wrapping is measured from the start;
/// spawning from when it began (a successor that never shows a composer); verifying
/// from the moment the first prompt was sent.
function overrun(run, now, cfg) {
  const c = cfg || handoffConfig(null);
  if (!run) return null;
  if (run.state === 'wrapping' && now - run.startedAt > c.wrapTimeoutMs) return 'no-brief';
  if (run.state === 'spawning' && now - run.at > c.readyTimeoutMs) return 'successor-not-ready';
  if (run.state === 'verifying' && now - (run.sentAt || run.at) > c.successorTimeoutMs) return 'successor-not-up';
  return null;
}

/// The run as published on the wire.
function publicRun(run) {
  if (!run || typeof run !== 'object') return null;
  const { state, reason, startedAt, at, successorId, successorName: sName, verdict, trigger } = run;
  return { state, reason: reason || null, startedAt: startedAt || null, at: at || null, trigger: trigger || null,
    successorId: successorId || null, successorName: sName || null,
    keptBecause: verdict && verdict.canClose === false ? verdict.why : null };
}

module.exports = {
  DEFAULTS, BRIEF_TTL_MS, ACTIVE_STATES, TERMINAL_STATES, FINISHED_ITEM_STATES, FORCEABLE_GATES,
  handoffConfig, occupancy, ctxThresholdFor, isActive, atBoundary, handoffCandidate, autoBlock, logRecord,
  briefFileName, wrapUpPrompt, successorPrompt, freshLaunchCommand, successorName,
  validateHandoffReport, startRun, sameRun, closeDecision, transition, fail, overrun, publicRun,
};
