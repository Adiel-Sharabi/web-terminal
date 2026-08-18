'use strict';
// The 5-hour usage-limit rules (issues #69, #137, #138) — pure, no I/O.
//
// ONE question, asked in three places, so it is answered here once:
//   - pty-worker.js  — may this session's auto-resume timer arm at all?
//   - server.js      — what does the session list say the session is doing?
//   - both clients   — render whatever the server derived; they compute nothing.
//
// WHY THIS MODULE EXISTS AT ALL. #69 shipped the timer with a self-documented
// gap: it fired purely because a timestamp elapsed, guarded only by "the session
// isn't currently `working`". **"Not working" is not "capped."** A finished
// session, an idle shell, and a session waiting on you are all "not working", and
// every one of them would have been sent `continue` — spending quota and
// restarting work the user considered done. That was tolerable only while the
// feature was opt-in and OFF; #137 turns it on by default, which removes the
// mitigation and makes a real signal a prerequisite rather than a refinement.
//
// THE SIGNAL, and why it is an observation rather than a guess. Both agents
// already publish the 5h window's consumption as a whole 0-100 percentage —
// Claude in its status-line payload (`rate_limits.five_hour.used_percentage`),
// Codex in its rollout (`rate_limits.<300min window>.used_percent`) — normalised
// by lib/metrics-common.js `clampPct`, which ROUNDS. So an exhausted window
// arrives as exactly 100 from either agent, and CAP_BLOCKED_PCT can be an
// equality rather than a tuned threshold. Nothing here parses screen text or
// pattern-matches a message string: #138 was explicit that the cap message must
// be captured from a real event before anything depends on its wording, and
// nothing here does.
//
// What this deliberately does NOT claim: that the agent tried and was refused.
// It claims the account's 5h window is spent and has a future reset — which,
// combined with the caller's own "and this session is not mid-turn" check, is
// the strongest honest signal available without a captured cap event. See
// `capMessagePattern` in lib/agents.js for where a captured one plugs in.

/**
 * The 5h window is spent at exactly 100: `clampPct` rounds to a whole number, so
 * 99.5% and above already arrive here as 100 from both agents. An equality is
 * therefore precise, not strict — and it never mistakes a merely busy window
 * (a tuned 90-something threshold would) for an exhausted one.
 */
const CAP_BLOCKED_PCT = 100;

/**
 * How long after the window turns over the resume fires — #69's "~1 minute
 * after", a buffer so the account-side counter has actually rolled before we
 * retry rather than burning the one-shot on a boundary race.
 *
 * Here rather than in pty-worker.js because BOTH processes need it and they must
 * agree: the worker schedules the write, and server.js publishes `resumeAt` to
 * the UI. Two copies would mean a clock in the sidebar counting down to a moment
 * that is not when anything happens.
 */
const AUTO_RESUME_DELAY_MS = 60000;
const AUTO_RESUME_DELAY_FAST_MS = 50; // tests only, via WT_AUTO_RESUME_FAST=1

/** The delay this process should use, honouring the test shrink in both. */
function autoResumeDelayMs(env) {
  return (env && env.WT_AUTO_RESUME_FAST === '1') ? AUTO_RESUME_DELAY_FAST_MS : AUTO_RESUME_DELAY_MS;
}

/**
 * Is this session's agent blocked on its 5-hour usage cap right now?
 *
 * Requires BOTH halves, because either alone is a different situation:
 *   - the window is spent (`fiveH` at CAP_BLOCKED_PCT) — without this we are
 *     back to #69's bare timestamp, and
 *   - the reset is still AHEAD (`fiveHResetAt > now`) — a reset already in the
 *     past means the window has turned over, so whatever the percentage says is
 *     a stale reading, not a live block.
 *
 * `fiveH` null (unknown/stale — #56's rule 3: unknown renders as nothing, never
 * as 0) yields false. Refusing to act on an unknown is the safe direction here:
 * the cost of a missed auto-resume is a session you resume by hand, and the cost
 * of a false one is quota spent on work nobody asked to restart.
 */
