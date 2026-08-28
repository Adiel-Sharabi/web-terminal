'use strict';
// Codex usage metrics, read out of a rollout transcript's tail.
//
// Claude PUSHES its status line to POST /api/claude-status; Codex has no such hook,
// but it writes everything we need into the rollout on every turn, so the same
// `{ ctx, fiveH, sevenD, fiveHResetAt, model, effort, capObservedAt }` shape is
// recoverable by reading the tail — no extra process, no extra endpoint. PURE (text
// in, object out) so the arithmetic and the field selection are exhaustively
// unit-testable; server.js supplies the tail. `capObservedAt` (#142) is the direct
// observation half of that shape — see findUsageCapAt below.
//
// Verified against codex-cli 0.134.0 rollouts. Per turn Codex emits:
//
//   {type:'event_msg', payload:{ type:'token_count',
//      info: { last_token_usage:{input_tokens,cached_input_tokens,output_tokens,...},
//              total_token_usage:{...}, model_context_window },
//      rate_limits: { primary:{used_percent,window_minutes,resets_at},
//                     secondary:{...}, ... } }}
//   {type:'turn_context', payload:{ model, effort, ... }}
//
// TRAP: `total_token_usage.total_tokens` is the session's CUMULATIVE spend (millions on
// a long session) — it is NOT context occupancy. What fills the context window is
// `last_token_usage.input_tokens` (the most recent request's input), of which
// `cached_input_tokens` is a SUBSET, not an addition. Using the wrong one reports
// thousands of percent.
//
// `resets_at` (issue #69, the 5h auto-resume timer): UNIX EPOCH SECONDS, not ms —
// verified against a real 0.144.0 rollout on 2026-07-10 (rollout-2026-07-10T00-03-21-
// 019f48b1-367f-7861-835c-256d175ac1d2.jsonl, written from a session that started
// 2026-07-09T21:03:21Z): `primary.resets_at: 1783645131` decodes to
// `2026-07-10T00:58:51.000Z`, well within that 5h window's plausible end. The 7-day
// window's `secondary.resets_at: 1784231931` decodes to `2026-07-16T19:58:51.000Z`,
// six days later — consistent. Converted to ms and exposed as `fiveHResetAt`.

// `used_percent` and `resets_at` are read the same way for every agent — see
// lib/metrics-common.js, which owns both rules (Claude reports the identical pair
// through its status line, in the identical units).
const { clampPct, resetAtMsFromSeconds, label: _label } = require('./metrics-common');

// A rate-limit window is identified by its length, not by its position in the object:
// `primary`/`secondary` are ordering, and pinning meaning to order would silently
// mislabel the badges if Codex ever swapped them.
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
const WINDOW_TOLERANCE = 0.15; // accept a window within ±15% of the nominal length

