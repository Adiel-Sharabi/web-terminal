'use strict';
// #483 - switch this machine's Claude login to the next saved account when the active one
// has spent its WEEKLY window, and say so over ntfy. The rules, pure: server.js owns the
// I/O (the status-line route that feeds readings in, lib/claude-account.js for the switch,
// the ntfy sender, the state file), and asks this module every question.
//
// THE HARD PART IS "WHOSE READING IS THIS?". A status-line payload carries the account's
// rate limits as of the session's LAST API response, and nothing in it names the account.
// Claude re-renders its status line on many events, so a payload that arrives a minute
// after a switch can still carry the OLD account's numbers: the session simply has not
// called the API since. Acting on it would switch away from an account nobody has used.
//
// So a reading counts for the account active since the last switch only when it PROVES it
// came from an API response that began after that switch, AND it does not name a window
// proven to be the old account's (#490, below). The payload's cost block carries
// `total_api_duration_ms`, which grows by the duration of every API response the session
// has had. A report in which it grew by `delta` ms since the PREVIOUS report reflects
// responses that ended after that previous report (else it would have counted them) and
// took `delta` ms in total, so each of them began no earlier than `previousAt - delta`.
// (Not `receivedAt - delta`: a response can end long before the report that first shows
// it, when a push was lost.) If that bound is after the switch, with a margin for the
// status line's own render delay, every response behind the reading ran on the new login.
// A report in which the counter did not grow is a re-render and proves nothing.
//
// #490 - THE COUNTER ALONE IS NOT ENOUGH. A running Claude process does not pick up the
// new login at once, and a refused request grows the counter too, so a response that began
// well after a switch can still carry the OLD account's rate limits. Seen on 2026-11-23: a
// switch by hand to account B, then 19 s later a counted 100% reading made the automatic
// switch go BACK to the spent account A, filing B as capped until A's reset time. The
// reading names its window, though: `sevenDResetAt` is per account. So at every switch the
// reset times proven for the account switched away from (its counted readings) are kept
// as `oldWindows`, and a later reading naming one of them is never the new account's.
// Windows are taken only at a switch whose outgoing account is KNOWN (the server recorded
// that login), and never from a reading that already named an older old window - else a
// switch back to an account would file that account's own window as old. Two accounts whose
// weeks reset within RESET_SAME_MS of each other would then never switch: that fails toward
// no switch, which is the state before #483.
//
// #490 - WHEN. Claude does not re-render its status line when it refuses a request at the
// weekly limit, so a session parks on the limit menu with its last pushed reading at 98 or
// 99%: a trigger at 100% never fired. The switch point is `switchAtPct` (default 95), a
// reading a response actually carried on the way up.
//
// What this does NOT use as a trigger: the worker seeing Claude's usage-limit prompt. That
// proves the active account was refused, but not which window refused it, and whether a
// refused request refreshes the status line's rate limits is unmeasured - so the reading
// beside the prompt may still be the previous account's. The prompt still drives the resume
// (a capped session resumes on the new account through the #69 auto-resume path).

const { isWindowSpent, resumeAtFrom, AUTO_RESUME_DELAY_MS, CAP_BLOCK_GRACE_MS } = require('./usage-limit');
const { ntfyTarget } = require('./notify-push');

const MINUTE_MS = 60 * 1000;
const COOLDOWN_MINUTES_DEFAULT = 30;
const COOLDOWN_MINUTES_MIN = 5;
const COOLDOWN_MINUTES_MAX = 24 * 60;
// The status line pushes within a moment of the response it renders; this covers that lag
// (and a clock tick) so a response that began just before the switch is never counted.
const REPORT_MARGIN_MS = 5000;
// #490 - the weekly percentage at which to switch. 100 is the refusal itself, which the
// status line never reports (see the header).
const SWITCH_AT_PCT_DEFAULT = 95;
const SWITCH_AT_PCT_MIN = 50;
const SWITCH_AT_PCT_MAX = 100;
// #490 - two reset times this close name one window (Claude reports them in whole seconds,
// on the hour; this absorbs a drift between responses).
const RESET_SAME_MS = 60 * 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The `claudeAccountAutoSwitch` config block, read live. OFF unless `enabled` is exactly
 * true. Its ntfy target is its own: the top-level `ntfy` key also turns on every
 * session-event push, which a machine may not want.
 */
function autoSwitchConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const m = num(c.cooldownMinutes);
  const minutes = m === null ? COOLDOWN_MINUTES_DEFAULT : Math.min(COOLDOWN_MINUTES_MAX, Math.max(COOLDOWN_MINUTES_MIN, m));
  const p = num(c.switchAtPct);
  const atPct = p === null ? SWITCH_AT_PCT_DEFAULT : Math.min(SWITCH_AT_PCT_MAX, Math.max(SWITCH_AT_PCT_MIN, p));
  return { enabled: c.enabled === true, cooldownMs: Math.round(minutes * MINUTE_MS), atPct, ntfy: ntfyTarget(c.ntfy) };
}

/**
 * Fold one status report into a session's reading. `prev` is the session's last reading
 * (or null), `report` is `{ sevenD, sevenDResetAt, apiMs, at }`. `fresh` is the newest
 * report that reflected a NEW API response; a re-render keeps the one before it, because a
 * capped session has no new responses and its evidence must not be lost to a redraw.
 */
function noteReading(prev, report) {
  const apiMs = num(report && report.apiMs);
  const prevApi = prev ? num(prev.apiMs) : null;
  const next = { apiMs: apiMs === null ? prevApi : apiMs, at: num(report && report.at), fresh: prev ? prev.fresh || null : null };
  // The first report of a session has nothing to grow from; a counter that went DOWN is a
  // new conversation, and its first report is a baseline too.
  if (apiMs !== null && prevApi !== null && apiMs > prevApi) {
    next.fresh = {
      at: num(report.at),
      prevAt: prev ? num(prev.at) : null,
      delta: apiMs - prevApi,
      sevenD: num(report.sevenD),
      sevenDResetAt: num(report.sevenDResetAt),
    };
  }
  return next;
}

/** Did every API response behind this reading begin after `switchedAt`? (see the header) */
function countsSince(fresh, switchedAt) {
  // num() on every field: a reading restored from the state file is checked, not trusted.
  if (!fresh || num(fresh.at) === null || num(fresh.prevAt) === null || !(num(fresh.delta) > 0)) return false;
  const since = num(switchedAt) || 0;
  return fresh.prevAt - fresh.delta - REPORT_MARGIN_MS > since;
}

/**
 * Has the active account's weekly window reached the switch point, by a reading that
 * counts? `opts` is `{ atPct, oldWindows }`: the config's switch point and the windows of
 * the account switched away from (windowsOf). Returns `{ resetAt, pct }` (resetAt null when
 * Claude gave none) or null. A reading whose reset has already passed describes a window
 * that has turned over.
 */
function weeklySpent(readings, switchedAt, now, opts) {
  let found = null;
  for (const r of readings || []) {
    if (!spentSince(r, switchedAt, now, opts)) continue;
    const f = r.fresh;
    // The latest reset wins: two sessions on one account report one window, and the later
    // number is the safer one to wait out.
    if (!found || (f.sevenDResetAt || 0) > (found.resetAt || 0)) found = { resetAt: f.sevenDResetAt, pct: f.sevenD };
  }
  return found;
}

/** One reading that says the active account's week is at the switch point (the test weeklySpent applies to each). */
function spentSince(r, switchedAt, now, { atPct = SWITCH_AT_PCT_DEFAULT, oldWindows = null } = {}) {
  const f = r && r.fresh;
  if (!countsSince(f, switchedAt) || !(num(f.sevenD) !== null && f.sevenD >= atPct)) return false;
  if (num(f.sevenDResetAt) !== null && f.sevenDResetAt <= now) return false;
  return !isOldWindow(f.sevenDResetAt, oldWindows);
}

/** Does this reset time name a window of the account switched away from? (#490, see the header) */
function isOldWindow(resetAt, oldWindows) {
  const r = num(resetAt);
  // num() on every entry: the list is restored from the state file, so it is checked, not trusted.
  return r !== null && Array.isArray(oldWindows) && oldWindows.some((w) => num(w) !== null && Math.abs(w - r) <= RESET_SAME_MS);
}

/**
 * The weekly windows PROVEN to be the active account's, taken at the moment it is switched
 * away from: the reset times of the readings that count since the previous switch, still in
 * the future, ascending. `previous` is the oldWindows in force until now: a reading naming
 * one of them is the account before, not this one. Becomes `oldWindows` for the account
 * switched to. Only for a switch whose outgoing account is known (see the header).
 */
