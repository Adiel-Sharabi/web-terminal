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
const pj = require('../lib/projects');
const { createPromptEpisodes } = require('../lib/mc-episodes');
const { promptOf, PROMPT_BYTES_MAX } = require('../lib/safe-prompt');
const { clearWait } = require('../lib/session-brief');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let n = 0;
const uid = (tag) => `${tag}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** A live row as the cluster view serves it (only the fields MC reads). */
function row(server, { id = uid('live'), name = 'session', status = 'idle', reason = null, items = [], wait = null,
  parentId = null, waitingFor = null, turnAt = NOW - 30 * MIN, lastActivity = NOW - 10 * MIN, prompt = null, createdAt = NOW - 2 * HOUR } = {}) {
  return {
    id, name, status, reason, waitingFor, cwd: 'C:\\dev\\widgets', server, serverUrl: server === 'alpha' ? null : `https://${server}.example.test`,
    lastActivity,
    brief: { items: items.map((it) => ({ title: '', state: 'in-progress', note: '', stage: null, source: 'agent', url: null, key: it.ref, ...it })),
      headline: null, reportAt: NOW - 20 * MIN, wait, turnAt, prompt },
    spawn: { parentId, replaces: [], createdAt },
  };
}
/** A session that reported a `you` wait `ago` minutes back. */
const asking = (server, what, ago, over = {}) => row(server, {
  reason: { kind: 'you', text: what, since: NOW - ago * MIN, source: 'reported' },
  wait: { on: 'you', what, at: NOW - ago * MIN }, ...over,
});
const working = (server, over = {}) => row(server, { status: 'working', reason: { kind: 'working', text: '' }, ...over });
const meta = (key, over = {}) => ({ key, ref: key, title: `Title of ${key}`, url: null, state: 'open', closed: false, prs: [], severity: null, ...over });

