'use strict';
// Account-wide usage roll-up (#56) — the ONE place that turns per-session metric
// reports into the per-server `usage` block the sidebars render.
//
// `ctx%` is genuinely per-session. The 5h and 7d rate-limit windows are NOT: they belong
// to the ACCOUNT the agent is logged into, so every session on a server reports the same
// pair of numbers. Repeating them on every row implies a per-session budget that does not
// exist. They belong once, on the server header — which means ONE roll-up, computed here
// and carried on the payload, never a max()/freshest-of picked independently by each
// client. PURE (sessions in, object out), so attribution and freshness are unit-testable.
//
// Three rules, and they are the whole module:
//
//  1. Quotas are PER AGENT and never merged. Claude and Codex bill separate accounts; one
//     blended "5h 42%" would be a lie about both. A server reports only the agents that
//     actually reported on it — no agent present, no key.
//
//  2. A report is attributed by its SOURCE, not by the session's declared agent.
//     `metrics.agent` (stamped where the metric is read — server.js getStatusMetrics /
//     readTranscriptMetrics) says whose quota it describes. That is not always the same as
//     `session.agent`: a user can run `claude` inside a plain shell, and that session
//     carries a Claude status-line report while declaring no agent at all.
//
//  3. A number is only as good as its report. `metrics.ts` says when it landed. No ts, a ts
//     older than the metrics TTL, or a ts further in the future than clock-skew tolerance
//     allows, all mean UNKNOWN — and unknown renders as NOTHING, never as 0%. Metrics are
//     frozen-while-idle by design, so "old" is the normal state of an idle server; the TTL is
//     what separates "idle but still true" from "gone". The future side matters just as much:
//     "freshest wins" picks the largest ts, so a single bogus future report would win forever
//     and hide every real one behind it.

// The metrics TTL — SSOT for "how old is too old" across every metric source. Idle sessions
// stop reporting (Claude's status line only runs while it renders), so the last-known values
// must survive hours of idleness; past this they are no longer worth trusting.
const METRICS_TTL_MS = 4 * 60 * 60 * 1000;

// The freshness gate must cut BOTH ways. A `ts` from a peer with a skewed or bogus clock can
// land in the future — and a future ts is not just "not stale", it is the largest ts anyone
// will ever report, so it wins "freshest wins" forever and permanently masks every genuine
// report for that agent. A real peer's clock can legitimately drift by a few seconds (NTP
// slew, scheduling jitter between reading the clock and the report landing) — never by
// minutes. Anything beyond that tolerance is not a fast clock, it is unattributable, exactly
// like a missing or stale ts (rule 3: unknown renders as nothing, never 0%).
const CLOCK_SKEW_TOLERANCE_MS = 30 * 1000;

// An agent id from a PEER's payload becomes a key in the object we serve, and a label in the
// clients' DOM. Accept only the shape a real provider id has (see lib/agents.js), so a rogue
// or buggy peer cannot inject `__proto__`, markup, or a novel-length key.
const AGENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/i;

// …and reject the ids that merely LOOK ordinary but collide with a builtin property name
// (`constructor`, `toString`, `valueOf`, …). We hand the key to clients that look the agent
// up in a plain object (`agents[id]` — the /api/agents catalogue), where such a key resolves
// to an inherited function instead of missing. Cheap to refuse; no real provider id is one.
function _isSafeAgentKey(id) {
  return AGENT_KEY_RE.test(id) && !(id in Object.prototype);
}

// A window percentage. Anything that is not a finite number is absent, never 0 — a blank
// reading must not render as "0% used".
function _pct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Roll a session list up into per-agent account usage.
 *
 * @param {Array<{metrics?: {agent?: string, fiveH?: number, sevenD?: number, ts?: number}}>} sessions
 *        Sessions as they appear on the wire (local shaped list, or a peer's /api/sessions
 *        array — identical shape, so ONE rule serves both).
 * @param {{now?: number, ttlMs?: number}} [opts]
 * @returns {null | Object<string, {fiveH: number|null, sevenD: number|null, ts: number}>}
 *          null when no agent has a usable, fresh report (render nothing — not zeros).
 */
function rollUpUsage(sessions, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : METRICS_TTL_MS;
  const out = Object.create(null);
  let any = false;

  for (const s of Array.isArray(sessions) ? sessions : []) {
    const m = s && s.metrics;
    if (!m || typeof m !== 'object') continue;

    const agent = typeof m.agent === 'string' && _isSafeAgentKey(m.agent) ? m.agent : null;
    if (!agent) continue; // an unattributable report cannot be charged to a quota

    const ts = typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : null;
    if (ts === null || now - ts > ttlMs || ts - now > CLOCK_SKEW_TOLERANCE_MS) continue; // unknown, stale, or bogus-future → nothing

    const fiveH = _pct(m.fiveH);
    const sevenD = _pct(m.sevenD);
    if (fiveH === null && sevenD === null) continue; // a ctx-only report says nothing about quota

    // Same account, so the freshest report for an agent is simply the truest one.
    const prev = out[agent];
    if (prev && prev.ts >= ts) continue;
    out[agent] = { fiveH, sevenD, ts };
    any = true;
  }

  return any ? out : null;
}

module.exports = { rollUpUsage, METRICS_TTL_MS, CLOCK_SKEW_TOLERANCE_MS };
