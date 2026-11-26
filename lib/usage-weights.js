'use strict';
// --- Usage weights (#529) -----------------------------------------------------
//
// The ONE owner, in this repo, of what a token costs in "weighted units" and of how a
// session's first prompt classifies it. The fleet usage ledger (lib/usage-session.js,
// lib/usage-report.js) and every reader import it from here.
//
// The numbers are an ESTIMATE: the weekly limit's real Opus-vs-Sonnet weighting is not
// published. They are the same weights claude-memory's usage-monitor.js has always used
// (its 30-minute windows and daily roll-up), so a figure here lines up with the figures
// that script has been writing. Follow-up: make usage-monitor.js import this file instead
// of keeping its own copy - until then, change BOTH when a weight moves.
//
//   units = in + (cw - cw1h) * 1.25 + cw1h * 2 + cr * 0.1 + out * 5
//
// `in` input tokens, `cw` cache-creation tokens (`cw1h` of them on the 1 hour TTL),
// `cr` cache reads, `out` output tokens. A model call is the unit of counting.

const WEIGHTS = Object.freeze({ input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 });

/** A token tally `{in, out, cr, cw, cw1h}` (any may be missing) in weighted units. */
function unitsOf(t) {
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const cw = n(t.cw);
  const cw1h = Math.min(n(t.cw1h), cw);
  return n(t.in) * WEIGHTS.input + (cw - cw1h) * WEIGHTS.cacheWrite5m + cw1h * WEIGHTS.cacheWrite1h + n(t.cr) * WEIGHTS.cacheRead + n(t.out) * WEIGHTS.output;
}

/** Only the cache-write part of a call - what waking an idle session (the 1 hour cache TTL has
 *  expired) costs. */
function cacheWriteUnitsOf(t) {
  const cw = typeof t.cw === 'number' ? t.cw : 0;
  const cw1h = Math.min(typeof t.cw1h === 'number' ? t.cw1h : 0, cw);
  return (cw - cw1h) * WEIGHTS.cacheWrite5m + cw1h * WEIGHTS.cacheWrite1h;
}

/** A wake-up is the first main assistant message after this long without one. */
const WAKE_IDLE_MS = 60 * 60e3;

/** What a user turn says it is, from its text. `null` = not a prompt at all (a local-command
 *  echo, a task notification); 'human' = anything else that is not a known automation. */
function promptClass(txt) {
  const t = String(txt).trim().replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '');
  if (/^<(local-command|task-notification)/.test(t)) return null;
  if (/^you are reviewing a pull request/i.test(t)) return 'pr-review';
  if (/^you are checking an automated/i.test(t)) return 'pipeline-check';
  if (/^this session is being continued/i.test(t)) return 'continued';
  if (/^\[web-terminal (supervisor|check-in|hand-off|restart)|^\[supervisor|^\[mission control/i.test(t)) return 'wt-automation';
  if (/^<command-name>/.test(t)) return 'slash';
  return 'human';
}

/** Does this prompt open the bug-hunter skill (the orchestrator session's first turn)? */
function opensBugHunter(txt) {
  return /^\s*(<command-name>)?\/?dds-bug-hunter\b/i.test(String(txt).trim().replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '').replace(/^<command-message>[^<]*<\/command-message>\s*/, ''));
}

module.exports = { WEIGHTS, WAKE_IDLE_MS, unitsOf, cacheWriteUnitsOf, promptClass, opensBugHunter };
