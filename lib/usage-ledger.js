'use strict';
// --- Usage ledger (#529) ------------------------------------------------------
//
// Reads the two files claude-memory's usage-monitor.js writes under ~/.claude and turns them
// into the report GET /api/usage-ledger serves (and Mission Control's Usage panel shows):
//   usage-ledger.jsonl  one line per 30-minute window: { at, machine, windowMin, windowM, dayM,
//                       out, cr, cw, model:{name,pct}, kind:{name,pct}, top:[{id,M}], alerts }
//                       - and, since #540, one line per check-in decision: { at, machine,
//                       event:'check-in', decision, by, id, why, n, idleMin, ctxK, ... }
//   usage-rollup.jsonl  one line per finished local day: { day, machine, calls, sessions, unitsM,
//                       subagentUnitsM, tokM:{in,out,cr,cw,cw1h}, model, cls, wake:{...} }
// usage-monitor.js is the ONE owner of those formats and of the transcript parser behind them;
// this module only READS them, and invents no field: a record that does not have the shape
// below is counted as unknown, never guessed at. The units are usage-monitor.js's weighted
// "cost units" (millions), an ESTIMATE - the weekly limit's real weighting is not published.
// Mirrored from usage-monitor.js (if it changes, change it there first): WEIGHTS, the local-day
// and Monday-based week rules, and the top 3 sessions per window.
//
// Cost rules (the files grow every week): a file is read INCREMENTALLY - one stat per request,
// then only the bytes appended since the last look; a first look reads at most the last
// MAX_FIRST_READ_BYTES; a truncated, replaced or rotated file is read again from its start.
// The report is memoised on the store's version, so an unchanged ledger costs nothing.

const fs = require('fs');
const path = require('path');

const WEIGHTS = Object.freeze({ input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 });
const TOP_PER_WINDOW = 3;
const DECISIONS = Object.freeze(['skipped', 'told', 'woken', 'handed-off']);
const RETAIN_DAYS = 60;
const MAX_FIRST_READ_BYTES = 8 * 1024 * 1024;
const MAX_POLL_BYTES = 8 * 1024 * 1024;
const MIN_POLL_GAP_MS = 1000;
/// A session "dominates" a window when it spent at least this share of the window's units: only
/// then is the window's own main-cost kind (cache reads / cache writes / output) its reason.
const DOMINANT_SHARE = 0.5;
/// This many successive windows in the top 3 (3 h at 30 min each) is a long run or a polling loop.
const LONG_RUN_WINDOWS = 6;

const DEFAULTS = Object.freeze({ days: 7, weeks: 6, top: 10 });
const LIMITS = Object.freeze({ days: [1, 35], weeks: [1, 12], top: [1, 50] });

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const str = (x) => (typeof x === 'string' ? x : null);
const R1 = (x) => Math.round(x * 10) / 10;

/** The two files: the env override (a spec's), else under [home]/.claude. Under WT_TEST nothing
 *  is read unless a file is named, so a suite never reads the machine's real ledger. */
function filesFor({ home, env }) {
  const e = env || {};
  const dir = home ? path.join(home, '.claude') : null;
  const pick = (name, file) => e[name] || (e.WT_TEST === '1' || !dir ? null : path.join(dir, file));
  return { ledger: pick('WT_USAGE_LEDGER_FILE', 'usage-ledger.jsonl'), rollup: pick('WT_USAGE_ROLLUP_FILE', 'usage-rollup.jsonl') };
}

// --- the incremental reader ---------------------------------------------------

/** Follow one append-only jsonl file. [onLine] gets each COMPLETE line's text once; [onReset] is
 *  called before a file that shrank or was replaced is read again from its start. `poll()`
 *  resolves to the number of lines delivered. A line still being written (no newline yet) is
 *  left for the next poll. */
