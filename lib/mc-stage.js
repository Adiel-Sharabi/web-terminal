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

/// #561 - what a work item's own workflow STATE proves, by name (case-insensitive). These are the
/// AM8 process's states; their meanings are AM8's (am8_core `.claude/wi-flow/flow.json`):
/// Committed = pushed to a branch, not on mainline (a PR may be open); Parked = complete, held
/// on a long-lived feature branch; Merged = on mainline, not yet in a published build; Ready for
/// test = in a published build, on the QA desk; Done = verified by its Verifier. Every other
/// state (New, Approved, In Progress, Reopen, More info required, Not Reproducible, Postponed)
/// proves nothing - In Progress says someone works on it, not how far it has got.
const TRACKER_STATE_STAGES = Object.freeze({
  'committed': { stage: 'pr-open', why: 'pushed, not on mainline' },
  'parked': { stage: 'pr-open', why: 'held on a feature branch' },
  'merged': { stage: 'merged', why: 'on mainline' },
  'ready for test': { stage: 'merged', why: 'released, on the QA desk' },
  'done': { stage: 'tested', why: 'verified' },
});
/// A CLOSED work item in one of these states was given up, not fixed: closed proves no stage.
const CLOSED_UNFIXED_STATES = Object.freeze(['removed']);

/// #569 - for an Azure DevOps item its STATION (the workflow state, as ADO names it) is the authority
/// on how far its code got: it outranks what a session reported and what a pull request proves
/// (a PR merged into a long-lived feature branch is not on mainline; a Reopen was rejected by QA).
/// So these stations CAP the stage the view shows: Committed and Parked = the code is not on
/// mainline, at most in-review; Reopen = QA rejected it, at most fixing. Every other station caps
/// nothing. Applied when the view is built (`foldStage`), never to the stored history.
const STATION_CAPS = Object.freeze({
  'committed': 'in-review',
  'parked': 'in-review',
  'reopen': 'fixing',
});
const STATION_MAX = 40;

/** #569 - an ADO item's station as ADO names it (`Parked`, `Ready for test`), or null: a GitHub
 *  item has none (the generic stage stays), nor does an item whose tracker was never read. */
function stationOf(meta) {
  if (!meta || typeof meta !== 'object' || meta.tracker !== 'ado' || !meta.fetchedAt || typeof meta.state !== 'string') return null;
  return meta.state.trim().slice(0, STATION_MAX) || null;
}

/** #569 - the furthest stage the item's station allows, or null when it caps nothing. */
function stationCap(meta) {
  const station = stationOf(meta);
  const k = station ? station.toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(STATION_CAPS, k) ? STATION_CAPS[k] : null;
}

/** The later of two stages (either may be null). */
function maxStage(a, b) { return stageIndex(b) > stageIndex(a) ? b : (stageIndex(a) >= 0 ? a : null); }

/** What the tracker PROVES about a work item, from its Meta (lib/tracker-meta.js), or null.
 *  A Meta never read (no `fetchedAt`) proves nothing.
 *  - The subject IS a pull request: its own state - merged -> merged, open -> pr-open; closed
 *    unmerged (abandoned) proves nothing (its `closed` is not a resolution).
 *  - A pull request linked to it still OPEN -> pr-open (in-review when the details carry
 *    `reviews`; they do not yet): the work goes on, even beside an earlier merged one (a
 *    phase-A PR merged while phase B is open).
 *  - Else a merged linked pull request, or the work item closed/resolved -> merged; a closed
 *    item given up (`CLOSED_UNFIXED_STATES`, Removed) proves nothing by being closed.
 *  - #561: the work item's own state (`TRACKER_STATE_STAGES`: Committed, Parked, Merged, Ready
 *    for test, Done) proves its stage too; the furthest of it and the above wins. */
