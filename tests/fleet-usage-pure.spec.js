// #529 - the fleet usage ledger, pure parts: weights and prompt classes, one session's summary from
// transcript lines (subagents, dedupe, wake-ups, the time split), the project key, classification,
// the bug-hunter items, and the report's numbers. No server, no model.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../lib/usage-weights');
const { createSessionAccumulator, localDay, wanted } = require('../lib/usage-session');
const proj = require('../lib/usage-project');
const col = require('../lib/usage-collector');
const bh = require('../lib/usage-bh');
const { createScoper, classifyDraft } = require('../lib/usage-classify');
const { buildReport, windowDays, percentile } = require('../lib/usage-report');

const rmTmp = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS */ } };
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// --- fixtures ------------------------------------------------------------------------------
const T0 = Date.parse('2026-03-10T08:00:00Z');
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const user = (min, text, extra = {}) => ({ type: 'user', timestamp: at(min), cwd: 'C:\\dev\\example-app', gitBranch: 'feat/x', message: { role: 'user', content: text }, ...extra });
const toolResult = (min) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
const asst = (min, id, usage, extra = {}) => ({
  type: 'assistant', timestamp: at(min), requestId: `req-${id}`,
  message: { id, model: extra.model || 'claude-opus-5-5', stop_reason: extra.stop || 'end_turn', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } }, ...(extra.top || {}),
});

test.describe('weights and prompt classes', () => {
  test('units follow the published weights, and the 1 h cache write costs more than the 5 min one', () => {
    expect(w.unitsOf({ in: 100, out: 10, cr: 1000, cw: 500, cw1h: 200 })).toBe(100 + 300 * 1.25 + 200 * 2 + 1000 * 0.1 + 10 * 5);
    expect(w.unitsOf({ in: 1, cw: 10, cw1h: 99 })).toBe(1 + 10 * 2); // 1 h part never exceeds the write
    expect(w.cacheWriteUnitsOf({ cw: 500, cw1h: 200 })).toBe(300 * 1.25 + 200 * 2);
  });
  test('promptClass names what a first prompt is, and nothing for an echo', () => {
    expect(w.promptClass('fix the bug')).toBe('human');
    expect(w.promptClass('<system-reminder>x</system-reminder>\nYou are reviewing a pull request')).toBe('pr-review');
    expect(w.promptClass('You are checking an automated run')).toBe('pipeline-check');
    expect(w.promptClass('This session is being continued from a previous')).toBe('continued');
    expect(w.promptClass('[web-terminal check-in] still there?')).toBe('wt-automation');
    expect(w.promptClass('<command-name>/recap</command-name>')).toBe('slash');
    expect(w.promptClass('<local-command-stdout>ok</local-command-stdout>')).toBeNull();
    expect(w.opensBugHunter('<command-message>dds-bug-hunter</command-message>\n<command-name>/dds-bug-hunter</command-name>')).toBe(true);
    expect(w.opensBugHunter('please review the dds-bug-hunter docs')).toBe(false);
  });
});

