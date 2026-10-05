'use strict';
// --- When a cluster peer's fetch result is worth a log line ------------------
//
// #272 follow-up. `server.js`'s `Cluster fetch` line sat inside
// `if (r.sessions.length > 0)`, so the log recorded a peer only while it was
// HEALTHY: a peer that went offline, answered 401, or came back empty produced no
// line at all — the one event worth recording was the only one that wasn't. #272
// itself spent three rounds of diagnosis on a live report partly because nothing
// said when, or how, a peer had dropped out of the merge.
//
// TRANSITIONS, NOT POLLS. The merge runs on every sidebar refresh from every viewer,
// so a line per failed fetch would flood the log for as long as a peer stays down.
// One line when a peer ENTERS a state, one when it leaves it — which is also exactly
// what a reader wants: "the peer went offline at 21:04 (timeout), back at 21:31".
//
// Pure apart from the caller-owned `states` map, for the reason every other rule in
// `lib/` is: `server.js` exports nothing, so a rule left inline is reachable by no test.

/// The four states a peer's fetch can end in. The REASON is not part of the state:
/// an offline peer flips between `timeout` and `ECONNREFUSED` from poll to poll, and
/// keying on it would turn one outage into a stream of "transitions".
const PEER_STATES = Object.freeze({
  OK: 'ok',                 // online, authorised, at least one session
  EMPTY: 'empty',           // online, authorised, ZERO sessions — dropped out of the merge
  NEEDS_AUTH: 'needs-auth', // no stored token, or the peer answered 401
  OFFLINE: 'offline',       // unreachable, non-2xx, timeout, unparseable
});

/// Which state one `_computeClusterSessions` peer result is in.
function peerFetchState(r) {
  if (r?.needsAuth) return PEER_STATES.NEEDS_AUTH;
  if (!r?.online) return PEER_STATES.OFFLINE;
  return Array.isArray(r.sessions) && r.sessions.length > 0 ? PEER_STATES.OK : PEER_STATES.EMPTY;
}

/// How much of a failure reason reaches the log. It is an error message from a
/// socket or a status line — short in practice, but not ours to trust.
const PEER_REASON_CAP = 120;

/// Note one peer result. Returns the log line body (no timestamp) when the peer's
/// state CHANGED, else null.
///
/// A peer first seen HEALTHY returns null: the existing session-summary line already
/// records it, and a second line saying the same thing at every startup is noise. A
/// peer first seen in any other state is logged at once — "it was never up" is
/// exactly the case the old code could not show.
function notePeerFetch(states, r) {
  const name = String(r?.server ?? '?');
  const state = peerFetchState(r);
  const prev = states.get(name);
  if (prev === state) return null;
  states.set(name, state);
  if (prev === undefined && state === PEER_STATES.OK) return null;
  let reason = typeof r?.reason === 'string' ? r.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length > PEER_REASON_CAP) reason = reason.slice(0, PEER_REASON_CAP) + '...';
  const detail = state === PEER_STATES.OK
    ? ` (${r.sessions.length} sessions)`
    : (reason ? ` (${reason})` : '');
  return `Cluster fetch: ${name} ${prev ?? 'unseen'} -> ${state}${detail}`;
}

module.exports = { PEER_STATES, PEER_REASON_CAP, peerFetchState, notePeerFetch };
