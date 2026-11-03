// @ts-check
// #413 - work-item resume. The rules are pure (lib/work-items.js); the two small I/O
// modules (lib/work-item-log.js, lib/work-item-hook.js) are driven for real here against a
// scratch directory and a real child process. Each negative breaks ONE thing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const W = require('../lib/work-items');
const wlog = require('../lib/work-item-log');
const whook = require('../lib/work-item-hook');

const SINK = path.join(__dirname, 'fixtures', 'work-item-hook-sink.js');
const T = 1_700_000_000_000;

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wt413-')); }

test.describe('#413 work items - refs', () => {
  test('a route ref is canonical or refused', () => {
    expect(W.parseRefParam('ado:25309')).toBe('ado:25309');
    expect(W.parseRefParam('AB#25309')).toBe('ado:25309');
    expect(W.parseRefParam('#413')).toBe('#413');
    expect(W.parseRefParam('Adiel-Sharabi/web-terminal#413')).toBe('adiel-sharabi/web-terminal#413');
    for (const bad of ['', 'ado:', 'ado:12a', '../etc/passwd', 'ado:1/../../x', '#1;rm', 'x'.repeat(300), null, 42]) {
      expect(W.parseRefParam(/** @type {any} */ (bad))).toBeNull();
    }
  });

  test('a bare #N query matches that number in any repo; ado and qualified refs match exactly', () => {
    expect(W.keyMatches('#413', '#413')).toBe(true);
    expect(W.keyMatches('o/r#413', '#413')).toBe(true);
    expect(W.keyMatches('o/r#4130', '#413')).toBe(false);
    expect(W.keyMatches('o/r#413', 'o/r#413')).toBe(true);
    expect(W.keyMatches('o/x#413', 'o/r#413')).toBe(false);
    expect(W.keyMatches('ado:5', 'ado:5')).toBe(true);
    expect(W.keyMatches('ado:55', 'ado:5')).toBe(false);
  });
});

test.describe('#413 work items - the configured command', () => {
  test('absent is OFF with no error; a well-formed one is on with defaults', () => {
    expect(W.hookConfig(undefined)).toEqual({ enabled: false, error: null });
    expect(W.hookConfig(null)).toEqual({ enabled: false, error: null });
    expect(W.hookConfig({ command: 'node' })).toEqual({ enabled: true, command: 'node', args: [], timeoutMs: W.HOOK_TIMEOUT_DEFAULT_MS, error: null });
    expect(W.hookConfig({ command: 'C:/x/node.exe', args: ['a b', 'c'], timeoutMs: 5000 }))
      .toMatchObject({ enabled: true, args: ['a b', 'c'], timeoutMs: 5000 });
  });

  test('anything malformed is OFF and says why - never a guess', () => {
    const bad = [
      'node', [], { command: '' }, { command: 5 }, { command: 'a\nb' }, { command: 'a\u0000b' },
      { command: 'node', args: 'x' }, { command: 'node', args: [1] }, { command: 'node', args: ['a\u0000'] },
      { command: 'node', args: new Array(W.HOOK_MAX_ARGS + 1).fill('a') },
      { command: 'node', timeoutMs: 10 }, { command: 'node', timeoutMs: 'x' }, { command: 'node', timeoutMs: 10 * 60 * 1000 },
      { command: 'C:/tools/wi-flow.cmd' }, { command: 'wi-flow.BAT' },
    ];
    for (const b of bad) {
      const c = W.hookConfig(b);
      expect(c.enabled, JSON.stringify(b)).toBe(false);
      expect(typeof c.error, JSON.stringify(b)).toBe('string');
    }
  });
});