test.describe('one session from its transcript lines', () => {
  function run() {
    const a = createSessionAccumulator();
    a.main(user(0, 'fix the login bug'));
    a.main(asst(1, 'm1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 }, { stop: 'tool_use' }));
    // Claude writes each block of a message on its own line: the LAST line has the final usage
    a.main(asst(1, 'm1', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 100 } }, { stop: 'tool_use' }));
    a.main(toolResult(2));
    a.main(asst(3, 'm2', { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 2000 }, { stop: 'end_turn', model: 'claude-sonnet-5-5' }));
    a.main(asst(4, 'syn', { input_tokens: 999 }, { model: '<synthetic>' }));            // costs nothing
    a.main(user(30, 'now the second thing'));                                              // 27 min after the turn ended: waits on a human
    a.main(asst(31, 'm3', { output_tokens: 10, cache_creation_input_tokens: 800 }));
    a.main(asst(120, 'm4', { output_tokens: 1, cache_creation_input_tokens: 600 }));       // 89 min later, nobody prompted: an idle wake-up
    a.main(user(121, '[web-terminal check-in] still there?'));
    a.main(asst(300, 'm5', { output_tokens: 1, cache_creation_input_tokens: 700, cache_creation: { ephemeral_1h_input_tokens: 700 } })); // woken by automation
    a.main({ type: 'system', subtype: 'compact_boundary', timestamp: at(301) });
    a.main(user(302, 'This session is being continued from a previous', { isCompactSummary: true }));
    a.sub(asst(5, 's1', { input_tokens: 7, output_tokens: 3 }, { model: 'claude-haiku-5-5' }), 'Explore', 'agent-1');
    a.sub(asst(6, 's2', { output_tokens: 2 }, { model: 'claude-haiku-5-5' }), 'Explore', 'agent-2');
    a.sub(asst(7, 's3', { output_tokens: 4 }, { model: 'claude-sonnet-5-5' }), 'build', 'agent-3');
    return a.finish();
  }

  test('tokens, units, models and subagents: a message is counted once, the last line wins', () => {
    const s = run();
    const m1 = { in: 10, out: 50, cr: 1000, cw: 400, cw1h: 100 };
    const m2 = { in: 5, out: 20, cr: 2000, cw: 0, cw1h: 0 };
    const m3 = { in: 0, out: 10, cr: 0, cw: 800, cw1h: 0 };
    const m4 = { in: 0, out: 1, cr: 0, cw: 600, cw1h: 0 };
    const m5 = { in: 0, out: 1, cr: 0, cw: 700, cw1h: 700 };
    const s1 = { in: 7, out: 3 }; const s2 = { out: 2 }; const s3 = { out: 4 };
    const all = [m1, m2, m3, m4, m5, s1, s2, s3];
    expect(s.tok).toEqual({ in: 22, out: 91, cr: 3000, cw: 2500, cw1h: 800 });
    expect(s.units).toBe(Math.round(all.reduce((n, t) => n + w.unitsOf(t), 0)));
    expect(s.models['opus-5-5'].calls).toBe(4);
    expect(s.models['sonnet-5-5'].calls).toBe(2);
    expect(s.models['haiku-5-5'].calls).toBe(2);
    expect(s.models['opus-5-5'].units).toBe(Math.round([m1, m3, m4, m5].reduce((n, t) => n + w.unitsOf(t), 0)));
    expect(s.sub.n).toBe(3);
    expect(s.sub.units).toBe(Math.round([s1, s2, s3].reduce((n, t) => n + w.unitsOf(t), 0)));
    expect(s.sub.byType.Explore.n).toBe(2);
    expect(s.sub.byType.build.n).toBe(1);
    expect(s.peakCtx).toBe(2005);
    expect(s.cwd).toBe('C:\\dev\\example-app');
    expect(s.branch).toBe('feat/x');
  });

  test('wake-ups are the calls after an idle hour, split by what woke the session', () => {
    const s = run();
    expect(s.wakes.n).toBe(2);   // m4 (89 min idle) and m5 (3 h after a check-in prompt)
    expect(s.wakes.units).toBe(Math.round(w.cacheWriteUnitsOf({ cw: 600 }) + w.cacheWriteUnitsOf({ cw: 700, cw1h: 700 })));
    expect(s.wakes.auto.n).toBe(1);
    expect(s.wakes.auto.units).toBe(Math.round(w.cacheWriteUnitsOf({ cw: 700, cw1h: 700 })));
  });

  test('time: active under 5 min, a long gap ending in a human prompt after a finished turn is a wait on you, other long gaps are idle', () => {
    const s = run();
    // events (main only): h0 a1 a1 u2 e3(end_turn) syn@4 h30 e31 e120 x121 e300
    expect(s.time.waits).toBe(1);
    expect(s.time.waitsMin).toEqual([26]);          // synthetic @4 ended the turn at 4 -> 26 min
    expect(s.time.waitYouMs).toBe(26 * 60e3);
    expect(s.time.activeMs).toBe((1 + 1 + 1 + 1) * 60e3 + 60e3 + 1 * 60e3); // 0->1, 2->3 (1), 3->4 (1), 1->2 (1), 30->31 (1), 120->121 (1)
    expect(s.time.idleMs).toBe((89 + 179) * 60e3);  // 31->120 and 121->300
  });

  test('prompts, class facts, compactions and the per-day split', () => {
    const s = run();
    expect(s.prompts).toEqual({ human: 2, auto: 1 }); // the compaction summary is no prompt
    expect(s.compactions).toBe(1);                    // a boundary and its summary line are ONE compaction
    expect(s.facts).toEqual({ firstClass: 'human', startsBugHunter: false });
    expect(Object.values(s.byDay).reduce((n, x) => n + x, 0)).toBeGreaterThan(0);
    expect(Math.abs(Object.values(s.byDay).reduce((n, x) => n + x, 0) - s.units)).toBeLessThanOrEqual(Object.keys(s.byDay).length);
    expect(Object.keys(s.byDay)).toContain(localDay(T0));
    expect(s.start).toBe(at(0).replace(/\.000Z$/, '.000Z'));
  });

  test('a session with no model call has no summary; the line filter keeps what matters', () => {
    const a = createSessionAccumulator();
    a.main(user(0, 'hello'));
    expect(a.finish()).toBeNull();
    expect(wanted('{"type":"user","x":1}')).toBe(true);
    expect(wanted('{"message":{"usage":{}}}')).toBe(true);
    expect(wanted('{"type":"attachment"}')).toBe(false);
  });
});

