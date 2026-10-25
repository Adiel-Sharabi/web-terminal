'use strict';
// --- The context budget: where a session's context actually runs out (#393) -------------
//
// Claude compacts at a point set by its `autoCompactWindow` setting, not at the model's
// window. Every rule that judges a session's context must judge it against THAT point, or
// it judges against a limit no session reaches. Two rules did: the auto hand-off offered at
// 500k (compaction fires first, so it never ran after 2026-10-18), and the companion's ctx
// colour warned at 50% of a 1M window (the largest value across 79 live sessions was 36%).
// This module is the one owner of the thresholds. server.js does the I/O (reading the
// setting, reading transcripts); this file is pure.
//
// MEASURED (2026-10-18..25, all three machines' transcripts): at autoCompactWindow=400000,
// sessions peaked at 366-367k and auto-compacted there, 268 times. So compaction fires at
// the window minus about 33k. The two ratios below are stated against the same window:
//   warn     0.625 -> 250k at 400k, the point C:\dev\claude-memory\hooks\context-advisor.js
//            starts advising /clear (its ADVISE), so the colour and the advice agree.
//   handoff  0.75  -> 300k at 400k: room before 367k for the wrap-up turn to run.
// With the setting unset (or not below the model's window) the model's window is the
// limit. That case is NOT measured on this fleet; it is taken as the window itself.

const COMPACT_BUFFER_TOKENS = 33000;
const WARN_RATIO = 0.625;
const HANDOFF_RATIO = 0.75;

/// A compaction record is a short line (the largest of 176 measured was 3041 bytes). A
/// longer line that mentions one is a tool result quoting it, so it is never parsed.
const MAX_RECORD_LINE = 64 * 1024;

const _pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/// The agent's auto-compact window from its parsed settings file, or null when unset,
/// invalid, or auto-compaction is switched off. [policy] is the registry's
/// `contextBudget` declaration (lib/agents.js), so the key names live there.
function autoCompactWindowFrom(settings, policy) {
  if (!settings || typeof settings !== 'object' || !policy) return null;
  if (policy.enabledSetting && settings[policy.enabledSetting] === false) return null;
  return _pos(settings[policy.windowSetting]);
}

/// The thresholds, in tokens of context occupancy, or null when neither the setting nor
/// the model's window is known. Always warnAt <= handoffAt <= compactAt.
///   source  'autoCompactWindow' when the setting decides, 'model' when the window does
function contextBudget({ ctxWindow, autoCompactWindow } = {}) {
  const model = _pos(ctxWindow);
  const setting = _pos(autoCompactWindow);
  const fromSetting = setting !== null && (model === null || setting < model);
  const base = fromSetting ? setting : model;
  if (base === null) return null;
  const compactAt = fromSetting ? Math.max(base - COMPACT_BUFFER_TOKENS, 0) : base;
  const handoffAt = Math.min(Math.round(base * HANDOFF_RATIO), compactAt);
  const warnAt = Math.min(Math.round(base * WARN_RATIO), handoffAt);
  return { warnAt, handoffAt, compactAt, source: fromSetting ? 'autoCompactWindow' : 'model' };
}

/// Context occupancy in tokens: percentage x window. NOT `ctxTokens`, which is the
/// status line's `total_input_tokens` - a running total, not what is in context now.
function occupancy(metrics) {
  const m = metrics || {};
  if (!Number.isFinite(m.ctx) || !Number.isFinite(m.ctxWindow) || m.ctxWindow <= 0) return null;
  return Math.round((m.ctx / 100) * m.ctxWindow);
}

/// A fresh compaction-count scan of one transcript: bytes consumed, records counted, and
/// whether it is part-way through a line too long to be a record.
function emptyScan() { return { offset: 0, count: 0, skipping: false }; }

function _isRecord(line, record) {
  try {
    const o = JSON.parse(line);
    return Boolean(o && o.type === record.type && o.subtype === record.subtype);
  } catch { return false; }
}

/// Fold [buf] - the transcript's bytes from `state.offset` on - into the scan. Counts the
/// complete lines that ARE a compaction record (the registry's `compaction` {type,
/// subtype}): a line that only mentions one (a tool result, 46 of 222 lines measured)
/// does not count. Only lines holding the subtype are parsed. A trailing line with no
/// newline yet is left unconsumed, so the next read starts on it again - which is why a
/// read must be longer than MAX_RECORD_LINE: one shorter than its first line consumes
/// nothing (server.js reads 4MB).
function scanCompactions(state, buf, record) {
  const s = state || emptyScan();
  if (!record || !record.subtype) return s;
  const needle = Buffer.from(record.subtype, 'utf8');
  let { count, skipping } = s;
  let pos = 0;
  if (skipping) {
    const nl = buf.indexOf(10);
    if (nl < 0) return { offset: s.offset + buf.length, count, skipping: true };
    pos = nl + 1;
    skipping = false;
  }
  for (;;) {
    const hit = buf.indexOf(needle, pos);
    if (hit < 0) {
      const last = buf.lastIndexOf(10);
      if (last >= pos) pos = last + 1;
      break;
    }
    const lineStart = buf.lastIndexOf(10, hit) + 1;
    const lineEnd = buf.indexOf(10, hit);
    if (lineEnd < 0) { pos = Math.max(lineStart, pos); break; }
    if (lineEnd - lineStart <= MAX_RECORD_LINE && _isRecord(buf.toString('utf8', lineStart, lineEnd), record)) count += 1;
    pos = lineEnd + 1;
  }
  // An unfinished line longer than any record: skip it rather than re-read it forever.
  if (buf.length - pos > MAX_RECORD_LINE) return { offset: s.offset + buf.length, count, skipping: true };
  return { offset: s.offset + pos, count, skipping };
}

module.exports = {
  COMPACT_BUFFER_TOKENS, WARN_RATIO, HANDOFF_RATIO, MAX_RECORD_LINE,
  autoCompactWindowFrom, contextBudget, occupancy, emptyScan, scanCompactions,
};
