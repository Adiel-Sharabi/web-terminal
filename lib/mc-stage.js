'use strict';
// #505 - Mission Control: how far a work item has got (its progress stage).
//
// The ONE owner of the stage order, the words an agent may report for one, and the evidence
// rule: what the tracker proves (a pull request's real state, a closed work item) beats what
// an agent last said, and a stage never moves backwards (docs/mission-control.md "Stage").
// `lib/session-brief.js` validates a reported `stage` through `normalizeStage`; the subjects
// view (lib/mc-subjects.js) folds each subject's history through `foldStage`.
//
// Pure: no I/O, no clock reads except through `now`. Required only by modules that
// `server.js` requires (never by pty-worker.js / monitor.js or anything they require).

const STAGES = Object.freeze(['triage', 'reproduced', 'planned', 'fixing', 'pr-open', 'in-review', 'merged', 'tested']);

/// Words an agent plausibly writes for a stage. As with `state`, mapping them is kinder than
/// refusing; an unknown word is refused WITH the list.
const STAGE_ALIASES = Object.freeze({
  'triage': 'triage', 'triaged': 'triage', 'investigating': 'triage', 'analysis': 'triage',
  'reproduced': 'reproduced', 'repro': 'reproduced', 'reproducing': 'reproduced',
  'planned': 'planned', 'plan': 'planned', 'planning': 'planned', 'designed': 'planned',
  'fixing': 'fixing', 'fix': 'fixing', 'implementing': 'fixing', 'coding': 'fixing',
  'pr-open': 'pr-open', 'pr': 'pr-open', 'pr-opened': 'pr-open', 'opened-pr': 'pr-open',
  'in-review': 'in-review', 'review': 'in-review', 'reviewing': 'in-review', 'reviewed': 'in-review',
  'merged': 'merged', 'landed': 'merged',
  'tested': 'tested', 'verified': 'tested', 'test-passed': 'tested',
});

/// At most this many history entries per subject. Only ADVANCES are recorded, so the eight
/// stages bound it already; the cap guards a hand-edited state file.
const HISTORY_MAX = STAGES.length;

function normalizeStage(s) {
  if (typeof s !== 'string') return null;
  const k = s.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return STAGE_ALIASES[k] || null;
}

/** The stage's place in the order, or -1 for none / unknown. */
function stageIndex(s) { return typeof s === 'string' ? STAGES.indexOf(s) : -1; }

/** The later of two stages (either may be null). */
function maxStage(a, b) { return stageIndex(b) > stageIndex(a) ? b : (stageIndex(a) >= 0 ? a : null); }

/** What the tracker PROVES about a work item, from its Meta (lib/tracker-meta.js), or null.
 *  A merged pull request or a closed/resolved work item -> merged; a pull request with
 *  reviews -> in-review (only when the tracker details carry `reviews`; they do not yet);
 *  an open pull request (a draft too) -> pr-open. A Meta that could not be read (no
 *  `fetchedAt`) proves nothing. */
function evidenceStage(meta) {
  if (!meta || typeof meta !== 'object' || !meta.fetchedAt) return null;
  const prs = Array.isArray(meta.prs) ? meta.prs : [];
  const label = (p) => (p && p.number ? `PR #${p.number}` : 'a pull request');
  const merged = prs.find((p) => p && p.state === 'merged');
  if (merged) return { stage: 'merged', source: 'pr', detail: `${label(merged)} merged` };
  if (meta.closed === true) return { stage: 'merged', source: 'tracker', detail: `work item ${meta.state ? `is ${String(meta.state).slice(0, 40)}` : 'closed'}` };
  const reviewed = prs.find((p) => p && p.state === 'open' && Number.isFinite(p.reviews) && p.reviews > 0);
  if (reviewed) return { stage: 'in-review', source: 'pr', detail: `${label(reviewed)} has reviews` };
  const open = prs.find((p) => p && p.state === 'open');
  if (open) return { stage: 'pr-open', source: 'pr', detail: `${label(open)} open${open.draft ? ' (draft)' : ''}` };
  return null;
}

/** A stored history, cleaned: known stages only, strictly advancing, capped. */
function cleanHistory(raw) {
  const out = [];
  for (const h of Array.isArray(raw) ? raw : []) {
    if (!h || stageIndex(h.stage) < 0) continue;
    if (out.length && stageIndex(h.stage) <= stageIndex(out[out.length - 1].stage)) continue;
    out.push({ stage: h.stage, at: Number.isFinite(h.at) ? h.at : null,
      source: ['report', 'pr', 'tracker'].includes(h.source) ? h.source : 'report',
      detail: typeof h.detail === 'string' ? h.detail.slice(0, 160) : null });
  }
  return out.slice(-HISTORY_MAX);
}

/** Fold what is known NOW into a subject's stage. `reported` is the latest stage an agent
 *  reported for it (null when none did) and `reportedAt` when; `meta` the tracker details.
 *  `history` is what was stored before. Returns `{stage: Stage, history, changed}`:
 *  current = the furthest of the history, the report and the evidence - never backwards. */
function foldStage({ history, reported, reportedAt, reportDetail, meta, now }) {
  const hist = cleanHistory(history);
  const before = hist.length;
  const ev = evidenceStage(meta);
  const top = () => (hist.length ? hist[hist.length - 1].stage : null);
  const push = (stage, at, source, detail) => {
    if (stageIndex(stage) > stageIndex(top())) hist.push({ stage, at, source, detail: detail || null });
  };
  const rep = stageIndex(reported) >= 0 ? reported : null;
  // The lower of the two first, so a history reads in the order the stages were reached.
  const steps = [];
  if (rep) steps.push([rep, Number.isFinite(reportedAt) ? reportedAt : now, 'report', reportDetail]);
  if (ev) steps.push([ev.stage, now, ev.source, ev.detail]);
  steps.sort((a, b) => stageIndex(a[0]) - stageIndex(b[0]));
  for (const s of steps) push(...s);
  const capped = hist.slice(-HISTORY_MAX);
  return {
    stage: { current: top(), reported: rep, evidence: ev ? ev.stage : null, history: capped },
    history: capped,
    changed: capped.length !== before,
  };
}

module.exports = {
  STAGES, STAGE_ALIASES, HISTORY_MAX,
  normalizeStage, stageIndex, maxStage, evidenceStage, cleanHistory, foldStage,
};
