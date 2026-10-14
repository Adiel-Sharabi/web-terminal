'use strict';
// #350 - the pure rules for finishing a turn that an AUTO compaction ended.
//
// Since claude 2.1.29x an auto compaction that fires mid-turn ENDS the turn: the summary
// is written, `compacting` is left standing until its 360s backstop, and nothing runs
// again until a human types. Claude's own `SessionStart` hook (source "compact") is the
// one signal that the compaction is over, and `PreCompact` carries the one fact that says
// whose compaction it was (`trigger`: "auto" | "manual"). A manual /compact must never be
// nudged - the person who typed it is at the keyboard, and the API-error ladder replays
// its own prompt after the /compact it types - so only an AUTO one is.
//
// What a hook MEANS is decided in the worker (pty-worker.js); this file owns the two
// small facts every layer must agree on, so server.js cannot forward a spelling the
// worker does not read:
//   * hookFacts      - which payload fields cross the server -> worker boundary
//   * triggerKind    - 'auto' or 'manual', with anything unrecognised read as 'manual'
//   * finishesCompaction - is this event the end of a compaction
// The policy (does this agent get nudged, and after how long) is the registry's:
// lib/agents.js `compactResume`.

/** The values a PreCompact `trigger` may carry. Anything else is dropped, not forwarded. */
const TRIGGERS = Object.freeze(['auto', 'manual']);

/** The values a SessionStart `source` may carry. Only 'compact' is acted on; the rest are
 *  listed so an ordinary start/resume/clear is forwarded as what it is. */
const SOURCES = Object.freeze(['startup', 'resume', 'clear', 'compact']);

/**
 * The hook-payload fields the worker needs beyond what it already receives, shaped for
 * the hookEvent RPC and spread into it. External input, so each is an allowlisted
 * string or absent - `undefined` is dropped by JSON, which is how "this event says
 * nothing about it" stays distinguishable from a value (the #98 tri-state rule).
 */
function hookFacts(event, body) {
  if (!body || typeof body !== 'object') return {};
  if (event === 'PreCompact' && TRIGGERS.includes(body.trigger)) return { trigger: body.trigger };
  if (event === 'SessionStart' && SOURCES.includes(body.source)) return { source: body.source };
  return {};
}

/**
 * Whose compaction was this? Anything but an explicit 'auto' is 'manual', i.e. never
 * nudged: a payload from an older Claude that carries no trigger at all must not be
 * promoted to a compaction we type into.
 */
function triggerKind(trigger) {
  return trigger === 'auto' ? 'auto' : 'manual';
}

/** Is this hook the end of a compaction? Every other SessionStart source is not. */
function finishesCompaction(event, source) {
  return event === 'SessionStart' && source === 'compact';
}

module.exports = { TRIGGERS, SOURCES, hookFacts, triggerKind, finishesCompaction };
