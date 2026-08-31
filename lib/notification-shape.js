'use strict';
// --- What a Claude `Notification` hook event IS, and what is safe to log ------
//
// #194 Gap 1: `server.js` classified a `Notification` into "permission ask",
// "idle" or — for everything else — a bare `drop` that changed nothing and said
// nothing. So the set of notifications Claude actually sends is UNKNOWABLE from
// this fleet's logs: `notification-other` is returned in the hook's HTTP
// response body and never handed to a logger, and raw hook bodies are never
// logged either. Verified 2026-08-31 — zero hits across every file in `logs/`.
// The existing logs cannot answer it in either direction.
//
// THE ORDER MATTERS AND IS THE WHOLE POINT. The tempting fix is to flip the
// fallthrough to `permission`, and it is NOT safe on current evidence:
// `correctStaleStatus` gives a `waiting` session **12 hours** against 5 minutes
// for a `working` one, so a benign notification misread as a permission ask
// parks a session on a false "waiting for permission" for half a day — worse
// than the silence it replaces. Measure first, then decide the default from
// data. That is #179's *every gate fails closed* rule applied to a classifier.
//
// The rule lives here rather than in `server.js` for the reason every other pure
// rule in this repo does (`lib/submit-frames.js`, `lib/usage-limit.js`,
// `lib/agent-ready.js`): `server.js` exports nothing, so a rule inside it can
// only be tested through an HTTP round trip — and the whole point of step 2 is
// that this classifier is going to be CHANGED once the data arrives.

/// What a `Notification` turned out to be.
const NOTIFICATION_KINDS = Object.freeze({
  PERMISSION: 'permission', // an approval ask — becomes a PermissionRequest
  IDLE: 'idle',             // Claude is waiting for input
  BENIGN: 'benign',         // recognised, and deliberately ignored
  UNKNOWN: 'unknown',       // matched nothing — the #194 Gap 1 case
});

/// Classifies one `Notification` hook body.
///
/// `BENIGN` and `UNKNOWN` are both ignored by the caller and always have been —
/// splitting them changes no behaviour. It exists so the log can carry only the
/// ones nobody has ever seen: logging the two known-harmless matchers would bury
/// the signal in noise that is already understood.
function classifyNotification(body) {
  // Claude's payload shape varies by version; check the common fields. The
  // matcher arrives as `notification_type` in newer versions and as part of
  // `message` in older ones — match both.
  const matcher = String(body?.notification_type || body?.matcher || '').toLowerCase();
  const msg = String(body?.message || '').toLowerCase();
  if (matcher === 'permission_prompt' || /\bpermission\b|\bapprov/.test(msg)) {
    return NOTIFICATION_KINDS.PERMISSION;
  }
  if (matcher === 'idle_prompt' || /waiting for your input|idle/.test(msg)) {
    return NOTIFICATION_KINDS.IDLE;
  }
  if (matcher === 'auth_success' || matcher === 'elicitation_dialog') {
    return NOTIFICATION_KINDS.BENIGN;
  }
  return NOTIFICATION_KINDS.UNKNOWN;
}

/// How much of a notification message survives into a log line.
const NOTIFICATION_MSG_CAP = 200;

const _UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A URL goes FIRST, and not for tidiness. `http://host/a` ends in `p:/…`, which
// is a perfectly good Windows drive-path match — so without this rule the drive
// pattern bit into the middle of the scheme and logged `htt<path>`, mangling the
// wording this function exists to preserve. The `\b` on the drive letter is the
// second half of that fix: there is no word boundary inside `http`.
const _URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>|]*/gi;
const _WIN_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'<>|]*/g;
const _POSIX_PATH_RE = /(^|\s)\/[^\s"'<>|]{2,}/g;
const _LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;

/// A notification message reduced to its SHAPE: enough wording to recognise the
/// class of message, with the specifics taken out, collapsed to one line and
/// capped.
///
/// Redacted because this lands in `logs/error.log`, which is read over
/// `/api/exec` and pasted into issues. What we need is *which wordings exist*,
/// never which file was being edited. Paths go first and hex last: a path can
/// contain a long hex-looking segment, and redacting the hex first would leave a
/// half-redacted path behind.
function redactNotificationMessage(msg) {
  if (typeof msg !== 'string' || !msg) return '';
  const out = msg
    .replace(_UUID_RE, '<id>')
    .replace(_URL_RE, '<url>')
    .replace(_WIN_PATH_RE, '<path>')
    .replace(_POSIX_PATH_RE, '$1<path>')
    .replace(_LONG_HEX_RE, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > NOTIFICATION_MSG_CAP
    ? out.slice(0, NOTIFICATION_MSG_CAP) + '...'
    : out;
}

/// Count one sighting of `key` in `counts`, and return which sighting it is —
/// or **0**, meaning "not countable, do not log".
///
/// The cap is the whole reason this is a function. The first cut inlined it and
/// got it backwards: a new key arriving at a FULL table was simply not stored,
/// so `n` was recomputed as 1 on every single occurrence, `shouldLogDrop(1)` was
/// always true, and the bound that exists to prevent a flood PRODUCED one. A
/// shape that cannot be counted cannot be rate-limited, so it must be dropped
/// from the log rather than let through — 0 says exactly that, and
/// `shouldLogDrop(0)` is already false.
///
/// `counts` is mutated deliberately: the caller owns the map's lifetime, and a
/// process-lifetime counter is the one piece of state this module cannot be pure
/// about. Everything else about it — the cap, the ordering, the return — is.
function noteShape(counts, key, max) {
  if (counts.has(key)) {
    const n = counts.get(key) + 1;
    counts.set(key, n);
    return n;
  }
  if (counts.size < max) {
    counts.set(key, 1);
    return 1;
  }
  return 0;
}

/// Should the `n`th sighting of one shape be written to the log?
///
/// First always, then every hundredth. An unrecognised notification is expected
/// to be rare — possibly non-existent — but "expected" is exactly the assumption
/// this instrumentation exists to test, and a per-event log on a shape that
/// turns out to fire constantly would flood a disk the monitor is rotating.
/// Bounded, and the count still rides along so the volume is never lost.
function shouldLogDrop(n) {
  return n === 1 || (n > 0 && n % 100 === 0);
}

module.exports = {
  NOTIFICATION_KINDS,
  NOTIFICATION_MSG_CAP,
  classifyNotification,
  redactNotificationMessage,
  noteShape,
  shouldLogDrop,
};
