'use strict';
// --- #468 R9 "going in circles": the same failure coming back across turns ---------------
//
// docs/SUPERVISOR-DESIGN.md section 5, R9: "The same failure, test or error comes back across
// turns, retries pile up." The transcript is the ground truth (CLAUDE.md, Method), so this
// reads it: every tool_result the main agent got back with `is_error: true` is reduced to a
// FINGERPRINT (the tool's name and the line of its output that names the failure, with every
// number and hex id blanked, so "3 failed" and "4 failed" are one failure), and counted with
// the prompt it came back under (`promptId`, one per user turn). The same fingerprint seen
// again and again under more than one prompt is a session that keeps hitting the same wall.
//
// It is FED by the same incremental transcript read that finds background work
// (server.js readBackgroundTasks), so it costs no read of its own. A subagent's result
// (`isSidechain`) is not the session's own failure and is skipped, like every line that is
// not a `type: "user"` transcript line (the `api-request-blob` copies repeat each result).
//
// What it publishes is the evidence (`circlingField`); whether that is a case is the rule's
// call (lib/supervisor.js planCases, `circleMin`). Patching symptoms (a special-case `if`,
// a swallowed error) is not something a transcript scan can tell: the dispatcher reads the
// session's tail for that, when this or another rule opens a case.
//
// Pure: no I/O, no clock (every function takes `now` where it needs one).

/** Fingerprints kept per session; the oldest (by last sighting) is dropped past it. */
const MAX_FINGERPRINTS = 200;
/** Sightings kept per fingerprint (the newest). */
const MAX_SIGHTINGS = 20;
/** Sightings older than this do not count: an error seen yesterday is not today's circle. */
const WINDOW_MS = 6 * 60 * 60 * 1000;
/** A fingerprint is published once it has been seen this often in the window. */
const PUBLISH_MIN = 3;

const PREFILTER = ['"is_error":true', '"tool_use"'];
const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/// The text of a tool_result's content (a string, or an array of text blocks).
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (_isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/// The line of a failure's output that names it, or null. "Exit code N" says only THAT it
/// failed; the first line that says error/fail/exception/assert says what.
function failureLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^exit code -?\d+$/i.test(l));
  if (!lines.length) return null;
  // An error or exception line says WHAT broke; a "3 failed" summary only that something did.
  const named = lines.find((l) => /error|exception/i.test(l))
    || lines.find((l) => /fail|assert|expected|cannot|not found|denied|refused|timed? ?out/i.test(l));
  return (named || lines[0]).slice(0, 300);
}

/// The fingerprint of one failure line: numbers, hex ids and quoted paths blanked, spaces
/// folded, lower case. Two runs of the same failing test give the same fingerprint.
function fingerprint(tool, line) {
  const f = String(line || '')
    .replace(/\b(0x)?[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase().slice(0, 160);
  return f ? `${String(tool || '?').slice(0, 40)}|${f}` : null;
}

/// An incremental scanner over a transcript's JSONL text. `feed(text)` takes whole lines.
function createCirclingScanner() {
  const toolOf = new Map(); // tool_use id -> tool name (bounded)
  const fps = new Map();    // fingerprint -> { tool, sample, seen: [{at, prompt}], lastAt }

  function noteUse(id, name) {
    toolOf.set(id, name);
    if (toolOf.size > 500) toolOf.delete(toolOf.keys().next().value);
  }

  function noteFailure(tool, text, at, prompt) {
    const line = failureLine(text);
    const key = line ? fingerprint(tool, line) : null;
    if (!key) return;
    const e = fps.get(key) || { tool, sample: line.slice(0, 160), seen: [], lastAt: 0 };
    e.seen.push({ at, prompt });
    if (e.seen.length > MAX_SIGHTINGS) e.seen.splice(0, e.seen.length - MAX_SIGHTINGS);
    e.lastAt = Math.max(e.lastAt, at || 0);
    e.sample = line.slice(0, 160); // the newest wording
    fps.delete(key); fps.set(key, e); // most recent last
    if (fps.size > MAX_FINGERPRINTS) fps.delete(fps.keys().next().value);
  }

  function feedLine(line) {
    if (!PREFILTER.some((p) => line.includes(p))) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!_isObj(obj) || obj.isSidechain === true) return;
    const msg = _isObj(obj.message) ? obj.message : null;
    if (!msg || !Array.isArray(msg.content)) return;
    if (obj.type === 'assistant') {
      for (const b of msg.content) if (_isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') noteUse(b.id, typeof b.name === 'string' ? b.name : '?');
      return;
    }
    if (obj.type !== 'user') return;
    const at = Date.parse(obj.timestamp || '') || 0;
    const prompt = typeof obj.promptId === 'string' ? obj.promptId : null;
    for (const b of msg.content) {
      if (!_isObj(b) || b.type !== 'tool_result' || b.is_error !== true) continue;
      noteFailure(toolOf.get(b.tool_use_id) || '?', resultText(b.content), at, prompt);
    }
  }

  return {
    feed(text) { for (const l of String(text || '').split('\n')) if (l) feedLine(l); },
    /// The strongest repeated failure at [now] (see circlingField), or null.
    field(now) { return circlingField(fps, now); },
  };
}

/// The published evidence: the fingerprint seen most often within WINDOW_MS of [now], if it
/// was seen at least PUBLISH_MIN times. `turns` counts the distinct prompts it came back
/// under (a sighting with no promptId counts as its own). Ties go to the most recent.
function circlingField(fps, now) {
  let best = null;
  for (const e of fps.values()) {
    const seen = e.seen.filter((s) => Number.isFinite(now) && s.at && now - s.at <= WINDOW_MS);
    if (seen.length < PUBLISH_MIN) continue;
    const turns = new Set(seen.map((s, i) => s.prompt || `#${i}`)).size;
    const c = { tool: e.tool, sample: e.sample, count: seen.length, turns,
      firstAt: seen[0].at, lastAt: seen[seen.length - 1].at };
    if (!best || c.count > best.count || (c.count === best.count && c.lastAt > best.lastAt)) best = c;
  }
  return best;
}

module.exports = { MAX_FINGERPRINTS, MAX_SIGHTINGS, WINDOW_MS, PUBLISH_MIN,
  resultText, failureLine, fingerprint, createCirclingScanner, circlingField };