function windowsOf(readings, switchedAt, now, previous) {
  const out = new Set();
  for (const r of readings || []) {
    const f = r && r.fresh;
    if (!countsSince(f, switchedAt) || num(f.sevenDResetAt) === null || f.sevenDResetAt <= now) continue;
    if (isOldWindow(f.sevenDResetAt, previous)) continue;
    out.add(f.sevenDResetAt);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The readings a switch still waiting to happen rests on (a cooldown, the #359 restart
 * hold), as `{ sessionId: reading }`. Persisted with the state, so the restart the hold
 * leads to does not throw the evidence away: a capped session makes no new API calls, so
 * nothing would bring it back. Times and percentages only, never a token.
 */
function pendingReadings(entries, switchedAt, now, opts) {
  const out = {};
  for (const [sid, r] of entries || []) if (typeof sid === 'string' && spentSince(r, switchedAt, now, opts)) out[sid] = r;
  return out;
}

/**
 * Why an automatic switch may NOT happen now, or null when it may. The cooldown counts
 * from the last ATTEMPT, so a switch that failed is not retried until it has passed.
 */
function blockedBy({ cfg, state, now, holdActive }) {
  if (!cfg || !cfg.enabled) return 'disabled';
  // The last switch ended with a warning (heldBy): no more automatic switches until a
  // person has switched by hand, since the next one could file one account's tokens
  // under the other's name.
  if (state && state.held) return 'warning-hold';
  if (holdActive) return 'restart-hold';
  const at = num(state && state.attemptAt);
  if (at !== null && now - at < cooldownAfter(cfg, state)) return 'cooldown';
  return null;
}

/**
 * The wait after the last attempt: the cooldown, doubled for each failure in a row since
 * the last success (capped at a day). A switch that keeps failing is tried less and less
 * often, never on a fixed clock for the days its account stays capped.
 */
function cooldownAfter(cfg, state) {
  const failures = Math.min(10, Math.max(0, num(state && state.failures) || 0));
  return Math.min(COOLDOWN_MINUTES_MAX * MINUTE_MS, cfg.cooldownMs * 2 ** failures);
}

const identity = (a) => (a ? `${a.email || ''}|${a.organization || ''}` : null);

/**
 * The next saved account to switch to. `saved` is lib/claude-account.js status().saved
 * (no tokens). Stable order: by label, starting after the active one and wrapping round.
 * Skipped: broken entries, the active account, a refresh token known to have expired, and
 * an account known to be weekly-capped (`capped[label]` is its reset time).
 * Returns `{ next, earliest }`: `next` is a label or null, `earliest` is the soonest known
 * reset among the capped candidates, `{ label, resetAt }` or null.
 */
function pickNext({ saved, activeLabel, capped, now }) {
  const all = (saved || []).filter((s) => s && !s.broken && typeof s.label === 'string')
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  const lc = (l) => String(l || '').toLowerCase();
  const at = all.findIndex((s) => lc(s.label) === lc(activeLabel));
  const ring = at < 0 ? all : [...all.slice(at + 1), ...all.slice(0, at)];
  let earliest = null;
  for (const s of ring) {
    if (s.active || lc(s.label) === lc(activeLabel)) continue;
    const exp = num(s.refreshExpiresAt);
    if (exp !== null && exp <= now) continue;
    const until = num(capped && capped[s.label]);
    if (until !== null && until > now) {
      if (!earliest || until < earliest.resetAt) earliest = { label: s.label, resetAt: until };
      continue;
    }
    return { next: s.label, earliest };
  }
  return { next: null, earliest };
}

/** Drop capped marks whose reset has passed. */
function pruneCapped(capped, now) {
  const out = {};
  for (const [label, until] of Object.entries(capped || {})) if (num(until) !== null && until > now) out[label] = until;
  return out;
}

/**
 * While a capped session waits to resume after an AUTOMATIC switch, the reset it is armed
 * on is the switch: that is when this machine's quota came back. Only while the session's
 * own reading is from before the switch (a reading after it describes the new account and
 * speaks for itself), and only when that switch is earlier than the reset it would
 * otherwise wait for. Returns the reset to arm on.
 */
function resumeResetAt({ resumeFrom, resumeUntil, readingAt, resetAt, now }) {
  const from = num(resumeFrom);
  if (from === null) return resetAt;
  // Once the old account's week has reset, the switch is no longer news to anyone.
  const until = num(resumeUntil);
  if (until !== null && num(now) !== null && now > until) return resetAt;
  const ts = num(readingAt);
  if (ts !== null && ts > from) return resetAt;
  const r = num(resetAt);
  if (r !== null && r <= from) return resetAt;
  return from;
}

/**
 * Is a session that waits on the switch (resumeResetAt returned the switch) blocked by
 * its WEEKLY window? The 5-hour rule the worker is normally told (lib/usage-limit.js
 * isCapBlocked) reads only the 5-hour window, so a session stopped by its week with the
 * 5-hour window NOT spent read as "not blocked" and never resumed. Its own reading says
 * so: the pushed metrics (`sevenD`, blank once they age out) or the session's reading
 * here, taken no later than the switch.
 *
 * Bounded exactly as the 5-hour block is (isCapBlocked with the switch as the reset): true
 * only until the resume's settle delay plus CAP_BLOCK_GRACE_MS have passed, so the block is
 * there when the worker's one-shot fires and is not held for days after it.
 */
function weeklyBlockedAtSwitch({ sevenD, reading, resumeFrom, now, delayMs }) {
  const from = num(resumeFrom);
  if (from === null) return false;
  if (resumeAtFrom(from, delayMs === undefined ? AUTO_RESUME_DELAY_MS : delayMs) + CAP_BLOCK_GRACE_MS <= (num(now) ?? Date.now())) return false;
  if (isWindowSpent(sevenD)) return true;
  const f = reading && reading.fresh;
  return !!f && num(f.at) !== null && f.at <= from && isWindowSpent(f.sevenD);
}

/**
 * The hold an automatic switch's warning leaves (lib/claude-account.js switchTo): the
 * files were written, but what is on disk afterwards may not be the account they name
 * (the previous account's refresh landing just after the switch). Generic text only.
 */
function heldBy(warning, now) {
  return warning ? { warning: String(warning), at: now } : null;
}

/** A time a person reads on a phone: "Sat 28 Nov 14:00", in this machine's zone. */
function clock(ms) {
  if (num(ms) === null) return 'an unknown time';
  return new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The ntfy message for each outcome. `server` is this machine's name. */
function notice(kind, { server, from, to, resetAt, error, earliest, retryAt, warning, pct } = {}) {
  const where = server || 'this machine';
  // #490 - the switch now happens before the limit (switchAtPct): say how far the week got.
  const reached = num(pct) !== null && pct < 100 ? `reached ${pct}% of its weekly limit` : 'hit its weekly limit';
  if (kind === 'switched') {
    const warned = warning
      ? ` WARNING: ${warning}. Automatic switching is paused until the account is switched by hand (the companion's account sheet).`
      : '';
    return {
      title: `Claude account switched on ${where}`,
      message: `${from || 'The active account'} ${reached} (resets ${clock(resetAt)}). Now using ${to}.${warned}`,
      priority: 4, tags: warning ? ['warning'] : ['arrows_counterclockwise'],
    };
  }
  if (kind === 'all-capped') {
    const soon = earliest ? `${earliest.label} resets first, ${clock(earliest.resetAt)}.` : 'No other saved account can be used.';
    return {
      title: `Every Claude account is at its limit on ${where}`,
      message: `${from || 'The active account'} ${reached} (resets ${clock(resetAt)}) and there is no account to switch to. ${soon}`,
      priority: 4, tags: ['no_entry'],
    };
  }
  return {
    title: `Claude account switch failed on ${where}`,
    message: `${from || 'The active account'} ${reached}; switching to ${to} failed: ${error}. No new attempt before ${clock(retryAt)}.`,
    priority: 4, tags: ['warning'],
  };
}

module.exports = {
  COOLDOWN_MINUTES_DEFAULT, COOLDOWN_MINUTES_MIN, COOLDOWN_MINUTES_MAX, REPORT_MARGIN_MS,
  SWITCH_AT_PCT_DEFAULT, SWITCH_AT_PCT_MIN, SWITCH_AT_PCT_MAX, RESET_SAME_MS,
  autoSwitchConfig, noteReading, countsSince, weeklySpent, windowsOf, isOldWindow, pendingReadings, blockedBy, cooldownAfter, identity,
  pickNext, pruneCapped, resumeResetAt, weeklyBlockedAtSwitch, heldBy, clock, notice,
};
