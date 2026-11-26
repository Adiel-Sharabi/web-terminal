// #529 - does a smaller context give BETTER results? The quality signals counted from a transcript,
// the settings regime a session ran under, and the "Quality by context" section: compared within a
// complexity band, n per cell, cells under 5 marked too few. Pure; no server.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionAccumulator, localDay } = require('../lib/usage-session');
const { isCorrection } = require('../lib/usage-correction');
const q = require('../lib/usage-quality');
const settings = require('../lib/usage-settings');
const { buildReport } = require('../lib/usage-report');

const T0 = Date.parse('2026-03-10T08:00:00Z');
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const user = (min, text) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });

test.describe('quality signals from a transcript', () => {
  test('tool errors, a refusal by the person, the same call failing twice in a row, corrections and mid-task compactions are counted - never their text', () => {
    const a = createSessionAccumulator();
    const use = (min, id, name, input) => ({ type: 'assistant', timestamp: at(min), requestId: `r${id}`, message: { id: `m${id}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] } });
    const res = (min, id, isError, extra = {}) => ({ type: 'user', timestamp: at(min), ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'secret-tool-output' }] } });
    a.main(user(0, 'fix it'));
    a.main(use(1, 't1', 'Bash', { command: 'make' })); a.main(res(2, 't1', true));
    a.main(use(3, 't2', 'Bash', { command: 'make' })); a.main(res(4, 't2', true));      // the same call failing again: a retry
    a.main(use(5, 't3', 'Bash', { command: 'make -j2' })); a.main(res(6, 't3', true));   // a different input: an error, not a retry
    a.main(use(7, 't4', 'Edit', { file: 'x' })); a.main(res(8, 't4', true, { toolUseResult: 'User rejected tool use' })); // the person said no
    a.main(use(9, 't5', 'Bash', { command: 'ls' })); a.main(res(10, 't5', false));
    a.main(user(11, 'no, that is not what I asked'));
    a.main(user(12, 'now do the other thing'));
    a.main({ type: 'system', subtype: 'compact_boundary', timestamp: at(13), compactMetadata: { trigger: 'auto' } });
    a.main({ type: 'system', subtype: 'compact_boundary', timestamp: at(14), compactMetadata: { trigger: 'manual' } });
    const s = a.finish();
    expect(s.quality).toEqual({ toolCalls: 5, toolErrors: 3, deniedTools: 1, retriesSameTool: 1, humanCorrections: 1, compactionsMidTask: 1 });
    expect(JSON.stringify(s)).not.toContain('secret-tool-output');
  });

  test('a first prompt is never a correction, and a prompt that merely contains the words is not one', () => {
    const a = createSessionAccumulator();
    a.main(user(0, 'no wait, start over'));   // the first prompt: nothing to correct yet
    a.main({ type: 'assistant', timestamp: at(1), requestId: 'r', message: { id: 'm', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { output_tokens: 1 } } });
    a.main(user(2, 'please do not stop now'));
    expect(a.finish().quality.humanCorrections).toBe(0);
  });

  test('isCorrection reads the opening words only: no, wrong, stop, not what, again, Hebrew', () => {
    const he = (...cps) => String.fromCodePoint(...cps);
    const no = he(0x5dc, 0x5d0); const again = he(0x5e9, 0x5d5, 0x5d1); const later = he(0x5dc, 0x5d0, 0x5d7, 0x5e8, 0x5d9, 0x5d5, 0x5d5);
    for (const t of ['no, that is wrong', 'Wrong file', "that's not what I asked", 'stop', 'again please', 'Not what I meant', "don't do that", `${no}, ${no} ${no}`, again, '<system-reminder>x</system-reminder>\nno way']) expect(isCorrection(t), t).toBe(true);
    for (const t of ['Now fix the next thing', 'nothing to add', 'notice the output', 'please do not stop', 'the test says no', later]) expect(isCorrection(t), t).toBe(false);
  });
});

test.describe('the settings a session ran under', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-set-')); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS */ } });
  test('the snapshot reads Claude\'s settings and the hand-off thresholds; a change is a change, the same is not', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoCompactWindow: 400000, effortLevel: 'xhigh', model: 'opus[1m]', hooks: { secret: 1 } }));
    const a = settings.readSettings({ claudeDir: dir, config: { handoff: { ctxThreshold: 200000, auto: true, note: 'text is dropped', nested: { x: 1 } } } });
    expect(a).toEqual({ autoCompactWindow: 400000, effort: 'xhigh', defaultModel: 'opus[1m]', handoff: { ctxThreshold: 200000, auto: true } });
    expect(settings.sameSettings(a, { ...a, handoff: { auto: true, ctxThreshold: 200000 } })).toBe(true);
    expect(settings.sameSettings(a, { ...a, autoCompactWindow: 150000 })).toBe(false);
    expect(settings.sameSettings(a, null)).toBe(false);
    expect(settings.readSettings({ claudeDir: path.join(dir, 'missing'), config: null })).toEqual({ autoCompactWindow: null, effort: null, defaultModel: null, handoff: {} });
    expect(settings.regimeLabel(a)).toBe('400k compact / xhigh / opus[1m] / hand-off 200k');
    expect(settings.settingsDraft({ origin: 'Home', at: 'T', snapshot: a })).toMatchObject({ type: 'settings', key: 'Home|settings|T', autoCompactWindow: 400000 });
  });
});

test.describe('quality by context', () => {
  test('bands: context from the peak, complexity from the measured fix (or the state file\'s band), the regime in force at a time', () => {
    expect([50e3, 99999, 100e3, 250e3, 300e3, 900e3, 0].map(q.ctxBandOf)).toEqual(['<100k', '<100k', '100-200k', '200-300k', '>300k', '>300k', null]);
    const cx = (o) => q.complexityBandOf({ complexity: { files: 1, linesAdded: 5, linesDeleted: 0, layers: ['server'], gui: false, hw: false, db: false, ...o } });
    expect(cx({})).toBe('small');
    expect(cx({ files: 4 })).toBe('medium');
    expect(cx({ gui: true })).toBe('medium');
    expect(cx({ files: 9 })).toBe('large');
    expect(cx({ linesAdded: 400 })).toBe('large');
    expect(cx({ layers: ['a', 'b', 'c'] })).toBe('large');
    expect(cx({ hw: true })).toBe('large');
    expect(cx({ db: true })).toBe('large');
    expect(q.complexityBandOf({ band: 'easy' })).toBe('small');
    expect(q.complexityBandOf({ band: 'hard' })).toBe('large');
    expect(q.complexityBandOf({})).toBe('unknown');
    const set = [{ origin: 'Home', at: '2026-03-01T00:00:00Z', autoCompactWindow: 1 }, { origin: 'Home', at: '2026-03-10T00:00:00Z', autoCompactWindow: 2 }, { origin: 'Office', at: '2026-03-05T00:00:00Z', autoCompactWindow: 9 }];
    expect(q.regimeAt(set, 'home', Date.parse('2026-03-09T00:00:00Z')).autoCompactWindow).toBe(1);
    expect(q.regimeAt(set, 'Home', Date.parse('2026-03-11T00:00:00Z')).autoCompactWindow).toBe(2);
    expect(q.regimeAt(set, 'Home', Date.parse('2026-02-01T00:00:00Z'))).toBeNull();
  });

  const item = (o) => ({ origin: 'Home', startedAt: '2026-03-02T00:00:00Z', complexityBand: 'medium', peakCtx: 150e3, fixed: true, escalated: false, finished: true, firstPass: true, rejects: 0, reviewsTotal: 2, gateFails: 0, gatesTotal: 4, attempts: 1, durationMin: 30, workerUnitsM: 2, ...o });
  const sess = (o) => ({ origin: 'Home', start: '2026-03-02T00:00:00Z', peakCtx: 150e3, human: 10, corrections: 1, toolErrors: 2, denied: 0, toolCalls: 100, midTask: 0, handoffs: 0, unitsM: 3, ...o });

  test('items are compared within a complexity band, by context band; cells under 5 are marked too few; rates use the right denominators', () => {
    const items = [
      ...Array.from({ length: 5 }, () => item({ peakCtx: 80e3 })),                                                          // medium, <100k: 5 fixed first pass
      ...Array.from({ length: 4 }, (_, i) => item({ peakCtx: 250e3, firstPass: i === 0, rejects: i === 0 ? 0 : 1, attempts: i === 0 ? 1 : 2, gateFails: 1 })), // medium, 200-300k: 4 items
      item({ complexityBand: 'large', peakCtx: 250e3, fixed: false, escalated: true, firstPass: false, attempts: 3 }),       // large band: its own cell
      item({ peakCtx: 0 }),                                                                                                   // no measured context: in no ctx cell
    ];
    const r = q.buildQuality({ records: [], itemRows: items, sessionRows: [] });
    const cell = (c, b) => r.bugHunter.byContext.find((x) => x.complexity === c && x.ctxBand === b);
    expect(cell('medium', '<100k')).toMatchObject({ n: 5, tooFew: false, firstPassYieldPct: 100, reviewRejectRatePct: 0, gateFailRatePct: 0, avgAttempts: 1 });
    expect(cell('medium', '200-300k')).toMatchObject({ n: 4, tooFew: true, firstPassYieldPct: 25, reviewRejectRatePct: 37.5, gateFailRatePct: 25, avgAttempts: 1.8 });
    expect(cell('large', '200-300k')).toMatchObject({ n: 1, tooFew: true, escalationRatePct: 100 });
    expect(r.bugHunter.byContext.some((x) => x.ctxBand === null)).toBe(false);
    expect(r.bugHunter.note).toMatch(/WITHIN a complexity band/);
    expect(r.minN).toBe(5);
  });

  test('other sessions: corrections per 10 prompts, tool errors per 100 calls, handed-off share; by context and by the regime in force at their start', () => {
    const settingsRecs = [
      { type: 'settings', origin: 'Home', at: '2026-03-01T00:00:00Z', autoCompactWindow: 400000, effort: 'xhigh', defaultModel: 'opus', handoff: { ctxThreshold: 200000 } },
      { type: 'settings', origin: 'Home', at: '2026-03-05T00:00:00Z', autoCompactWindow: 150000, effort: 'xhigh', defaultModel: 'opus', handoff: { ctxThreshold: 100000 } },
    ];
    const rows = [
      ...Array.from({ length: 5 }, () => sess({ peakCtx: 90e3, corrections: 1, human: 10, toolErrors: 1, toolCalls: 100, start: '2026-03-06T00:00:00Z' })),
      ...Array.from({ length: 5 }, (_, i) => sess({ peakCtx: 320e3, corrections: 3, human: 10, toolErrors: 5, toolCalls: 100, handoffs: i < 2 ? 1 : 0, start: '2026-03-02T00:00:00Z' })),
    ];
    const r = q.buildQuality({ records: settingsRecs, itemRows: [], sessionRows: rows });
    const small = r.sessions.byContext.find((c) => c.ctxBand === '<100k');
    const big = r.sessions.byContext.find((c) => c.ctxBand === '>300k');
    expect(small).toMatchObject({ n: 5, tooFew: false, correctionsPer10Prompts: 1, toolErrorsPer100Calls: 1, handedOffPct: 0 });
    expect(big).toMatchObject({ n: 5, correctionsPer10Prompts: 3, toolErrorsPer100Calls: 5, handedOffPct: 40 });
    expect(r.sessions.byRegime.map((c) => [c.regime, c.n])).toEqual([['150k compact / xhigh / opus / hand-off 100k', 5], ['400k compact / xhigh / opus / hand-off 200k', 5]]);
    expect(r.sessions.note).toMatch(/NOT controlled/);
    expect(r.regimes.map((x) => x.autoCompactWindow)).toEqual([400000, 150000]);
  });

  test('the report carries the section: a handed-off session is one a later session replaced; the bug-hunter classes stay out of the other-sessions table', () => {
    const now = Date.parse('2026-03-12T12:00:00');
    const d0 = localDay(now);
    const base = (o) => ({ type: 'session', origin: 'Home', seq: 1, at: new Date(now).toISOString(), key: `Home|${o.sid}`, cls: 'interactive', project: 'p', tok: {}, models: {}, sub: {}, prompts: { human: 10, auto: 0 },
      wakes: {}, time: {}, compactions: 0, peakCtx: 120000, byDay: { [d0]: 1e6 }, units: 1e6, start: new Date(now).toISOString(), quality: { toolCalls: 50, toolErrors: 1, humanCorrections: 2, deniedTools: 0, compactionsMidTask: 0 }, ...o });
    const recs = [base({ sid: 'a', wtId: 'wt-a' }), base({ sid: 'b', wtId: 'wt-b', replaces: ['wt-a'] }), base({ sid: 'w', cls: 'bh-worker', bh: { item: 1, role: 'worker' } })];
    const r = buildReport(recs, { now, days: 7 });
    const cell = r.quality.sessions.byContext.find((c) => c.ctxBand === '100-200k');
    expect(cell.n).toBe(2);                    // the bug-hunter worker is not in it
    expect(cell.handedOffPct).toBe(50);        // a was replaced by b
    expect(cell.correctionsPer10Prompts).toBe(2);
  });
});