function createTail(file, onLine, onReset, { maxFirstRead = MAX_FIRST_READ_BYTES, maxPoll = MAX_POLL_BYTES } = {}) {
  const st = { ino: null, birth: null, offset: 0 };
  async function poll() {
    if (!file) return 0;
    let stat;
    try { stat = await fs.promises.stat(file); } catch {
      if (st.offset || st.ino !== null) { onReset(); st.offset = 0; st.ino = null; st.birth = null; }
      return 0;
    }
    const same = st.ino === stat.ino && st.birth === stat.birthtimeMs;
    let skipFirst = false;
    if (!same || stat.size < st.offset) {
      if (st.ino !== null) onReset();
      st.ino = stat.ino; st.birth = stat.birthtimeMs;
      st.offset = Math.max(0, stat.size - maxFirstRead);
      skipFirst = st.offset > 0; // we may have landed mid-line: the first segment is dropped (below)
    }
    if (stat.size <= st.offset) return 0;
    // Read from ONE BYTE BEFORE the cut when we dropped into the file: if that byte is the newline that
    // ends the previous line, the first segment is empty and the line the cut lands on is kept whole.
    const from = skipFirst ? st.offset - 1 : st.offset;
    const want = Math.min(stat.size - from, maxPoll);
    const buf = Buffer.alloc(want);
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      const { bytesRead } = await fh.read(buf, 0, want, from);
      const chunk = buf.subarray(0, bytesRead);
      const last = chunk.lastIndexOf(0x0a);
      if (last < 0) {
        if (bytesRead >= maxPoll) st.offset = from + bytesRead; // one line longer than a whole poll: give it up
        return 0;
      }
      st.offset = from + last + 1;
      const lines = chunk.subarray(0, last).toString('utf8').split('\n');
      if (skipFirst) lines.shift();
      let n = 0;
      for (const l of lines) { const t = l.trim(); if (t) { onLine(t); n++; } }
      return n;
    } catch { return 0; } finally { if (fh) await fh.close().catch(() => {}); }
  }
  return { poll };
}

// --- record shapes ------------------------------------------------------------

/** A 30-minute window line, or null. */
function windowOf(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.top) || typeof o.at !== 'string' || o.event !== undefined) return null;
  const t = Date.parse(o.at);
  if (!Number.isFinite(t)) return null;
  const named = (x) => (x && typeof x === 'object' && typeof x.name === 'string' ? { name: x.name, pct: num(x.pct) } : null);
  return { t, machine: str(o.machine), windowMin: num(o.windowMin) || 30, windowM: num(o.windowM), dayM: num(o.dayM),
    out: num(o.out), cr: num(o.cr), cw: num(o.cw), model: named(o.model), kind: named(o.kind),
    top: o.top.filter((x) => x && typeof x.id === 'string' && x.id).map((x) => ({ id: x.id.slice(0, 16), M: num(x.M) })) };
}

const mapOf = (m, fields) => {
  const out = {};
  if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (v && typeof v === 'object') out[k] = Object.fromEntries(fields.map((f) => [f, num(v[f])]));
  return out;
};

