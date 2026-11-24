// @ts-check
// #532 - the supervisor's dispatcher is the fleet's supervisor, not one of its sessions: Mission
// Control's lists and counts leave it out, but what it needs from the owner (a `you` wait, its
// asks) stays an Answer-now card. The row says so with `role: 'supervisor'` (server.js
// supervisorRowFields); lib/mc-subjects.js is the one place that reads it. Pure.
const { test, expect } = require('@playwright/test');
const M = require('../lib/mc-subjects');
const N = require('../lib/mc-needs');

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;
const ITEM = { ref: 'ado:7', key: 'ado:7', title: 'Seven', state: 'in-progress', note: '', stage: null, source: 'agent', url: null };
const DECISION = { question: 'Which fix do we take?', context: 'two ways, one is riskier', options: [{ label: 'Small' }, { label: 'Rewrite' }], recommended: 0 };

function row({ id = 'u-0000-4000-8000-000000000001', name = 'worker', role = null, status = 'working', reason = { kind: 'working', text: '' }, wait = null, asks = [], items = [ITEM], cwd = 'C:\\dev\\widgets' } = {}) {
  return {
    id, name, status, reason, waitingFor: null, cwd, server: 'alpha', serverUrl: null, lastActivity: NOW - 5 * MIN,
    ...(role ? { role } : {}),
    brief: { items, headline: null, reportAt: NOW - 30 * MIN, wait, asks, possibleAsk: null, turnAt: NOW - 40 * MIN },
    spawn: { parentId: null, replaces: [], createdAt: NOW - 120 * MIN },
  };
}
const DISPATCHER = { id: 'd-0000-4000-8000-000000000009', name: 'web-terminal supervisor', role: 'supervisor' };
const youWait = { on: 'you', what: 'a case it cannot settle', at: NOW - 5 * MIN, decision: DECISION };

function viewOf(rows) {
  const nodes = M.sessionNodes({ rows, closed: [], now: NOW });
  return { nodes, view: M.buildView({ nodes, metaByKey: {}, projects: [], now: NOW, platform: 'win32' }) };
}
function nowOf(rows) {
  const { nodes, view } = viewOf(rows);
  return N.buildNow({ nodes, view, now: NOW });
}

test.describe('#532 the dispatcher is a row that is not a session', () => {
  test('the node carries the role; an ordinary row and a closed record carry none', () => {
    const nodes = M.sessionNodes({ rows: [row({ ...DISPATCHER }), row({ id: 'o-0000-4000-8000-000000000002', name: 'other' })],
      closed: [{ server: 'alpha', serverUrl: null, rec: { id: 'c-0000-4000-8000-000000000003', name: 'gone', at: NOW - MIN, items: [], spawn: {} }, origin: null }], now: NOW });
    expect(nodes.map((n) => [n.name, n.role])).toEqual([['web-terminal supervisor', 'supervisor'], ['other', null], ['gone', null]]);
    expect(M.isSupervisor(nodes[0])).toBe(true);
    expect(M.isSupervisor(nodes[1])).toBe(false);
    expect(M.isSupervisor(null)).toBe(false);
  });

  test('a subject and a run leave it out: only the dispatcher reports on item 7 -> no subject', () => {
    const { view } = viewOf([row({ ...DISPATCHER, items: [ITEM] })]);
    expect(view.subjects).toEqual([]);
    expect(view.runs).toEqual([]);
  });

  test('a subject another session shares lists that session alone', () => {
    const w = row({ id: 'o-0000-4000-8000-000000000002', name: 'worker' });
    const { view } = viewOf([row({ ...DISPATCHER }), w]);
    expect(view.subjects).toHaveLength(1);
    expect(view.subjects[0].sessions.map((s) => s.name)).toEqual(['worker']);
  });

  test('moving counts leave it out: a working dispatcher is not one of the sessions moving on their own', () => {
    const n = nowOf([row({ ...DISPATCHER }), row({ id: 'o-0000-4000-8000-000000000002', name: 'worker' })]);
    expect(n.moving).toEqual({ working: 1, idle: 0, total: 1 });
  });
});

test.describe('#532 what the dispatcher needs from the owner is still an Answer-now card', () => {
  test('its `you` wait (a decision it escalated) is ONE card, naming the dispatcher', () => {
    const d = row({ ...DISPATCHER, status: 'idle', reason: { kind: 'you', text: 'a case it cannot settle' }, wait: youWait });
    const n = nowOf([d]);
    expect(n.answerNow).toHaveLength(1);
    expect(n.answerNow[0]).toMatchObject({ kind: 'decision', sessionName: 'web-terminal supervisor', sessionId: DISPATCHER.id, server: 'alpha', blocking: true });
    expect(n.answerNow[0].decision).toMatchObject({ question: DECISION.question });
    // ...and still no session of the lists: nothing is moving, nothing is a subject.
    expect(n.moving.total).toBe(0);
    expect(viewOf([d]).view.subjects).toEqual([]);
  });

  test('its asks are cards too, one per decision, none of them blocking', () => {
    const ask = (q) => ({ id: q, question: q, context: 'c', options: [{ label: 'A' }, { label: 'B' }], at: NOW - 20 * MIN, maybeAnswered: false });
    const n = nowOf([row({ ...DISPATCHER, asks: [ask('first?'), ask('second?')] })]);
    expect(n.answerNow.map((c) => [c.kind, c.sessionName, c.blocking, c.supervisor])).toEqual([
      ['ask', 'web-terminal supervisor', false, true], ['ask', 'web-terminal supervisor', false, true]]);
    expect(n.moving.total).toBe(0);
  });

  test('a card of the dispatcher ranks with the others: a wait on the owner of an ordinary session is not pushed behind it', () => {
    const d = row({ ...DISPATCHER, status: 'idle', reason: { kind: 'you', text: 'x' }, wait: youWait });
    const w = row({ id: 'o-0000-4000-8000-000000000002', name: 'worker', status: 'idle', reason: { kind: 'you', text: 'go' }, wait: { on: 'you', what: 'go', at: NOW - 2 * MIN } });
    const n = nowOf([d, w]);
    expect(n.answerNow.map((c) => c.sessionName).sort()).toEqual(['web-terminal supervisor', 'worker']);
  });

  test('a to-do made from it parks nothing: the dispatcher is not told to carry on by a park message', () => {
    const d = row({ ...DISPATCHER, status: 'idle', reason: { kind: 'you', text: 'x' }, wait: youWait });
    const [card] = nowOf([d]).answerNow;
    expect(card.supervisor).toBe(true);
    const t = N.newTodo(card, { id: 't1', text: null, now: NOW });
    expect(t.park).toMatchObject({ state: 'none', why: 'supervisor' });
    // An ordinary session's card is not marked, and its park is still sent.
    const w = row({ id: 'o-0000-4000-8000-000000000002', name: 'worker', status: 'idle', reason: { kind: 'you', text: 'go' }, wait: { on: 'you', what: 'go', at: NOW - 2 * MIN, decision: DECISION } });
    const [wc] = nowOf([w]).answerNow;
    expect(wc.supervisor).toBe(false);
    expect(N.newTodo(wc, { id: 't2', text: null, now: NOW }).park.state).toBe('sending');
  });
});

test.describe('#532 server wiring (source gate)', () => {
  test('the project counts are made from the rows that are not the dispatcher', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function _computeMcView'), src.indexOf('function cachedMcView'));
    expect(fn).toContain('rows.filter((s) => !mcSubjects.isSupervisor(s))');
  });
});