test.describe('which project a cwd is in', () => {
  let root;
  test.beforeEach(() => { root = mk('wt-proj-'); });
  test.afterEach(() => rmTmp(root));
  const repo = (dir, url) => { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`); };

  test('the repo name from its origin, from a subfolder, a no-origin repo, a worktree, no repo, a vanished folder', () => {
    repo(path.join(root, 'main-checkout'), 'https://example.test/org/_git/Example_App.git');
    fs.mkdirSync(path.join(root, 'main-checkout', 'src', 'deep'), { recursive: true });
    expect(proj.projectKey(path.join(root, 'main-checkout', 'src', 'deep'))).toBe('example_app');
    // a worktree: .git is a file naming a gitdir whose commondir leads back to the main .git
    const wt = path.join(root, 'wt-one');
    const gd = path.join(root, 'main-checkout', '.git', 'worktrees', 'wt-one');
    fs.mkdirSync(wt, { recursive: true }); fs.mkdirSync(gd, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
    fs.writeFileSync(path.join(gd, 'commondir'), '../..\n');
    expect(proj.projectKey(wt)).toBe('example_app');
    // a repo with no origin: its folder name
    fs.mkdirSync(path.join(root, 'Local-Only', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Local-Only', '.git', 'config'), '[core]\n');
    expect(proj.projectKey(path.join(root, 'Local-Only'))).toBe('local-only');
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
    expect(proj.projectKey(path.join(root, 'plain'))).toBe('(none)');
    expect(proj.projectKey(path.join(root, 'Gone-Worktree'))).toBe('gone-worktree');
    expect(proj.projectKey('')).toBe('(none)');
    expect(proj.keyOfUrl('git@host.test:org/Some-Repo.git')).toBe('some-repo');
    expect(proj.keyOfUrl('C:\\repos\\Thing')).toBe('thing');
  });
  test('reposUnder lists each repo once, a worktree under the same name', () => {
    repo(path.join(root, 'a'), 'https://example.test/x/alpha.git');
    repo(path.join(root, 'b'), 'https://example.test/x/beta.git');
    fs.mkdirSync(path.join(root, 'not-a-repo'));
    expect(proj.reposUnder(root)).toEqual(['alpha', 'beta']);
  });
});

test.describe('classes, attribution and the scan rules', () => {
  const facts = (firstClass = 'human', startsBugHunter = false) => ({ firstClass, startsBugHunter });
  test('classOf: bug-hunter worker and orchestrator first, then the first prompt, then hand-off, child, interactive', () => {
    expect(col.classOf({ facts: facts(), wt: { name: 'BH worker #1234' } })).toBe('bh-worker');
    expect(col.classOf({ facts: facts(), wt: { name: 'lead' }, isOrchestrator: true })).toBe('bh-orchestrator');
    expect(col.classOf({ facts: facts('slash', true), wt: null })).toBe('bh-orchestrator');
    expect(col.classOf({ facts: facts('pr-review'), wt: { parentId: 'p' } })).toBe('pr-review');
    expect(col.classOf({ facts: facts(), wt: { replaces: ['a'], parentId: 'p' } })).toBe('handoff');
    expect(col.classOf({ facts: facts(), wt: { parentId: 'p' } })).toBe('child');
    expect(col.classOf({ facts: facts(), wt: null })).toBe('interactive');
    expect(col.bhOf('bh-worker', { name: 'BH worker #77 retry' })).toEqual({ item: 77, role: 'worker' });
    expect(col.bhOf('child', {})).toBeNull();
  });
  test('an orchestrator is the session that started bug-hunter workers, by id or by name', () => {
    const keys = col.orchestratorKeys([{ name: 'BH worker #1', parentId: 'AAA', spawnedBy: 'Lead One' }, { name: 'other', parentId: 'zzz' }]);
    expect(keys.has('aaa')).toBe(true);
    expect(keys.has('lead one')).toBe(true);
    expect(keys.has('zzz')).toBe(false);
    const summary = { start: 's', end: 'e', cwd: 'c', project: 'p', tok: {}, units: 1, models: {}, sub: {}, prompts: {}, wakes: {}, time: {}, compactions: 0, peakCtx: 0, byDay: {}, facts: facts() };
    const rec = col.buildSessionRecord({ origin: 'Home', sid: 's1', summary, entry: { wtId: 'AAA', name: 'x' }, orchestrators: keys });
    expect(rec.cls).toBe('bh-orchestrator');
    expect(rec.key).toBe('Home|s1');
    expect(rec.bh).toEqual({ item: null, role: 'orchestrator' });
    expect(rec.facts).toBeUndefined();
  });
  test('shouldScan: new reads; unchanged never; growing at most every 2 h; quiet for an hour reads the final one', () => {
    const now = 10 * 3600e3 * 10;
    const known = { sig: 'a', at: now - 30 * 60e3 };
    expect(col.shouldScan({ known: undefined, sig: 'a', mtimeMs: now, now })).toBe(true);
    expect(col.shouldScan({ known, sig: 'a', mtimeMs: now, now })).toBe(false);
    expect(col.shouldScan({ known, sig: 'a', mtimeMs: now - 5 * 3600e3, now })).toBe(false);          // quiet and unchanged: the final version is already written
    expect(col.shouldScan({ known, sig: 'b', mtimeMs: now - 60e3, now })).toBe(false);                 // growing, emitted 30 min ago
    expect(col.shouldScan({ known: { ...known, at: now - 121 * 60e3 }, sig: 'b', mtimeMs: now - 60e3, now })).toBe(true);
    expect(col.shouldScan({ known, sig: 'b', mtimeMs: now - 61 * 60e3, now })).toBe(true);             // quiet for an hour
  });
});

test.describe('work or private', () => {
  const inv = (origin, projects) => ({ type: 'inventory', origin, projects });
  test('a project is work when the work-source machine has it; a classify record overrides; auto withdraws', () => {
    const recs = [inv('Office', ['alpha-app', 'beta-tool']), inv('Home', ['hobby'])];
    const s = createScoper({ records: recs, workSource: 'office' });
    expect(s.scopeOf('alpha-app')).toBe('work');
    expect(s.scopeOf('ALPHA-APP')).toBe('work');
    expect(s.scopeOf('hobby')).toBe('private');
    expect(s.scopeOf('(none)')).toBe('private');
    const s2 = createScoper({ records: [...recs, { type: 'classify', project: 'hobby', as: 'work' }, { type: 'classify', project: 'beta-tool', as: 'private' }], workSource: 'Office' });
    expect(s2.scopeOf('hobby')).toBe('work');
    expect(s2.scopeOf('beta-tool')).toBe('private');
    const s3 = createScoper({ records: [...recs, { type: 'classify', project: 'beta-tool', as: 'auto' }], workSource: 'Office' });
    expect(s3.scopeOf('beta-tool')).toBe('work');
    // no work-source machine named: nothing is work until someone says so
    const s4 = createScoper({ records: [...recs, { type: 'classify', project: 'hobby', as: 'work' }] });
    expect([s4.scopeOf('alpha-app'), s4.scopeOf('hobby'), s4.hasInventory]).toEqual(['private', 'work', false]);
    expect(classifyDraft('Hobby', 'work')).toEqual({ type: 'classify', key: 'classify|hobby', project: 'hobby', as: 'work' });
    expect(classifyDraft('x', 'maybe').error).toMatch(/as must be/);
    expect(classifyDraft('', 'work').error).toMatch(/project/);
  });
});

test.describe('bug-hunter items', () => {
  let root;
  test.beforeEach(() => { root = mk('wt-bh-'); });
  test.afterEach(() => rmTmp(root));
  const ev = (min, o) => JSON.stringify({ at: at(min), item: 501, ...o });

  test('state.json and events.jsonl become one item with phases, gates, reviews, escalation and complexity; a run without events still counts', () => {
    const dir = path.join(root, 'run-a', '.claude', 'bug-hunter');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ processed: {
      501: { outcome: 'paused-for-opus', startedAt: at(0), finishedAt: at(90), attempt: 2, band: 'hard', reason: 'reproducer cannot escape the unit', summary: 'long free text that must not be kept' },
      502: { outcome: 'fixed-pushed', startedAt: at(5), finishedAt: at(65), band: 'easy', commitSha: 'abc' },
      'not-a-number': { outcome: 'x' },
    } }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      ev(0, { kind: 'phase', phase: 'reproduce' }), ev(20, { kind: 'phase', phase: 'fix' }), ev(60, { kind: 'phase', phase: 'review' }),
      ev(30, { kind: 'gate', phase: 'fix', criterion: 'build', status: 'FAIL', detail: 'x' }), ev(40, { kind: 'gate', phase: 'fix', criterion: 'build', status: 'PASS' }),
      ev(41, { kind: 'gate', phase: 'fix', criterion: 'tests', status: 'SKIP' }),
      ev(70, { kind: 'review', by: 'reviewer', verdict: 'REJECT', attempt: 1 }), ev(80, { kind: 'review', by: 'pre-pr', verdict: 'READY', attempt: 2 }),
      ev(1, { kind: 'worker', wtId: 'wt-1', name: 'BH worker #501', attempt: 1, model: 'opus' }), ev(2, { kind: 'worker', wtId: 'wt-2', name: 'BH worker #501', attempt: 2, model: 'sonnet' }),
      ev(89, { kind: 'outcome', outcome: 'paused-for-opus', reason: 'reproducer cannot escape the unit' }),
      ev(88, { kind: 'complexity', files: 4, linesAdded: 30, linesDeleted: 5, layers: ['server', 'tests'], gui: false, hw: true, db: false }),
      '{ torn line', JSON.stringify({ at: 'nope', item: 501, kind: 'gate' }),
    ].join('\n'));
    const items = bh.scanBhDirs(bh.discoverRunDirs([root]), { origin: 'Home' });
    expect(items.map((i) => i.item).sort()).toEqual([501, 502]);
    const a = items.find((i) => i.item === 501);
    expect(a.key).toBe(`Home|bh|run-a|501|${at(0)}`);
    expect(a.outcome).toBe('paused-for-opus');
    expect(a.attempts).toBe(2);
    expect(a.phases.map((p) => p.phase)).toEqual(['reproduce', 'fix', 'review']);
    expect(a.gates).toEqual({ pass: 1, fail: 1, byGate: { build: { pass: 1, fail: 1 } } });
    expect(a.reviews).toEqual({ 'reviewer:REJECT': 1, 'pre-pr:READY': 1 });
    expect(a.escalation).toEqual({ outcome: 'paused-for-opus', reason: 'reproducer cannot escape the unit' });
    expect(a.complexity).toEqual({ files: 4, linesAdded: 30, linesDeleted: 5, layers: ['server', 'tests'], gui: false, hw: true, db: false });
    expect(a.workers).toEqual(['wt-1', 'wt-2']);
    expect(a.band).toBe('hard');
    expect(JSON.stringify(a)).not.toContain('free text');
    const b = items.find((i) => i.item === 502);
    expect(b.hasEvents).toBe(false);
    expect(b.escalation).toBeNull();
    expect(b.phases).toEqual([]);
    expect(bh.discoverRunDirs([path.join(root, 'missing')])).toEqual([]);
  });

  test('Bug Hunter 1A and 2A keep their run in .claude/bug-hunter-1a: it is discovered like the main one, with its events', () => {
    const own = path.join(root, 'run-1a', '.claude', 'bug-hunter-1a');
    const main = path.join(root, 'run-main', '.claude', 'bug-hunter');
    const none = path.join(root, 'run-none', '.claude', 'bug-hunter-1a');   // a folder without a state.json is not a run
    for (const d of [own, main, none]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(own, 'state.json'), JSON.stringify({ processed: { 601: { outcome: 'fixed-pushed', startedAt: at(0), finishedAt: at(60) } } }));
    fs.writeFileSync(path.join(main, 'state.json'), JSON.stringify({ processed: { 602: { outcome: 'fixed-pushed', startedAt: at(0), finishedAt: at(60) } } }));
    fs.writeFileSync(path.join(own, 'events.jsonl'), [
      JSON.stringify({ at: at(1), item: 601, kind: 'worker', wtId: 'wt-1a', name: 'BH1A worker #601', attempt: 1, model: 'fable' }),
      JSON.stringify({ at: at(30), item: 601, kind: 'phase', phase: 'fix' }),
    ].join('\n'));
    const dirs = bh.discoverRunDirs([root]);
    expect(dirs.sort()).toEqual([main, own].sort());
    const items = bh.scanBhDirs(dirs, { origin: 'Home' });
    const a = items.find((i) => i.item === 601);
    expect(a.run).toBe('run-1a');
    expect(a.hasEvents).toBe(true);
    expect(a.workers).toEqual(['wt-1a']);
    expect(a.models).toEqual(['fable']);
    expect(a.phases.map((p) => p.phase)).toEqual(['fix']);
    expect(items.find((i) => i.item === 602).run).toBe('run-main');
  });
});

test.describe('the report', () => {
  const now = Date.parse('2026-03-12T12:00:00');
  const day = (n) => localDay(now - n * 864e5);
  const ses = (o) => ({ type: 'session', origin: 'Home', seq: 1, at: new Date(now).toISOString(), key: `${o.origin || 'Home'}|${o.sid}`, cls: 'interactive', project: 'alpha',
    tok: { in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 }, models: { 'opus-5-5': { calls: 10, units: o.units } }, sub: { n: 0, units: 0, byType: {} }, prompts: { human: 4, auto: 1 },
    wakes: { n: 0, units: 0, auto: { n: 0, units: 0 } }, time: { activeMs: 36e5, idleMs: 0, waitYouMs: 0, waits: 0, waitsMin: [] }, compactions: 0, peakCtx: 0, byDay: { [day(0)]: o.units }, ...o });
  const recs = [
    { type: 'inventory', origin: 'Office', seq: 1, at: new Date(now).toISOString(), key: 'Office|inventory', projects: ['alpha'] },
    ses({ sid: 'a', units: 10e6, wakes: { n: 2, units: 1e6, auto: { n: 1, units: 5e5 } }, time: { activeMs: 36e5, idleMs: 18e5, waitYouMs: 3 * 6e5, waits: 3, waitsMin: [10, 20, 30] }, compactions: 2, peakCtx: 300000 }),
    ses({ sid: 'b', origin: 'Office', cls: 'pr-review', project: 'beta', units: 4e6, models: { 'opus-5-5': { calls: 1, units: 1e6 }, 'sonnet-5-5': { calls: 3, units: 3e6 } } }),
    // straddles the window: 8e6 two days before the window starts, 2e6 inside - only the inside part counts
    ses({ sid: 'c', units: 10e6, byDay: { [day(20)]: 8e6, [day(1)]: 2e6 }, models: { 'sonnet-5-5': { calls: 10, units: 10e6 } } }),
    ses({ sid: 'old', units: 99e6, byDay: { [day(40)]: 99e6 } }),
  ];
  test('totals by machine, class, project, model; the window edge counts only what is inside', () => {
    const r = buildReport(recs, { now, days: 7, workSource: 'Office' });
    expect(r.window).toEqual({ days: 7, from: day(6), to: day(0) });
    expect(r.totals.unitsM).toBe(16);                 // 10 + 4 + 2; the old session is out
    expect(r.totals.sessions).toBe(3);
    expect(r.byMachine.map((m) => [m.machine, m.unitsM])).toEqual([['Home', 12], ['Office', 4]]);
    expect(r.byClass.find((c) => c.cls === 'pr-review').unitsM).toBe(4);
    expect(r.byProject.map((p) => [p.project, p.scope, p.unitsM])).toEqual([['alpha', 'work', 12], ['beta', 'private', 4]]);
    // opus: a's 10 + b's 1 + c is sonnet only
    expect(r.totals.opusUnitsM).toBe(11);
    expect(r.byModel[0].model).toBe('opus-5-5');
    expect(r.routine.unitsM).toBe(4);                  // pr-review is a routine class
    expect(r.routine.opusUnitsM).toBe(1);
    expect(r.routine.opusSharePct).toBe(25);
  });
  test('wake-ups, compactions, and the wait-on-you median and p90 over the individual waits', () => {
    const r = buildReport(recs, { now, days: 7, workSource: 'Office' });
    expect(r.wake.n).toBe(2);
    expect(r.wake.unitsM).toBe(1);
    expect(r.wake.autoN).toBe(1);
    expect(r.compactions).toEqual({ n: 2, sessions: 1, maxPeakCtxK: 300 });
    expect(r.time.waits).toBe(3);
    expect(r.time.waitYouMedianMin).toBe(20);
    expect(r.time.waitYouP90Min).toBe(30);
    expect(r.time.waitsMeasured).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
  });
  test('scope and machine filters', () => {
    const work = buildReport(recs, { now, days: 7, scope: 'work', workSource: 'Office' });
    expect(work.totals.unitsM).toBe(12);
    expect(work.byProject.map((p) => p.project)).toEqual(['alpha']);
    const priv = buildReport(recs, { now, days: 7, scope: 'private', workSource: 'Office' });
    expect(priv.totals.unitsM).toBe(4);
    const office = buildReport(recs, { now, days: 7, machine: 'office', workSource: 'Office' });
    expect(office.totals.unitsM).toBe(4);
    expect(windowDays(now, 1)).toEqual({ from: day(0), to: day(0) });
  });
  test('bug hunter: per item tokens from the worker sessions, first-pass yield, escalation rate and reasons, orchestrator as overhead', () => {
    const t = (min) => new Date(now - 3 * 864e5 + min * 60e3).toISOString();
    const item = (n, o) => ({ type: 'bh-item', origin: 'Home', seq: 1, at: t(0), key: `Home|bh|run|${n}|${t(0)}`, item: n, startedAt: t(0), finishedAt: t(60), phases: [], gates: { pass: 0, fail: 0, byGate: {} }, reviews: {}, workers: [], attempts: 1, ...o });
    const worker = (n, units, extra = {}) => ses({ sid: `w${n}`, cls: 'bh-worker', units, bh: { item: n, role: 'worker' }, start: t(2), byDay: { [localDay(now - 3 * 864e5)]: units }, ...extra });
    const r = buildReport([
      item(1, { outcome: 'fixed-pushed', phases: [{ phase: 'fix', at: t(0) }, { phase: 'review', at: t(40) }] }),
      item(2, { outcome: 'fixed', reviews: { 'reviewer:REJECT': 1 }, attempts: 2 }),
      item(3, { outcome: 'paused-for-opus', escalation: { outcome: 'paused-for-opus', reason: 'needs design' }, gates: { pass: 1, fail: 2, byGate: { build: { pass: 1, fail: 2 } } } }),
      worker(1, 6e6), worker(2, 2e6), worker(3, 4e6),
      ses({ sid: 'orch', cls: 'bh-orchestrator', units: 3e6, bh: { item: null, role: 'orchestrator' }, byDay: { [localDay(now - 3 * 864e5)]: 3e6 } }),
    ], { now, days: 7 });
    const b = r.bugHunter;
    expect(b.items).toBe(3);
    expect(b.fixed).toBe(2);
    expect(b.escalated).toBe(1);
    expect(b.firstPassYieldPct).toBe(50);            // item 1 fixed first time; item 2 was rejected and took 2 attempts
    expect(b.escalationRatePct).toBe(33.3);
    expect(b.topEscalationReasons).toEqual([{ what: 'needs design', n: 1 }]);
    expect(b.gatesFailedByGate).toEqual([{ what: 'build', n: 2 }]);
    expect(b.reviewsRejected).toBe(1);
    expect(b.orchestratorOverheadUnitsM).toBe(3);
    expect(b.avgWorkerUnitsM).toBe(4);
    expect(b.medianPhaseMin).toEqual({ fix: 40, review: 20 });
    expect(b.list.find((x) => x.item === 1).workerUnitsM).toBe(6);
    expect(b.list.find((x) => x.item === 1).durationMin).toBe(60);
  });
});

// --- the review's findings (#529) --------------------------------------------------------------
test.describe('what a record may hold', () => {
  const ev = (o) => ({ at: '2026-03-10T09:00:00Z', item: 7, ...o });
  test('a bug-hunter item that ran for days still fits the 64 KB record cap, and keeps no free prose from state.json', () => {
    const events = [
      ...Array.from({ length: 1500 }, (_, i) => ev({ kind: 'phase', phase: `phase-${i}`, at: new Date(Date.parse('2026-03-10T09:00:00Z') + i * 1000).toISOString() })),
      ...Array.from({ length: 300 }, (_, i) => ev({ kind: 'gate', criterion: `gate-${i}`, status: i % 2 ? 'PASS' : 'FAIL' })),
      ...Array.from({ length: 300 }, (_, i) => ev({ kind: 'worker', wtId: `wt-${i}`, model: `model-${i}` })),
      ...Array.from({ length: 300 }, (_, i) => ev({ kind: 'review', by: `r${i}`, verdict: 'ACCEPT' })),
    ];
    const it = bh.buildBhItem({ origin: 'Home', run: 'run', item: 7, st: { startedAt: '2026-03-10T08:59:00Z', finishedAt: '2026-03-12T09:00:00Z', outcome: 'fixed', review: 'a reviewer: free prose about the customer' }, events });
    expect(Buffer.byteLength(JSON.stringify({ ...it, origin: 'Home', seq: 1, at: 'x' }))).toBeLessThan(60 * 1024);
    expect(it.phases.length).toBeLessThanOrEqual(60);
    expect(it.workers.length).toBeLessThanOrEqual(20);
    expect(it.gates.pass + it.gates.fail).toBe(300);           // the totals stay exact; only the per-gate table is capped
    expect(Object.keys(it.gates.byGate).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(it)).not.toContain('free prose');
    expect(it.review).toBeUndefined();
  });
  test('an item run twice is two records, each with ONLY its own run\'s events (state.json keeps the latest, events.jsonl every run)', () => {
    const events = [
      ev({ at: '2026-03-10T09:00:00Z', kind: 'worker', wtId: 'w1', model: 'opus' }),
      ev({ at: '2026-03-10T09:30:00Z', kind: 'gate', criterion: 'build', status: 'FAIL' }),
      ev({ at: '2026-03-12T09:00:00Z', kind: 'worker', wtId: 'w2', model: 'opus' }),
      ev({ at: '2026-03-12T09:40:00Z', kind: 'gate', criterion: 'build', status: 'PASS' }),
    ];
    const second = bh.buildBhItem({ origin: 'Home', run: 'run', item: 7, st: { startedAt: '2026-03-12T08:58:00Z', finishedAt: '2026-03-12T10:00:00Z', outcome: 'fixed-pushed' }, events });
    expect(second.workers).toEqual(['w2']);
    expect(second.gates).toMatchObject({ pass: 1, fail: 0 });
    const first = bh.buildBhItem({ origin: 'Home', run: 'run', item: 7, st: { startedAt: '2026-03-10T08:58:00Z', finishedAt: '2026-03-10T10:00:00Z', outcome: 'paused-for-opus' }, events });
    expect(first.workers).toEqual(['w1']);
    expect(first.gates).toMatchObject({ pass: 0, fail: 1 });
    expect(first.key).not.toBe(second.key);
  });
  test('a session record carries no folder path', () => {
    const rec = col.buildSessionRecord({ origin: 'Home', sid: 's1', summary: { start: 'a', end: 'b', cwd: '/home/example/secret-project', project: 'secret-project', tok: {}, units: 1, models: {}, sub: {}, prompts: {}, wakes: {}, time: {}, compactions: 0, quality: {}, peakCtx: 0, byDay: {}, facts: { firstClass: 'interactive' } }, entry: null });
    expect(JSON.stringify(rec)).not.toContain('/home/example');
    expect(rec.cwd).toBeUndefined();
    expect(rec.project).toBe('secret-project');
  });
});

test.describe('a renamed machine', () => {
  test('a session re-recorded under the machine\'s new name counts once: the newest record of a Claude session wins', () => {
    const now = Date.parse('2026-03-12T12:00:00');
    const d0 = localDay(now);
    const row = (origin, units, atIso) => ({ type: 'session', origin, seq: 1, at: atIso, key: `${origin}|s1`, sid: 's1', cls: 'interactive', project: 'p', tok: {}, models: {}, sub: {}, prompts: { human: 1, auto: 0 }, wakes: {}, time: {}, compactions: 0, peakCtx: 0, byDay: { [d0]: units }, units });
    const r = buildReport([row('Home', 10e6, '2026-03-12T10:00:00.000Z'), row('home-pc', 15e6, '2026-03-12T11:00:00.000Z')], { now, days: 7 });
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.unitsM).toBe(15);
  });
  test('the work-source machine is matched the way an origin is made from a name (a space becomes a dash)', () => {
    const scoper = createScoper({ records: [{ type: 'inventory', origin: 'My-Machine', projects: ['alpha'] }], workSource: 'My Machine' });
    expect(scoper.scopeOf('alpha')).toBe('work');
  });
});