test.describe('#413 work items - how a session ended', () => {
  test('one answer per path, each decided by ONE input', () => {
    expect(W.endEvent({})).toBe('exited');                              // the process ended by itself (crash, /exit)
    expect(W.endEvent({ killedHow: 'closed' })).toBe('closed');         // DELETE /api/sessions/:id
    expect(W.endEvent({ killedHow: 'reaped' })).toBe('reaped');         // #351 sweep
    expect(W.endEvent({ handoffState: 'closing' })).toBe('handed-off'); // #340 close after a clean hand-off
    expect(W.endEvent({ handoffState: 'wrapping' })).toBe('exited');    // a run in flight is not a hand-off close
    expect(W.endEvent({ lost: true })).toBe('lost');                    // ended while server.js was down
    expect(W.endEvent({ lost: true, killedHow: 'closed' })).toBe('lost');
    expect(W.endEvent({ killedHow: 'bogus' })).toBe('exited');
  });

  test('a hand-off the server started on its own is the context-budget one (#393)', () => {
    expect(W.handoffEvent({ trigger: 'auto' })).toBe('context-budget');
    expect(W.handoffEvent({ trigger: 'manual' })).toBe('handoff');
    expect(W.handoffEvent({ trigger: 'forced' })).toBe('handoff');
    expect(W.handoffEvent(null)).toBe('handoff');
  });
});

test.describe('#413 work items - payload and event lines', () => {
  const item = { ref: 'ado:25309', key: 'ado:25309', title: 'work-item resume', state: 'in-progress', note: 'n', source: 'agent', url: null };
  const brief = { items: [item], headline: 'h', did: { text: 'did it', at: T }, reportAt: T };
  const report = { items: [{ ref: 'ado:25309', title: 'work-item resume', state: 'in-progress', note: 'n' }], headline: 'h', at: T, wait: null };

  test('the payload carries the item, the session, the machine, the reason, the last report and the brief', () => {
    const p = W.cardPayload({ reason: 'closed', item, sessionId: 's1', sessionName: 'n1', machine: 'adiel-xps', report, brief, at: T, extra: { cwd: 'C:/dev/x' } });
    expect(p).toEqual({
      v: 1, reason: 'closed', at: new Date(T).toISOString(),
      item: { ref: 'ado:25309', key: 'ado:25309', title: 'work-item resume', state: 'in-progress', note: 'n', url: null },
      sessionId: 's1', sessionName: 'n1', machine: 'adiel-xps', report, brief, cwd: 'C:/dev/x',
    });
  });

  test('an event line is a snapshot keyed by the item', () => {
    const e = W.eventRecord({ event: 'handoff', item, sessionId: 's1', sessionName: 'n1', machine: 'm', brief, at: T, extra: { handoffBriefFile: 'C:/h/handoff-s1.md' } });
    expect(e).toEqual({
      v: 1, at: new Date(T).toISOString(), key: 'ado:25309', ref: 'ado:25309', event: 'handoff',
      sessionId: 's1', sessionName: 'n1', machine: 'm',
      title: 'work-item resume', state: 'in-progress', note: 'n', headline: 'h', did: 'did it',
      handoffBriefFile: 'C:/h/handoff-s1.md',
    });
  });

  test('a report is an event only for an item that is NEW to the session or changed state', () => {
    const a = { ref: '#1', state: 'planning' };
    const b = { ref: '#2', state: 'in-progress' };
    expect(W.reportedChanges(null, [a, b]).map((i) => i.ref)).toEqual(['#1', '#2']);
    expect(W.reportedChanges([a, b], [a, b])).toEqual([]);
    expect(W.reportedChanges([a, b], [{ ...a, state: 'done' }, b]).map((i) => i.ref)).toEqual(['#1']);
    expect(W.reportedChanges([a], [{ ref: 'gh#1', state: 'planning' }])).toEqual([]); // the same item, spelled differently
    expect(W.reportedChanges([a, b], [a])).toEqual([]); // dropping one is not a touch
  });
});

