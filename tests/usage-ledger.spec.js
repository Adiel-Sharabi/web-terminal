// @ts-check
// #529 - lib/usage-ledger.js: the usage ledger's report, over the lines claude-memory's
// usage-monitor.js writes (its ONE owner) and the check-in decisions #540 appends. The record
// shapes below are the real ones (a window line, a finished-day roll-up line, a check-in line);
// ids are made up. Every gate here is one the report would silently lose without it:
//   - the files are followed INCREMENTALLY (a file is never read whole per request);
//   - a session's reason comes only from windows it DOMINATED, never from a window it merely shared;
//   - an ambiguous id prefix is left unlinked, never guessed;
//   - a day the roll-up does not hold yet is counted from its last window, once;
//   - a peer's answer is data: one that is not a report is left out.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../lib/usage-ledger');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 10, 25, 12, 0).getTime(); // Wednesday; its week starts Monday 2026-11-23

const win = (iso, windowM, dayM, kind, model, top, over = {}) => ({
  at: iso, machine: 'Home', windowMin: 30, windowM, dayM, out: 400000, cr: 50e6, cw: 2e6,
  model: { name: model, pct: 70 }, kind: { name: kind, pct: 55 }, top, alerts: [], rolledUp: 0, ...over,
});
const READS = 'cache reads (long contexts)';
const WRITES = 'cache writes (cold starts)';
const day = (d, unitsM, over = {}) => ({
  day: d, machine: 'Home', calls: 400, sessions: 2, unitsM, subagentUnitsM: 8.1,
  tokM: { in: 0, out: 0.4, cr: 77.3, cw: 3.3, cw1h: 0.9 },
  model: { 'opus-5-5': { calls: 428, units: unitsM * 0.9 }, 'haiku-5-5': { calls: 29, units: 0.8 } },
  cls: { human: { calls: 299, units: 8.1 } },
  wake: { n: 3, unitsM: 1.3, cwTokM: 0.6, perWakeK: 216, byCause: { human: { n: 3, units: 1.3 } } }, ...over,
});
const checkIn = (iso, id, decision, over = {}) => ({ at: iso, machine: 'Home', event: 'check-in', decision, by: 'rule', id, why: 'unchanged', n: 1, idleMin: 90, ctxK: 420, ...over });

const snapOf = (lines) => {
  const windows = []; const events = []; const days = new Map();
  for (const o of lines) {
    const w = U.windowOf(o); if (w) { windows.push(w); continue; }
    const e = U.eventOf(o); if (e) { events.push(e); continue; }
    const d = U.dayOf(o); if (d) days.set(d.day, d);
  }
  return { windows, events, days, version: 1, stats: { unknown: 0 } };
};
const report = (lines, over = {}) => U.buildReport(snapOf(lines), { machine: 'Home', now: NOW, days: 7, weeks: 6, top: 10, ...over });

test.describe('usage ledger: the record shapes (pure)', () => {
  test('a window, a roll-up day and a check-in line are each read as what they are; nothing else is', () => {
    const w = win(at(2026, 11, 24, 12, 6), 13, 165.6, READS, 'opus-5', [{ id: '735200a6', M: 1.6 }]);
    expect(U.windowOf(w)).toMatchObject({ windowM: 13, dayM: 165.6, kind: { name: READS }, top: [{ id: '735200a6', M: 1.6 }] });
    expect(U.eventOf(w)).toBeNull();
    expect(U.dayOf(w)).toBeNull();
    expect(U.dayOf(day('2026-11-24', 14.5))).toMatchObject({ unitsM: 14.5, wake: { n: 3, byCause: { human: { n: 3, units: 1.3 } } } });
    const ev = checkIn(at(2026, 11, 24, 12), 'abcd1234', 'woken');
    expect(U.eventOf(ev)).toMatchObject({ decision: 'woken', id: 'abcd1234', idleMin: 90, ctxK: 420 });
    // A check-in line carries the `top`-less shape: it is never a window, whatever else it holds.
    expect(U.windowOf(ev)).toBeNull();
    // Unknown decisions, a missing time and a bad day are refused, not guessed.
    expect(U.eventOf({ ...ev, decision: 'napped' })).toBeNull();
    expect(U.windowOf({ ...w, at: 'yesterday' })).toBeNull();
    expect(U.dayOf({ ...day('2026-11-24', 1), day: '24/11' })).toBeNull();
  });

  test('a check-in line\'s free-text reason is not carried into the report', () => {
    const ev = U.eventOf(checkIn(at(2026, 11, 24, 12), 'abcd1234', 'told', { reason: 'the session is waiting on the owner about a private matter' }));
    expect(JSON.stringify(ev)).not.toContain('private');
    expect(ev).not.toHaveProperty('reason');
  });
});

