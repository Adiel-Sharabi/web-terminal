'use strict';
// Pure helpers for per-session push notifications (ntfy). No I/O here — server.js
// owns storage, debounce timers, and the actual HTTPS POST. Kept pure so the
// gating matrix and message shape are unit-testable without network or timers.
//
// Per-session levels (default = "important"):
//   off       — never push
//   important — Claude needs approval + a stuck API error (default)
//   all       — the above + finished/idle (only after it settles)

const LEVELS = ['off', 'important', 'all'];
const DEFAULT_LEVEL = 'important';

function normalizeLevel(v) {
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

// kind: 'approval' | 'apierror' | 'idle'
function shouldPush(kind, level) {
  const lv = normalizeLevel(level);
  if (lv === 'off') return false;
  if (lv === 'all') return true;
  return kind === 'approval' || kind === 'apierror'; // 'important' excludes idle
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
  return { ...base, message: withDetail(reason || 'Claude is done, waiting for input'), priority: 3, tags: ['white_check_mark'] };
}

// Split the worker's notifyMsg (`"<name>" — <reason>`) into name + reason so the
// push can lead with a clean session name.
function splitNotifyMsg(msg) {
  const m = /^"(.*?)"\s*[—-]\s*([\s\S]*)$/.exec(msg || '');
  if (m) return { name: m[1], reason: m[2].trim() };
  return { name: '', reason: (msg || '').trim() };
}

module.exports = { LEVELS, DEFAULT_LEVEL, normalizeLevel, shouldPush, buildNtfyMessage, splitNotifyMsg };
