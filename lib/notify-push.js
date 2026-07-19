'use strict';
// Pure helpers for per-session push notifications (ntfy) + the companion
// "attention" record they feed. No I/O here — server.js owns storage, debounce
// timers, the actual HTTPS POST, and the live transcript read. Kept pure so the
// gating matrix, message shape, attention-record shape, and the G3 clear-decision
// matrix are all unit-testable without a network, timers, or a server.
//
// Per-session levels (default = "important"):
//   off       — never push
//   important — Claude needs approval + a stuck API error + an auto-resume after a
//               5h usage-limit reset (issue #69) (default)
//   all       — the above + finished/idle (only after it settles)

const LEVELS = ['off', 'important', 'all'];
const DEFAULT_LEVEL = 'important';

function normalizeLevel(v) {
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

// kind: 'approval' | 'apierror' | 'autoresume' | 'idle' | 'clear'
function shouldPush(kind, level) {
  // 'clear' is a resolution/auto-dismiss, not an alert — it bypasses the level
  // gate entirely so a delivered notification can be dismissed even when the
  // session is set to 'off'.
  if (kind === 'clear') return true;
  const lv = normalizeLevel(level);
  if (lv === 'off') return false;
  if (lv === 'all') return true;
  // 'important' excludes idle. 'autoresume' (issue #69) joins approval/apierror here:
  // the worker acted on the user's behalf while they weren't watching, same as the
  // API-error ladder — that is exactly the kind of thing 'important' means to cover.
  return kind === 'approval' || kind === 'apierror' || kind === 'autoresume';
}

// Build the ntfy publish object (JSON publishing form — handles UTF-8 titles/
// bodies cleanly, unlike ASCII-only headers). Pure: returns { topic-less } fields
// that server.js merges with the configured topic before POSTing.
function buildNtfyMessage(kind, { sessionName, serverName, reason, click, detail } = {}) {
  const name = sessionName || 'session';
  const where = serverName ? `${serverName}: ${name}` : name; // "Office: DroneLocator"
  const base = { title: where, click: click || undefined };
  // Optionally append Claude's last message as a second block so the phone
  // shows *what* Claude said/asked, not just that it wants attention.
  const withDetail = (msg) => (detail ? `${msg}\n\n${detail}` : msg);
  if (kind === 'approval') {
    return { ...base, message: withDetail(reason || 'Claude needs your approval'), priority: 5, tags: ['warning'] };
  }
  if (kind === 'apierror') {
    return { ...base, message: withDetail(reason || 'API error'), priority: 4, tags: ['rotating_light'] };
  }
  if (kind === 'autoresume') {
    // #69 — the worker sent 'continue' on its own after the account's 5h usage-limit
    // window reset. Informational, not urgent: priority 3 (same as the default "done"
    // push), not apierror's 4.
    return { ...base, message: withDetail(reason || 'Auto-resumed after usage-limit reset'), priority: 3, tags: ['arrows_counterclockwise'] };
  }
  if (kind === 'clear') {
    // A silent dismissal marker. The ntfy transport can't recall a delivered
    // push (server.js treats 'clear' as a no-op there), but the shape is defined
    // here so a future transport (FCM) can render/collapse it. Min priority so
    // it never buzzes the phone.
    return { ...base, message: withDetail(reason || 'Resolved'), priority: 1, tags: ['white_check_mark'] };
  }
  return { ...base, message: withDetail(reason || 'Claude is done, waiting for input'), priority: 3, tags: ['white_check_mark'] };
}

// Split the worker's notifyMsg (`"<name>" — <reason>`) into name + reason so the
// push can lead with a clean session name.
function splitNotifyMsg(msg) {
  const m = /^"(.*?)"\s*[—-]\s*([\s\S]*)$/.exec(msg || '');
  if (m) return { name: m[1], reason: m[2].trim() };
  return { name: '', reason: (msg || '').trim() };
}

// --- Attention record (the companion "what needs my attention" state) --------
// The record server.js stashes per session and serves from GET
// /api/sessions/:id/attention. Kept here (pure) alongside the push gating so the
// record shape + the G3 clear-decision matrix are unit-testable without a server.

// Build a fresh attention record. cleared:false — it flips true only once the
// state resolves (see statusClearsApproval / apiRecoveryClearsError). `at`
// defaults to now but is injectable so tests can pin it.
function makeAttention(kind, { reason, name, at } = {}) {
  return { kind, reason: reason || '', name: name || '', at: at ?? Date.now(), cleared: false };
}

// Shape the GET /api/sessions/:id/attention response body. The caller reads the
// live transcript (I/O) and passes lastMessage in. A null/absent record yields
// all-null event fields so the companion can tell "nothing needs attention"
// apart from a real event that happens to carry empty strings.
function buildAttentionResponse({ id, serverName, lastAttention, lastMessage } = {}) {
  const att = lastAttention || null;
  return {
    id: id ?? null,
    serverName: serverName ?? null,
    kind: att ? att.kind : null,
    reason: att ? att.reason : null,
    name: att ? att.name : null,
    at: att ? att.at : null,
    cleared: att ? !!att.cleared : null,
    lastMessage: lastMessage || '',
  };
}

// G3 (a): a statusChanged off 'waiting' resolves an uncleared 'approval' — the
// user answered the permission prompt, so the approval notification can be
// auto-dismissed.
function statusClearsApproval(status, lastAttention) {
  return !!(status && status !== 'waiting'
    && lastAttention && lastAttention.kind === 'approval' && !lastAttention.cleared);
}

// G3 (b): a recovered API error (the apiError event with cleared:true) resolves
// an uncleared 'apierror'. The caller only invokes this on that event, so this
// just checks the recorded attention still warrants a clear.
function apiRecoveryClearsError(lastAttention) {
  return !!(lastAttention && lastAttention.kind === 'apierror' && !lastAttention.cleared);
}

module.exports = {
  LEVELS, DEFAULT_LEVEL, normalizeLevel, shouldPush, buildNtfyMessage, splitNotifyMsg,
  makeAttention, buildAttentionResponse, statusClearsApproval, apiRecoveryClearsError,
};