test.describe('usage ledger: weekly totals (pure)', () => {
  test('finished days come from the roll-up; a day it does not hold yet is counted once, from its last window, and flagged', () => {
    const r = report([
      day('2026-11-16', 90), day('2026-11-17', 100), day('2026-11-23', 40), day('2026-11-24', 60),
      // Today: three windows of a running total - the LAST one is the day so far.
      win(at(2026, 11, 25, 2, 6), 5, 5, READS, 'opus-5', []),
      win(at(2026, 11, 25, 9, 6), 9, 30.5, READS, 'opus-5', []),
      win(at(2026, 11, 25, 11, 36), 6, 41.8, READS, 'opus-5', []),
      // Yesterday has a roll-up line: its windows must NOT be added on top of it.
      win(at(2026, 11, 24, 13, 6), 9, 59, READS, 'opus-5', []),
    ]);
    const [cur, prev] = r.weeks;
    expect(cur).toMatchObject({ weekOf: '2026-11-23', days: 3, inProgressDays: 1, partial: true, unitsM: 141.8 });
    expect(prev).toMatchObject({ weekOf: '2026-11-16', days: 2, inProgressDays: 0, partial: false, unitsM: 190 });
    expect(cur.perDayM).toBe(47.3);
    expect(cur.subagentM).toBe(16.2);          // two finished days of 8.1
    expect(cur.opusM).toBe(90);                // 0.9 x (40 + 60)
    expect(cur.wake).toEqual({ n: 6, unitsM: 2.6 });
    expect(r.weeks.map((w) => w.weekOf)).toEqual(['2026-11-23', '2026-11-16']); // newest first
  });

  test('check-in decisions are tallied into the week they happened in', () => {
    const r = report([
      day('2026-11-17', 10), day('2026-11-24', 12),
      checkIn(at(2026, 11, 24, 10), 'aaaaaaaa', 'woken'), checkIn(at(2026, 11, 24, 11), 'bbbbbbbb', 'skipped'),
      checkIn(at(2026, 11, 17, 10), 'cccccccc', 'handed-off'),
    ]);
    expect(r.weeks.find((w) => w.weekOf === '2026-11-23').checkIns).toEqual({ skipped: 1, told: 0, woken: 1, 'handed-off': 0 });
    expect(r.weeks.find((w) => w.weekOf === '2026-11-16').checkIns['handed-off']).toBe(1);
    // The headline tally covers the asked days (7), the weeks table every week kept: 8 days ago is only in the latter.
    expect(r.checkIns.total).toEqual({ skipped: 1, told: 0, woken: 1, 'handed-off': 0 });
  });
});

