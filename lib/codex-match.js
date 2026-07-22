'use strict';
// Which rollout belongs to WHICH Codex session, when several share a working directory.
//
// THE PROBLEM. A Codex rollout is keyed by date+uuid, never by cwd, so resolution has
// always been "the newest rollout whose session_meta.cwd matches". That silently assumes
// one Codex per directory. Run two and they collapse onto the same answer: measured on
// Office 2026-07-22, `Codex bug hunter` and `Codex setup sql fix 22421` both sat in
// C:\dev\acme_core and both reported agentSessionId 019f8928-… — so the dead session's
// chat lens showed the live session's conversation, beside a terminal that was correctly
// showing nothing. The terminal was honest; the chat was not.
//
// THE FIX, without hooks. A Codex process creates EXACTLY ONE rollout when it starts, and
// the rollout's filename carries that start time:
//     rollout-2026-07-22T10-07-16-019f8928-94e9-7072-93d3-271f00fbaea7.jsonl
// So "which rollout is this session's" becomes "which rollout was created when this
// session's codex process started" — a 1:1 correspondence, not a heuristic ranking. Two
// codex processes in one folder have different start times, so they get different
// rollouts. That is the whole idea.
//
// The stamp is LOCAL time, verified against real files: Office (UTC+3) wrote
// `rollout-2026-07-21T16-47-43-…` with an mtime of 13:51Z. Parsing it as UTC would shift
// every comparison by the machine's offset and match the wrong file — or nothing.

// How far apart a process's start and its rollout's stamp may be and still be the same
// session. Generous on purpose: the stamp has ONE-SECOND resolution, the process clock
// and the file stamp are taken at slightly different moments, and a cold start can spend
// a while booting MCP servers before the rollout lands. Two codex processes started
// within this window of each other in the SAME folder are genuinely ambiguous, and the
// caller is told so rather than being handed a coin-flip.
const MATCH_TOLERANCE_MS = 120000;

/**
 * The session start time encoded in a rollout filename, as local-time epoch ms.
 * Returns null for anything that isn't a rollout filename.
 */
function rolloutStartMs(p) {
  const m = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f]{8}-/i.exec(String(p || ''));
  if (!m) return null;
  // Local, NOT Date.parse — see the header. new Date(y, m, d, …) is local by definition.
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pick the candidate rollout created closest to `processStartMs`.
 *
 * @param {Array<{path:string, mtimeMs?:number}>} candidates cwd-matched rollouts
 * @param {number|null} processStartMs when this session's codex process started
 * @returns {{path:string, deltaMs:number, ambiguous:boolean}|null}
 *
 * `ambiguous` is set when a SECOND candidate sits within the tolerance too — two codex
 * processes started at nearly the same moment in one folder. The caller must not guess:
 * showing one session another's conversation is the bug this exists to prevent, and
 * showing nothing is the honest answer.
 */
function pickRolloutForProcessStart(candidates, processStartMs, toleranceMs = MATCH_TOLERANCE_MS) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (typeof processStartMs !== 'number' || !Number.isFinite(processStartMs)) return null;

  const scored = [];
  for (const c of candidates) {
    const started = rolloutStartMs(c.path);
    if (started === null) continue;
    // A rollout created BEFORE its process started cannot belong to it; allow only a
    // small negative slack for clock/rounding skew rather than a symmetric window.
    const delta = started - processStartMs;
    if (delta < -5000 || delta > toleranceMs) continue;
    scored.push({ path: c.path, deltaMs: Math.abs(delta) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.deltaMs - b.deltaMs);
  const best = scored[0];
  // Ambiguous only when a rival is genuinely close to the same start — a much tighter
  // bar than the outer tolerance, or a busy folder would report ambiguity constantly.
  const ambiguous = scored.length > 1 && Math.abs(scored[1].deltaMs - best.deltaMs) < 2000;
  return { path: best.path, deltaMs: best.deltaMs, ambiguous };
}

module.exports = { rolloutStartMs, pickRolloutForProcessStart, MATCH_TOLERANCE_MS };