/** A finished-day roll-up line, or null. */
function dayOf(o) {
  if (!o || typeof o !== 'object' || typeof o.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return null;
  const tok = o.tokM && typeof o.tokM === 'object' ? o.tokM : {};
  const w = o.wake && typeof o.wake === 'object' ? o.wake : {};
  return { day: o.day, machine: str(o.machine), calls: num(o.calls), sessions: num(o.sessions), unitsM: num(o.unitsM), subagentUnitsM: num(o.subagentUnitsM),
    tokM: { in: num(tok.in), out: num(tok.out), cr: num(tok.cr), cw: num(tok.cw), cw1h: num(tok.cw1h) },
    model: mapOf(o.model, ['calls', 'units']), cls: mapOf(o.cls, ['calls', 'units']),
    wake: { n: num(w.n), unitsM: num(w.unitsM), cwTokM: num(w.cwTokM), perWakeK: num(w.perWakeK), byCause: mapOf(w.byCause, ['n', 'units']) } };
}

/** A check-in decision line (#540), or null. The free-text `reason` is deliberately not read. */
function eventOf(o) {
  if (!o || typeof o !== 'object' || o.event !== 'check-in' || typeof o.at !== 'string' || !DECISIONS.includes(o.decision)) return null;
  const t = Date.parse(o.at);
  if (!Number.isFinite(t)) return null;
  const nz = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return { t, machine: str(o.machine), decision: o.decision, by: str(o.by), id: String(o.id || '').slice(0, 8), why: str(o.why), n: num(o.n) || 1,
    idleMin: nz(o.idleMin), ctxK: nz(o.ctxK) };
}

// --- the store ----------------------------------------------------------------

/** What the two files hold, kept current by reading only what was appended. [now] is injectable. */
function createStore({ ledgerFile, rollupFile, now = Date.now, minGapMs = MIN_POLL_GAP_MS }) {
  const s = { windows: [], events: [], days: new Map(), version: 0, lastPoll: -Infinity, stats: { windowLines: 0, rollupLines: 0, eventLines: 0, unknown: 0 } };
  let inflight = null;
  const bump = () => { s.version++; };
  const ledgerTail = createTail(ledgerFile, (line) => {
    let o; try { o = JSON.parse(line); } catch { s.stats.unknown++; return; }
    const w = windowOf(o);
    if (w) { s.windows.push(w); s.stats.windowLines++; return; }
    const ev = eventOf(o);
    if (ev) { s.events.push(ev); s.stats.eventLines++; return; }
    s.stats.unknown++;
  }, () => { s.windows = []; s.events = []; s.stats.windowLines = 0; s.stats.eventLines = 0; bump(); });
  const rollupTail = createTail(rollupFile, (line) => {
    let o; try { o = JSON.parse(line); } catch { s.stats.unknown++; return; }
    const d = dayOf(o);
    if (d) { s.days.set(d.day, d); s.stats.rollupLines++; } else s.stats.unknown++;
  }, () => { s.days = new Map(); s.stats.rollupLines = 0; bump(); });

  function prune() {
    const cut = now() - RETAIN_DAYS * 864e5;
    s.windows = s.windows.filter((w) => w.t >= cut);
    s.events = s.events.filter((e) => e.t >= cut);
  }
  /** Look at both files (at most once a second); resolves once the store is current. */
  async function refresh() {
    if (inflight) return inflight;
    if (now() - s.lastPoll < minGapMs) return undefined;
    inflight = (async () => {
      s.lastPoll = now();
      const [a, b] = await Promise.all([ledgerTail.poll(), rollupTail.poll()]);
      if (a || b) { prune(); bump(); }
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return { refresh, snapshot: () => ({ windows: s.windows, events: s.events, days: s.days, version: s.version, stats: { ...s.stats } }) };
}

// --- the rules ----------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function weekStart(day) { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDay(d.getTime()); }

const blankWeek = (weekOf) => ({ weekOf, days: 0, inProgressDays: 0, unitsM: 0, perDayM: 0, subagentM: 0, opusM: 0, partial: false,
  wake: { n: 0, unitsM: 0 }, tokM: { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 }, model: {}, checkIns: { skipped: 0, told: 0, woken: 0, 'handed-off': 0 } });

/** The weekly totals: finished days from the roll-up (it survives Claude's 30-day transcript
 *  clean-up), plus any day the roll-up does not hold yet - today, or a gap - read from its last
 *  window line's running `dayM` and flagged `inProgressDays`. Newest week first. */
function buildWeeks({ days, windows, events }, { weeks }) {
  const wk = new Map();
  const get = (weekOf) => { let w = wk.get(weekOf); if (!w) { w = blankWeek(weekOf); wk.set(weekOf, w); } return w; };
  for (const r of days.values()) {
    const w = get(weekStart(r.day));
    w.days++; w.unitsM += r.unitsM; w.subagentM += r.subagentUnitsM; w.wake.n += r.wake.n; w.wake.unitsM += r.wake.unitsM;
    for (const k of Object.keys(w.tokM)) w.tokM[k] += r.tokM[k];
    for (const [m, v] of Object.entries(r.model)) {
      const mm = w.model[m] ??= { calls: 0, unitsM: 0 };
      mm.calls += v.calls; mm.unitsM += v.units;
      if (/opus/.test(m)) w.opusM += v.units;
    }
  }
  const lastDayM = new Map();
  for (const x of windows) lastDayM.set(localDay(x.t), x.dayM); // windows are in file order, so the last wins
  for (const [day, dayM] of lastDayM) {
    if (days.has(day)) continue;
    const w = get(weekStart(day));
    w.days++; w.inProgressDays++; w.partial = true; w.unitsM += dayM;
  }
  for (const e of events) { const w = wk.get(weekStart(localDay(e.t))); if (w) w.checkIns[e.decision]++; }
  return [...wk.values()].sort((a, b) => (a.weekOf < b.weekOf ? 1 : -1)).slice(0, weeks).map((w) => ({
    ...w, perDayM: w.days ? R1(w.unitsM / w.days) : 0, unitsM: R1(w.unitsM), subagentM: R1(w.subagentM), opusM: R1(w.opusM),
    wake: { n: w.wake.n, unitsM: R1(w.wake.unitsM) }, tokM: Object.fromEntries(Object.entries(w.tokM).map(([k, v]) => [k, R1(v)])),
    model: Object.fromEntries(Object.entries(w.model).map(([k, v]) => [k, { calls: v.calls, unitsM: R1(v.unitsM) }])) }));
}

/** Why a session ranks, from the lines that exist and nothing else. What a window line holds per
 *  session is only its id and units (the window's top 3); the window's own main cost kind and
 *  model describe the whole window, so they explain a session only where it spent at least
 *  DOMINANT_SHARE of that window. Each reason says how many windows it rests on. */
function whyOf(row) {
  const why = [];
  const d = row.dominated;
  const kinds = Object.entries(d.kind).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of kinds) {
    const w = n === 1 ? 'window' : 'windows';
    if (/^cache reads/.test(name)) why.push({ code: 'context-reread', n, text: `Re-reads a huge context every turn: cache reads were the main cost in ${n} ${w} it dominated.` });
    else if (/^cache writes/.test(name)) why.push({ code: 'cold-cache-write', n, text: `Cold cache writes (a cold start, or a wake after an idle hour): cache writes were the main cost in ${n} ${w} it dominated.` });
    else if (/^output/.test(name)) why.push({ code: 'output-heavy', n, text: `Output-heavy: output tokens were the main cost in ${n} ${w} it dominated.` });
    else why.push({ code: 'main-cost', n, text: `Main cost "${name}" in ${n} ${w} it dominated.` });
  }
  const models = Object.entries(d.model).sort((a, b) => b[1] - a[1]);
  if (models.length) why.push({ code: 'model', n: models[0][1], text: `The heaviest model in its dominated windows: ${models[0][0]}.` });
  if (row.maxStreak >= LONG_RUN_WINDOWS) {
    const h = R1(row.maxStreak * row.windowMin / 60);
    why.push({ code: 'long-run', n: row.maxStreak, text: `Stayed in the top ${TOP_PER_WINDOW} for ${h} hours without a break: a long run or a polling loop.` });
  }
  return why;
}

/** The sessions of the last [days] days, ranked by the units the windows credit them
 *  (a lower bound: a window names only its top 3). */
function buildSessions({ windows }, { now, days, top }) {
  const since = now - days * 864e5;
  const rows = new Map();
  let i = -1;
  for (const w of windows) {
    if (w.t < since) continue;
    i++;
    for (const t of w.top) {
      const r = rows.get(t.id) ?? { id: t.id, idKind: 'agent', unitsM: 0, windows: 0, firstAt: w.t, lastAt: w.t, windowMin: w.windowMin,
        streak: 0, maxStreak: 0, lastIdx: -2, lastT: 0, dominated: { n: 0, kind: {}, model: {} } };
      rows.set(t.id, r);
      r.unitsM += t.M; r.windows++; r.lastAt = w.t;
      const contiguous = r.lastIdx === i - 1 && w.t - r.lastT <= 2 * w.windowMin * 60e3;
      r.streak = contiguous ? r.streak + 1 : 1;
      r.maxStreak = Math.max(r.maxStreak, r.streak);
      r.lastIdx = i; r.lastT = w.t;
      if (w.windowM > 0 && t.M / w.windowM >= DOMINANT_SHARE) {
        r.dominated.n++;
        if (w.kind) r.dominated.kind[w.kind.name] = (r.dominated.kind[w.kind.name] || 0) + 1;
        if (w.model) r.dominated.model[w.model.name] = (r.dominated.model[w.model.name] || 0) + 1;
      }
    }
  }
  const ranked = [...rows.values()].sort((a, b) => b.unitsM - a.unitsM || b.lastAt - a.lastAt).slice(0, top);
  return ranked.map((r) => ({ id: r.id, idKind: r.idKind, unitsM: R1(r.unitsM), windows: r.windows,
    firstAt: new Date(r.firstAt).toISOString(), lastAt: new Date(r.lastAt).toISOString(), longestRunWindows: r.maxStreak,
    dominatedWindows: r.dominated.n, why: whyOf(r) }));
}

/** The check-in decisions (#540) in the last [days] days: totals, and per session. */
function buildCheckIns({ events }, { now, days }) {
  const since = now - days * 864e5;
  const total = { skipped: 0, told: 0, woken: 0, 'handed-off': 0 };
  const by = new Map();
  for (const e of events) {
    if (e.t < since) continue;
    total[e.decision]++;
    const r = by.get(e.id) ?? { id: e.id, idKind: 'wt', skipped: 0, told: 0, woken: 0, handedOff: 0, maxCtxK: null, maxIdleMin: null, lastAt: e.t };
    by.set(e.id, r);
    if (e.decision === 'handed-off') r.handedOff++; else r[e.decision]++;
    if (e.ctxK !== null && (r.maxCtxK === null || e.ctxK > r.maxCtxK)) r.maxCtxK = e.ctxK;
    if (e.decision === 'woken' && e.idleMin !== null && (r.maxIdleMin === null || e.idleMin > r.maxIdleMin)) r.maxIdleMin = e.idleMin;
    r.lastAt = Math.max(r.lastAt, e.t);
  }
  const sessions = [...by.values()].sort((a, b) => b.woken - a.woken || (b.maxCtxK || 0) - (a.maxCtxK || 0))
    .map((r) => ({ ...r, lastAt: new Date(r.lastAt).toISOString() }));
  return { total, sessions };
}

/** The whole report of ONE machine. Pure over a store snapshot. */
function buildReport(snap, { machine, now, days = DEFAULTS.days, weeks = DEFAULTS.weeks, top = DEFAULTS.top }) {
  const since = now - days * 864e5;
  const inRange = snap.windows.filter((w) => w.t >= since);
  return {
    version: 1, machine, generatedAt: new Date(now).toISOString(), days,
    basis: { unit: 'millions of weighted cost units (an estimate; the weekly limit\'s real weighting is not published)', weights: WEIGHTS,
      windowMin: 30, topPerWindow: TOP_PER_WINDOW, sessionsAreLowerBound: true },
    coverage: { windows: inRange.length, from: inRange.length ? new Date(inRange[0].t).toISOString() : null,
      to: inRange.length ? new Date(inRange[inRange.length - 1].t).toISOString() : null, unknownLines: snap.stats.unknown },
    weeks: buildWeeks(snap, { weeks }),
    sessions: buildSessions(snap, { now, days, top }).map((r) => ({ ...r, machine })),
    checkIns: (({ total, sessions }) => ({ total, sessions: sessions.map((r) => ({ ...r, machine })) }))(buildCheckIns(snap, { now, days })),
  };
}

// --- session names and links ---------------------------------------------------

/** Attach, to every session of [report], the live session it belongs to - by prefix, and only when
 *  exactly ONE live session matches (an ambiguous prefix is left unlinked, never guessed).
 *  [live] is `[{ id, claudeSessionId, name }]` of THIS machine. A ledger window names an agent
 *  conversation (the transcript's own id), a check-in line names a web-terminal session. The
 *  check-in tally of a linked session moves onto its ranked row, with a reason of its own. */
function attachLive(report, live) {
  const pick = (test) => { const m = live.filter(test); return m.length === 1 ? m[0] : null; };
  const lc = (x) => String(x || '').toLowerCase();
  const link = (r) => {
    const hit = r.idKind === 'wt' ? pick((l) => lc(l.id).startsWith(lc(r.id))) : pick((l) => l.claudeSessionId && lc(l.claudeSessionId).startsWith(lc(r.id)));
    return { ...r, sessionId: hit ? hit.id : null, name: hit ? hit.name || null : null };
  };
  const checkInSessions = report.checkIns.sessions.map(link);
  const byWt = new Map(checkInSessions.filter((r) => r.sessionId).map((r) => [r.sessionId, r]));
  const sessions = report.sessions.map((r) => {
    const l = link(r);
    const ci = l.sessionId ? byWt.get(l.sessionId) : null;
    if (!ci) return l;
    const why = l.why.slice();
    if (ci.woken > 0) {
      const idle = ci.maxIdleMin !== null ? `, idle up to ${ci.maxIdleMin} min` : '';
      const ctx = ci.maxCtxK !== null ? ` at about ${ci.maxCtxK}k tokens of context` : '';
      why.push({ code: 'check-in-wakes', n: ci.woken, text: `Woken by ${ci.woken} check-in${ci.woken === 1 ? '' : 's'}${ctx}${idle}: each wake of an idle session re-reads its context cold.` });
    }
    return { ...l, why, checkIns: { skipped: ci.skipped, told: ci.told, woken: ci.woken, handedOff: ci.handedOff, maxCtxK: ci.maxCtxK, maxIdleMin: ci.maxIdleMin } };
  }).map((r) => (r.why.length ? r : { ...r, why: [{ code: 'unexplained', n: 0, text: 'It ranked in the top 3 of its windows, but no window it dominated says why: the ledger keeps no per-session split of reads, writes and output.' }] }));
  return { ...report, sessions, checkIns: { ...report.checkIns, sessions: checkInSessions } };
}

// --- cluster merge -------------------------------------------------------------

/** Is [r] a usable report from a peer? (a peer's answer is data, never trusted for its shape) */
function isReport(r) {
  return Boolean(r && typeof r === 'object' && Array.isArray(r.weeks) && Array.isArray(r.sessions) && r.checkIns && Array.isArray(r.checkIns.sessions) && r.checkIns.total && typeof r.checkIns.total === 'object');
}

const addInto = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + num(v); };
/** The elements of a peer's list that are objects: a null or a number in it is skipped, so a peer
 *  that sends a ragged list cannot turn the whole cluster answer into a 500. */
const objects = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);

/** Local report + the peers' (each its own machine's): weeks summed by week, sessions ranked
 *  together (each row keeps its `machine`), check-in tallies summed. [peers] is
 *  `[{ name, report }]`; one that is not a report is left out - the caller names it. */
function mergeReports(local, peers, { top = DEFAULTS.top, weeks = DEFAULTS.weeks } = {}) {
  const parts = [{ name: local.machine, report: local }, ...peers.filter((p) => isReport(p.report))];
  const wk = new Map();
  const total = { skipped: 0, told: 0, woken: 0, 'handed-off': 0 };
  const sessions = [];
  const ciSessions = [];
  for (const { report } of parts) {
    for (const w of objects(report.weeks)) {
      const m = wk.get(w.weekOf) ?? blankWeek(w.weekOf);
      wk.set(w.weekOf, m);
      m.days += num(w.days); m.inProgressDays += num(w.inProgressDays); m.unitsM += num(w.unitsM); m.subagentM += num(w.subagentM); m.opusM += num(w.opusM);
      m.partial = m.partial || !!w.partial; m.wake.n += num(w.wake && w.wake.n); m.wake.unitsM += num(w.wake && w.wake.unitsM);
      addInto(m.tokM, w.tokM); addInto(m.checkIns, w.checkIns);
      for (const [k, v] of Object.entries(w.model || {})) { if (!v || typeof v !== 'object') continue; const mm = m.model[k] ??= { calls: 0, unitsM: 0 }; mm.calls += num(v.calls); mm.unitsM += num(v.unitsM); }
      (m.machines ??= []).push({ machine: report.machine, unitsM: num(w.unitsM) });
    }
    addInto(total, report.checkIns.total);
    sessions.push(...objects(report.sessions));
    ciSessions.push(...objects(report.checkIns.sessions));
  }
  const mergedWeeks = [...wk.values()].sort((a, b) => (a.weekOf < b.weekOf ? 1 : -1)).slice(0, weeks).map((w) => ({
    ...w, unitsM: R1(w.unitsM), subagentM: R1(w.subagentM), opusM: R1(w.opusM), wake: { n: w.wake.n, unitsM: R1(w.wake.unitsM) },
    // Days of different machines are different days of work: the per-day figure is per machine-day.
    perDayM: w.days ? R1(w.unitsM / w.days) : 0 }));
  return {
    ...local, machines: parts.map((p) => p.name), days: local.days,
    coverage: { windows: parts.reduce((n, p) => n + num(p.report.coverage && p.report.coverage.windows), 0), from: local.coverage.from, to: local.coverage.to, unknownLines: parts.reduce((n, p) => n + num(p.report.coverage && p.report.coverage.unknownLines), 0) },
    weeks: mergedWeeks,
    sessions: sessions.sort((a, b) => num(b.unitsM) - num(a.unitsM)).slice(0, top),
    checkIns: { total, sessions: ciSessions.sort((a, b) => num(b.woken) - num(a.woken)).slice(0, top) },
  };
}

/** The query ints, or `{ error }` naming the one that is wrong. */
function parseParams(query) {
  const out = {};
  for (const k of ['days', 'weeks', 'top']) {
    const raw = query[k];
    if (raw === undefined || raw === '') { out[k] = DEFAULTS[k]; continue; }
    const n = Number(raw);
    const [lo, hi] = LIMITS[k];
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw) || n < lo || n > hi) return { error: `${k} must be a whole number from ${lo} to ${hi}` };
    out[k] = n;
  }
  out.cluster = query.cluster === '1';
  return out;
}

module.exports = {
  WEIGHTS, TOP_PER_WINDOW, DECISIONS, RETAIN_DAYS, MAX_FIRST_READ_BYTES, DOMINANT_SHARE, LONG_RUN_WINDOWS, DEFAULTS, LIMITS,
  filesFor, createTail, createStore, windowOf, dayOf, eventOf, localDay, weekStart,
  buildWeeks, buildSessions, buildCheckIns, buildReport, attachLive, isReport, mergeReports, parseParams,
};