test.describe('usage ledger: who burned the most, and why (pure)', () => {
  const windows = () => {
    const out = [];
    // "big" dominates five reads windows (>= half of each) and two cold-write windows.
    for (let i = 0; i < 5; i++) out.push(win(at(2026, 11, 24, 10 + i), 4, 20, READS, 'opus-5', [{ id: 'b1b1b1b1', M: 3 }, { id: 'c2c2c2c2', M: 0.4 }]));
    for (let i = 0; i < 2; i++) out.push(win(at(2026, 11, 24, 15 + i), 2, 25, WRITES, 'sonnet-5-5', [{ id: 'b1b1b1b1', M: 1.5 }]));
    // "shared" sits in READS windows but never spends half of one: no reason may be drawn from them.
    for (let i = 0; i < 3; i++) out.push(win(at(2026, 11, 23, 9 + i), 10, 9, READS, 'opus-5', [{ id: 'd3d3d3d3', M: 4 }, { id: 'e4e4e4e4', M: 3 }, { id: 'f5f5f5f5', M: 2 }]));
    return out;
  };

  test('sessions are ranked by the units their windows credit them, with the windows they appear in', () => {
    const r = report(windows());
    expect(r.sessions.map((s) => s.id)).toEqual(['b1b1b1b1', 'd3d3d3d3', 'e4e4e4e4', 'f5f5f5f5', 'c2c2c2c2']);
    expect(r.sessions[0]).toMatchObject({ unitsM: 18, windows: 7, idKind: 'agent', machine: 'Home' });
    expect(r.sessions[1].unitsM).toBe(12);
    expect(r.basis.sessionsAreLowerBound).toBe(true); // a window names only its top 3
    expect(U.buildReport(snapOf(windows()), { machine: 'Home', now: NOW, days: 7, weeks: 6, top: 2 }).sessions).toHaveLength(2);
  });

  test('a session is explained by the windows it dominated: re-read of a huge context, cold writes, the model', () => {
    const big = report(windows()).sessions[0];
    const codes = big.why.map((w) => w.code);
    expect(codes).toContain('context-reread');
    expect(codes).toContain('cold-cache-write');
    expect(big.why.find((w) => w.code === 'context-reread')).toMatchObject({ n: 5 });
    expect(big.why.find((w) => w.code === 'cold-cache-write')).toMatchObject({ n: 2 });
    expect(big.why.find((w) => w.code === 'model').text).toContain('opus-5');
    expect(big.dominatedWindows).toBe(7);
  });

  test('a session that only SHARED a window is not blamed for that window\'s main cost', () => {
    const shared = report(windows()).sessions.find((s) => s.id === 'd3d3d3d3');
    expect(shared.dominatedWindows).toBe(0);
    expect(shared.why.map((w) => w.code)).not.toContain('context-reread');
    // ... and says plainly that the ledger cannot tell, rather than inventing a reason.
    const linked = U.attachLive(report(windows()), []).sessions.find((s) => s.id === 'd3d3d3d3');
    expect(linked.why).toHaveLength(1);
    expect(linked.why[0]).toMatchObject({ code: 'unexplained' });
  });

  test('six windows in a row in the top 3 is a long run; a window it is absent from, or a hole in the ledger, breaks the run', () => {
    const top = (withIt) => [...(withIt ? [{ id: 'a0a0a0a0', M: 1 }] : []), { id: 'ffffffff', M: 1.4 }, { id: 'eeeeeeee', M: 1.4 }];
    const at30 = (h, mi) => at(2026, 11, 24, h, mi);
    const run = (n, h0) => Array.from({ length: n }, (_, i) => win(at30(h0 + Math.floor(i / 2), (i % 2) * 30), 4, 10, READS, 'opus-5', top(true)));
    const s = (lines) => report(lines).sessions.find((x) => x.id === 'a0a0a0a0');
    // Six windows (3 hours) in a row.
    expect(s(run(6, 8)).longestRunWindows).toBe(6);
    expect(s(run(6, 8)).why.find((w) => w.code === 'long-run').text).toContain('3 hours');
    // Four, then a window of the ledger without it, then four: two runs of four, no long run.
    const absent = [...run(4, 8), win(at30(10, 0), 4, 10, READS, 'opus-5', top(false)), ...run(4, 10).map((w) => ({ ...w, at: new Date(Date.parse(w.at) + 30 * 60e3).toISOString() }))];
    expect(s(absent).longestRunWindows).toBe(4);
    expect(s(absent).why.map((w) => w.code)).not.toContain('long-run');
    // Four, then hours with no line in the ledger at all (the monitor was off), then four.
    const hole = [...run(4, 8), ...run(4, 14)];
    expect(s(hole).longestRunWindows).toBe(4);
    expect(s(hole).why.map((w) => w.code)).not.toContain('long-run');
  });

  test('windows older than the asked days are not ranked', () => {
    const r = report([win(at(2026, 11, 10, 9), 4, 4, READS, 'opus-5', [{ id: '0ld0ld00', M: 9 }]), ...windows()]);
    expect(r.sessions.map((s) => s.id)).not.toContain('0ld0ld00');
  });
});