function isCapBlocked({ fiveH, fiveHResetAt, now }) {
  if (typeof fiveH !== 'number' || !Number.isFinite(fiveH)) return false;
  if (fiveH < CAP_BLOCKED_PCT) return false;
  return isFutureReset(fiveHResetAt, now);
}

/** A usable, still-ahead reset timestamp? */
function isFutureReset(fiveHResetAt, now) {
  if (typeof fiveHResetAt !== 'number' || !Number.isFinite(fiveHResetAt) || fiveHResetAt <= 0) return false;
  return fiveHResetAt > (typeof now === 'number' ? now : Date.now());
}

/**
 * When the resume would fire: the reset plus the settle delay (#69's "~1 minute
 * after", so the account-side counter has actually rolled before we retry).
 * null when there is no usable reset time.
 */
function resumeAtFrom(fiveHResetAt, delayMs) {
  if (typeof fiveHResetAt !== 'number' || !Number.isFinite(fiveHResetAt) || fiveHResetAt <= 0) return null;
  const d = (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0) ? delayMs : 0;
  return Math.round(fiveHResetAt + d);
}

/**
 * The whole per-session usage-limit picture, derived in one pass so the wire
 * field, the arming decision and the UI can never disagree about it.
 *
 * `enabled` is the per-session opt-out (server-side pref, default on). It is
 * folded in HERE rather than at each call site so that "the user turned this
 * session off" is expressed once — an opted-out session reports `waiting: true`
 * (it IS still blocked, and hiding that would be a lie) with `armed: false`, so
 * the UI can honestly say "capped, resume off".
 *
 * @returns {{capBlocked, waiting, armed, resetAt, resumeAt, enabled}}
 */
function usageLimitState({ metrics, enabled, delayMs, now, observedBlockAt }) {
  const t = typeof now === 'number' ? now : Date.now();
  const m = metrics || {};
  const fiveH = typeof m.fiveH === 'number' ? m.fiveH : null;
  const resetAt = (typeof m.fiveHResetAt === 'number' && Number.isFinite(m.fiveHResetAt) && m.fiveHResetAt > 0)
    ? m.fiveHResetAt : null;
  // TWO sources, either sufficient. `observedBlockAt` is the worker having SEEN the
  // agent's own cap prompt (#138) — a direct observation, so it does not need the
  // percentage to corroborate it and works even when metrics are absent or stale.
  // The metrics route stays because it covers an agent with no such prompt, and a
  // session that was already capped before this server started watching.
  const observed = typeof observedBlockAt === 'number' && Number.isFinite(observedBlockAt) && observedBlockAt > 0;
  const capBlocked = observed || isCapBlocked({ fiveH, fiveHResetAt: resetAt, now: t });
  const on = enabled !== false;
  return {
    capBlocked,
    // `waiting` is what the UI keys the "in the wait period" indicator on: the
    // session is sitting out a window it cannot use. Independent of `enabled`,
    // deliberately — see above.
    waiting: capBlocked,
    // `armed` is the narrower claim: a resume is actually SCHEDULED to fire — which
    // needs a reset time, not just a block. The worker cannot arm a timer without
    // one (armAutoResumeTimer returns early), so reporting armed here on the block
    // alone would have the badge promise a resume nothing was going to make. That
    // is the precise disagreement this module exists to prevent, and it is reachable:
    // the cap PROMPT can be seen before any resets_at has been read.
    armed: capBlocked && on && resetAt !== null,
    resetAt,
    resumeAt: capBlocked ? resumeAtFrom(resetAt, delayMs) : null,
    enabled: on,
  };
}

module.exports = {
  CAP_BLOCKED_PCT, AUTO_RESUME_DELAY_MS, AUTO_RESUME_DELAY_FAST_MS, autoResumeDelayMs,
  isCapBlocked, isFutureReset, resumeAtFrom, usageLimitState,
};
