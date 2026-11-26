'use strict';
// --- The fleet usage report (#529) --------------------------------------------------------
//
// ONE pure function over the folded ledger records (lib/usage-store.js `records()`), used by
// GET /api/usage/report and scripts/usage-report.js, so the two can never disagree.
//
// Windows. `days` counts LOCAL calendar days ending today (7 = today and the six before it). A session's
// units are taken day by day from its `byDay`, so a session that straddles the window's edge counts
// exactly the part inside. Every other figure of a session (tokens, models, wake-ups, time, prompts)
// is the session's whole life scaled by that same share: exact for a session inside the window, an
// approximation at the edges. `basis` says how each figure was measured.

const { WEIGHTS } = require('./usage-weights');
const { localDay } = require('./usage-session');
const { createScoper } = require('./usage-classify');
const { isFixed, isEscalated } = require('./usage-bh');
const { buildQuality, complexityBandOf } = require('./usage-quality');

/** Classes whose work is routine: Sonnet (or Haiku) is the right model, Opus a waste. */
const ROUTINE_CLASSES = Object.freeze(['pr-review', 'pipeline-check', 'wt-automation', 'child', 'handoff']);
const TOP_PROJECTS = 10;
const TOP_LIST = 8;
const REJECT_RE = /^(reject|fix|fail|unclear|no-answer)$/i;

const R1 = (x) => Math.round(x * 10) / 10;
const M = (x) => R1(x / 1e6);
const sum = (a) => a.reduce((n, x) => n + x, 0);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** The first and last local day of a window of [days] ending at [now]. */
function windowDays(now, days) {
  const to = localDay(now);
  const d = new Date(now);
  d.setDate(d.getDate() - (days - 1));
  return { from: localDay(d.getTime()), to };
}

const bump = (o, k, v) => { o[k] = (o[k] || 0) + v; };
const addTok = (a, b, f) => { for (const k of ['in', 'out', 'cr', 'cw', 'cw1h']) a[k] += (b[k] || 0) * f; };
const rank = (o, f) => Object.entries(o).map(([k, v]) => f(k, v)).sort((a, b) => b.units - a.units);

/** @param {object[]} records   the store's folded records
 *  @param {{now?: number, days?: number, scope?: 'work'|'private'|'all', machine?: string, workSource?: string|null}} o */
/** A session keeps growing after a machine is renamed: its new record lives under the new origin while the old
 *  one still exists. A Claude session is ONE session, so the newest record of each session id counts. */
function oneRecordPerSession(records) {
  const best = new Map();
  for (const r of records) {
    if (r.type !== 'session' || !r.sid) continue;
    const cur = best.get(r.sid);
    if (!cur || r.at > cur.at || (r.at === cur.at && r.origin > cur.origin)) best.set(r.sid, r);
  }
  return records.filter((r) => r.type !== 'session' || !r.sid || best.get(r.sid) === r);
}