test.describe('usage ledger: linking a row to the session that still exists (pure)', () => {
  const base = () => report([
    win(at(2026, 11, 24, 10), 4, 4, READS, 'opus-5', [{ id: '735200a6', M: 3 }]),
    win(at(2026, 11, 24, 11), 4, 8, READS, 'opus-5', [{ id: '61a59a4d', M: 3 }]),
    checkIn(at(2026, 11, 24, 12), 'abcd1234', 'woken', { idleMin: 140, ctxK: 610 }),
    checkIn(at(2026, 11, 24, 13), 'abcd1234', 'woken', { idleMin: 95, ctxK: 640 }),
    checkIn(at(2026, 11, 24, 14), 'abcd1234', 'skipped'),
    checkIn(at(2026, 11, 24, 15), 'deadbeef', 'told'),
  ]);
  const live = [
    { id: 'abcd1234-0000-4000-8000-000000000001', claudeSessionId: '735200a6-1111-4111-8111-111111111111', name: 'the ranked one' },
    { id: '99990000-0000-4000-8000-000000000002', claudeSessionId: '61a59a4d-2222-4222-8222-222222222222', name: 'ambiguous' },
    { id: '99990001-0000-4000-8000-000000000003', claudeSessionId: '61a59a4d-3333-4333-8333-333333333333', name: 'ambiguous too' },
  ];

  test('an agent id links to the session that carries it; an id two sessions share is NOT linked', () => {
    const r = U.attachLive(base(), live);
    const one = r.sessions.find((s) => s.id === '735200a6');
    expect(one).toMatchObject({ sessionId: live[0].id, name: 'the ranked one' });
    const two = r.sessions.find((s) => s.id === '61a59a4d');
    expect(two.sessionId).toBeNull();
    expect(two.name).toBeNull();
  });

  test('a check-in line links by web-terminal session id, and its tally rides on the ranked row with its own reason', () => {
    const r = U.attachLive(base(), live);
    const ci = r.checkIns.sessions.find((s) => s.id === 'abcd1234');
    expect(ci).toMatchObject({ sessionId: live[0].id, woken: 2, skipped: 1, maxCtxK: 640, maxIdleMin: 140 });
    expect(r.checkIns.sessions.find((s) => s.id === 'deadbeef').sessionId).toBeNull(); // gone: still listed, unlinked
    const row = r.sessions.find((s) => s.id === '735200a6');
    expect(row.checkIns).toMatchObject({ woken: 2, skipped: 1, maxCtxK: 640 });
    const why = row.why.find((w) => w.code === 'check-in-wakes');
    expect(why.n).toBe(2);
    expect(why.text).toContain('640k');
    expect(why.text).toContain('140 min');
  });
});

