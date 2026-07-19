'use strict';
// Codex usage metrics, read out of a rollout transcript's tail.
//
// Claude PUSHES its status line to POST /api/claude-status; Codex has no such hook,
// but it writes everything we need into the rollout on every turn, so the same
// `{ ctx, fiveH, sevenD, fiveHResetAt, model, effort }` shape is recoverable by reading
// the tail — no extra process, no extra endpoint. PURE (text in, object out) so the
// arithmetic and the field selection are exhaustively unit-testable; server.js supplies
// the tail.
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

function _pct(v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function _matchesWindow(minutes, nominal) {
  if (typeof minutes !== 'number' || !(minutes > 0)) return false;
  return Math.abs(minutes - nominal) <= nominal * WINDOW_TOLERANCE;
}

// `resets_at` is UNIX EPOCH SECONDS (see the file-header note) — convert to ms, and
// reject anything that isn't a sane positive number so a malformed field can never
// produce a timer that fires immediately (or in the past) in pty-worker.js.
function _resetAtMs(v) {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return null;
  return Math.round(v * 1000);
}

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

// Scan a block of rollout text from its END toward its start, taking the newest
// `token_count` that actually carries `info` (Codex occasionally writes one with
// info:null) and the newest `turn_context` for the model/effort labels. Returns null
// when the tail holds neither — the caller then reports no metrics rather than zeros.
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
      if (typeof p.model === 'string' && p.model) model = p.model;
      if (typeof p.effort === 'string' && p.effort) effort = p.effort;
    }

    if (usage && model) break;
  }

  if (!usage && !model) return null;
  return {
    ctx: usage ? usage.ctx : null,
    fiveH: usage ? usage.fiveH : null,
    sevenD: usage ? usage.sevenD : null,
    fiveHResetAt: usage ? usage.fiveHResetAt : null,
    model,
    effort,
  };
}

module.exports = { parseMetricsFromTail, FIVE_HOUR_MINUTES, SEVEN_DAY_MINUTES };
