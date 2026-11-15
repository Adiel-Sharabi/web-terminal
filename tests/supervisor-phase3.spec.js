// @ts-check
// #468 - supervisor phase 3, the pure rules: R9's evidence from the transcript
// (lib/circling.js), the cases L1 opens for the dispatcher (R2, R3, R6, R9), when a case
// stops standing, the verb gate (act / card, the owner's reserved actions), the owner queue
// of escalations and cards, and the morning summary. Each negative mutates ONE gate of its
// positive, so a pass names the gate that held.
const { test, expect } = require('@playwright/test');
const circ = require('../lib/circling');
const cases = require('../lib/supervisor-cases');
const sup = require('../lib/supervisor');
const { TEXT_BYTES_MAX } = sup;

const T0 = Date.parse('2026-11-16T10:00:00Z');
const MIN = 60 * 1000;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// --- lib/circling.js -------------------------------------------------------------------
// Shapes as Claude Code writes them: an assistant line with a tool_use, then a user line
// (with the turn's promptId) carrying the tool_result with is_error.
const use = (tid, name) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input: {} }] } });
const fail = (tid, text, at, prompt, extra = {}) => JSON.stringify({ type: 'user', isSidechain: false, promptId: prompt, timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: true, content: text }] }, ...extra });

test.describe('#468 R9 evidence: the same failure across turns (lib/circling.js)', () => {
  const run = (n, prompts, text = (i) => `Exit code 1\n  ${i + 3} failed, 40 passed\nError: expected 200, got 500`, extra = {}) => {
    const lines = [];
    for (let i = 0; i < n; i++) { lines.push(use(`t${i}`, 'Bash')); lines.push(fail(`t${i}`, text(i), T0 + i * MIN, prompts[i % prompts.length], extra)); }
    return lines.join('\n');
  };

  test('four sightings of one failure over two prompts are published, numbers blanked', () => {
    const s = circ.createCirclingScanner();
    s.feed(run(4, ['p1', 'p2']));
    const f = s.field(T0 + 10 * MIN);
    expect(f).toMatchObject({ tool: 'Bash', count: 4, turns: 2 });
    expect(f.sample).toBe('Error: expected 200, got 500');
  });

  test('negatives: under PUBLISH_MIN, outside the window, a subagent line, a different failure each time', () => {
    const a = circ.createCirclingScanner(); a.feed(run(circ.PUBLISH_MIN - 1, ['p1', 'p2']));
    expect(a.field(T0 + 10 * MIN)).toBeNull();
    const b = circ.createCirclingScanner(); b.feed(run(4, ['p1', 'p2']));
    expect(b.field(T0 + circ.WINDOW_MS + 10 * MIN)).toBeNull();
    const c = circ.createCirclingScanner(); c.feed(run(4, ['p1', 'p2'], undefined, { isSidechain: true }));
    expect(c.field(T0 + 10 * MIN)).toBeNull();
    const d = circ.createCirclingScanner(); d.feed(run(4, ['p1', 'p2'], (i) => `Error: ${['alpha', 'beta', 'gamma', 'delta'][i]} broke`));
    expect(d.field(T0 + 10 * MIN)).toBeNull();
  });

  test('a result with no is_error, and the api-request-blob copy, are not failures', () => {
    const ok = JSON.stringify({ type: 'user', promptId: 'p', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Error: x' }] } });
    const blob = fail('t', 'Error: x', T0, 'p').replace('"type":"user"', '"type":"api-request-blob"');
    const s = circ.createCirclingScanner();
    s.feed([use('t', 'Bash'), ok, ok, ok, blob, blob, blob, blob].join('\n'));
    expect(s.field(T0 + MIN)).toBeNull();
  });

  test('failureLine skips "Exit code N" and prefers the line that names the failure', () => {
    expect(circ.failureLine('Exit code 2\nsome output\nTypeError: r.json is not iterable')).toBe('TypeError: r.json is not iterable');
    expect(circ.failureLine('Exit code 1')).toBeNull();
    expect(circ.fingerprint('Bash', 'at 12:30 run 0xdeadbeef 3 failed')).toBe(circ.fingerprint('Bash', 'at 09:15 run 0xcafef00d 7 failed'));
  });
});

// --- lib/supervisor-cases.js: which cases L1 opens -----------------------------------
const cfg = cases.dispatcherConfig(null);
const node = (over) => ({ id: id(1), server: 'alpha', name: 'worker', status: 'idle', wait: null, checkIn: null, compacting: false, waitingFor: null,
  liveAgents: 0, circling: null, nowAt: null, turnAt: null, reportAt: null, now: null, ...over });
const graphOf = (...nodes) => ({ at: T0, complete: true, nodes, aliases: {} });
const cand = (n, extra = {}) => cases.caseCandidates({ graph: graphOf(n), verdicts: extra.verdicts || {}, resolutions: extra.resolutions || {}, now: extra.now || T0, cfg, skip: extra.skip });

test.describe('#468 the cases L1 opens (caseCandidates)', () => {
  const lead = id(9);
  const orphanWait = { on: 'external', what: 'the lead', at: T0 - 30 * MIN };
  const orphan = { [id(1)]: { state: 'orphan', parentId: lead } };

  test('R2: an orphan waiting on its lead (untargeted external, or a lead target)', () => {
    expect(cand(node({ wait: orphanWait }), { verdicts: orphan }).map((c) => c.rule)).toEqual(['R2']);
    expect(cand(node({ wait: { ...orphanWait, on: 'self', target: { kind: 'lead' } } }), { verdicts: orphan }).map((c) => c.rule)).toEqual(['R2']);
    // one gate at a time: not an orphan yet, a self wait with no target, a wait on the owner
    expect(cand(node({ wait: orphanWait }), { verdicts: { [id(1)]: { state: 'suspect', parentId: lead } } })).toEqual([]);
    expect(cand(node({ wait: { ...orphanWait, on: 'self' } }), { verdicts: orphan })).toEqual([]);
    expect(cand(node({ wait: { ...orphanWait, on: 'you' } }), { verdicts: orphan })).toEqual([]);
  });

  test('R3a: the same check-in answer twice in one idle period (n >= 2), untargeted, still standing', () => {
    const w = { on: 'self', what: 'the build', at: T0 - 10 * MIN };
    const ci = { n: 2, deliveredAt: T0 - 11 * MIN, endedAt: T0 - 10 * MIN, answer: { on: 'self', what: 'the build' } };
    expect(cand(node({ wait: w, checkIn: ci })).map((c) => c.rule)).toEqual(['R3']);
    expect(cand(node({ wait: w, checkIn: { ...ci, n: 1 } }))).toEqual([]);                       // first ask
    expect(cand(node({ wait: w, checkIn: { ...ci, endedAt: null } }))).toEqual([]);              // still answering
    expect(cand(node({ wait: w, checkIn: { ...ci, answer: { on: 'done', what: '' } } }))).toEqual([]); // answered otherwise
    expect(cand(node({ wait: { ...w, at: ci.deliveredAt - MIN }, checkIn: ci }))).toEqual([]);  // the wait predates the ask
    expect(cand(node({ wait: { ...w, target: { kind: 'time', until: new Date(T0 + MIN).toISOString() } }, checkIn: ci }))).toEqual([]); // targeted: R1's
  });

  test('R3b: a wait past its own checkBy, unless its target resolved', () => {
    const w = { on: 'external', what: 'CI', at: T0 - 31 * MIN, checkBy: 30 };
    expect(cand(node({ wait: w })).map((c) => c.rule)).toEqual(['R3']);
    expect(cand(node({ wait: { ...w, checkBy: 40 } }))).toEqual([]);
    expect(cand(node({ wait: { ...w, target: { kind: 'pr' } } }), { resolutions: { [id(1)]: { state: 'resolved' } } })).toEqual([]);
    expect(cand(node({ wait: { ...w, target: { kind: 'pr' } } }), { resolutions: { [id(1)]: { state: 'pending' } } }).map((c) => c.rule)).toEqual(['R3']);
  });

  test('R6: working with no hook for hungMin and nothing live under it', () => {
    const hung = { status: 'working', turnAt: T0 - 60 * MIN, nowAt: T0 - 50 * MIN, now: 'Bash: npm test' };
    const [c] = cand(node(hung));
    expect(c.rule).toBe('R6');
    expect(c.line).toContain('50 min');
    expect(cand(node({ ...hung, nowAt: T0 - 5 * MIN }))).toEqual([]);   // a hook 5 min ago
    expect(cand(node({ ...hung, status: 'idle' }))).toEqual([]);
    expect(cand(node({ ...hung, compacting: true }))).toEqual([]);
    expect(cand(node({ ...hung, waitingFor: 'permission' }))).toEqual([]);
    expect(cand(node({ ...hung, liveAgents: 1 }))).toEqual([]);
  });

  test('R9: one failure circleMin times over 2+ turns, seen in the last hour', () => {
    const c9 = { tool: 'Bash', sample: 'error: expected 200, got 500', count: 4, turns: 2, lastAt: T0 - 5 * MIN };
    expect(cand(node({ circling: c9, wait: { on: 'self', what: 'x', at: T0 - MIN } })).map((c) => c.rule)).toEqual(['R9']);
    expect(cand(node({ circling: { ...c9, count: 3 } }))).toEqual([]);
    expect(cand(node({ circling: { ...c9, turns: 1 } }))).toEqual([]);
    expect(cand(node({ circling: { ...c9, lastAt: T0 - 61 * MIN } }))).toEqual([]);
    expect(cand(node({ circling: c9, wait: { on: 'done', what: '', at: T0 } }))).toEqual([]);
  });

  test('the dispatcher itself (skip) never gets a case', () => {
    const hung = { status: 'working', turnAt: T0 - 60 * MIN, nowAt: T0 - 50 * MIN };
    expect(cand(node(hung), { skip: new Set([id(1)]) })).toEqual([]);
  });

  test('caseHolds: the trigger moving on retires the case; an incomplete scan decides nothing', () => {
    const c = { rule: 'R3', waitAt: 100 };
    expect(cases.caseHolds(c, node({ wait: { at: 100 } }), graphOf())).toBe(true);
    expect(cases.caseHolds(c, node({ wait: { at: 200 } }), graphOf())).toBe(false);
    expect(cases.caseHolds(c, null, graphOf())).toBe(false);
    expect(cases.caseHolds(c, null, { ...graphOf(), complete: false })).toBe(true);
    expect(cases.caseHolds({ rule: 'R6', turnAt: 5 }, node({ status: 'idle', turnAt: 5 }), graphOf())).toBe(false);
    expect(cases.caseHolds({ rule: 'R9', sample: 'a' }, node({ circling: { sample: 'a' } }), graphOf())).toBe(true);
  });
});

// --- the verb gate -----------------------------------------------------------------------
test.describe('#468 a verb acts or becomes a card (verbDecision)', () => {
  test('every class acts by default; recommend mode makes a card', () => {
    expect(cases.verbDecision({ verb: 'coach', text: 'step back', cfg })).toMatchObject({ mode: 'act', cls: 'coach', text: 'Coaching: step back' });
    const rec = cases.dispatcherConfig({ autonomy: { wake: 'recommend' } });
    expect(cases.verbDecision({ verb: 'wake', text: 'CI is green', cfg: rec })).toMatchObject({ mode: 'card', cls: 'wake' });
    expect(cases.verbDecision({ verb: 'coach', text: 'step back', cfg: rec }).mode).toBe('act');
  });

  test('an answer for the owner must say how to undo it', () => {
    expect(cases.verbDecision({ verb: 'answer', text: 'fix it in the server', cfg }).error).toMatch(/undo/);
    const d = cases.verbDecision({ verb: 'answer', text: 'fix it in the server', undo: 'revert the commit', cfg });
    expect(d).toMatchObject({ mode: 'act', cls: 'answer' });
    expect(d.text).toContain('(to undo: revert the commit)');
  });

  test('the owner\'s reserved actions are never typed on the dispatcher\'s word', () => {
    for (const t of ['go ahead and merge the PR', 'run gh pr merge 12', 'git push origin it', 'post a comment on the GitHub issue',
      'delete the old branch', 'rm -rf the build folder', 'install the MSI on the host', 'buy more credits', 'email the customer the notes']) {
      const d = cases.verbDecision({ verb: 'lead', text: t, cfg });
      expect(d.mode, t).toBe('card');
    }
    for (const t of ['finish the tests first', 'the root cause is in lib/x.js, fix it there', 'report done when green']) {
      expect(cases.verbDecision({ verb: 'lead', text: t, cfg }).mode, t).toBe('act');
    }
  });

  test('refused, never cleaned: an unknown verb, an empty or multi-line text', () => {
    expect(cases.verbDecision({ verb: 'kill', text: 'x', cfg }).error).toBeTruthy();
    expect(cases.verbDecision({ verb: 'wake', text: ' ', cfg }).error).toBeTruthy();
    expect(cases.verbDecision({ verb: 'wake', text: 'a\nb', cfg }).error).toBeTruthy();
  });

  test('the case prompt fits the gated prompt with its tag', () => {
    const c = { id: 'abcd1234', rule: 'R9', line: 'x'.repeat(2000) };
    const p = cases.casePrompt(c, 'C:/dev/web-terminal/scripts/wt-supervise.js', TEXT_BYTES_MAX);
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(TEXT_BYTES_MAX);
    expect(p).toMatch(/^Case abcd1234 \(R9\): /);
    expect(p).toMatch(/case abcd1234$/);
  });

  test('the dispatcher cannot take a case when off, paused or capped', () => {
    expect(cases.dispatcherBlock({ cfg, paused: false, node: null })).toBeNull();
    expect(cases.dispatcherBlock({ cfg: { ...cfg, enabled: false }, paused: false, node: null })).toBe('off');
    expect(cases.dispatcherBlock({ cfg, paused: true, node: null })).toBe('paused');
    expect(cases.dispatcherBlock({ cfg, paused: false, node: { capped: true } })).toBe('capped');
  });
});

// --- the owner's queue, the fold, the summary ------------------------------------------
test.describe('#468 escalations and cards reach the owner', () => {
  test('foldCases: open, deliver, escalate, resolve; cards decided; keys survive', () => {
    const f = cases.foldCases([
      { event: 'open', at: 1, case: { id: 'c1c1c1c1', key: 'R3|a|1', rule: 'R3', sessionId: id(1), server: 'alpha', line: 'L', openedAt: 1 } },
      { event: 'delivered', at: 2, caseId: 'c1c1c1c1' },
      { event: 'escalated', at: 3, caseId: 'c1c1c1c1', question: 'Q?', by: 'dispatcher' },
      { event: 'card', at: 4, card: { id: 'aaaa0001', cls: 'owner', sessionId: id(1), server: 'alpha', text: 'merge it', at: 4 } },
    ]);
    expect(f.cases.c1c1c1c1).toMatchObject({ deliveredAt: 2, escalated: { question: 'Q?' }, resolvedAt: null });
    expect(f.keys.has('R3|a|1')).toBe(true);
    const items = cases.ownerItems(f);
    expect(items.map((x) => x.key)).toEqual(['case|c1c1c1c1', 'card|aaaa0001']);
    cases.foldCases([{ event: 'resolved', at: 5, caseId: 'c1c1c1c1', how: 'done' }, { event: 'decided', at: 6, cardId: 'aaaa0001', decision: 'approve' }], f);
    expect(cases.ownerItems(f)).toEqual([]);
    expect(cases.autonomyRecord(cfg, f.cards).owner).toMatchObject({ approved: 1, dismissed: 0 });
  });

  test('an id is data: __proto__ and other unminted ids never land in the maps', () => {
    const f = cases.foldCases([
      { event: 'open', at: 1, case: { id: '__proto__', key: 'k', rule: 'R3', line: 'L', openedAt: 1 } },
      { event: 'resolved', at: 2, caseId: '__proto__', how: 'x' },
      { event: 'card', at: 3, card: { id: 'constructor', cls: 'owner', text: 't' } },
    ]);
    expect(Object.keys(f.cases)).toEqual([]);
    expect(Object.keys(f.cards)).toEqual([]);
    expect(/** @type {any} */ ({}).resolvedAt).toBeUndefined();
  });

  test('ownerPlan pushes an escalation by day, holds it at night, then one summary', () => {
    const graph = graphOf();
    const extra = [{ key: 'case|c1', id: id(1), server: 'alpha', name: 'w', what: 'Q?', at: T0 }];
    const day = sup.ownerPlan({ graph, ladder: {}, quiet: false, now: T0, cfg: sup.supervisorConfig(null), extra });
    expect(day.pushes.map((p) => p.key)).toEqual(['case|c1']);
    const night = sup.ownerPlan({ graph, ladder: {}, quiet: true, now: T0, cfg: sup.supervisorConfig(null), extra });
    expect(night.pushes).toEqual([]);
    const morning = sup.ownerPlan({ graph, ladder: night.ladder, quiet: false, now: T0 + 8 * 60 * MIN, cfg: sup.supervisorConfig(null), extra });
    expect(morning.summary).toMatchObject({ count: 1 });
    // without the extra item there is nothing to push (the mutation that proves it is the extra)
    expect(sup.ownerPlan({ graph, ladder: {}, quiet: false, now: T0, cfg: sup.supervisorConfig(null) }).pushes).toEqual([]);
  });

  test('the morning summary says what the night shift did', () => {
    const acts = [
      { at: T0 + 1, rule: 'answer', outcome: 'delivered' }, { at: T0 + 2, rule: 'coach', outcome: 'delivered' },
      { at: T0 + 3, rule: 'R1', outcome: 'delivered' }, { at: T0 + 4, rule: 'coach', outcome: 'card' }, { at: T0 - 5, rule: 'coach', outcome: 'delivered' },
    ];
    expect(cases.nightSummary(acts, T0, 4)).toBe('Overnight: 1 answered, 1 coached, 1 woken. 4 things wait on you');
    expect(cases.nightSummary([], T0, 1)).toBe('1 thing waits on you');
  });
});

// --- lib/supervisor.js nodeOf carries what the case rules read -----------------------
test('#468 nodeOf keeps brief.now as text and its time, the check-in, live work and R9 evidence', () => {
  const n = sup.nodeOf({ id: id(1), status: 'working', compacting: false, waitingFor: null,
    backgroundTasks: [{ kind: 'agent' }, { kind: 'command' }, { kind: 'monitor', stale: true }],
    circling: { tool: 'Bash', sample: 's', count: 4, turns: 2, lastAt: T0 },
    usageLimit: { waiting: true },
    brief: { now: { text: 'Bash: npm test', at: T0 - MIN }, turnAt: T0 - 2 * MIN, reportAt: null,
      checkIn: { sentAt: T0 - 3 * MIN, n: 2, deliveredAt: T0 - 3 * MIN, endedAt: T0 - 2 * MIN, answer: { on: 'self', what: 'x' } } } }, 'alpha');
  expect(n).toMatchObject({ now: 'Bash: npm test', nowAt: T0 - MIN, turnAt: T0 - 2 * MIN, liveAgents: 1, capped: true,
    checkIn: { n: 2, answer: { on: 'self' } }, circling: { count: 4, turns: 2 } });
});