function now({ rows = [], metaByKey = {}, todos = [], later = {}, at = NOW, episodes = null, projects = [] } = {}) {
  const nodes = M.sessionNodes({ rows, closed: [], now: at });
  if (episodes) episodes.observe(nodes, at);
  const view = M.buildView({ nodes, metaByKey, projects, now: at, platform: 'win32' });
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
    // #541/#548: a prompt that says nothing of its item is about the session's ONE item (never the first of
    // several); what it blocks is still every item of the sessions above it.
    expect(q).toMatchObject({ kind: 'question', hasQuestion: true, rank: 1, subjectKey: 'ado:3', ref: 'ado:3', title: 'ado:3', server: 'beta', sessionId: leaf.id,
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

  test('a prompt on screen keeps ONE card id while it is up; the next prompt in the same turn is a new card', () => {
    const PID = 'perm-0000-4000-8000-000000000001';
    const at = (last, waiting = true) => row('alpha', { id: PID, status: waiting ? 'waiting' : 'working', waitingFor: waiting ? 'permission' : null,
      reason: waiting ? { kind: 'you', text: 'approve a tool' } : { kind: 'working', text: '' }, turnAt: NOW - 20 * MIN, lastActivity: last });
    const episodes = createPromptEpisodes();
    const first = now({ rows: [at(NOW - 10 * MIN)], episodes, at: NOW - 9 * MIN }).answerNow[0];
    expect(first).toMatchObject({ kind: 'permission', askedAt: NOW - 10 * MIN, id: `alpha|${PID}|permission:${NOW - 10 * MIN}` });
    // Parked. A viewer's redraw and Claude's idle Notification move the last activity: same card, still parked.
    const todos = [{ id: 't-1', cardId: first.id, createdAt: NOW, state: 'open', park: { state: 'none' } }];
    const redrawn = now({ rows: [at(NOW - 5 * MIN)], episodes, todos, at: NOW - 4 * MIN });
    expect(redrawn.answerNow).toEqual([]);
    expect(redrawn.pending[0].id).toBe(first.id);
    // Tool A was approved at the desk and ran; the same turn now asks about tool B: a new card,
    // which neither the first one's to-do nor its later hides.
    now({ rows: [at(NOW - 3 * MIN, false)], episodes, at: NOW - 3 * MIN });
    const second = now({ rows: [at(NOW - 2 * MIN)], episodes, todos, later: { [first.id]: { until: NOW + HOUR } } });
    expect(second.answerNow).toHaveLength(1);
    expect(second.answerNow[0].id).not.toBe(first.id);
    expect(second.answerNow[0].askedAt).toBe(NOW - 2 * MIN);
    // Known limit (docs/mission-control.md): with no view between the two prompts they read as one.
    const quiet = createPromptEpisodes();
    const a = now({ rows: [at(NOW - 10 * MIN)], episodes: quiet }).answerNow[0];
    expect(now({ rows: [at(NOW - 2 * MIN)], episodes: quiet }).answerNow[0].id).toBe(a.id);
    // Without an episode tracker the turn and the last activity name it.
    const second0 = now({ rows: [at(NOW - 2 * MIN)] }).answerNow[0];
    expect(second0.id).toBe(`alpha|${PID}|permission:${NOW - 20 * MIN}.${NOW - 2 * MIN}`);
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

// #522 - a "you" wait the person must DO (kind action): never in Answer now, always on My to-do
// (`actions`), ranked by the same order, with its steps and where; its Done tells the session
// once through the gated prompt, and a refusal keeps it with the reason.
test.describe('#522 action waits: on My to-do, never Answer now, and their Done', () => {
  /** A session that reported an action wait `ago` minutes back. */
  const acting = (server, what, ago, over = {}) => asking(server, what, ago, {
    wait: { on: 'you', what, at: NOW - ago * MIN, kind: 'action', steps: ['Install 0.2.51', 'Start a shift'], where: 'phone' }, ...over });
  /** buildNow over [rows] with the Done records [actionsDone]. */
  const nowDone = (rows, actionsDone) => {
    const nodes = M.sessionNodes({ rows, closed: [], now: NOW });
    return N.buildNow({ nodes, view: M.buildView({ nodes, metaByKey: {}, projects: [], now: NOW, platform: 'win32' }), actionsDone, now: NOW });
  };

  test('an action is in `actions` (ranked by what it blocks), never in Answer now, never phrased as a question', () => {
    const root = working('alpha', { name: 'orchestrator', items: [{ ref: 'ado:1' }] });
    const big = acting('alpha', 'try on-duty', 5, { name: 'big', parentId: root.id, items: [{ ref: 'ado:2' }] });
    const lone = acting('beta', 'power the drone', 90, { name: 'lone' });
    const q = asking('alpha', 'pick a schema', 3, { name: 'asks' });
    const v = now({ rows: [lone, big, q, root] });
    expect(v.answerNow.map((c) => c.sessionName)).toEqual(['asks']);
    expect(v.answerNow[0]).toMatchObject({ kind: 'wait', rank: 1, action: null });
    // The same order as Answer now: blocked sessions first (big blocks its orchestrator too).
    expect(v.actions.map((c) => c.sessionName)).toEqual(['big', 'lone']);
    expect(v.actions.map((c) => c.rank)).toEqual([1, 2]);
    const [a] = v.actions;
    expect(a).toMatchObject({ kind: 'action', hasQuestion: false, decision: null, done: null, what: 'try on-duty',
      action: { steps: ['Install 0.2.51', 'Start a shift'], where: 'phone' },
      why: { blocks: 2, text: 'blocks 2 sessions and 2 work items' } });
    expect(a.id).toBe(`alpha|${big.id}|action:${NOW - 5 * MIN}`);
    // The action's session owes the person something: it is not "moving on its own".
    expect(v.moving).toEqual({ working: 1, idle: 0, total: 1 });
    // A prompt on screen outranks the report: that one IS a question.
    const onScreen = acting('alpha', 'x', 1, { status: 'waiting', waitingFor: 'question', reason: { kind: 'you', text: 'answer a question' } });
    expect(now({ rows: [onScreen] }).answerNow.map((c) => c.kind)).toEqual(['question']);
    // A wait with no steps or where is an action all the same.
    const bare = asking('alpha', 'plug in the rig', 2, { wait: { on: 'you', what: 'plug in the rig', at: NOW - 2 * MIN, kind: 'action' } });
    expect(now({ rows: [bare] }).actions[0].action).toEqual({ steps: [], where: null });
  });

  test('Later hides an action until it ends; Done hides it once told, a maybe-told one stays saying so, a refusal keeps it with the reason', () => {
    const a = acting('alpha', 'try on-duty', 4);
    const id = `alpha|${a.id}|action:${NOW - 4 * MIN}`;
    expect(now({ rows: [a], later: { [id]: { until: NOW + HOUR } } }).actions).toEqual([]);
    expect(now({ rows: [a], later: { [id]: { until: NOW - 1 } } }).actions).toHaveLength(1);
    expect(nowDone([a], { [id]: { state: 'delivered', why: null, at: NOW } }).actions).toEqual([]);
    // It may have landed: still shown while the session blocks (fail toward showing), saying so.
    for (const state of ['sending', 'uncertain']) {
      const maybe = nowDone([a], { [id]: { state, why: null, at: NOW } }).actions;
      expect(maybe, state).toHaveLength(1);
      expect(maybe[0].done, state).toEqual({ state, refused: null, reason: null, at: NOW });
    }
    const kept = nowDone([a], { [id]: { state: 'refused', why: 'draft', at: NOW } }).actions;
    expect(kept).toHaveLength(1);
    expect(kept[0].done).toEqual({ state: 'refused', refused: 'draft', reason: 'it has unsent text in its prompt box', at: NOW });
    // A NEW wait of the same session is a new card: an old Done never hides it.
    const again = acting('alpha', 'and now this', 1, { id: a.id });
    expect(nowDone([again], { [id]: { state: 'delivered', at: NOW } }).actions).toHaveLength(1);
  });

  test('the Done message: one fixed line under 512 bytes with the tag, naming what was done, checking the wait it answers', () => {
    const card = { kind: 'action', what: 'try on-duty on 0.2.51', askedAt: NOW - MIN };
    const body = N.actionDoneBody(card);
    // clearWait: the Done ENDS the wait it answers on the session's own server (that wait only).
    expect(body).toEqual({ text: '[Mission Control] Done: try on-duty on 0.2.51. The user did it; carry on.', tag: 'supervisor', expectWaitAt: NOW - MIN, clearWait: true });
    const p = promptOf(body);
    expect(p.error).toBeUndefined();
    expect(p).toMatchObject({ expectWaitAt: NOW - MIN, clearWait: true });
    expect(Buffer.byteLength(p.prompt, 'utf8')).toBeLessThanOrEqual(PROMPT_BYTES_MAX);
    // Hostile or long text: one line, cut by code point, still under the cap.
    const nl = String.fromCodePoint(10);
    const esc = String.fromCodePoint(27);
    const long = N.actionDoneBody({ kind: 'action', what: `a${nl}b${esc}[2J${String.fromCodePoint(0x1F600).repeat(200)}`, askedAt: NOW });
    expect(/[\u0000-\u001f]/.test(long.text)).toBe(false);
    expect(promptOf(long).error).toBeUndefined();
    expect(N.actionDoneBody({ kind: 'action', what: '', askedAt: null })).toEqual({ text: '[Mission Control] Done: what you asked the user to do. The user did it; carry on.', tag: 'supervisor' });
  });

  test('the gated prompt clears ONLY the wait it answers (session-brief clearWait, the one owner)', () => {
    const at = NOW - MIN;
    const entry = { reported: { headline: 'h', wait: { on: 'you', what: 'try it', at, kind: 'action' } }, pinned: [] };
    expect(clearWait(entry, at)).toEqual({ reported: { headline: 'h', wait: null }, pinned: [] });
    expect(entry.reported.wait).not.toBeNull(); // never mutated
    expect(clearWait(entry, at + 1)).toBeNull(); // reported again since: that wait is not ours
    expect(clearWait({ reported: { wait: null } }, at)).toBeNull();
    expect(clearWait(null, at)).toBeNull();
    expect(clearWait(entry, 'x')).toBeNull();
    // No `at`: a person clearing a wrong wait (#320) clears whatever is reported.
    expect(clearWait(entry)).toEqual({ reported: { headline: 'h', wait: null }, pinned: [] });
    // clearWait is refused without the wait it answers, and must be a boolean.
    expect(promptOf({ text: 'x', clearWait: true }).error).toContain('clearWait needs expectWaitAt');
    expect(promptOf({ text: 'x', clearWait: 'yes', expectWaitAt: at }).error).toContain('clearWait must be true');
    expect(promptOf({ text: 'x', clearWait: false, expectWaitAt: at })).toEqual({ prompt: '[web-terminal supervisor] x', expectWaitAt: at });
  });

  test('what Done may do: only an action, once; a refused one may be pressed again', () => {
    const card = { id: 'c', kind: 'action' };
    expect(N.actionDonePlan(undefined, undefined)).toMatchObject({ status: 404 });
    expect(N.actionDonePlan({ id: 'c', kind: 'wait' }, undefined)).toMatchObject({ status: 409 });
    expect(N.actionDonePlan({ id: 'c', kind: 'question' }, undefined)).toMatchObject({ status: 409 });
    expect(N.actionDonePlan(card, undefined)).toEqual({ send: true });
    expect(N.actionDonePlan(card, { state: 'refused', why: 'draft' })).toEqual({ send: true });
    for (const state of ['sending', 'delivered', 'uncertain']) {
      expect(N.actionDonePlan(card, { state, at: NOW }), state).toEqual({ already: { state, at: NOW } });
    }
    // Told once: pressed again it says so, even after the wait has ended.
    expect(N.actionDonePlan(undefined, { state: 'delivered', at: NOW })).toEqual({ already: { state: 'delivered', at: NOW } });
    expect(N.actionDonePlan(undefined, { state: 'refused', why: 'draft' })).toMatchObject({ status: 404 });
    expect(N.actionSending(NOW)).toEqual({ state: 'sending', why: null, at: NOW });
    expect(N.actionDoneResult({ delivered: true }, NOW)).toEqual({ state: 'delivered', why: null, at: NOW });
    expect(N.actionDoneResult({ uncertain: true }, NOW)).toEqual({ state: 'uncertain', why: null, at: NOW });
    expect(N.actionDoneResult({ why: 'draft' }, NOW)).toEqual({ state: 'refused', why: 'draft', at: NOW });
    expect(N.doneAnswer({ state: 'refused', why: 'draft' })).toEqual({ delivered: false, refused: 'draft', reason: 'it has unsent text in its prompt box' });
    expect(N.doneAnswer({ state: 'delivered' }, { already: true })).toEqual({ delivered: true, already: true });
    // An action is never turned into a to-do: it is on My to-do already.
    expect(N.todoRefusal(card)).toMatchObject({ status: 409 });
    expect(N.todoRefusal({ kind: 'wait' })).toBeNull();
    // Inputs, and the records kept a week.
    expect(N.actionDoneInput(null).error).toBeTruthy();
    expect(N.actionDoneInput({ cardId: '' }).error).toBeTruthy();
    expect(N.actionDoneInput({ cardId: 'x'.repeat(401) }).error).toBeTruthy();
    expect(N.actionDoneInput({ cardId: 'c' })).toEqual({ cardId: 'c' });
    expect(N.pruneActionsDone({ a: { state: 'delivered', at: NOW - HOUR }, b: { state: 'delivered', at: NOW - 8 * 24 * HOUR }, c: null }, NOW))
      .toEqual({ a: { state: 'delivered', at: NOW - HOUR } });
  });

  test('every screen carries an action card WITH its Done record (withDone): My to-do and a subject agree', () => {
    const card = { id: 'alpha|s|action:1', kind: 'action', what: 'x' };
    expect(N.withDone(card, {})).toEqual({ ...card, done: null });
    expect(N.withDone(card, { [card.id]: { state: 'uncertain', why: null, at: NOW } }).done).toEqual({ state: 'uncertain', refused: null, reason: null, at: NOW });
    expect(N.withDone(card, { [card.id]: { state: 'refused', why: 'draft', at: NOW } }).done).toMatchObject({ refused: 'draft', reason: 'it has unsent text in its prompt box' });
    // Only an action carries one; own keys only; never mutated.
    const q = { id: 'constructor', kind: 'wait' };
    expect(N.withDone(q, { constructor: { state: 'delivered' } })).toBe(q);
    expect(N.withDone({ ...card, id: 'constructor' }, {}).done).toBeNull();
    expect(N.withDone(null, {})).toBeNull();
    expect(card).not.toHaveProperty('done');
  });

  test('mc-state keeps the Done records across a restart, written at once when asked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-actions-'));
    const file = path.join(dir, 'mc-state.json');
    try {
      const s1 = createMcState({ file, log: () => {}, saveDelayMs: 60000 });
      expect(s1.actionsDone()).toEqual({});
      expect(s1.setActionsDone({ c: { state: 'sending', why: null, at: NOW } }, { now: true })).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).actionsDone).toEqual({ c: { state: 'sending', why: null, at: NOW } });
      const s2 = createMcState({ file, log: () => {} });
      expect(s2.actionsDone()).toEqual({ c: { state: 'sending', why: null, at: NOW } });
      // A record that is not one of ours is dropped on read.
      fs.writeFileSync(file, JSON.stringify({ v: 1, actionsDone: { a: { state: 5, at: NOW }, b: { state: 'refused', why: 'draft', at: NOW }, c: { state: 'x' } } }));
      expect(createMcState({ file, log: () => {} }).actionsDone()).toEqual({ b: { state: 'refused', why: 'draft', at: NOW } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test.describe('#541 a wait card is about the item it names - never the session\'s first item', () => {
  const A5 = { ref: 'ado:5', title: 'Landscape on a phone' };
  const B9 = { ref: 'ado:9', title: 'Sensor cap for the DOM readout' };
  const card = (r) => now({ rows: [r] }).answerNow[0];
  const face = (c) => [c.subjectKey, c.ref, c.title];
  const waitOf = (what, items, extra = {}, over = {}) => asking('alpha', what, 3, { items, wait: { on: 'you', what, at: NOW - 3 * MIN, ...extra }, ...over });

  test('the wait\'s own "ref" decides, wherever the item is in the list', () => {
    expect(face(card(waitOf('Ship it?', [A5, B9], { ref: 'ado:9' })))).toEqual(['ado:9', 'ado:9', 'Sensor cap for the DOM readout']);
    expect(face(card(waitOf('Ship it?', [A5, B9], { ref: 'ado:5' })))).toEqual(['ado:5', 'ado:5', 'Landscape on a phone']);
  });

  test('without a ref the wait is about the item that is blocked', () => {
    expect(face(card(waitOf('Nothing to do with a title', [A5, { ...B9, state: 'blocked' }])))[0]).toBe('ado:9');
    // Two blocked items say nothing about which one: no subject.
    expect(face(card(waitOf('Nothing to do with a title', [{ ...A5, state: 'blocked' }, { ...B9, state: 'blocked' }])))).toEqual([null, null, null]);
    // A finished item is never guessed at: no blocked one and no shared words, so none.
    expect(face(card(waitOf('Nothing to do with a title', [{ ...A5, state: 'done' }, B9])))).toEqual([null, null, null]);
  });

  test('without a ref or a blocked item, the wait is about the item whose note shares its words', () => {
    const noted = { ...A5, note: 'the sensor cap readout waits for a hardware decision' };
    expect(face(card(waitOf('Which sensor cap readout do you want?', [noted, { ...B9, title: 'Unrelated' }])))[0]).toBe('ado:5');
    expect(face(card(waitOf('Which colour for the badge?', [noted, B9])))).toEqual([null, null, null]);
  });

  test('a wait never borrows the first item of SEVERAL; the only item of a session is what its wait is about (#548)', () => {
    const c = card(waitOf('Which colour for the badge?', [A5, B9]));
    expect(face(c)).toEqual([null, null, null]);
    expect(c.project).toBeNull();
    // What it blocks is still every item of the session (the ranking is not about the title).
    expect(c.why).toMatchObject({ blocks: 1, subjects: ['ado:5', 'ado:9'], text: 'blocks this session and 2 work items' });
    const one = card(waitOf('Which colour for the badge?', [A5]));
    expect(face(one)).toEqual(['ado:5', 'ado:5', 'Landscape on a phone']);
    expect(one.why).toMatchObject({ blocks: 1, subjects: ['ado:5'], text: 'blocks this session and 1 work item' });
  });

  test('a question on screen is about the item its text shares words with, else none', () => {
    const q = (text, items) => row('alpha', { name: 'q', status: 'waiting', waitingFor: 'question', reason: { kind: 'you', text, since: null }, items });
    expect(face(card(q('Raise the sensor cap readout to 40?', [A5, B9]))).slice(0, 1)).toEqual(['ado:9']);
    expect(face(card(q('Which colour for the badge?', [A5, B9])))).toEqual([null, null, null]);
    // A reported wait with a ref does not name an on-screen prompt's item: the prompt is its own card.
    expect(face(card({ ...q('Which colour for the badge?', [A5, B9]), brief: { ...q('x', [A5, B9]).brief, wait: { on: 'you', what: 'old', ref: 'ado:9', at: NOW - 3 * MIN } } }))).toEqual([null, null, null]);
  });

  test('the resolver is one function: the wait and the asks use the same rule', () => {
    const nodes = M.sessionNodes({ rows: [waitOf('x', [A5, B9])], closed: [], now: NOW });
    const view = M.buildView({ nodes, metaByKey: {}, projects: [], now: NOW, platform: 'win32' });
    const subjects = new Map(view.subjects.map((s) => [s.key, s]));
    expect(N.subjectFor(nodes[0], subjects, { ref: 'ado:5' }).title).toBe('Landscape on a phone');
    expect(N.subjectFor(nodes[0], subjects, { ref: 'ado:99', words: 'Landscape on a phone' })).toBeNull();
    expect(N.subjectFor(nodes[0], subjects, { words: 'Landscape on a phone' }).key).toBe('ado:5');
    expect(N.subjectFor(nodes[0], subjects, {})).toBeNull();
  });
});

test.describe('#548 a card says what it is about: the session\'s one real item', () => {
  // SYNTHETIC copy of the reported row: an orchestrator holding one filed item and a `#0`
  // placeholder (an issue it had not filed yet), asking a decision that names neither.
  const projects = pj.validateProjects([{ id: 'support', name: 'Support', match: { adoProjects: ['Contoso'] } }]).projects;
  const metaByKey = { 'ado:7001': meta('ado:7001', { adoProject: 'Contoso', title: 'Split upgrade not migrated' }) };
  const decision = { question: 'How should the two leftovers be finished so this session can close?',
    context: 'A rule is on a pushed branch, unmerged (review kept finding gaps). A test VM is held for QA.',
    options: [{ label: 'Defer both to a work item' }, { label: 'Land the rule as-is' }], recommended: 0 };
  const REAL = { ref: 'ado:7001', title: 'Split upgrade not migrated', state: 'committed' };
  const PLACEHOLDER = { ref: 'Owner/Repo#0', key: 'owner/repo#0', title: 'Close-out rule', state: 'in-progress' };
  const orchestrator = (items, over = {}) => asking('beta', 'rule branch + test VM: land/defer', 40, { name: '#7001 Split upgrade fix (supervisor)', items,
    wait: { on: 'you', what: 'rule branch + test VM: land/defer', at: NOW - 40 * MIN, decision }, ...over });
  const card = (r, o = {}) => now({ rows: [r], metaByKey, projects, ...o }).answerNow[0];

  test('ONE real item and nothing else matched: the card is about it, with its project; a `#0` placeholder is no item', () => {
    for (const items of [[REAL], [REAL, PLACEHOLDER], [PLACEHOLDER, REAL]]) {
      const c = card(orchestrator(items));
      expect([c.subjectKey, c.ref, c.title, c.project], JSON.stringify(items.map((i) => i.ref))).toEqual(['ado:7001', 'ado:7001', 'Split upgrade not migrated', 'support']);
      // The decision's context rides the card (the face shows its first line).
      expect(c.decision.context).toContain('pushed branch');
      // What it blocks is the real item alone: no `#0` anywhere in the answer.
      expect(c.why.subjects).toEqual(['ado:7001']);
      expect(JSON.stringify(c)).not.toMatch(/#0\b/);
    }
  });

  test('the item can be in any state: a session\'s only item is what its card is about', () => {
    expect(card(orchestrator([{ ...REAL, state: 'done' }])).subjectKey).toBe('ado:7001');
    expect(card(orchestrator([{ ...REAL, state: 'blocked' }])).subjectKey).toBe('ado:7001');
  });

  test('SEVERAL real items and no ref, blocked item or shared words: still no borrowed title', () => {
    const other = { ref: 'ado:7002', title: 'Something unrelated', state: 'in-progress' };
    const c = card(orchestrator([REAL, other, PLACEHOLDER]));
    expect([c.subjectKey, c.ref, c.title, c.project]).toEqual([null, null, null, null]);
    // What it blocks stays every real item (never the placeholder).
    expect(c.why.subjects).toEqual(['ado:7001', 'ado:7002']);
  });

  test('the wait\'s own ref and the shared words still decide first; a ref naming no item of the session is none, never the one item', () => {
    const other = { ref: 'ado:7002', title: 'Something unrelated', state: 'in-progress' };
    const named = orchestrator([REAL, other], { wait: { on: 'you', what: 'x', at: NOW - 40 * MIN, decision, ref: 'ado:7002' } });
    expect(card(named).subjectKey).toBe('ado:7002');
    const missing = orchestrator([REAL], { wait: { on: 'you', what: 'x', at: NOW - 40 * MIN, decision, ref: 'ado:99' } });
    expect(card(missing).subjectKey).toBeNull();
  });

  test('an ask follows the same rule (one resolver)', () => {
    const asked = (items) => {
      const r = row('beta', { name: 'worker', status: 'working', reason: { kind: 'working', text: '' }, items });
      r.brief.asks = [{ id: 'abcd1234', question: 'Which build flavour?', context: 'why', options: [{ label: 'a' }, { label: 'b' }], at: NOW - 5 * MIN, maybeAnswered: false }];
      return now({ rows: [r], metaByKey, projects }).answerNow.find((c) => c.kind === 'ask');
    };
    expect(asked([REAL, PLACEHOLDER])).toMatchObject({ subjectKey: 'ado:7001', title: 'Split upgrade not migrated', project: 'support' });
    expect(asked([REAL, { ref: 'ado:7002', title: 'Other', state: 'in-progress' }])).toMatchObject({ subjectKey: null, title: null });
  });

  test('the resolver: one real item is the subject; a session with none is about none', () => {
    const nodes = M.sessionNodes({ rows: [orchestrator([REAL, PLACEHOLDER])], closed: [], now: NOW });
    const view = M.buildView({ nodes, metaByKey, projects, now: NOW, platform: 'win32' });
    const subjects = new Map(view.subjects.map((s) => [s.key, s]));
    expect(view.subjects.map((s) => s.key)).toEqual(['ado:7001']);
    expect(N.subjectFor(nodes[0], subjects, {}).key).toBe('ado:7001');
    expect(N.subjectFor(nodes[0], subjects, { ref: 'owner/repo#0' })).toBeNull();
    const none = M.sessionNodes({ rows: [orchestrator([PLACEHOLDER])], closed: [], now: NOW });
    expect(N.subjectFor(none[0], new Map(), {})).toBeNull();
  });
});

test.describe('#547 a wait answered in another session is marked "maybe answered elsewhere", and Tell it sends the news', () => {
  const projects = [];
  const decision = { question: 'Route the PR through the release branch or master?', context: 'Both are possible; the child needs one.',
    options: [{ label: 'Release branch' }, { label: 'Master' }], recommended: 0 };
  const ITEM = { ref: 'ado:8001', title: 'Audit port job' };
  const OTHER = { ref: 'ado:8002', title: 'Unrelated reader bug' };
  const WAIT_AT = NOW - 30 * MIN;
  const parentRow = (over = {}) => asking('alpha', 'Child question: PR route', 30, { name: 'parent-orch', items: [ITEM, OTHER],
    wait: { on: 'you', what: 'Child question: PR route', at: WAIT_AT, decision, ref: 'ado:8001' }, ...over });
  const childRow = (parent, over = {}) => row('beta', { name: 'WI 8001 audit port', parentId: parent.id, items: [ITEM], status: 'working',
    reason: { kind: 'working', text: '' }, ...over });
  const typed = (minAgo, text = 'Use the release branch, as option 1') => ({ text, at: NOW - minAgo * MIN });
  const parentCard = (rows) => now({ rows, projects }).answerNow.find((c) => c.sessionName === 'parent-orch');

  test('the owner typed into the CHILD after the parent\'s wait was reported: the parent\'s card says where', () => {
    const p = parentRow();
    const c = childRow(p, { prompt: typed(10) });
    const card = parentCard([p, c]);
    expect(card).toMatchObject({ kind: 'decision', maybeAnswered: true,
      answeredIn: { server: 'beta', serverUrl: 'https://beta.example.test', sessionId: c.id, name: 'WI 8001 audit port', at: NOW - 10 * MIN } });
    // The subject's own card for the same wait carries the same mark (one rule, both screens).
    const nodes = M.sessionNodes({ rows: [p, c], closed: [], now: NOW });
    const view = M.buildView({ nodes, metaByKey: {}, projects, now: NOW, platform: 'win32' });
    expect(view.subjects.find((s) => s.key === 'ado:8001').needsYou).toMatchObject({ maybeAnswered: true, answeredIn: { sessionId: c.id } });
  });

  test('a prompt typed BEFORE the wait was reported, or none at all, marks nothing', () => {
    const p = parentRow();
    for (const prompt of [typed(45), null]) {
      const card = parentCard([p, childRow(p, { prompt })]);
      expect(card.maybeAnswered ?? false).toBe(false);
      expect(card.answeredIn).toBeUndefined();
    }
  });

  test('another session on the SAME item counts (not a child); one on another item does not', () => {
    const p = parentRow();
    const sibling = row('beta', { name: 'reviewer', items: [ITEM], prompt: typed(5) });
    expect(parentCard([p, sibling]).answeredIn).toMatchObject({ sessionId: sibling.id, name: 'reviewer' });
    const stranger = row('beta', { name: 'elsewhere', items: [OTHER], prompt: typed(5) });
    expect(parentCard([p, stranger]).answeredIn).toBeUndefined();
    // The newest prompt names the session.
    const later = row('beta', { name: 'newest', items: [ITEM], prompt: typed(2) });
    expect(parentCard([p, sibling, later]).answeredIn.name).toBe('newest');
  });

  test('only a reported wait or a decision is marked: a question on screen stays a question', () => {
    const q = row('alpha', { name: 'parent-orch', status: 'waiting', waitingFor: 'question', reason: { kind: 'you', text: 'answer a question', since: null }, items: [ITEM] });
    const kid = childRow(q, { prompt: typed(5) });
    const c = now({ rows: [q, kid], projects }).answerNow[0];
    expect(c.kind).toBe('question');
    expect(c.maybeAnswered ?? false).toBe(false);
    expect(c.answeredIn).toBeUndefined();
  });

  test('a marked card ranks after an unmarked one of the same weight, however old', () => {
    const p = parentRow();
    const c = childRow(p, { prompt: typed(10) });
    // Equal weight: each blocks one session and two work items.
    const fresh2 = asking('alpha', 'Which colour?', 2, { name: 'fresh', items: [{ ref: 'ado:8003', title: 'Colour' }, { ref: 'ado:8004', title: 'Shade' }] });
    const eq = now({ rows: [p, c, fresh2], projects }).answerNow;
    expect(eq.map((x) => x.sessionName)).toEqual(['fresh', 'parent-orch']);
  });

  test('Tell it: the fixed message names the session, what the owner typed and its last reply; one line under the gated prompt\'s cap', () => {
    const p = parentRow();
    const c = childRow(p, { prompt: typed(10, 'Use the release branch, as option 1') });
    const card = parentCard([p, c]);
    const text = N.tellText(card, { said: 'Use the release branch, as option 1', reply: 'Done: the PR now targets the release branch.' });
    expect(text).toContain('[Mission Control]');
    expect(text).toContain('may have answered');
    expect(text).toContain('WI 8001 audit port');
    expect(text).toContain('Use the release branch, as option 1');
    expect(text).toContain('the PR now targets the release branch');
    const body = N.tellBody(card, { said: 'Use the release branch, as option 1', reply: 'Done.' });
    expect(body).toMatchObject({ tag: 'supervisor', expectWaitAt: WAIT_AT });
    expect(promptOf(body).error).toBeUndefined();
    // No reply readable: the message still goes, without it.
    expect(N.tellText(card, { said: 'Option 1', reply: null })).not.toMatch(/last reply/i);
  });

  test('Tell it stays inside 511 bytes whatever the names and words hold, with no control character', () => {
    const p = parentRow();
    const c = childRow(p, { prompt: typed(10), name: `${'\u{1F600}'.repeat(80)}\nname` });
    const card = parentCard([p, c]);
    const long = `${'\u{1F4A5}'.repeat(300)}\u001b[31m "quoted"\r\nnext`;
    const body = N.tellBody(card, { said: long, reply: long });
    const r = promptOf(body);
    expect(r.error).toBeUndefined();
    expect(Buffer.byteLength(r.prompt, 'utf8')).toBeLessThanOrEqual(PROMPT_BYTES_MAX);
    expect(body.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    // No lone surrogate: a cut never splits a pair.
    expect(Buffer.from(body.text, 'utf8').toString('utf8')).toBe(body.text);
  });

  test('a session created AFTER the wait was reported (a launch or hand-off prompt is no answer) does not count; one that existed before does', () => {
    const p = parentRow();
    // An orchestrator's launch line, or a successor's `continue`, reaches a NEW session after the wait.
    const born = parentCard([p, childRow(p, { prompt: typed(10), createdAt: WAIT_AT + 5 * MIN })]);
    expect(born.answeredIn).toBeUndefined();
    expect(born.maybeAnswered ?? false).toBe(false);
    expect(parentCard([p, childRow(p, { prompt: typed(10), createdAt: WAIT_AT - MIN })]).answeredIn).toBeDefined();
    // A creation time that is not known fails closed.
    const unknown = childRow(p, { prompt: typed(10) });
    unknown.spawn.createdAt = null;
    expect(parentCard([p, unknown]).answeredIn).toBeUndefined();
  });

  test('Answer now and the subject screen mark the same wait the same way: the pool is the item the WAIT names, never the screen\'s subject', () => {
    const b = row('beta', { name: 'b', items: [ITEM], prompt: typed(5) });
    const screens = (rows) => {
      const nodes = M.sessionNodes({ rows, closed: [], now: NOW });
      const view = M.buildView({ nodes, metaByKey: {}, projects, now: NOW, platform: 'win32' });
      return { view, card: parentCard(rows), on: (key) => view.subjects.find((s) => s.key === key).needsYou };
    };
    // Two items and a wait that names none: its descendants only, on every screen. #546: no item shows
    // it - the view carries it once (`waits`), marked as Answer now marks it.
    const bare = parentRow({ items: [ITEM, OTHER], wait: { on: 'you', what: 'which colour?', at: WAIT_AT } });
    const s1 = screens([bare, b]);
    expect(s1.card.answeredIn).toBeUndefined();
    expect(s1.on('ado:8001')).toBeNull();
    expect(s1.on('ado:8002')).toBeNull();
    expect(s1.view.waits).toHaveLength(1);
    expect(s1.view.waits[0].card.answeredIn).toBeUndefined();
    // The wait names ado:8001: b is on it, so the card is marked - on Answer now and under that subject only (#546).
    const named = parentRow({ items: [ITEM, OTHER] });
    const s2 = screens([named, b]);
    expect(s2.card.answeredIn).toMatchObject({ sessionId: b.id });
    expect(s2.on('ado:8001').answeredIn).toMatchObject({ sessionId: b.id });
    expect(s2.on('ado:8002')).toBeNull();
    // A wait that names nothing, from a session holding ONE real item: that item is the pool, on both.
    const one = parentRow({ items: [ITEM], wait: { on: 'you', what: 'which colour?', at: WAIT_AT } });
    const s3 = screens([one, b]);
    expect(s3.card.answeredIn).toMatchObject({ sessionId: b.id });
    expect(s3.on('ado:8001').answeredIn).toMatchObject({ sessionId: b.id });
  });

  test('the supervisor dispatcher is never marked, and a supervisor session is never the answer', () => {
    const sup = { ...parentRow({ name: 'dispatcher' }), role: 'supervisor' };
    const kid = childRow(sup, { prompt: typed(10) });
    const dispatcher = now({ rows: [sup, kid], projects }).answerNow.find((c) => c.sessionName === 'dispatcher');
    expect(dispatcher).toBeDefined();
    expect(dispatcher.answeredIn).toBeUndefined();
    expect(N.tellPlan(dispatcher)).toMatchObject({ status: 409 });
    const p = parentRow();
    const other = { ...row('beta', { name: 'disp2', items: [ITEM], prompt: typed(5) }), role: 'supervisor' };
    expect(parentCard([p, other]).answeredIn).toBeUndefined();
    // A closed session's record carries no prompt, so it never answers either.
    const gone = M.sessionNodes({ rows: [], closed: [{ id: 'dead-1', name: 'gone', server: 'beta', items: [ITEM], closedAt: NOW - MIN }], now: NOW });
    expect(gone.every((x) => x.promptAt === null)).toBe(true);
  });

  test('zero-width and bidirectional controls in another agent\'s words never reach the line', () => {
    const p = parentRow();
    const card = parentCard([p, childRow(p, { prompt: typed(10) })]);
    const evil = 'ab' + String.fromCodePoint(0x202e) + 'cd' + String.fromCodePoint(0x200b) + 'ef' + String.fromCodePoint(0xfeff) + String.fromCodePoint(0x2066) + 'g' + String.fromCodePoint(0xad);
    const text = N.tellText(card, { said: evil, reply: evil });
    expect(text).toContain('abcdefg');
    for (const cp of [0x202e, 0x200b, 0xfeff, 0x2066, 0xad]) expect(text.includes(String.fromCodePoint(cp))).toBe(false);
  });

  test('tellPlan: only a card still marked is told; a card that is gone is a 404, an unmarked one a 409', () => {
    const p = parentRow();
    const card = parentCard([p, childRow(p, { prompt: typed(10) })]);
    expect(N.tellPlan(card)).toEqual({ send: true });
    expect(N.tellPlan(undefined)).toMatchObject({ status: 404 });
    const plain = parentCard([p, childRow(p)]);
    expect(N.tellPlan(plain)).toMatchObject({ status: 409 });
    expect(N.tellInput({ cardId: 'a|b|c' })).toEqual({ cardId: 'a|b|c' });
    expect(N.tellInput({}).error).toContain('cardId');
    expect(N.tellInput(null).error).toContain('JSON object');
  });

  test('the answer shape: delivered, refused with the reason in words, or maybe landed', () => {
    expect(N.tellAnswer({ delivered: true })).toEqual({ delivered: true });
    expect(N.tellAnswer({ why: 'draft' })).toMatchObject({ delivered: false, refused: 'draft', reason: expect.stringContaining('unsent text') });
    expect(N.tellAnswer({ uncertain: true })).toMatchObject({ delivered: false, uncertain: true });
  });
});
