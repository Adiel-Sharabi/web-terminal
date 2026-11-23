// @ts-check
// #506 - lib/mc-needs.js: "Answer now" vs "My to-do", ranked by what each card blocks, the
// fixed park message and what each to-do action may do; and lib/mc-state.js keeping the
// to-dos and "later"s. Pure, from SYNTHETIC fixtures (two fake servers' session rows). The
// routes are pinned in mc-needs-routes.spec.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const M = require('../lib/mc-subjects');
const N = require('../lib/mc-needs');
const { createMcState } = require('../lib/mc-state');
const { promptOf, PROMPT_BYTES_MAX } = require('../lib/safe-prompt');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A live row as the cluster view serves it (only the fields MC reads). */
function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], wait = null,
  parentId = null, waitingFor = null, turnAt = NOW - 30 * MIN, lastActivity = NOW - 10 * MIN } = {}) {
  return {
    id, name, status, reason, waitingFor, cwd: 'C:\\dev\\widgets', server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`,
    lastActivity,
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      headline: null, reportAt: NOW - 20 * MIN, wait, turnAt },
    spawn: { parentId, replaces: [], createdAt: NOW - 2 * HOUR },
  };
}
/** A session that reported a `you` wait `ago` minutes back. */
const asking = (server, what, ago, over = {}) => row(server, {
  reason: { kind: 'you', text: what, since: NOW - ago * MIN, source: 'reported' },
  wait: { on: 'you', what, at: NOW - ago * MIN }, ...over,
});
const working = (server, over = {}) => row(server, { status: 'working', reason: { kind: 'working', text: '' }, ...over });
const meta = (key, over = {}) => ({ key, ref: key, title: `Title of ${key}`, url: null, state: 'open', closed: false, prs: [], severity: null, ...over });

function now({ rows = [], metaByKey = {}, todos = [], later = {}, at = NOW } = {}) {
  const nodes = M.sessionNodes({ rows, closed: [], now: at });
  const view = M.buildView({ nodes, metaByKey, projects: [], now: at, platform: 'win32' });
  return N.buildNow({ nodes, view, todos, later, now: at });
}

test.describe('#506 Answer now: which waits, ranked by what they block', () => {
  test('a question blocking 3 sessions sorts above a lone 2-hour-old one', () => {
    // An orchestrator opened a child that opened a grandchild; the grandchild asks, 5 min ago.
    const root = working('alpha', { name: 'orchestrator', items: [{ ref: 'ado:1' }] });
    const mid = working('beta', { name: 'lead', parentId: root.id, items: [{ ref: 'ado:2' }] });
    const leaf = row('beta', { name: 'leaf', parentId: mid.id, status: 'waiting', waitingFor: 'question',
      reason: { kind: 'you', text: 'answer a question', since: null }, items: [{ ref: 'ado:3' }], lastActivity: NOW - 5 * MIN });
    // A lone session has waited two hours.
    const lone = asking('alpha', 'pick a schema', 120, { name: 'lone', items: [{ ref: 'ado:9' }] });
    const v = now({ rows: [lone, root, mid, leaf] });
    expect(v.answerNow.map((c) => c.sessionName)).toEqual(['leaf', 'lone']);
    const [q, l] = v.answerNow;
    expect(q).toMatchObject({ kind: 'question', hasQuestion: true, rank: 1, subjectKey: 'ado:3', server: 'beta', sessionId: leaf.id,
      why: { blocks: 3, subjects: ['ado:3', 'ado:2', 'ado:1'], ageMin: 5, severity: null, text: 'blocks 3 sessions and 3 work items' } });
    expect(q.why.blockedSessions.map((s) => s.name)).toEqual(['leaf', 'lead', 'orchestrator']);
    expect(l).toMatchObject({ kind: 'wait', hasQuestion: false, rank: 2, what: 'pick a schema',
      why: { blocks: 1, ageMin: 120, text: 'blocks this session and 1 work item' } });
    // Only the askers owe anything: the two working sessions move on their own.
    expect(v.moving).toEqual({ working: 2, idle: 0, total: 2 });
  });

  test('blocked sessions first, then work items, then severity (1 highest), then age', () => {
    const a = asking('alpha', 'a', 10, { name: 'a', items: [{ ref: 'ado:10' }] });
    const b = asking('alpha', 'b', 50, { name: 'b', items: [{ ref: 'ado:11' }] });
    const c = asking('alpha', 'c', 30, { name: 'c', items: [{ ref: 'ado:12' }] });
    const d = asking('alpha', 'd', 99, { name: 'd' }); // no work item: fewer things blocked
    const e = asking('alpha', 'e', 5, { name: 'e', items: [{ ref: 'ado:13' }, { ref: 'ado:14' }] }); // two items
    const metaByKey = { 'ado:10': meta('ado:10', { severity: 2 }), 'ado:11': meta('ado:11', { severity: 3 }), 'ado:12': meta('ado:12', { severity: 2 }) };
    const v = now({ rows: [a, b, c, d, e], metaByKey });
    // e (2 items) > a,c (severity 2: older first) > b (severity 3) > d (no item).
    expect(v.answerNow.map((x) => x.sessionName)).toEqual(['e', 'c', 'a', 'b', 'd']);
    expect(v.answerNow.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(v.answerNow[1].why.severity).toBe(2);
    expect(v.answerNow[4].why).toMatchObject({ blocks: 1, subjects: [], text: 'blocks this session' });
    // A finished item is not blocked any more.
    const done = asking('alpha', 'x', 1, { items: [{ ref: 'ado:20', state: 'done' }] });
    expect(now({ rows: [done] }).answerNow[0].why.subjects).toEqual([]);
  });

  test('kinds: a question, a permission, a decision card and a reported wait; anything else is not on the person', () => {
    const q = row('alpha', { status: 'waiting', waitingFor: 'question', reason: { kind: 'you', text: 'answer a question' }, turnAt: NOW - 7 * MIN,
      lastActivity: NOW - 6 * MIN });
    const p = row('alpha', { status: 'waiting', waitingFor: 'permission', reason: { kind: 'you', text: 'approve a tool' } });
    const d = asking('alpha', 'choose', 3, { wait: { on: 'you', what: 'choose', at: NOW - 3 * MIN, decision: { question: 'A or B?', options: [] } } });
    const w = asking('beta', 'say go', 4);
    const ext = row('alpha', { reason: { kind: 'external', text: 'CI' } });
    const self = row('alpha', { reason: { kind: 'self', text: 'build' } });
    const v = now({ rows: [q, p, d, w, ext, self] });
    const byKind = Object.fromEntries(v.answerNow.map((c) => [c.kind, c]));
    expect(Object.keys(byKind).sort()).toEqual(['decision', 'permission', 'question', 'wait']);
    // The id names the wait itself: a prompt on screen by its turn and the session's last
    // activity, a reported wait by its `at`.
    expect(byKind.question.id).toBe(`alpha|${q.id}|question:${NOW - 7 * MIN}.${NOW - 6 * MIN}`);
    expect(byKind.wait.id).toBe(`beta|${w.id}|wait:${NOW - 4 * MIN}`);
    expect(byKind.decision.decision).toEqual({ question: 'A or B?', options: [] });
    expect(v.moving).toEqual({ working: 0, idle: 2, total: 2 });
    // A peer too old to send `reason`: its status and wait decide (the subjects' own rule).
    const old = row('beta', { status: 'waiting', waitingFor: 'question' });
    delete old.reason;
    expect(now({ rows: [old] }).answerNow).toHaveLength(1);
  });

  test('a to-do hides its card (open or done), a "later" until it ends; a new wait of the same session is a new card', () => {
    const w = asking('alpha', 'say go', 4, { items: [{ ref: 'ado:5' }] });
    const id = `alpha|${w.id}|wait:${NOW - 4 * MIN}`;
    const todo = (state) => ({ id: 't-1', cardId: id, createdAt: NOW, state, doneAt: state === 'done' ? NOW : null, park: { state: 'delivered' } });
    expect(now({ rows: [w] }).answerNow.map((c) => c.id)).toEqual([id]);
    expect(now({ rows: [w], todos: [todo('open')] }).answerNow).toEqual([]);
    expect(now({ rows: [w], todos: [todo('done')] }).answerNow).toEqual([]);
    expect(now({ rows: [w], todos: [todo('back')] }).answerNow).toHaveLength(1);
    expect(now({ rows: [w], later: { [id]: { until: NOW + HOUR } } }).answerNow).toEqual([]);
    expect(now({ rows: [w], later: { [id]: { until: NOW - 1 } } }).answerNow).toHaveLength(1);
    // The session reports a NEW wait: a new id, so neither the to-do nor the later hides it.
    const again = asking('alpha', 'say go again', 1, { id: w.id, items: [{ ref: 'ado:5' }] });
    expect(now({ rows: [again], todos: [todo('open')], later: { [id]: { until: NOW + HOUR } } }).answerNow).toHaveLength(1);
    // The to-do list: open first (newest first), then done; a sent-back one is not listed.
    const list = now({ rows: [], todos: [{ ...todo('done'), id: 't-a', createdAt: NOW - 1 }, { ...todo('open'), id: 't-b', createdAt: NOW - 5 },
      { ...todo('open'), id: 't-c', createdAt: NOW - 2 }, { ...todo('back'), id: 't-d' }] }).todo;
    expect(list.map((t) => t.id)).toEqual(['t-c', 't-b', 't-a']);
    expect(list[2].doneAt).toBe(NOW);
  });

  test('a second permission prompt in the same turn is a new card: the first one\'s to-do or later never hides it', () => {
    const at = (last) => row('alpha', { id: 'perm-0000-4000-8000-000000000001', status: 'waiting', waitingFor: 'permission',
      reason: { kind: 'you', text: 'approve a tool' }, turnAt: NOW - 20 * MIN, lastActivity: last });
    const first = now({ rows: [at(NOW - 10 * MIN)] }).answerNow[0];
    // Tool A was approved at the desk and ran; the same turn now asks about tool B.
    const todos = [{ id: 't-1', cardId: first.id, createdAt: NOW, state: 'done', doneAt: NOW, park: { state: 'none' } }];
    const second = now({ rows: [at(NOW - 2 * MIN)], todos, later: { [first.id]: { until: NOW + HOUR } } });
    expect(second.answerNow).toHaveLength(1);
    expect(second.answerNow[0].id).not.toBe(first.id);
    // A session with no turn and no activity known still has a card (named by zeros).
    expect(now({ rows: [row('alpha', { status: 'waiting', waitingFor: 'question', reason: { kind: 'you' }, turnAt: null, lastActivity: null })] })
      .answerNow[0].id).toMatch(/\|question:0\.0$/);
  });
});

test.describe('#506 the park message and the to-do actions', () => {
  test('the park message is one fixed line under 512 bytes with the tag, names the item, and checks the wait it answers', () => {
    const card = { kind: 'wait', ref: 'acme/widgets#42', askedAt: NOW - MIN };
    const body = N.parkBody(card);
    expect(body).toEqual({ text: N.parkText(card), tag: 'supervisor', expectWaitAt: NOW - MIN });
    expect(body.text).toContain('acme/widgets#42');
    expect(body.text).toMatch(/^\[Mission Control\] The user moved .* to their to-do list .*report that wait as external\.$/);
    const p = promptOf(body);
    expect(p.error).toBeUndefined();
    expect(Buffer.byteLength(p.prompt, 'utf8')).toBeLessThanOrEqual(PROMPT_BYTES_MAX);
    // A question on screen carries no `at` to check; a long or hostile ref is cut to one line.
    const nl = String.fromCodePoint(10);
    const q = N.parkBody({ kind: 'question', ref: `x${nl}${'y'.repeat(400)}`, askedAt: NOW });
    expect(q.expectWaitAt).toBeUndefined();
    expect(promptOf(q).error).toBeUndefined();
    expect(N.parkBody({ kind: 'wait', ref: null, askedAt: null }).text).toContain('your current wait on them');
  });

  test('actions: done, reopen, back; park retries a REFUSED message only, never one that was or may have been delivered', () => {
    const base = { id: 't-1', cardId: 'c', createdAt: NOW, state: 'open', doneAt: null, park: { state: 'delivered', body: { text: 'x' } } };
    expect(N.applyAction(base, 'nope', NOW)).toMatchObject({ status: 400 });
    expect(N.applyAction(null, 'done', NOW)).toMatchObject({ status: 404 });
    expect(N.applyAction({ ...base, state: 'back' }, 'done', NOW)).toMatchObject({ status: 404 });
    const d = N.applyAction(base, 'done', NOW + 1);
    expect(d.todo).toMatchObject({ state: 'done', doneAt: NOW + 1 });
    expect(N.applyAction(d.todo, 'done', NOW)).toMatchObject({ status: 409 });
    expect(N.applyAction(d.todo, 'reopen', NOW).todo).toMatchObject({ state: 'open', doneAt: null });
    expect(N.applyAction(base, 'reopen', NOW)).toMatchObject({ status: 409 });
    expect(N.applyAction(base, 'back', NOW).todo).toMatchObject({ state: 'back', backAt: NOW });
    for (const s of ['delivered', 'sending', 'uncertain']) {
      expect(N.applyAction({ ...base, park: { state: s } }, 'park', NOW), s).toMatchObject({ status: 409 });
    }
    const r = N.applyAction({ ...base, park: { state: 'refused', why: 'draft', body: { text: 'x' } } }, 'park', NOW);
    expect(r).toMatchObject({ park: true, todo: { park: { state: 'sending', why: null, body: { text: 'x' } } } });
    // What came back is recorded; a refusal is said in plain words.
    const t = N.newTodo({ id: 'card', kind: 'wait', ref: 'ado:5', askedAt: NOW - MIN, sessionId: 's', server: 'alpha' }, { id: 't-2', text: null, now: NOW });
    expect(t.park).toMatchObject({ state: 'sending', body: { expectWaitAt: NOW - MIN } });
    const refused = N.parkResult(t, { why: 'draft' }, NOW);
    expect(N.parkedAnswer(refused)).toEqual({ delivered: false, refused: 'draft', reason: 'it has unsent text in its prompt box' });
    expect(N.publicTodo(refused).park).toEqual({ state: 'refused', refused: 'draft', reason: 'it has unsent text in its prompt box', at: NOW });
    expect(N.publicTodo(refused).park.body).toBeUndefined();
    expect(N.parkedAnswer(N.parkResult(t, { delivered: true }, NOW), { already: true })).toEqual({ delivered: true, already: true });
    expect(N.parkedAnswer(N.parkResult(t, { uncertain: true }, NOW))).toEqual({ delivered: false, uncertain: true });
  });

  test('a prompt on screen is never sent a park message: typed text would answer it, and later it may name another wait', () => {
    for (const kind of ['question', 'permission']) {
      const t = N.newTodo({ id: 'card', kind, ref: 'ado:5', askedAt: NOW, sessionId: 's', server: 'alpha' }, { id: 't-3', text: null, now: NOW });
      expect(t.park, kind).toEqual({ state: 'none', why: 'on-screen', at: NOW });
      expect(N.parkedAnswer(t)).toEqual({ delivered: false, refused: 'on-screen', reason: N.refusalWords('on-screen') });
      expect(N.publicTodo(t).park).toMatchObject({ state: 'none', refused: 'on-screen' });
      // No retry either: once the prompt is gone the message could hide a NEW wait.
      expect(N.applyAction(t, 'park', NOW)).toMatchObject({ status: 409 });
    }
    expect(N.refusalWords('on-screen')).toContain('answer it there');
    // A long non-ASCII ref is cut by code point, never through a surrogate pair.
    const ref = String.fromCodePoint(0x1F600).repeat(100);
    const text = N.parkText({ ref });
    expect(text).toContain(`${String.fromCodePoint(0x1F600).repeat(79)}...`);
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  });

  test('inputs are refused with the reason; finished to-dos are kept a week', () => {
    expect(N.todoInput(null).error).toBeTruthy();
    expect(N.todoInput({ cardId: '' }).error).toBeTruthy();
    expect(N.todoInput({ cardId: 'c', text: 5 }).error).toBeTruthy();
    expect(N.todoInput({ cardId: 'c', text: 'x'.repeat(501) }).error).toBeTruthy();
    expect(N.todoInput({ cardId: 'c', text: '  try the build  ' })).toEqual({ cardId: 'c', text: 'try the build' });
    for (const h of [0, 25, 1.5, '2', null]) expect(N.laterInput({ cardId: 'c', hours: h }).error, String(h)).toBeTruthy();
    expect(N.laterInput({ cardId: 'c', hours: 24 })).toEqual({ cardId: 'c', hours: 24 });
    const day = 24 * HOUR;
    const kept = N.pruneTodos([
      { id: 'open', state: 'open', createdAt: 0 },
      { id: 'done-new', state: 'done', doneAt: NOW - day, createdAt: 0 },
      { id: 'done-old', state: 'done', doneAt: NOW - 8 * day, createdAt: 0 },
      { id: 'back-old', state: 'back', backAt: NOW - 8 * day, createdAt: 0 },
    ], NOW);
    expect(kept.map((t) => t.id)).toEqual(['open', 'done-new']);
    expect(N.pruneLater({ a: { until: NOW + 1 }, b: { until: NOW } }, NOW)).toEqual({ a: { until: NOW + 1 } });
  });

  test('mc-state keeps the to-dos and the "later"s across a restart; a to-do is on disk before the message goes out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-needs-'));
    const file = path.join(dir, 'mc-state.json');
    try {
      const s1 = createMcState({ file, log: () => {}, saveDelayMs: 60000 });
      s1.setTodos([{ id: 't-1', cardId: 'c', createdAt: NOW, state: 'open', park: { state: 'sending' } }], { now: true });
      // Written at once (the save timer is a minute away).
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).todos[0]).toMatchObject({ id: 't-1', park: { state: 'sending' } });
      s1.setLater({ c: { until: NOW + HOUR, at: NOW } });
      s1.flush();
      const s2 = createMcState({ file, log: () => {} });
      expect(s2.todos().map((t) => t.id)).toEqual(['t-1']);
      expect(s2.later()).toEqual({ c: { until: NOW + HOUR, at: NOW } });
      expect(s2.stageHistory('x')).toEqual([]);
      // A record that is not a to-do is dropped on read.
      fs.writeFileSync(file, JSON.stringify({ v: 1, stages: {}, todos: [{ id: 5 }, { id: 't-2', cardId: 'c', createdAt: NOW }], later: { a: { until: 'x' } } }));
      const s3 = createMcState({ file, log: () => {} });
      expect(s3.todos().map((t) => t.id)).toEqual(['t-2']);
      expect(s3.later()).toEqual({});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('mc-state: a write that fails says so, and a file that exists but cannot be read is never written over', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-needs-'));
    try {
      // A directory where the file goes: the write (tmp + rename onto it) fails.
      const blocked = path.join(dir, 'blocked.json');
      fs.mkdirSync(blocked);
      const logs = [];
      const s1 = createMcState({ file: blocked, log: (m) => logs.push(m) });
      // Reading it is not ENOENT: unreadable, so nothing is stored and nothing written.
      expect(s1.setTodos([{ id: 't-1', cardId: 'c', createdAt: NOW, state: 'open' }], { now: true })).toBe(false);
      expect(s1.setLater({ c: { until: NOW + 1 } })).toBe(false);
      expect(s1.flush()).toBe(false);
      expect(fs.statSync(blocked).isDirectory()).toBe(true);
      expect(logs.join(' ')).toContain('unreadable');
      // A readable state whose write fails: false, and the caller sends nothing.
      const file = path.join(dir, 'mc-state.json');
      const s2 = createMcState({ file, log: () => {} });
      expect(s2.setTodos([], { now: true })).toBe(true);
      fs.rmSync(file);
      fs.mkdirSync(file);
      expect(s2.setTodos([{ id: 't-2', cardId: 'c', createdAt: NOW, state: 'open' }], { now: true })).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