function evidenceStage(meta) {
  if (!meta || typeof meta !== 'object' || !meta.fetchedAt) return null;
  const label = (p) => (p && p.number ? `PR #${p.number}` : 'a pull request');
  if (meta.type === 'Pull request') {
    if (meta.state === 'merged') return { stage: 'merged', source: 'pr', detail: 'the pull request is merged' };
    if (meta.state === 'open') return { stage: 'pr-open', source: 'pr', detail: 'the pull request is open' };
    return null;
  }
  const prs = Array.isArray(meta.prs) ? meta.prs.filter((p) => p && typeof p === 'object') : [];
  const open = prs.filter((p) => p.state === 'open');
  const merged = prs.find((p) => p.state === 'merged');
  const stateName = typeof meta.state === 'string' ? meta.state.trim().toLowerCase() : '';
  const byState = Object.prototype.hasOwnProperty.call(TRACKER_STATE_STAGES, stateName) ? TRACKER_STATE_STAGES[stateName] : null;
  const fromState = byState
    ? { stage: byState.stage, source: 'tracker', detail: `work item is ${String(meta.state).trim().slice(0, 40)} (${byState.why})` } : null;
  let fromPr = null;
  if (meta.closed === true) {
    if (merged) fromPr = { stage: 'merged', source: 'pr', detail: `${label(merged)} merged` };
    else if (!CLOSED_UNFIXED_STATES.includes(stateName)) {
      fromPr = { stage: 'merged', source: 'tracker', detail: `work item ${meta.state ? `is ${String(meta.state).slice(0, 40)}` : 'closed'}` };
    }
  } else {
    const reviewed = open.find((p) => Number.isFinite(p.reviews) && p.reviews > 0);
    if (reviewed) fromPr = { stage: 'in-review', source: 'pr', detail: `${label(reviewed)} has reviews` };
    else if (open.length) fromPr = { stage: 'pr-open', source: 'pr', detail: `${label(open[0])} open${open[0].draft ? ' (draft)' : ''}` };
    else if (merged) fromPr = { stage: 'merged', source: 'pr', detail: `${label(merged)} merged` };
  }
  // The furthest of the two; on a tie the pull request names it (it is the more specific proof).
  if (!fromState) return fromPr;
  if (!fromPr) return fromState;
  return stageIndex(fromState.stage) > stageIndex(fromPr.stage) ? fromState : fromPr;
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

/** Fold what is known NOW into a subject's stage. `reports`: every stage an agent reports
 *  for it now, `[{stage, at, detail}]`, newest first (the first names `reported`); `meta` the
 *  tracker details; `history` what was stored before. Returns `{stage: Stage, history, changed}`.
 *  current = the furthest of the history, the reports and the evidence, then held to an ADO item's
 *  station cap (#569: `stage.station`, `STATION_CAPS`; the stored `history` is never capped). A stage
 *  reached by a REPORT is never moved back. A stage only the tracker proved is withdrawn when a fresh,
 *  complete read (no `error`, no `warning`) no longer proves it - a reopened work item, a pull request reopened - down to
 *  what the reports and the evidence still hold. */
function foldStage({ history, reports, meta, now }) {
  const hist = cleanHistory(history);
  const was = JSON.stringify(hist);
  const ev = evidenceStage(meta);
  const reps = (Array.isArray(reports) ? reports : []).filter((r) => r && stageIndex(r.stage) >= 0);
  const top = () => (hist.length ? hist[hist.length - 1].stage : null);
  // Only a COMPLETE read withdraws: a `warning` means part of it (a linked PR, the timeline)
  // could not be read, and withdrawing on it would flap with every failed timeline page.
  const freshRead = Boolean(meta && meta.fetchedAt && !meta.error && !meta.warning);
  if (freshRead) {
    const reportedTop = Math.max(-1, ...hist.filter((h) => h.source === 'report').map((h) => stageIndex(h.stage)),
      ...reps.map((r) => stageIndex(r.stage)));
    const floor = Math.max(reportedTop, ev ? stageIndex(ev.stage) : -1);
    while (hist.length && hist[hist.length - 1].source !== 'report' && stageIndex(top()) > floor) hist.pop();
  }
  const push = (stage, at, source, detail) => {
    if (stageIndex(stage) > stageIndex(top())) hist.push({ stage, at, source, detail: detail || null });
  };
  // Lowest first, so a history reads in the order the stages were reached.
  const steps = reps.map((r) => [r.stage, Number.isFinite(r.at) ? r.at : now, 'report', typeof r.detail === 'string' ? r.detail.slice(0, 160) : null]);
  if (ev) steps.push([ev.stage, now, ev.source, ev.detail]);
  steps.sort((x, y) => stageIndex(x[0]) - stageIndex(y[0]));
  for (const st of steps) push(...st);
  const capped = hist.slice(-HISTORY_MAX);
  // #569 - what the view SHOWS is held to the station's cap; `history` (what is stored, and what
  // `changed` compares) is not: the station moves on, the steps a session reported stay recorded.
  const cap = stationCap(meta);
  const shown = cap ? capped.filter((h) => stageIndex(h.stage) <= stageIndex(cap)) : capped;
  return {
    stage: { current: cap && stageIndex(top()) > stageIndex(cap) ? cap : top(), reported: reps.length ? reps[0].stage : null,
      evidence: ev ? ev.stage : null, station: stationOf(meta), history: shown },
    history: capped,
    changed: JSON.stringify(capped) !== was,
  };
}

module.exports = {
  STAGES, STAGE_ALIASES, HISTORY_MAX, TRACKER_STATE_STAGES, CLOSED_UNFIXED_STATES, STATION_CAPS,
  normalizeStage, stageIndex, maxStage, evidenceStage, stationOf, stationCap, cleanHistory, foldStage,
};
