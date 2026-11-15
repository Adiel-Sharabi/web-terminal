'use strict';
// --- #466 The gated prompt a peer may type (POST /api/sessions/:id/prompt) -------------
//
// The supervisor runs on ONE server (the lease authority) but its sessions live on every
// server, so it needs a way to type a prompt into a session on another machine. `typePrompt`
// in server.js is local only, and POST /api/sessions/:id/answer checks none of the gates a
// prompt typed on its own needs. This route types one tagged prompt, and only when every
// gate the check-in (#443) and the restart hold (#359) already apply says it is safe:
//
//   restart-hold    a restart hold types its own question
//   handoff /       a hand-off in progress, or one that left a successor doing the work
//   handed-off        (lib/check-in.js handoffBlock)
//   busy            the check-in or hand-off scan is typing into a session right now
//   check-in        a check-in was typed and its delivery not yet seen (lib/check-in.js inFlight)
//   no-agent, not-ready, not-idle, blocked-prompt, menu, waiting, compacting
//                   lib/maintenance.js promptBlock: text typed into a selector or a menu
//                   ANSWERS it, a booting agent loses it, one behind a turn is queued
//   capped          the usage-limit auto-resume owns a capped session's next prompt
//   api-error       the worker's auto-continue owns a turn an API error just cut (#461,
//                   lib/check-in.js apiErrorOwned): its timer would type behind this prompt
//   typing          a person typed into it in the last typingQuietMin (lib/check-in.js)
//
// The answer is `delivered` (typed) or `refused: <why>` - never a silent drop. Phase 1
// adds the route only; nothing calls it yet.
//
// Pure: no I/O, no clock.

const { promptBlock } = require('./maintenance');
const { typedRecently, handoffBlock, inFlight, apiErrorOwned, checkInConfig } = require('./check-in');
const { SUPERVISOR_PROMPT_TAG } = require('./user-turn');

/** The tags a caller may ask for, by name. Each is a SYSTEM turn in lib/user-turn.js. */
const TAGS = Object.freeze({ supervisor: SUPERVISOR_PROMPT_TAG });
/** The whole prompt, tag included, stays under Claude's bracketAbove (512 bytes, #213),
 *  like every prompt the server types on its own. */
const PROMPT_BYTES_MAX = 511;
const REASONS = Object.freeze(['restart-hold', 'handoff', 'handed-off', 'busy', 'check-in', 'no-agent', 'not-ready', 'not-idle',
  'blocked-prompt', 'menu', 'waiting', 'compacting', 'capped', 'api-error', 'typing']);

/// Validate the body: `{text, tag?}` -> `{prompt}` (the exact line to type, no CR) or `{error}`.
/// Refused, never cleaned: a control character or a newline would change what is typed.
function promptOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const tagName = body.tag === undefined || body.tag === null ? 'supervisor' : body.tag;
  if (typeof tagName !== 'string' || !Object.prototype.hasOwnProperty.call(TAGS, tagName)) {
    return { error: `tag must be one of: ${Object.keys(TAGS).join(', ')}` };
  }
  if (typeof body.text !== 'string' || !body.text.trim()) return { error: 'text must be a non-empty string' };
  // C0, DEL, C1 (U+0080-U+009F: U+009B is a one-byte CSI) and the Unicode line separators.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(body.text)) return { error: 'text must be one line with no control characters' };
  const prompt = `${TAGS[tagName]} ${body.text.trim()}`;
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_BYTES_MAX) {
    return { error: `the prompt (tag included) must be at most ${PROMPT_BYTES_MAX} bytes` };
  }
  return { prompt };
}

/// Why the prompt may NOT be typed into [row] now, or null. [row] is the session row the
/// hand-off and check-in rules read (server.js handoffRowFor); the rest is what a row cannot
/// carry; [cfg] is the check-in config (lib/check-in.js checkInConfig) its shared gates read.
/// Order matters only for which reason is named: every one refuses.
function promptRefusal(row, { brief, hold, busy, inputAt, startedAt, now, cfg } = {}) {
  if (hold) return 'restart-hold';
  const hb = handoffBlock(brief);
  if (hb) return hb;
  if (busy) return 'busy';
  // A check-in typed and not yet delivered: this prompt would land in its turn.
  if (inFlight(brief && brief.checkIn, now, cfg)) return 'check-in';
  const pb = promptBlock(row);
  if (pb) return pb;
  if (row.capBlocked || row.autoResumeArmed || (row.usageLimit && row.usageLimit.waiting)) return 'capped';
  if (apiErrorOwned(row, now, cfg)) return 'api-error';
  if (typedRecently(inputAt, startedAt, now, (cfg || checkInConfig(null)).typingQuietMin)) return 'typing';
  return null;
}

module.exports = { TAGS, PROMPT_BYTES_MAX, REASONS, promptOf, promptRefusal };