test.describe('usage ledger: the cluster merge (pure)', () => {
  const mk = (machine, id, units, weekUnits) => {
    const r = report([day('2026-11-24', weekUnits), win(at(2026, 11, 24, 10), 4, 4, READS, 'opus-5', [{ id, M: units }]), checkIn(at(2026, 11, 24, 11), 'aaaaaaaa', 'woken')], {});
    return { ...r, machine, sessions: r.sessions.map((s) => ({ ...s, machine })) };
  };

  test('weeks add up, sessions rank together and keep their machine, check-in tallies add up', () => {
    const merged = U.mergeReports(mk('Home', '11111111', 2, 40), [{ name: 'Office', report: mk('Office', '22222222', 5, 70) }], { top: 10, weeks: 6 });
    expect(merged.machines).toEqual(['Home', 'Office']);
    expect(merged.weeks[0]).toMatchObject({ weekOf: '2026-11-23', unitsM: 110, days: 2 });
    expect(merged.sessions.map((s) => `${s.machine}:${s.id}`)).toEqual(['Office:22222222', 'Home:11111111']);
    expect(merged.checkIns.total.woken).toBe(2);
    expect(U.mergeReports(mk('Home', '11111111', 2, 40), [{ name: 'Office', report: mk('Office', '22222222', 5, 70) }], { top: 1, weeks: 6 }).sessions).toHaveLength(1);
  });

  test('an answer that is not a report is left out, not merged', () => {
    const local = mk('Home', '11111111', 2, 40);
    for (const junk of [null, {}, { weeks: 'x' }, { weeks: [], sessions: [], checkIns: null }, 'html']) expect(U.isReport(junk)).toBe(false);
    const merged = U.mergeReports(local, [{ name: 'Bad', report: { weeks: [{ weekOf: '2026-11-23', unitsM: 999 }] } }], { top: 10, weeks: 6 });
    expect(merged.machines).toEqual(['Home']);
    expect(merged.weeks[0].unitsM).toBe(40);
  });
});

test.describe('usage ledger: query parameters (pure)', () => {
  test('defaults, bounds, and a refusal that names the parameter', () => {
    expect(U.parseParams({})).toEqual({ days: 7, weeks: 6, top: 10, cluster: false });
    expect(U.parseParams({ days: '30', weeks: '12', top: '50', cluster: '1' })).toEqual({ days: 30, weeks: 12, top: 50, cluster: true });
    expect(U.parseParams({ days: '0' }).error).toMatch(/days must be a whole number from 1 to 35/);
    expect(U.parseParams({ top: '51' }).error).toMatch(/top/);
    expect(U.parseParams({ weeks: '2.5' }).error).toMatch(/weeks/);
    expect(U.parseParams({ days: ['7', '8'] }).error).toMatch(/days/);
  });
});

test.describe('usage ledger: following the files incrementally', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt529-')); });
  test.afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const line = (o) => `${JSON.stringify(o)}\n`;
  const w = (n) => win(at(2026, 11, 24, 10, n), 1, n, READS, 'opus-5', [{ id: `s${String(n).padStart(7, '0')}`, M: 1 }]);

  test('a second look reads ONLY what was appended, and a line still being written waits for its newline', async () => {
    const f = path.join(dir, 'usage-ledger.jsonl');
    fs.writeFileSync(f, line(w(1)) + line(w(2)));
    const seen = [];
    const t = U.createTail(f, (l) => seen.push(JSON.parse(l).dayM), () => seen.push('RESET'));
    expect(await t.poll()).toBe(2);
    expect(await t.poll()).toBe(0);            // nothing new: nothing read
    fs.appendFileSync(f, line(w(3)));
    expect(await t.poll()).toBe(1);            // exactly the new line, not the whole file again
    const half = line(w(4));
    fs.appendFileSync(f, half.slice(0, 40));   // a writer caught mid-line
    expect(await t.poll()).toBe(0);
    fs.appendFileSync(f, half.slice(40));
    expect(await t.poll()).toBe(1);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test('a file that shrank or was replaced is read again from its start, and what it held before is dropped', async () => {
    const f = path.join(dir, 'usage-ledger.jsonl');
    const store = U.createStore({ ledgerFile: f, rollupFile: null, now: () => NOW, minGapMs: 0 });
    fs.writeFileSync(f, [1, 2, 3].map((n) => line(w(n))).join(''));
    await store.refresh();
    expect(store.snapshot().windows).toHaveLength(3);
    fs.writeFileSync(f, line(w(9)));           // rotated: shorter than the offset we hold
    await store.refresh();
    const after = store.snapshot();
    expect(after.windows.map((x) => x.dayM)).toEqual([9]);
  });

  test('a first look at a huge file reads only its tail, from the start of a whole line', async () => {
    const f = path.join(dir, 'usage-ledger.jsonl');
    const all = Array.from({ length: 200 }, (_, i) => line(w(i)));
    fs.writeFileSync(f, all.join(''));
    const size = fs.statSync(f).size;
    const seen = [];
    const t = U.createTail(f, (l) => seen.push(JSON.parse(l).dayM), () => {}, { maxFirstRead: Math.floor(size / 4) });
    const n = await t.poll();
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(70);
    expect(seen[seen.length - 1]).toBe(199);
    // Every line it did deliver parsed whole: the half line it landed in was dropped.
    expect(seen.every((x) => Number.isFinite(x))).toBe(true);
    expect(seen).toEqual(Array.from({ length: n }, (_, i) => 200 - n + i));
  });

  test('the store keeps windows, roll-up days and check-in lines apart, counts what it cannot read, and drops what is older than it keeps', async () => {
    const lf = path.join(dir, 'usage-ledger.jsonl');
    const rf = path.join(dir, 'usage-rollup.jsonl');
    fs.writeFileSync(lf, line(w(1)) + 'not json\n' + line({ hello: 'world' }) + line(checkIn(at(2026, 11, 24, 12), 'abcd1234', 'woken'))
      + line(win(at(2026, 8, 1, 10), 1, 1, READS, 'opus-5', [])));
    fs.writeFileSync(rf, line(day('2026-11-24', 14.5)));
    const store = U.createStore({ ledgerFile: lf, rollupFile: rf, now: () => NOW, minGapMs: 0 });
    await store.refresh();
    const s = store.snapshot();
    expect(s.windows).toHaveLength(1);          // the August line is past RETAIN_DAYS
    expect(s.events).toHaveLength(1);
    expect([...s.days.keys()]).toEqual(['2026-11-24']);
    expect(s.stats.unknown).toBe(2);
  });

  test('a store with no files (the suite\'s default) reports nothing and never throws', async () => {
    const store = U.createStore({ ledgerFile: null, rollupFile: null, now: () => NOW });
    await store.refresh();
    const r = U.buildReport(store.snapshot(), { machine: 'Home', now: NOW });
    expect(r.weeks).toEqual([]);
    expect(r.sessions).toEqual([]);
    expect(r.coverage.windows).toBe(0);
    const missing = U.createStore({ ledgerFile: path.join(dir, 'nope.jsonl'), rollupFile: path.join(dir, 'nope2.jsonl'), now: () => NOW });
    await missing.refresh();
    expect(missing.snapshot().windows).toEqual([]);
  });

  test('under WT_TEST no file is read unless a spec names one', () => {
    expect(U.filesFor({ home: dir, env: { WT_TEST: '1' } })).toEqual({ ledger: null, rollup: null });
    expect(U.filesFor({ home: dir, env: { WT_TEST: '1', WT_USAGE_LEDGER_FILE: 'x.jsonl' } })).toEqual({ ledger: 'x.jsonl', rollup: null });
    const real = U.filesFor({ home: dir, env: {} });
    expect(real.ledger).toBe(path.join(dir, '.claude', 'usage-ledger.jsonl'));
    expect(real.rollup).toBe(path.join(dir, '.claude', 'usage-rollup.jsonl'));
  });
});
