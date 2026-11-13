'use strict';
// --- Is an "API Error" line worth retrying? (#461) ---------------------------------
//
// Claude Code prints "API Error: <what>" into the PTY when a request fails (no hook
// carries it), and pty-worker.js sniffs that line. A TRANSIENT error walks the worker's
// auto-continue ladder (continue, continue, /compact + replay); anything else is only
// flagged and pushed, because retrying a 400 or an unreadable image fails the same way.
//
// #461: the rule knew status codes and words like "timeout" / "connection reset", but not
// the transport phrasings Claude prints today, so a turn cut by a dropped connection was
// called non-transient and slept until a person typed. Across three weeks of two
// machines' worker logs every one of these was a network failure, and a plain `continue`
// resumed the one that was measured (26 h idle, resumed at once):
//   Connection lost mid-response. / Connection closed mid-response.
//   Server error mid-response. / Response stalled mid-stream.
//   Can't reach the API server - check your internet ... (also rendered with no spaces,
//     "Can'treachtheAPIserver", when the TUI positions words by cursor moves)
//   Unable to connect to API (ConnectionRefused)
//   API returned an empty or malformed response
// Left non-transient on purpose: 4xx codes other than 408/409/425/429 (a 403 block page,
// a 401, a 400 request the API rejects), and "an image in the conversation could not be
// processed" - the same request fails the same way.
//
// Pure: one string in, a boolean out.

const STATUS_RE = /\b(408|409|425|429|500|502|503|504|520|521|522|523|524|529)\b/;
const WORDS_RE = new RegExp([
  'overload', 'rate.?limit', 'temporar', 'time(?:d)?\\s*out', 'timeout',
  'connection\\s*(?:error|reset|lost|closed|refused)', 'econnreset', 'etimedout', 'enetunreach',
  'fetch failed', 'socket hang up', 'service unavailable', 'bad gateway', 'gateway time',
  // #461 - the stream was cut part-way: the request itself was fine.
  'mid-?\\s*(?:response|stream)',
  // #461 - the API was never reached. The apostrophe may be straight or curly, or gone.
  "can.?t\\s*reach\\s*the\\s*api", 'unable\\s*to\\s*connect',
  'empty\\s*or\\s*malformed\\s*response', 'stopped\\s*arriving',
].join('|'), 'i');
// Reaching the API failed for a reason a retry cannot fix: a certificate or proxy problem
// ("Unable to connect to API due to SSL certificate verification error") fails the same way
// on every attempt, so it is never retried however the rest of the line reads.
const PERMANENT_RE = /certificate|\bssl\b|\btls\b|self.?signed|proxy\s*auth/i;

function isTransientApiError(line) {
  const s = typeof line === 'string' ? line : '';
  if (PERMANENT_RE.test(s)) return false;
  return STATUS_RE.test(s) || WORDS_RE.test(s);
}

module.exports = { isTransientApiError };
