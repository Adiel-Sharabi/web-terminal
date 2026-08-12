'use strict';
// Claude Code usage metrics, read out of the payload its status line is handed.
//
// Codex RECORDS its usage in its rollout (lib/metrics-codex.js reads it back);
// Claude PUSHES its usage instead — Claude Code invokes the configured
// `statusLine` command every render and pipes it a JSON blob on stdin. That blob
// is the only place these numbers are exposed, and scripts/wt-push-status.sh
// forwards it verbatim to POST /api/claude-status. This module is the SSOT for
// what it means. PURE (object in, object out), so every field choice below is
// unit-testable against a captured payload.
//
// Verified by CAPTURING A REAL PAYLOAD from claude-code 2.1.215 on 2026-07-19
// (the repo doctrine: the data is ground truth, the docs are a cross-check), then
// confirmed against code.claude.com/docs/en/statusline.md:
//
//   { session_id, model:{id,display_name}, effort:{level},
//     context_window: { total_input_tokens, total_output_tokens,
//                       context_window_size, used_percentage,
//                       remaining_percentage, current_usage:{...} },
//     rate_limits: { five_hour:{used_percentage,resets_at},
//                    seven_day:{used_percentage,resets_at} } }
//
// TWO facts here each killed a bug that had been worked around in a client:
//
//   `context_window_size` — 200000 normally, 1000000 on an extended-context
//   session. The window is therefore a KNOWN NUMBER, not something a renderer
//   has to assume. The companion used to divide by a hardcoded 200000, which
//   pinned every 1M session's badge at ~100% once it passed 200k tokens (#71).
//   Note the docs are explicit that extended context is detected by THIS FIELD
//   and never by looking for a `[1m]` marker on the model name — display_name
//   carries no such suffix.
//
//   `rate_limits.five_hour.resets_at` — the 5h window's reset time. #69 shipped
//   with this stubbed to null on the belief that Claude's push carried no reset
//   time; it does, in the same UNIX EPOCH SECONDS Codex uses, so the auto-resume
//   timer needs no per-agent special case (lib/metrics-common.js).
//
// NULLABILITY IS THE WHOLE DIFFICULTY, and it is documented behaviour, not
// defensive padding:
//   - `rate_limits` is ABSENT entirely for non-Pro/Max accounts, and until the
//     session's first API response. Each window is independently absent too.
//   - `context_window.used_percentage` may be null.
//   - `context_window.current_usage` is null before the first API call AND
//     immediately after /compact until the next one.
// So a perfectly healthy session emits blank reports, and blank must never be
// read as 0% (#56) — nor be allowed to overwrite a good reading (see mergeStatus).

const { clampPct, resetAtMsFromSeconds, label: _label, LABEL_MAX } = require('./metrics-common');

// A context window is a token count. Reject nonsense outright rather than
// clamping it to something plausible: a bogus window silently rescales every
// percentage derived from it, which is exactly the class of bug #71 was.
const CTX_WINDOW_MAX = 100000000;

function _tokens(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

function _window(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > CTX_WINDOW_MAX) return null;
  return Math.round(v);
}

// The legacy shape: claude-status.sh used to parse the payload itself and POST a
// flat `{session_id, ctx, five, seven}` of BASH STRINGS ('' for absent — and
// Number('') is 0, which is why blank is checked before it is converted).
//
// Every machine that has not yet had scripts/wt-push-status.sh installed still
// pushes this, and a mixed fleet is the normal state here, so it stays supported
// rather than being migrated away. Such a report simply carries no window and no
// reset time, which is precisely the state that existed before this change.
function _legacyNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return clampPct(n);
}

function _isRawPayload(body) {
  if (!body || typeof body !== 'object') return false;
  return (
    (body.context_window && typeof body.context_window === 'object') ||
    (body.rate_limits && typeof body.rate_limits === 'object') ||
    (body.model && typeof body.model === 'object')
  );
}

/**
 * One status report -> the shared metrics shape, or null when the body is not an
 * object at all. Accepts BOTH the raw statusline payload and the legacy flat
 * push; every field is null when the source does not carry it.
 *
 * @returns {null | {ctx, ctxWindow, ctxTokens, fiveH, sevenD, fiveHResetAt, model, effort}}
 */