test.describe('#413 work items - the view a resume starts from', () => {
  const line = (at, event, extra = {}) => ({ v: 1, at: new Date(at).toISOString(), key: 'ado:7', ref: 'ado:7', event, sessionId: 's', machine: 'm', ...extra });

  test('events newest-last for that item only; `last` is the newest END or HAND-OFF snapshot', () => {
    const lines = [
      line(T, 'reported', { state: 'planning' }),
      { ...line(T + 1, 'reported'), key: 'ado:8', ref: 'ado:8' },
      line(T + 2, 'handoff', { state: 'in-progress', handoffBriefFile: 'x' }),
      line(T + 3, 'reported', { state: 'in-progress', sessionId: 's2' }),
      line(T + 4, 'closed', { state: 'committed', sessionId: 's2', headline: 'pushed' }),
    ];
    const v = W.workItemView(lines, 'ado:7');
    expect(v.key).toBe('ado:7');
    expect(v.events.map((e) => e.event)).toEqual(['reported', 'handoff', 'reported', 'closed']);
    expect(v.last).toMatchObject({ event: 'closed', state: 'committed', headline: 'pushed', sessionId: 's2' });
    expect(v.sessions).toEqual(['s', 's2']);
  });

  test('the event list is capped at the newest, and nothing at all is not an error', () => {
    const lines = Array.from({ length: W.VIEW_MAX_EVENTS + 5 }, (_, i) => line(T + i, 'reported'));
    const v = W.workItemView(lines, 'ado:7');
    expect(v.events.length).toBe(W.VIEW_MAX_EVENTS);
    expect(v.events[v.events.length - 1].at).toBe(new Date(T + W.VIEW_MAX_EVENTS + 4).toISOString());
    expect(W.workItemView([], 'ado:7')).toEqual({ key: 'ado:7', events: [], last: null, sessions: [] });
  });

  test('views from several machines merge in time order, the newest snapshot wins', () => {
    const a = W.workItemView([line(T, 'reported', { machine: 'home' }), line(T + 10, 'closed', { machine: 'home' })], 'ado:7');
    const b = W.workItemView([line(T + 5, 'handoff', { machine: 'xps', sessionId: 'x' })], 'ado:7');
    const m = W.mergeViews('ado:7', [a, b]);
    expect(m.events.map((e) => `${e.machine}:${e.event}`)).toEqual(['home:reported', 'xps:handoff', 'home:closed']);
    expect(m.last).toMatchObject({ machine: 'home', event: 'closed' });
  });

  test("a peer's answer is validated before it is merged: wrong-key, malformed and oversized parts are dropped", () => {
    const good = line(T, 'closed');
    const v = W.peerView({ events: [good, { ...good, key: 'ado:8' }, 'x', null, { ...good, at: 'never' }, { ...good, event: 5 }],
      handoffBrief: { file: 'C:/h/handoff-1.md', text: 'brief' } }, 'ado:7');
    expect(v.events).toEqual([good]);
    expect(v.last).toEqual(good);
    expect(v.handoffBrief).toEqual({ file: 'C:/h/handoff-1.md', text: 'brief' });
    // Only known fields survive, each clipped.
    const odd = W.peerView({ events: [{ ...good, evil: '<x>', headline: 'h'.repeat(5000), handedOffTo: { id: 's2', name: 'n', x: 1 } }] }, 'ado:7').events[0];
    expect(odd.evil).toBeUndefined();
    expect(odd.headline.length).toBeLessThanOrEqual(160);
    expect(odd.handedOffTo).toEqual({ id: 's2', name: 'n' });
    expect(W.peerView({ events: [good], handoffBrief: { file: 'x', text: 'y'.repeat(W.HANDOFF_BRIEF_MAX + 1) } }, 'ado:7').handoffBrief).toBeNull();
    expect(W.peerView({ events: [good], handoffBrief: { file: 5, text: 'y' } }, 'ado:7').handoffBrief).toBeNull();
    for (const bad of [null, 'x', {}, { events: 'x' }]) expect(W.peerView(bad, 'ado:7')).toBeNull();
  });

  test('the resume text names the last state and every touch, and says so when nothing is known', () => {
    const v = W.workItemView([line(T, 'reported', { state: 'planning' }), line(T + 1, 'closed', { state: 'committed', headline: 'pushed', did: 'did x' })], 'ado:7');
    const txt = W.resumeText(v);
    expect(txt).toContain('ado:7');
    expect(txt).toContain('committed');
    expect(txt).toContain('pushed');
    expect(txt).toContain('closed');
    expect(W.resumeText(W.workItemView([], 'ado:7'))).toMatch(/no session on this cluster has recorded ado:7/i);
  });
});

