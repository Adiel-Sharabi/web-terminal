'use strict';
// Rules shared by every usage-metrics parser (lib/metrics-claude.js,
// lib/metrics-codex.js).
//
// Both agents report the SAME two kinds of number, and each has exactly one
// correct reading — so each reading lives here once rather than being restated
// per provider. When a third agent arrives it imports these instead of
// re-deriving them (and re-deriving them slightly differently).

/**
 * A window percentage as the wire carries it: a whole 0–100, or null when the
 * value isn't a usable number.
 *
 * null is NOT 0. A blank/absent reading rendered as "0% used" reads as "plenty
 * left" at the exact moment we cannot say — the #56 rule is that unknown renders
 * as nothing. A negative is likewise rejected outright rather than clamped up to
 * 0, because it means the source is malformed, not that the window is empty.
 */
function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * A rate-limit window's reset time -> ms-epoch, or null.
 *
 * BOTH agents report `resets_at` in UNIX EPOCH **SECONDS**, and both were
 * verified against real data rather than docs:
 *   - Codex: rollout `rate_limits.<window>.resets_at` — 1783645131 decoded to
 *     2026-07-10T00:58:51Z, inside that session's plausible 5h window
 *     (lib/metrics-codex.js header has the full provenance).
 *   - Claude: statusline payload `rate_limits.five_hour.resets_at` — captured
 *     live on 2026-07-19 and confirmed against the documented schema
 *     (code.claude.com/docs/en/statusline.md), which states epoch seconds.
 *
 * Treating seconds as ms yields a timestamp in 1970, and treating ms as seconds
 * yields one ~50,000 years out — either way pty-worker.js's #69 auto-resume
 * timer fires immediately or never. Anything not a sane positive number is
 * rejected so a malformed field can never arm a timer at all.
 */
function resetAtMsFromSeconds(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1000);
}

/**
 * A model id / effort level as a display label, or null when unusable.
 *
 * Both agents report these (Claude in its status-line payload, Codex in its
 * rollout's `turn_context`) and BOTH now become rendered text in both clients —
 * the web sidebar row and the companion's meta bar. That makes the cap a real
 * boundary rather than tidiness: `metrics` rides on `GET /api/cluster/sessions`,
 * so a peer supplies these strings, and a client renders what the peer sent. A
 * length bound here means no surface downstream has to defend itself against an
 * unbounded one. (Escaping is still the client's job — this bounds size, not
 * content.)
 *
 * Lives here, not in one parser, because the Claude side capped at 40 while the
 * Codex side only type-checked — the same fact read two different ways, which is
 * exactly what this module exists to prevent.
 */
const LABEL_MAX = 40;

function label(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= LABEL_MAX ? v : null;
}

module.exports = { clampPct, resetAtMsFromSeconds, label, LABEL_MAX };