function parseStatusPayload(body) {
  if (!body || typeof body !== 'object') return null;

  if (!_isRawPayload(body)) {
    // `undefined`, not null: a flat push that carries no label CANNOT SPEAK about the
    // model — unlike a raw statusline render, where an absent label means there is
    // none. mergeStatus keys the difference off exactly that (#122).
    return {
      ctx: _legacyNum(body.ctx),
      ctxWindow: null,
      ctxTokens: null,
      fiveH: _legacyNum(body.five),
      sevenD: _legacyNum(body.seven),
      fiveHResetAt: null,
      model: _label(body.model) ?? undefined,
      effort: _label(body.effort) ?? undefined,
    };
  }

  const cw = (body.context_window && typeof body.context_window === 'object') ? body.context_window : {};
  const rl = (body.rate_limits && typeof body.rate_limits === 'object') ? body.rate_limits : {};
  const five = (rl.five_hour && typeof rl.five_hour === 'object') ? rl.five_hour : {};
  const seven = (rl.seven_day && typeof rl.seven_day === 'object') ? rl.seven_day : {};
  const model = (body.model && typeof body.model === 'object') ? body.model : {};
  const effort = (body.effort && typeof body.effort === 'object') ? body.effort : {};

  const ctxWindow = _window(cw.context_window_size);
  const ctxTokens = _tokens(cw.total_input_tokens);

  // Prefer the percentage Claude computed — it is the number its own UI shows, so
  // deriving a slightly different one would make the badge disagree with the TUI
  // for no gain. Fall back to the arithmetic only when it is null but the two
  // operands are present (documented: used_percentage can be null while the
  // token counts are not). Output tokens are deliberately excluded, matching
  // Claude's own definition of the figure.
  let ctx = clampPct(cw.used_percentage);
  if (ctx === null && ctxTokens !== null && ctxWindow !== null) {
    ctx = clampPct((ctxTokens / ctxWindow) * 100);
  }

  return {
    ctx,
    ctxWindow,
    ctxTokens,
    fiveH: clampPct(five.used_percentage),
    sevenD: clampPct(seven.used_percentage),
    fiveHResetAt: resetAtMsFromSeconds(five.resets_at),
    // display_name ("Opus 4.8") is the human label; id ("claude-opus-4-8") is the
    // fallback so a payload without a display name still identifies the model.
    model: _label(model.display_name) || _label(model.id),
    effort: _label(effort.level),
  };
}

/** Does this report carry any live number at all? */
function hasReading(m) {
  return !!m && (m.ctx !== null || m.fiveH !== null || m.sevenD !== null);
}

/**
 * Fold a new report onto the stored one.
 *
 * The split is between what a session IS and what it is DOING:
 *
 *   STABLE  — ctxWindow, model, effort. Properties of the session's
 *             configuration. A report that omits one has not learned that it
 *             changed, so the known value carries forward. Without this, the
 *             blank report Claude emits right after /compact would erase the
 *             window and take the ctx badge back to guessing.
 *
 * "Stable" is not "immutable", and conflating the two was #122: `/model` changes
 * both labels mid-session, and a model that has no effort left the OLD effort
 * standing forever — the badge read `Haiku 4.5 · xhigh`. So a LIVE raw report is
 * authoritative about the labels it renders: it shows what Claude is using now, and
 * an absent effort there is a statement that there is none. Silence still carries
 * forward, but only real silence — a blank (readingless) report, or a legacy flat
 * push that cannot express a label at all, which is why those arrive as `undefined`
 * while a raw render's absent label arrives as `null`.
 *   VOLATILE — ctx, ctxTokens, fiveH, sevenD, fiveHResetAt. Only ever the newest
 *             reading; a stale one carried forward would be reported as fresh.
 *
 * A report with no reading at all (`hasReading` false — pre-first-call, or the
 * post-/compact gap) must not land as an all-null entry, because that would
 * blank a perfectly good stored reading and reset its `ts` to now, marking the
 * blank as the freshest truth. Such a report still contributes its stable
 * fields, which is how the window survives a /compact.
 */
function mergeStatus(prev, next) {
  if (!next) return prev || null;
  const p = prev || {};
  const ctxWindow = next.ctxWindow !== null && next.ctxWindow !== undefined
    ? next.ctxWindow : (p.ctxWindow ?? null);
  if (!hasReading(next)) {
    // Not authoritative about anything: fill gaps, overwrite nothing.
    const filled = {
      ctxWindow,
      model: next.model || p.model || null,
      effort: next.effort || p.effort || null,
    };
    if (!prev) return { ...next, ...filled };
    return { ...p, ...filled }; // keep the stored reading AND its ts
  }
  return {
    ctx: next.ctx,
    ctxTokens: next.ctxTokens,
    fiveH: next.fiveH,
    sevenD: next.sevenD,
    fiveHResetAt: next.fiveHResetAt,
    ctxWindow,
    // A live render speaks for the labels: `null` clears, `undefined` (a source that
    // cannot express one) carries forward. See the note above — #122.
    model: next.model !== undefined ? next.model : (p.model ?? null),
    effort: next.effort !== undefined ? next.effort : (p.effort ?? null),
  };
}

module.exports = { parseStatusPayload, mergeStatus, hasReading, LABEL_MAX, CTX_WINDOW_MAX };
