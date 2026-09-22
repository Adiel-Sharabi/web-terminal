'use strict';

/**
 * When to log that a request was slow, and how to say it.
 *
 * Pure, and in its own module for the reason every other rule in `lib/` is: the
 * two halves of "log it, but not too often" are exactly the shape this repo has
 * shipped broken before — a throttle that pins so the line never appears at all,
 * and a comparison whose obvious-looking inversion logs garbage forever. Both
 * failures look identical from outside to "nothing was slow", which is the
 * answer a reader is already inclined to believe.
 *
 * Used by `GET /api/sessions` in server.js, the one session route that goes
 * through the worker RPC and therefore the one a client times out on.
 */

/**
 * Whether a slow reading should be logged right now.
 *
 * @param {{totalMs:number, thresholdMs:number, lastLoggedAt:number, now:number, gapMs:number}} o
 * @returns {boolean}
 */
function shouldLogSlow({ totalMs, thresholdMs, lastLoggedAt, now, gapMs }) {
  // Written as a NEGATED POSITIVE test on purpose, and the tempting
  // simplification is not equivalent: `if (totalMs < thresholdMs) return false`
  // lets a NaN through, because `NaN < t` is false — it would fall past the
  // guard and log a garbage line on every single request forever. A missing
  // measurement has to read as "not slow", never as "slow". `>=` rather than
  // `>` so a threshold of 0 means "log everything", which is what makes the
  // wiring verifiable end to end.
  if (!(totalMs >= thresholdMs)) return false;
  // `lastLoggedAt` 0 means nothing has been logged yet, and the FIRST slow call
  // is the one most worth having — a throttle that swallows it turns the
  // instrument off for the first `gapMs` of an outage, which is the window that
  // matters. Guarded explicitly rather than relying on `now - 0` being large:
  // that happens to hold for a `Date.now()` clock and silently stops holding
  // for any other.
  if (lastLoggedAt > 0 && (now - lastLoggedAt) < gapMs) return false;
  return true;
}

/**
 * The log line's body: `total=17431ms rpc=12ms metrics=8ms runningWork=17400ms`.
 *
 * Every phase is named even when it is 0ms — a phase missing from the line is
 * indistinguishable from a phase that was never measured, and naming the
 * responsible phase is the whole point of the line.
 *
 * @param {Record<string, number>} phases
 * @param {number} totalMs
 * @returns {string}
 */
function formatSlowPhases(phases, totalMs) {
  const ms = (v) => (Number.isFinite(v) ? Math.round(v) : '?') + 'ms';
  const parts = Object.keys(phases || {}).map((k) => `${k}=${ms(phases[k])}`);
  return `total=${ms(totalMs)}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

module.exports = { shouldLogSlow, formatSlowPhases };
