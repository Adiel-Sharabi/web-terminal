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
// What the PERCENTAGE rule deliberately does NOT claim: that the agent tried and
// was refused. It claims the account's 5h window is spent and has a future reset
// — which, combined with the caller's own "and this session is not mid-turn"
// check, is the strongest honest signal available without a captured cap event.
//
// A captured one now exists, and it lives in lib/agents.js as `usageLimitPrompt`
// (the field this header used to call `capMessagePattern`, which never existed).
// `matchUsageLimitPrompt` below is the rule that reads it. It is here rather than
// in pty-worker.js for the same reason everything else in this file is: the rule
// is pure and must be testable without a PTY, and the worker owns only the place
// where bytes meet a real terminal.

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
 * How long past the scheduled resume a spent window still counts as blocked.
 *
 * THIS CONSTANT EXISTS BECAUSE THE FIRST CUT WAS SELF-DEFEATING. `isCapBlocked`
 * originally required the reset to be in the FUTURE — but the resume deliberately
 * fires a minute AFTER the window turns over (#69's settle buffer). So in exactly
 * that minute the derivation flipped to "not blocked", the next session poll pushed
 * it, and the worker cancelled the very timer it was about to fire. For any session
 * detected through metrics alone — every Codex session — the resume could
 * essentially never happen. Found by review, not by a test, because the worker specs
 * inject `capBlocked` over the RPC and never cross the reset boundary.
 *
 * The grace also covers the legitimate catch-up: a worker down across the reset arms
 * with an already-elapsed deadline and fires at once (#69). Bounded, so a genuinely
 * stale reading — a window that turned over hours ago — still arms nothing.
 */
const CAP_BLOCK_GRACE_MS = 10 * 60 * 1000;

/** Is the 5h window's quota exhausted? (null/unknown is NOT exhausted.) */
function isWindowSpent(fiveH) {
  return typeof fiveH === 'number' && Number.isFinite(fiveH) && fiveH >= CAP_BLOCKED_PCT;
}

/**
 * Is this session's agent blocked on its 5-hour usage cap, for ARMING purposes?
 *
 * Requires the window to be spent AND its resume still pending-or-recent. "Recent"
 * rather than "future" is the whole fix described on CAP_BLOCK_GRACE_MS: the deadline
 * that matters is when we ACT (resetAt + delay), not when the window turns over, and
 * the answer must not flip to false in between.
 *
 * `fiveH` null (unknown/stale — #56's rule 3: unknown renders as nothing, never as 0)
 * yields false. Refusing to act on an unknown is the safe direction: a missed resume
 * costs a manual click, a false one costs quota restarting work nobody asked about.
 * But the CALLER must not confuse "unknown" with "recovered" — pushing a stale blank
 * to the worker as "not blocked" was its own bug, see server.js
 * armResetTimerFromMetrics.
 */
function isCapBlocked({ fiveH, fiveHResetAt, now, delayMs, graceMs }) {
  if (!isWindowSpent(fiveH)) return false;
  const resumeAt = resumeAtFrom(fiveHResetAt, delayMs === undefined ? AUTO_RESUME_DELAY_MS : delayMs);
  if (resumeAt === null) return false;
  const grace = (typeof graceMs === 'number' && Number.isFinite(graceMs)) ? graceMs : CAP_BLOCK_GRACE_MS;
  return (resumeAt + grace) > (typeof now === 'number' ? now : Date.now());
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
 * The whole per-session usage-limit picture, derived in one pass so the wire field,
 * the arming decision and the UI can never disagree about it.
 *
 * TWO deadlines, because arming and display genuinely want different ones:
 *   - `capBlocked` (arming) runs to resumeAt + CAP_BLOCK_GRACE_MS, so the gate cannot
 *     cancel the timer during the settle minute — see CAP_BLOCK_GRACE_MS.
 *   - `waiting` (the badge) runs to resumeAt, so the row stops saying "resumes 14:32"
 *     when 14:32 arrives rather than a minute early. Keying the badge on the same
 *     future-reset test made it vanish 60s BEFORE the thing it was announcing.
 *
 * `enabled` is the per-session opt-out. Folded in HERE rather than at each call site
 * so "the user turned this session off" is expressed once — an opted-out session
 * reports `waiting: true` (it IS still capped, and hiding that would be a lie) with
 * `armed: false`, so the UI can honestly say "capped, resume off".
 *
 * @returns {{capBlocked, waiting, armed, resetAt, resumeAt, enabled}}
 */
function usageLimitState({ metrics, enabled, delayMs, now, observedBlockAt, canArm }) {
  const t = typeof now === 'number' ? now : Date.now();
  const d = (typeof delayMs === 'number' && Number.isFinite(delayMs)) ? delayMs : AUTO_RESUME_DELAY_MS;
  const m = metrics || {};
  const fiveH = typeof m.fiveH === 'number' ? m.fiveH : null;
  const resetAt = (typeof m.fiveHResetAt === 'number' && Number.isFinite(m.fiveHResetAt) && m.fiveHResetAt > 0)
    ? m.fiveHResetAt : null;
  const resumeAt = resumeAtFrom(resetAt, d);

  // TWO sources, either sufficient. `observedBlockAt` is the worker having SEEN the
  // agent's own cap prompt (#138) — a direct observation, so it needs no percentage
  // to corroborate it and works when metrics are absent or stale. The metrics route
  // covers an agent with no such prompt, and a session already capped before this
  // server started watching.
  const observed = typeof observedBlockAt === 'number' && Number.isFinite(observedBlockAt) && observedBlockAt > 0;
  const capBlocked = observed || isCapBlocked({ fiveH, fiveHResetAt: resetAt, now: t, delayMs: d });
  const spent = isWindowSpent(fiveH);
  const on = enabled !== false;
  return {
    capBlocked,
    // Held, as the row shows it: an observed cap prompt (time may be unknown), or a
    // spent window whose resume has not come round yet.
    waiting: observed || (spent && resumeAt !== null && resumeAt > t),
    // `armed` is the narrower claim: a resume is actually SCHEDULED. It needs a reset
    // time, not just a block — the worker cannot arm a timer without one
    // (armAutoResumeTimer returns early), so claiming armed on the block alone would
    // have the badge promise a resume nothing was going to make. Reachable: the cap
    // PROMPT can be seen before any resets_at has been read.
    // canArm is the AGENT's capability (registry), distinct from `enabled`, which is
    // the user's per-session choice. Defaults true so a caller that does not know
    // about agents (and every existing test) behaves as before. It narrows `armed`
    // only, never `waiting` - a Codex session really IS held, and hiding that would
    // be the lie. It simply has nothing scheduled.
    armed: capBlocked && on && canArm !== false && resetAt !== null,
    resetAt,
    resumeAt: (capBlocked || spent) ? resumeAt : null,
    enabled: on,
  };
}

/**
 * One RENDERED menu option: an optional selection cursor, the option's own number,
 * a separator and some text — anchored at the START of the line.
 *
 * The anchor is load-bearing, and it is the cheaper half of the false-positive fix
 * below. A menu option begins its line; a mention of one inside prose, a comment or
 * a quoted string does not.
 */
const MENU_OPTION_LINE = /^[^\S\r\n]*(?:[>❯»•*][^\S\r\n]*)?(\d)[.)][^\S\r\n]+\S/;

/**
 * The digit to press for "stop and wait" if this text contains the agent's real cap
 * SELECTOR, else null. `cfg` is the provider's `usageLimitPrompt` (lib/agents.js).
 *
 * WHY THIS IS MORE THAN `cfg.pattern.test(text)`. The worker answers by WRITING A
 * KEYSTROKE into somebody's live terminal, so a match is an action, not a reading —
 * and the first cut matched the option sentence anywhere in the scanned output. THIS
 * REPO'S OWN SOURCE IS THEN A TRIGGER PHRASE: lib/agents.js carries the captured
 * render verbatim in a comment (`> 1. Stop and wait for limit to reset`) and
 * tests/reset-resume.spec.js assembles it, so a Claude session working in this
 * checkout that cat'd, grepped or diffed either file typed a stray `1` into its
 * composer and recorded a cap block that never happened. Bounded harm — the next
 * hook clears the latch and fireAutoResume re-checks — but a keystroke caused by
 * READING A FILE is a false positive by any standard. The "no numbered menu means no
 * match" defence explicitly did not cover it: those lines DO carry a numbered menu.
 *
 * Two independent barriers, both derived from what a selector actually looks like on
 * screen and neither from the wording:
 *   1. the sentence must BE a rendered option line — at the line's start, per
 *      MENU_OPTION_LINE. A `//` or a `'` in front of it is not a menu.
 *   2. a sibling option line must sit directly above or below it. One lone number is
 *      prose; a selector always offers a choice. ABOVE OR BELOW, not just below —
 *      "stop and wait" is the LAST option in the reordered render, and requiring a
 *      follower would have quietly stopped answering it.
 *
 * The answer is the option's OWN rendered number (`cfg.answer` only if a render ever
 * carries none), so a reordered menu still picks the right row rather than buying a
 * plan upgrade.
 */
function matchUsageLimitPrompt(text, cfg) {
  if (!cfg || !(cfg.pattern instanceof RegExp)) return null;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const isOption = (i) => (i >= 0 && i < lines.length ? MENU_OPTION_LINE.exec(lines[i]) : null);
  for (let i = 0; i < lines.length; i++) {
    if (cfg.pattern.global || cfg.pattern.sticky) cfg.pattern.lastIndex = 0;
    if (!cfg.pattern.test(lines[i])) continue;
    const own = isOption(i);
    if (!own) continue;
    if (!isOption(i - 1) && !isOption(i + 1)) continue;
    return own[1] || cfg.answer || null;
  }
  return null;
}

module.exports = {
  CAP_BLOCKED_PCT, CAP_BLOCK_GRACE_MS,
  AUTO_RESUME_DELAY_MS, AUTO_RESUME_DELAY_FAST_MS, autoResumeDelayMs,
  isWindowSpent, isCapBlocked, isFutureReset, resumeAtFrom, usageLimitState,
  MENU_OPTION_LINE, matchUsageLimitPrompt,
};