function buildReport(allRecords, { now = Date.now(), days = 7, scope = 'all', machine = null, workSource = null } = {}) {
  const records = oneRecordPerSession(allRecords);
  const win = windowDays(now, days);
  const scoper = createScoper({ records, workSource });
  const want = machine ? String(machine).toLowerCase() : null;
  const inScope = (project) => scope === 'all' || scoper.scopeOf(project) === scope;

  const t = { units: 0, sessions: 0, tok: { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 }, subUnits: 0, human: 0, auto: 0, compactions: 0, compactedSessions: 0, peakCtx: 0 };
  const byMachine = {};
  const byScope = { work: { units: 0, sessions: 0 }, private: { units: 0, sessions: 0 } };
  const byClass = {};
  const byProject = {};
  const byModel = {};
  const wake = { n: 0, units: 0, autoN: 0, autoUnits: 0 };
  const time = { activeMs: 0, idleMs: 0, waitYouMs: 0, waits: 0, waitsMin: [] };
  const routine = { units: 0, opus: 0 };
  let opusUnits = 0;
  const sessionRows = [];
  const qualityRows = [];
  const successors = new Map(); // wt id -> how many sessions replaced it (it was handed off)
  for (const r of records) if (r.type === 'session' && Array.isArray(r.replaces)) for (const id of r.replaces) successors.set(String(id).toLowerCase(), (successors.get(String(id).toLowerCase()) || 0) + 1);

  for (const r of records) {
    if (r.type !== 'session') continue;
    if (want && String(r.origin).toLowerCase() !== want) continue;
    if (!inScope(r.project)) continue;
    let inUnits = 0;
    for (const [day, u] of Object.entries(r.byDay || {})) if (day >= win.from && day <= win.to) inUnits += u;
    if (inUnits <= 0) continue;
    const f = r.units > 0 ? Math.min(1, inUnits / r.units) : 1;
    t.units += inUnits; t.sessions++;
    addTok(t.tok, r.tok || {}, f);
    t.subUnits += ((r.sub && r.sub.units) || 0) * f;
    t.human += ((r.prompts && r.prompts.human) || 0) * f; t.auto += ((r.prompts && r.prompts.auto) || 0) * f;
    t.compactions += (r.compactions || 0) * f; if (r.compactions) t.compactedSessions++;
    t.peakCtx = Math.max(t.peakCtx, r.peakCtx || 0);
    const mb = byMachine[r.origin] ??= { units: 0, sessions: 0 };
    mb.units += inUnits; mb.sessions++;
    const sc = scoper.scopeOf(r.project);
    byScope[sc].units += inUnits; byScope[sc].sessions++;
    const cb = byClass[r.cls || 'interactive'] ??= { units: 0, sessions: 0 };
    cb.units += inUnits; cb.sessions++;
    const pb = byProject[r.project || '(none)'] ??= { units: 0, sessions: 0, scope: sc };
    pb.units += inUnits; pb.sessions++;
    let sessionOpus = 0;
    for (const [name, v] of Object.entries(r.models || {})) {
      const mb2 = byModel[name] ??= { units: 0, calls: 0 };
      mb2.units += v.units * f; mb2.calls += v.calls * f;
      if (/opus/i.test(name)) sessionOpus += v.units * f;
    }
    opusUnits += sessionOpus;
    if (ROUTINE_CLASSES.includes(r.cls)) { routine.units += inUnits; routine.opus += sessionOpus; }
    const w = r.wakes || {};
    wake.n += (w.n || 0) * f; wake.units += (w.units || 0) * f;
    wake.autoN += ((w.auto && w.auto.n) || 0) * f; wake.autoUnits += ((w.auto && w.auto.units) || 0) * f;
    const tm = r.time || {};
    time.activeMs += (tm.activeMs || 0) * f; time.idleMs += (tm.idleMs || 0) * f; time.waitYouMs += (tm.waitYouMs || 0) * f; time.waits += (tm.waits || 0) * f;
    // The individual waits only for a session that lies wholly inside the window: a share of a wait is no wait.
    if (f >= 0.999 && Array.isArray(tm.waitsMin)) time.waitsMin.push(...tm.waitsMin);
    if (!(r.cls === 'bh-worker' || r.cls === 'bh-orchestrator')) {
      const q = r.quality || {};
      qualityRows.push({ origin: r.origin, start: r.start, peakCtx: r.peakCtx || 0, human: (r.prompts && r.prompts.human) || 0, corrections: q.humanCorrections || 0,
        toolErrors: q.toolErrors || 0, denied: q.deniedTools || 0, toolCalls: q.toolCalls || 0, midTask: q.compactionsMidTask || 0,
        handoffs: r.wtId ? successors.get(String(r.wtId).toLowerCase()) || 0 : 0, unitsM: M(inUnits) });
    }
    sessionRows.push({ origin: r.origin, sid: String(r.sid || '').slice(0, 8), name: r.name || null, cls: r.cls, project: r.project, unitsM: M(inUnits), models: Object.keys(r.models || {}) });
  }

  const total = t.units;
  const bh = buildBugHunter(records, { win, want, scoper, scope });
  const share = (u) => (total > 0 ? Math.round((1000 * u) / total) / 10 : 0);
  const waits = time.waitsMin.slice().sort((a, b) => a - b);
  const report = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    window: { days, from: win.from, to: win.to },
    filter: { scope, machine: machine || null, workSource, inventoryKnown: scoper.hasInventory },
    basis: {
      units: 'weighted cost units, millions (an estimate: the weekly limit\'s real weighting is not published); input 1, cache write 1.25 (5 min) / 2 (1 h), cache read 0.1, output 5',
      weights: WEIGHTS,
      window: 'local calendar days ending today; a session\'s units are summed from its per-day split, its other figures are scaled by the share of its units inside the window',
      wakeUp: 'the first main-session model call after more than 1 h idle; its cost is the cache write that call paid (the 1 h cache had expired)',
      waitYou: 'from transcript gaps: a gap over the active limit (5 min) that ends in a human prompt after an assistant turn ended; idle is any other long gap',
      routineClasses: ROUTINE_CLASSES,
      opus: 'the share of units spent on models whose name contains "opus"',
    },
    totals: {
      unitsM: M(total), sessions: t.sessions,
      tokM: Object.fromEntries(Object.entries(t.tok).map(([k, v]) => [k, M(v)])),
      subagentUnitsM: M(t.subUnits), humanPrompts: Math.round(t.human), autoPrompts: Math.round(t.auto),
      opusUnitsM: M(opusUnits), opusSharePct: share(opusUnits),
    },
    byMachine: rank(byMachine, (k, v) => ({ machine: k, unitsM: M(v.units), sessions: v.sessions, sharePct: share(v.units), units: v.units })).map((r) => { const { units: _u, ...x } = r; return x; }),
    byScope: {
      work: { unitsM: M(byScope.work.units), sessions: byScope.work.sessions, sharePct: share(byScope.work.units) },
      private: { unitsM: M(byScope.private.units), sessions: byScope.private.sessions, sharePct: share(byScope.private.units) },
    },
    byClass: rank(byClass, (k, v) => ({ cls: k, unitsM: M(v.units), sessions: v.sessions, sharePct: share(v.units), units: v.units })).map((r) => { const { units: _u, ...x } = r; return x; }),
    byProject: rank(byProject, (k, v) => ({ project: k, scope: v.scope, unitsM: M(v.units), sessions: v.sessions, sharePct: share(v.units), units: v.units })).slice(0, TOP_PROJECTS).map((r) => { const { units: _u, ...x } = r; return x; }),
    byModel: rank(byModel, (k, v) => ({ model: k, unitsM: M(v.units), calls: Math.round(v.calls), sharePct: share(v.units), units: v.units })).map((r) => { const { units: _u, ...x } = r; return x; }),
    wake: { n: Math.round(wake.n), unitsM: M(wake.units), sharePct: share(wake.units), autoN: Math.round(wake.autoN), autoUnitsM: M(wake.autoUnits), perWakeKUnits: wake.n ? Math.round(wake.units / wake.n / 1e3) : 0 },
    routine: { unitsM: M(routine.units), opusUnitsM: M(routine.opus), opusSharePct: routine.units > 0 ? Math.round((1000 * routine.opus) / routine.units) / 10 : 0 },
    compactions: { n: Math.round(t.compactions), sessions: t.compactedSessions, maxPeakCtxK: Math.round(t.peakCtx / 1e3) },
    time: {
      activeH: R1(time.activeMs / 36e5), idleH: R1(time.idleMs / 36e5), waitYouH: R1(time.waitYouMs / 36e5), waits: Math.round(time.waits),
      waitYouMedianMin: percentile(waits, 50), waitYouP90Min: percentile(waits, 90), waitsMeasured: waits.length,
    },
    topSessions: sessionRows.sort((a, b) => b.unitsM - a.unitsM).slice(0, TOP_LIST),
    bugHunter: bh.summary,
    quality: buildQuality({ records, itemRows: bh.rows, sessionRows: qualityRows }),
  };
  return report;
}

// --- bug hunter ------------------------------------------------------------------------

function buildBugHunter(records, { win, want, scoper, scope }) {
  const items = records.filter((r) => r.type === 'bh-item' && (!want || String(r.origin).toLowerCase() === want));
  const sessions = records.filter((r) => r.type === 'session' && r.bh && (!want || String(r.origin).toLowerCase() === want));
  const inWin = (iso) => { if (!iso) return false; const d = localDay(Date.parse(iso)); return d >= win.from && d <= win.to; };
  const picked = items.filter((r) => inWin(r.finishedAt) || (!r.finishedAt && inWin(r.startedAt)));
  const rows = [];
  for (const it of picked) {
    const worker = sessions.filter((s) => s.origin === it.origin && s.bh.role === 'worker' && s.bh.item === it.item
      && ((it.workers && it.workers.includes(s.wtId)) || overlaps(s, it)));
    if (scope !== 'all' && worker.length && !worker.some((s) => scoper.scopeOf(s.project) === scope)) continue;
    rows.push(itemRow(it, worker));
  }
  const overheadUnits = sum(sessions.filter((s) => s.bh.role === 'orchestrator').map((s) => sumDays(s, win)));
  const finished = rows.filter((r) => r.outcome && !/^(in-progress|skipped.*)$/.test(r.outcome));
  const fixed = finished.filter((r) => isFixed(r.outcome));
  const escalated = finished.filter((r) => isEscalated(r.outcome));
  const firstPass = fixed.filter((r) => (r.attempts || 1) <= 1 && r.rejects === 0);
  const gateFails = {};
  const reasons = {};
  const phaseMin = {};
  for (const r of rows) {
    for (const [g, n] of Object.entries(r.gateFailsByGate)) bump(gateFails, g, n);
    if (r.escalation && r.escalation.reason) bump(reasons, r.escalation.reason, 1);
    for (const [p, m] of Object.entries(r.phaseMin)) (phaseMin[p] ??= []).push(m);
  }
  const avg = (a) => (a.length ? R1(sum(a) / a.length) : null);
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, TOP_LIST).map(([k, n]) => ({ what: k, n }));
  const cx = rows.filter((r) => r.complexity);
  const summary = {
    items: rows.length, finished: finished.length, fixed: fixed.length, escalated: escalated.length,
    firstPassYieldPct: fixed.length ? Math.round((1000 * firstPass.length) / fixed.length) / 10 : null,
    escalationRatePct: finished.length ? Math.round((1000 * escalated.length) / finished.length) / 10 : null,
    topEscalationReasons: top(reasons),
    gatesFailedByGate: top(gateFails),
    reviewsRejected: sum(rows.map((r) => r.rejects)),
    humanPrompts: sum(rows.map((r) => r.humanPrompts)),
    avgDurationMin: avg(rows.map((r) => r.durationMin).filter((x) => x !== null)),
    avgWorkerUnitsM: avg(rows.map((r) => r.workerUnitsM)),
    orchestratorOverheadUnitsM: M(overheadUnits),
    medianPhaseMin: Object.fromEntries(Object.entries(phaseMin).map(([p, a]) => [p, percentile(a.slice().sort((x, y) => x - y), 50)])),
    complexity: cx.length ? {
      measured: cx.length, avgFiles: avg(cx.map((r) => r.complexity.files || 0)), avgLines: avg(cx.map((r) => (r.complexity.linesAdded || 0) + (r.complexity.linesDeleted || 0))),
      guiPct: Math.round((100 * cx.filter((r) => r.complexity.gui).length) / cx.length), hwPct: Math.round((100 * cx.filter((r) => r.complexity.hw).length) / cx.length), dbPct: Math.round((100 * cx.filter((r) => r.complexity.db).length) / cx.length),
    } : null,
    measured: 'per item: outcome and times from the run\'s state.json, phases/gates/reviews/complexity from its events.jsonl (absent in older runs: those items show no phases), tokens from the worker sessions (a session\'s subagents included); the orchestrator is overhead, shown once',
    list: rows.slice().sort((a, b) => b.workerUnitsM - a.workerUnitsM).slice(0, 30).map(listRow),
  };
  return { summary, rows };
}

/** A row without the fields only the quality section needs. */
function listRow(r) {
  const { startedAt, peakCtx, complexityBand, firstPass, fixed, escalated, finished, reviewsTotal, gatesTotal, ...rest } = r; // eslint-disable-line no-unused-vars
  return rest;
}

function overlaps(s, it) {
  const slack = 10 * 60e3;
  const a = Date.parse(s.start);
  const lo = Date.parse(it.startedAt || it.finishedAt);
  const hi = Date.parse(it.finishedAt || it.startedAt);
  return Number.isFinite(a) && Number.isFinite(lo) && a >= lo - slack && a <= hi + slack;
}

function sumDays(s, win) {
  let u = 0;
  for (const [d, x] of Object.entries(s.byDay || {})) if (d >= win.from && d <= win.to) u += x;
  return u;
}

function itemRow(it, workers) {
  const rejects = sum(Object.entries(it.reviews || {}).filter(([k]) => REJECT_RE.test(k.split(':')[1] || '')).map(([, n]) => n));
  const start = Date.parse(it.startedAt);
  const end = Date.parse(it.finishedAt);
  const durationMin = Number.isFinite(start) && Number.isFinite(end) && end >= start ? R1((end - start) / 60e3) : (typeof it.durationMin === 'number' ? it.durationMin : null);
  const phaseMin = {};
  const ph = it.phases || [];
  for (let i = 0; i < ph.length; i++) {
    const a = Date.parse(ph[i].at);
    const b = i + 1 < ph.length ? Date.parse(ph[i + 1].at) : end;
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) bump(phaseMin, ph[i].phase, R1((b - a) / 60e3));
  }
  return {
    origin: it.origin, item: it.item, outcome: it.outcome, band: it.band, attempts: it.attempts, durationMin, phaseMin,
    workerUnitsM: M(sum(workers.map((s) => s.units))), workerSessions: workers.length,
    humanPrompts: sum(workers.map((s) => (s.prompts && s.prompts.human) || 0)),
    gateFails: it.gates ? it.gates.fail : 0,
    gateFailsByGate: Object.fromEntries(Object.entries((it.gates && it.gates.byGate) || {}).filter(([, v]) => v.fail > 0).map(([g, v]) => [g, v.fail])),
    rejects, escalation: it.escalation || null, complexity: it.complexity || null,
    // for the quality section (lib/usage-quality.js)
    startedAt: it.startedAt || it.finishedAt, peakCtx: Math.max(0, ...workers.map((s) => s.peakCtx || 0)), complexityBand: complexityBandOf(it),
    fixed: isFixed(it.outcome), escalated: isEscalated(it.outcome), finished: Boolean(it.outcome) && !/^(in-progress|skipped.*)$/.test(it.outcome),
    firstPass: isFixed(it.outcome) && (it.attempts || 1) <= 1 && rejects === 0,
    reviewsTotal: sum(Object.values(it.reviews || {})), gatesTotal: it.gates ? it.gates.pass + it.gates.fail : 0,
  };
}

// --- text ------------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const table = (rows, cols) => rows.map((r) => `  ${cols.map(([k, w, right]) => (right ? rpad(r[k], w) : pad(r[k], w))).join('  ')}`).join('\n');

const mark = (c) => (c.tooFew ? ' (too few)' : '');
const v = (x, unit = '') => (x === null || x === undefined ? '-' : `${x}${unit}`);

/** The "Quality by context" lines of the text report. */
function renderQuality(q) {
  const o = ['Quality by context (n is printed per cell; a cell with fewer than ' + q.minN + ' is "too few": no trend is claimed from it):'];
  if (q.regimes.length) o.push('  settings regimes seen: ' + q.regimes.map((r) => `${r.origin} from ${r.at.slice(0, 10)}: ${r.label}`).join('; '));
  o.push('  bug-hunter items, within a complexity band - ' + q.bugHunter.note);
  for (const c of q.bugHunter.byContext) {
    o.push(`    ${c.complexity.padEnd(8)} ctx ${String(c.ctxBand).padEnd(9)} n=${c.n}${mark(c)}: first-pass ${v(c.firstPassYieldPct, '%')}, review rejects ${v(c.reviewRejectRatePct, '%')}, gate fails ${v(c.gateFailRatePct, '%')}, attempts ${v(c.avgAttempts)}, escalated ${v(c.escalationRatePct, '%')}, ${v(c.avgDurationMin, ' min')}, ${v(c.avgWorkerUnitsM, 'M')} units`);
  }
  if (!q.bugHunter.byContext.length) o.push('    (no bug-hunter item with a measured context in this window)');
  o.push('  other sessions - ' + q.sessions.note);
  for (const c of q.sessions.byContext) {
    o.push(`    ctx ${String(c.ctxBand).padEnd(9)} n=${c.n}${mark(c)}: corrections ${v(c.correctionsPer10Prompts)} per 10 prompts, tool errors ${v(c.toolErrorsPer100Calls)} per 100 calls, denied ${v(c.deniedPer100Calls)} per 100, handed off ${v(c.handedOffPct, '%')}, mid-task compactions ${v(c.midTaskCompactionsPerSession)} per session`);
  }
  for (const c of q.sessions.byRegime) {
    o.push(`    regime ${c.regime} n=${c.n}${mark(c)}: corrections ${v(c.correctionsPer10Prompts)} per 10 prompts, tool errors ${v(c.toolErrorsPer100Calls)} per 100 calls, handed off ${v(c.handedOffPct, '%')}`);
  }
  return o;
}

/** The report as plain text for a terminal. */
function renderText(rep) {
  const o = [];
  const sc = rep.filter.scope === 'all' ? 'all projects' : `${rep.filter.scope} projects`;
  o.push(`Usage ${rep.window.from} .. ${rep.window.to} (${rep.window.days} days), ${sc}${rep.filter.machine ? `, machine ${rep.filter.machine}` : ''}`);
  if (!rep.filter.inventoryKnown && rep.filter.scope !== 'all') o.push(`  note: ${rep.filter.workSource ? `no inventory from "${rep.filter.workSource}" yet` : 'no work-source machine is set (usageLedger.workSource)'}, so every project reads as private unless classified`);
  const t = rep.totals;
  o.push(`Total ${t.unitsM}M units, ${t.sessions} sessions, opus ${t.opusSharePct}%, subagents ${t.subagentUnitsM}M, prompts ${t.humanPrompts} human / ${t.autoPrompts} automated`);
  o.push('By machine:'); o.push(table(rep.byMachine, [['machine', 16], ['unitsM', 8, 1], ['sharePct', 6, 1], ['sessions', 8, 1]]));
  o.push(`Work ${rep.byScope.work.unitsM}M (${rep.byScope.work.sharePct}%) / private ${rep.byScope.private.unitsM}M (${rep.byScope.private.sharePct}%)`);
  o.push('By class:'); o.push(table(rep.byClass, [['cls', 16], ['unitsM', 8, 1], ['sharePct', 6, 1], ['sessions', 8, 1]]));
  o.push('Top projects:'); o.push(table(rep.byProject, [['project', 24], ['scope', 8], ['unitsM', 8, 1], ['sharePct', 6, 1], ['sessions', 8, 1]]));
  o.push('By model:'); o.push(table(rep.byModel, [['model', 28], ['unitsM', 8, 1], ['sharePct', 6, 1], ['calls', 8, 1]]));
  o.push(`Wake-ups ${rep.wake.n} (${rep.wake.autoN} by automation), ${rep.wake.unitsM}M units = ${rep.wake.sharePct}%, ${rep.wake.perWakeKUnits}k units each`);
  o.push(`Opus in routine classes (${ROUTINE_CLASSES.join(', ')}): ${rep.routine.opusUnitsM}M of ${rep.routine.unitsM}M = ${rep.routine.opusSharePct}%`);
  o.push(`Compactions ${rep.compactions.n} in ${rep.compactions.sessions} sessions, largest context ${rep.compactions.maxPeakCtxK}k`);
  o.push(`Time: active ${rep.time.activeH}h, waiting on you ${rep.time.waitYouH}h (${rep.time.waits} waits; median ${rep.time.waitYouMedianMin ?? '-'} min, p90 ${rep.time.waitYouP90Min ?? '-'} min over ${rep.time.waitsMeasured} measured), idle ${rep.time.idleH}h`);
  const b = rep.bugHunter;
  o.push(`Bug hunter: ${b.items} items (${b.fixed} fixed, ${b.escalated} escalated); first-pass yield ${b.firstPassYieldPct ?? '-'}%, escalation rate ${b.escalationRatePct ?? '-'}%, avg ${b.avgDurationMin ?? '-'} min and ${b.avgWorkerUnitsM ?? '-'}M units per item, orchestrator overhead ${b.orchestratorOverheadUnitsM}M, reviews rejected ${b.reviewsRejected}, human prompts ${b.humanPrompts}`);
  if (b.topEscalationReasons.length) o.push(`  top escalation reasons: ${b.topEscalationReasons.map((x) => `${x.what} (${x.n})`).join('; ')}`);
  if (b.gatesFailedByGate.length) o.push(`  gates failed: ${b.gatesFailedByGate.map((x) => `${x.what} (${x.n})`).join('; ')}`);
  if (Object.keys(b.medianPhaseMin).length) o.push(`  median minutes per phase: ${Object.entries(b.medianPhaseMin).map(([p, m]) => `${p} ${m}`).join(', ')}`);
  if (b.complexity) o.push(`  complexity (${b.complexity.measured} items): ${b.complexity.avgFiles} files, ${b.complexity.avgLines} lines; gui ${b.complexity.guiPct}%, hw ${b.complexity.hwPct}%, db ${b.complexity.dbPct}%`);
  o.push(...renderQuality(rep.quality));
  o.push(`Measured: ${rep.basis.units}.`);
  o.push(`  ${rep.basis.window}.`);
  o.push(`  Wait-you: ${rep.basis.waitYou}.`);
  return `${o.join('\n')}\n`;
}

module.exports = { ROUTINE_CLASSES, percentile, windowDays, buildReport, renderText };