test.describe('#413 machine capabilities', () => {
  test('absent is none; a clean list is returned as is', () => {
    expect(W.machineCapabilities(undefined)).toEqual({ capabilities: [], error: null });
    expect(W.machineCapabilities(['builds', 'flutter', 'adb', 'host:ci-vm-1', 'avoid.heavy-builds']))
      .toEqual({ capabilities: ['builds', 'flutter', 'adb', 'host:ci-vm-1', 'avoid.heavy-builds'], error: null });
  });

  test('a malformed list is refused WHOLE (null) with the reason, never trimmed', () => {
    const bad = ['builds', {}, [''], ['Builds'], ['a b'], ['<script>'], ['x'.repeat(49)], ['ok', 'ok'],
      new Array(W.CAPABILITIES_MAX + 1).fill(0).map((_, i) => `c${i}`), ['-lead']];
    for (const b of bad) {
      const r = W.machineCapabilities(b);
      expect(r.capabilities, JSON.stringify(b)).toBeNull();
      expect(typeof r.error, JSON.stringify(b)).toBe('string');
    }
  });
});

test.describe('#413 the event log file', () => {
  test('append, read back, rotate to ONE older generation, skip a torn line', () => {
    const dir = scratch();
    const file = path.join(dir, 'work-items.jsonl');
    wlog.appendLines(file, [{ a: 1 }, { a: 2 }], { maxBytes: 64 });
    expect(wlog.readLines(file)).toEqual([{ a: 1 }, { a: 2 }]);
    // Past the cap: the current file becomes .1, the new line starts a fresh file.
    wlog.appendLines(file, [{ a: 3, pad: 'x'.repeat(40) }], { maxBytes: 64 });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(wlog.readLines(file).map((l) => l.a)).toEqual([1, 2, 3]);
    // A second rotation drops the oldest generation.
    wlog.appendLines(file, [{ a: 4, pad: 'x'.repeat(40) }], { maxBytes: 64 });
    expect(wlog.readLines(file).map((l) => l.a)).toEqual([3, 4]);
    fs.appendFileSync(file, '{"torn":');
    expect(wlog.readLines(file).map((l) => l.a)).toEqual([3, 4]);
    expect(wlog.readLines(path.join(dir, 'absent.jsonl'))).toEqual([]);
  });
});

test.describe('#413 running the configured command', () => {
  test('the payload arrives on stdin as JSON; argv is passed untouched', async () => {
    const dir = scratch();
    const cfg = W.hookConfig({ command: process.execPath, args: [SINK, dir] });
    const r = await whook.runHook(cfg, { v: 1, reason: 'closed', note: "it's \"quoted\" & $HOME" });
    expect(r).toEqual({ ok: true, code: 0 });
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))).toEqual({ v: 1, reason: 'closed', note: "it's \"quoted\" & $HOME" });
  });

  test('a failure, a timeout and a missing program each RESOLVE with the reason, never throw', async () => {
    const dir = scratch();
    const fail = await whook.runHook(W.hookConfig({ command: process.execPath, args: [SINK, dir, 'fail'] }), { v: 1 });
    expect(fail).toMatchObject({ ok: false, code: 3 });
    const t0 = Date.now();
    const slow = await whook.runHook(W.hookConfig({ command: process.execPath, args: [SINK, dir, 'slow'], timeoutMs: 1000 }), { v: 1 });
    expect(slow.ok).toBe(false);
    expect(slow.error).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(15000);
    const missing = await whook.runHook(W.hookConfig({ command: path.join(dir, 'no-such-program.exe') }), { v: 1 });
    expect(missing.ok).toBe(false);
    expect(typeof missing.error).toBe('string');
    expect(await whook.runHook(W.hookConfig(undefined), { v: 1 })).toEqual({ ok: false, skipped: 'off' });
  });

  test('the queue runs one at a time, in order, and refuses past its cap with a log line', async () => {
    const dir = scratch();
    const cfg = W.hookConfig({ command: process.execPath, args: [SINK, dir] });
    const logged = [];
    const q = whook.createQueue({ max: 2, log: (m) => logged.push(m) });
    const all = [q.enqueue(cfg, { n: 1 }), q.enqueue(cfg, { n: 2 }), q.enqueue(cfg, { n: 3 })];
    const res = await Promise.all(all);
    expect(res[2]).toEqual({ ok: false, skipped: 'queue-full' });
    expect(logged.some((m) => /queue full/.test(m))).toBe(true);
    const got = fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).n);
    expect(got).toEqual([1, 2]);
  });
});