function _pctOf(used, total) {
  if (typeof used !== 'number' || typeof total !== 'number' || !(total > 0)) return null;
  if (!(used >= 0)) return null;
  const pct = Math.round((used / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

const _pct = clampPct;

function _matchesWindow(minutes, nominal) {
  if (typeof minutes !== 'number' || !(minutes > 0)) return false;
  return Math.abs(minutes - nominal) <= nominal * WINDOW_TOLERANCE;
}

// `resets_at` is UNIX EPOCH SECONDS (see the file-header note) — the conversion and
// its rationale now live in lib/metrics-common.js, since Claude reports the same
// field in the same units.
const _resetAtMs = resetAtMsFromSeconds;

// Pull the 5-hour and 7-day usage out of a rate_limits object by WINDOW LENGTH.
// Falls back to primary=5h / secondary=7d only when neither window is recognisable,
// which preserves today's reading of a payload whose windows we don't know.
function _rateLimits(rl) {
  if (!rl || typeof rl !== 'object') return { fiveH: null, sevenD: null, fiveHResetAt: null };
  const entries = [rl.primary, rl.secondary].filter((e) => e && typeof e === 'object');
  let fiveH = null;
  let sevenD = null;
  let fiveHResetAt = null;
  let matched = false;
  for (const e of entries) {
    if (_matchesWindow(e.window_minutes, FIVE_HOUR_MINUTES)) {
      fiveH = _pct(e.used_percent);
      fiveHResetAt = _resetAtMs(e.resets_at);
      matched = true;
    } else if (_matchesWindow(e.window_minutes, SEVEN_DAY_MINUTES)) {
      sevenD = _pct(e.used_percent);
      matched = true;
    }
  }
  if (!matched) {
    fiveH = rl.primary ? _pct(rl.primary.used_percent) : null;
    sevenD = rl.secondary ? _pct(rl.secondary.used_percent) : null;
    fiveHResetAt = rl.primary ? _resetAtMs(rl.primary.resets_at) : null;
  }
  return { fiveH, sevenD, fiveHResetAt };
}

// Context occupancy as a percentage of the model's window, or null when the line
// doesn't carry enough to say. `cached_input_tokens` is deliberately ignored — it is
// already counted inside `input_tokens`.
function _ctxPercent(info) {
  if (!info || typeof info !== 'object') return null;
  const last = info.last_token_usage;
  if (!last || typeof last !== 'object') return null;
  return _pctOf(last.input_tokens, info.model_context_window);
}

// #142 — has this rollout most recently ended on Codex's OWN usage-cap error?
//
// Codex's cap does not block on anything answerable (lib/usage-limit.js's file
// header, lib/agents.js's Codex `autoResume` comment): the turn simply ends and the
// rollout records it as an error, not a selector. Captured verbatim from a real
// event, Office, 2026-08-02T20:26:58.735Z (issue #142):
//
//   {"type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,
//    "error":{"message":"You've hit your usage limit. Upgrade to Pro (…) or try
//    again at Aug 9th, 2026 3:02 PM.","codex_error_info":"usage_limit_exceeded"}}}
//
// The line's own `timestamp` (top-level, ISO-8601 with ms — verified against real
// local rollouts written by the same codex-cli generation, e.g.
// {"timestamp":"2026-08-07T12:18:52.775Z","ordinal":379,"type":"event_msg",...}) is
// what "stamped 2026-08-02T20:26:58.735Z" in the issue was read off.
//
// STALENESS. A rollout is per Codex PROCESS and this line is never removed, so it
// means "still capped" only while it is the NEWEST thing that happened: if the user
// waits out the cap and takes another turn, Codex appends to the SAME file. Walking
// the tail backward — same direction parseMetricsFromTail already walks — makes
// "newest" fall out of iteration order for free: any turn-start evidence (a
// `turn_context`, a user `response_item`, a `token_count`) reached BEFORE the error
// line in that walk sits AFTER it in the file, so a subsequent turn ran and the cap
// is over. That none of those three can belong to the SAME failed turn and land after
// its `task_complete` is MEASURED, not assumed — the whole rule dies if a trailing
// `token_count` follows the error, because every cap would then read as superseded.
// Swept the 25 newest local rollouts, every `task_complete` in them: 23 were the LAST
// line of their file, and the other 2 were followed by
// `task_started > turn_context > response_item/message` — a genuinely new turn. Not one
// `token_count` ever followed a `task_complete`. So the same-turn `token_count` whose
// rate_limits read 100% sits BEFORE the error, where it cannot trip this.
//
// Returns the error line's own timestamp as epoch ms, or null when there is no live
// (unsuperseded) cap error in the given text.
function findUsageCapAt(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split('\n');
  let sawLaterTurn = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // a truncated first line, etc.
    const type = obj && obj.type;
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;

    if (type === 'turn_context') { sawLaterTurn = true; continue; }
    if (type === 'response_item' && p.type === 'message' && p.role === 'user') { sawLaterTurn = true; continue; }
    if (type === 'event_msg' && p.type === 'token_count') { sawLaterTurn = true; continue; }

    if (type === 'event_msg' && p.type === 'task_complete'
        && p.error && typeof p.error === 'object' && p.error.codex_error_info === 'usage_limit_exceeded') {
      if (sawLaterTurn) return null; // a subsequent turn ran — this cap is over
      const ts = Date.parse(obj.timestamp);
      return Number.isFinite(ts) ? ts : null;
    }
  }
  return null;
}

// Scan a block of rollout text from its END toward its start, taking the newest
// `token_count` that actually carries `info` (Codex occasionally writes one with
// info:null) and the newest `turn_context` for the model/effort labels. Returns null
// when the tail holds neither AND no cap error was found — the caller then reports
// no metrics rather than zeros.
//
// #122 — MEASURED, do not re-derive: a mid-session `/model` writes NO new
// `turn_context` (scripts/rig/probe-codex-model-change.js: baseline
// ["gpt-5.5/high"], picker driven, nothing added in 20s). `turn_context` is written
// immediately before each `role:user` turn, so a Codex model change reaches the
// rollout only on the NEXT prompt, and no server-side change can invent it earlier.
// Nothing to fix HERE either way: taking the newest already follows a change the
// moment one is written, and those bytes move the file's size, so the metrics cache
// re-reads. The first cut of that probe reported the opposite by sampling its
// baseline before the first turn_context existed and calling []->[one] a change —
// a zero-to-one delta is rollout creation, not evidence.
function parseMetricsFromTail(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split('\n');

  let usage = null;   // { ctx, fiveH, sevenD }
  let model = null;
  let effort = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // a truncated first line, etc.
    const p = obj && obj.payload;
    if (!p || typeof p !== 'object') continue;

    if (!usage && obj.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const ctx = _ctxPercent(p.info);
      const { fiveH, sevenD, fiveHResetAt } = _rateLimits(p.rate_limits);
      // Only accept the line if it yielded at least one number; otherwise keep looking
      // further back rather than locking onto an empty one.
      if (ctx !== null || fiveH !== null || sevenD !== null) usage = { ctx, fiveH, sevenD, fiveHResetAt };
    }

    if (!model && obj.type === 'turn_context') {
      // Bounded by the SAME rule as Claude's labels (metrics-common.label): these
      // become rendered text in both clients and ride to peers on the cluster
      // session list, so the length bound belongs to the field, not to one parser.
      if (_label(p.model)) model = p.model;
      if (_label(p.effort)) effort = p.effort;
    }

    if (usage && model) break;
  }

  // #142 — a SEPARATE backward scan (see findUsageCapAt) rather than folded into the
  // one above: the cap-error rule needs to see EVERY token_count/turn_context/user
  // message it passes, not just the newest, so it can tell "superseded" from "still
  // capped" — a different traversal than "take the first (newest) qualifying line and
  // stop" that usage/model already do. The extra pass is bounded by the same tail
  // text this function already receives.
  const capObservedAt = findUsageCapAt(text);

  if (!usage && !model && capObservedAt === null) return null;
  return {
    ctx: usage ? usage.ctx : null,
    fiveH: usage ? usage.fiveH : null,
    sevenD: usage ? usage.sevenD : null,
    fiveHResetAt: usage ? usage.fiveHResetAt : null,
    model,
    effort,
    capObservedAt,
  };
}

module.exports = { parseMetricsFromTail, findUsageCapAt, FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES };
