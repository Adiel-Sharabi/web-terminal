'use strict';
// --- "Quality by context": does a smaller context give BETTER results? (#529) --------------
//
// Pure functions over the folded ledger. Two questions, answered from counts only:
//   bug-hunter items - first-pass yield, review reject rate, gate fail rate, attempts, escalation rate, time and
//                      tokens, grouped by COMPLEXITY band and by CONTEXT band (the largest context any of the
//                      item's worker sessions reached) and by the settings regime in force when it started;
//   other sessions   - corrections per 10 human prompts, tool errors per 100 tool calls, how often a session
//                      was handed off, grouped by context band and regime.
// Harder bugs need more context, so a comparison is only fair WITHIN a complexity band: the bug-hunter table is
// laid out per band, and the other-sessions table says plainly that it is not complexity-controlled.
// A cell with fewer than MIN_N is marked `tooFew`: no trend is ever claimed from it.

const { regimeLabel } = require('./usage-settings');

const MIN_N = 5;
const CTX_BANDS = Object.freeze(['<100k', '100-200k', '200-300k', '>300k']);
const COMPLEXITY_BANDS = Object.freeze(['small', 'medium', 'large', 'unknown']);

/** The context band of a session's largest context, in tokens. */
function ctxBandOf(peakCtx) {
  if (!(peakCtx > 0)) return null;
  if (peakCtx < 100e3) return CTX_BANDS[0];
  if (peakCtx < 200e3) return CTX_BANDS[1];
  if (peakCtx < 300e3) return CTX_BANDS[2];
  return CTX_BANDS[3];
}

/** How hard a bug-hunter item was. Measured when the bug hunter recorded the fix's size
 *  (`complexity`): large = 8+ files, 300+ changed lines, 3+ layers, hardware or database paths; small = at most
 *  2 files and 40 lines in one layer with no GUI, hardware or database; medium otherwise. Without a measurement
 *  the state file's own `band` stands in (easy / medium / hard); else 'unknown'. */
function complexityBandOf(item) {
  const c = item && item.complexity;
  if (c && typeof c === 'object' && c.files !== null && c.files !== undefined) {
    const lines = (c.linesAdded || 0) + (c.linesDeleted || 0);
    const layers = Array.isArray(c.layers) ? c.layers.length : 0;
    if (c.files >= 8 || lines >= 300 || layers >= 3 || c.hw || c.db) return 'large';
    if (c.files <= 2 && lines <= 40 && layers <= 1 && !c.gui) return 'small';
    return 'medium';
  }
  const b = String((item && item.band) || '').toLowerCase();
  if (b === 'easy' || b === 'trivial' || b === 'small') return 'small';
  if (b === 'medium') return 'medium';
  if (b === 'hard' || b === 'large') return 'large';
  return 'unknown';
}

/** The `settings` record of [origin] in force at [t] (ms): the newest one at or before it. */
function regimeAt(settings, origin, t) {
  let best = null;
  const want = String(origin).toLowerCase();
  for (const r of settings) {
    if (String(r.origin).toLowerCase() !== want) continue;
    const at = Date.parse(r.at);
    if (!(at <= t)) continue;
    if (!best || at > Date.parse(best.at)) best = r;
  }
  return best;
}

const sum = (a) => a.reduce((n, x) => n + x, 0);
const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
const avg = (a) => (a.length ? Math.round((10 * sum(a)) / a.length) / 10 : null);
const per = (n, d, k) => (d > 0 ? Math.round((10 * k * n) / d) / 10 : null);

function itemCell(rows) {
  const fixed = rows.filter((r) => r.fixed);
  const finished = rows.filter((r) => r.fixed || r.escalated || r.finished);
  return {
    n: rows.length, tooFew: rows.length < MIN_N,
    firstPassYieldPct: pct(fixed.filter((r) => r.firstPass).length, fixed.length),
    reviewRejectRatePct: pct(sum(rows.map((r) => r.rejects)), sum(rows.map((r) => r.reviewsTotal))),
    gateFailRatePct: pct(sum(rows.map((r) => r.gateFails)), sum(rows.map((r) => r.gatesTotal))),
    avgAttempts: avg(rows.map((r) => r.attempts).filter((x) => typeof x === 'number')),
    escalationRatePct: pct(rows.filter((r) => r.escalated).length, finished.length),
    avgDurationMin: avg(rows.map((r) => r.durationMin).filter((x) => typeof x === 'number')),
    avgWorkerUnitsM: avg(rows.map((r) => r.workerUnitsM)),
  };
}

function sessionCell(rows) {
  const human = sum(rows.map((r) => r.human));
  return {
    n: rows.length, tooFew: rows.length < MIN_N, humanPrompts: human,
    correctionsPer10Prompts: per(sum(rows.map((r) => r.corrections)), human, 10),
    toolErrorsPer100Calls: per(sum(rows.map((r) => r.toolErrors)), sum(rows.map((r) => r.toolCalls)), 100),
    deniedPer100Calls: per(sum(rows.map((r) => r.denied)), sum(rows.map((r) => r.toolCalls)), 100),
    handedOffPct: pct(rows.filter((r) => r.handoffs > 0).length, rows.length),
    midTaskCompactionsPerSession: avg(rows.map((r) => r.midTask)),
    avgUnitsM: avg(rows.map((r) => r.unitsM)),
  };
}

/** Group [rows] by [keyOf] and answer each group with [cell]; keys in [order] first. */
function grouped(rows, keyOf, cell, order) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (k === null) continue; (m.get(k) || m.set(k, []).get(k)).push(r); }
  const keys = [...m.keys()].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || String(a).localeCompare(String(b)));
  return keys.map((k) => ({ key: k, ...cell(m.get(k)) }));
}

/** @param {object} o
 *  @param {object[]} o.records       folded ledger records
 *  @param {object[]} o.itemRows      the report's bug-hunter rows (each with origin, startedAt, complexityBand,
 *                                    peakCtx, fixed, escalated, finished, firstPass, rejects, reviewsTotal,
 *                                    gateFails, gatesTotal, attempts, durationMin, workerUnitsM)
 *  @param {object[]} o.sessionRows   the report's non-bug-hunter sessions in the window
 *                                    (each with origin, start, peakCtx, human, corrections, toolErrors, denied, toolCalls, handoffs, midTask, unitsM) */
function buildQuality({ records, itemRows, sessionRows }) {
  const settings = records.filter((r) => r.type === 'settings');
  const regimeOf = (origin, iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? regimeLabel(regimeAt(settings, origin, t)) : 'unknown'; };
  const items = itemRows.map((r) => ({ ...r, ctxBand: ctxBandOf(r.peakCtx), regime: regimeOf(r.origin, r.startedAt) }));
  const sess = sessionRows.map((r) => ({ ...r, ctxBand: ctxBandOf(r.peakCtx), regime: regimeOf(r.origin, r.start) }));
  const bhByContext = [];
  const bhByRegime = [];
  for (const band of COMPLEXITY_BANDS) {
    const inBand = items.filter((r) => r.complexityBand === band);
    if (!inBand.length) continue;
    for (const g of grouped(inBand, (r) => r.ctxBand, itemCell, CTX_BANDS)) bhByContext.push({ complexity: band, ctxBand: g.key, ...stripKey(g) });
    for (const g of grouped(inBand, (r) => r.regime, itemCell, [])) bhByRegime.push({ complexity: band, regime: g.key, ...stripKey(g) });
  }
  return {
    minN: MIN_N, ctxBands: CTX_BANDS,
    regimes: settings.map((r) => ({ origin: r.origin, at: r.at, label: regimeLabel(r), autoCompactWindow: r.autoCompactWindow ?? null, effort: r.effort ?? null, defaultModel: r.defaultModel ?? null, handoff: r.handoff || {} }))
      .sort((a, b) => (a.at < b.at ? -1 : 1)),
    bugHunter: {
      note: 'compared WITHIN a complexity band (harder bugs need more context); n is printed per cell and a cell with fewer than ' + MIN_N + ' is marked too few: read no trend from it',
      byContext: bhByContext, byRegime: bhByRegime,
    },
    sessions: {
      note: 'NOT controlled for how hard the task was: bigger tasks use more context, so a difference here is a lead, not proof. Corrections are counted by a local heuristic on the opening words of a prompt',
      byContext: grouped(sess, (r) => r.ctxBand, sessionCell, CTX_BANDS).map(rename('ctxBand')),
      byRegime: grouped(sess, (r) => r.regime, sessionCell, []).map(rename('regime')),
    },
  };
}

const stripKey = ({ key, ...rest }) => rest; // eslint-disable-line no-unused-vars
const rename = (name) => ({ key, ...rest }) => ({ [name]: key, ...rest });

module.exports = { MIN_N, CTX_BANDS, COMPLEXITY_BANDS, ctxBandOf, complexityBandOf, regimeAt, buildQuality };
