// #558 - a session's parent changes after creation: PATCH /api/sessions/:id/parent moves one
// session, POST /api/sessions/:id/children/move hands a session's children to another. The
// store (lib/spawn-store.js assign) and the move rules (lib/session-family.js) are pinned
// first; the last block drives the real server: the family the clients read
// (`spawn.parentId` on GET /api/sessions) is what moved.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { authCtx } = require('./test-helpers');
const { createSpawnStore } = require('../lib/spawn-store');
const F = require('../lib/session-family');

const A = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const Q = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';

test.describe('#558 spawn-store assign - an assigned parent beats every other source', () => {
  let file;
  test.beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-558-')), 'spawned.json'); });
  const store = (o = {}) => createSpawnStore({ file, log: () => {}, ...o });

  test('it replaces the parent a session was opened with, and null detaches it', () => {
    const st = store();
    st.created(A, 'x', P);
    expect(st.assign(A, Q)).toBe(true);
    expect(st.field(A).parentId).toBe(Q);
    expect(st.assign(A, null)).toBe(true);
    // Explicit "no parent": the creation-time parent does NOT come back.
    expect(st.field(A).parentId).toBeNull();
  });

  test('a session with NO verdict (restored, opened by hand) can be given a parent', () => {
    const st = store();
    expect(st.field(A)).toBeNull();
    expect(st.assign(A, P)).toBe(true);
    expect(st.field(A)).toMatchObject({ by: null, parentId: P, replaces: [] });
  });

  test('it survives a restart (a fresh store over the same file)', () => {
    store().assign(A, P.toUpperCase());
    expect(store().field(A).parentId).toBe(P);
    const st = store();
    st.assign(A, null);
    expect(store().field(A).parentId).toBeNull();
  });

  test('itself or junk is refused and nothing is written', () => {
    const st = store();
    st.created(A, 'x', P);
    expect(st.assign(A, A)).toBe(false);
    expect(st.assign(A, 'nope')).toBe(false);
    expect(st.field(A).parentId).toBe(P);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('a traced parent (#377) never replaces an assigned one', () => {
    const st = store();
    st.created(A, 'x', null);
    st.assign(A, null);
    expect(st.setParent(A, P)).toBe(false);
    expect(st.field(A).parentId).toBeNull();
  });

  test('a hand-off successor keeps the ASSIGNED parent', () => {
    const st = store();
    st.created(A, 'x', P);
    st.assign(A, Q);
    st.inherit(A, S);
    expect(st.field(S)).toMatchObject({ parentId: Q, replaces: [A] });
  });

  test('forget and prune drop it; a junk entry on disk falls back to the other sources', () => {
    const st = store();
    st.assign(A, P);
    st.forget(A);
    expect(st.field(A)).toBeNull();
    st.assign(A, P);
    st.prune(new Set(), Date.now() + 1000);
    expect(st.field(A)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ _parents: { [A]: { parentId: 'junk', at: 1 }, [Q]: { parentId: Q, at: 1 }, [S]: { parentId: null, at: 1 } } }));
    const fresh = store();
    expect(fresh.field(A)).toBeNull(); // junk is no "no parent": the entry is dropped
    expect(fresh.field(Q)).toBeNull(); // itself
    expect(fresh.field(S)).toMatchObject({ parentId: null });
  });
});

// rows as the cluster list carries them
const row = (id, parentId = null, replaces = [], o = {}) => ({ id, name: id.slice(0, 4), spawn: { parentId, replaces }, ...o });

test.describe('#558 moveRefusal - where a session may go', () => {
  // L leads K1 and K2; K1 leads G. L2 replaced L0 (a hand-off).
  const L = 'a0000000-0000-4000-8000-000000000001';
  const K1 = 'a0000000-0000-4000-8000-000000000002';
  const K2 = 'a0000000-0000-4000-8000-000000000003';
  const G = 'a0000000-0000-4000-8000-000000000004';
  const L0 = 'a0000000-0000-4000-8000-000000000005';
  const L2 = 'a0000000-0000-4000-8000-000000000006';
  const rows = [row(L), row(K1, L), row(K2, L), row(G, K1), row(L2, null, [L0])];
  const tree = F.familyOf(rows);

  test('a sibling, a stranger or no parent at all is fine', () => {
    expect(F.moveRefusal(tree, K2, K1)).toBeNull();
    expect(F.moveRefusal(tree, K1, L2)).toBeNull();
    expect(F.moveRefusal(tree, G, null)).toBeNull();
  });
  test('an unknown parent is refused (404), never stored as a dangling link', () => {
    expect(F.moveRefusal(tree, K1, 'b0000000-0000-4000-8000-000000000009')).toMatchObject({ status: 404 });
  });
  test('itself, or an id it replaced, is refused (409)', () => {
    expect(F.moveRefusal(tree, L, L)).toMatchObject({ status: 409 });
    expect(F.moveRefusal(tree, L2, L0)).toMatchObject({ status: 409 });
  });
  test('a descendant at ANY depth is a loop (409)', () => {
    expect(F.moveRefusal(tree, L, K1)).toMatchObject({ status: 409 });
    expect(F.moveRefusal(tree, L, G)).toMatchObject({ status: 409 });
    // The negative: G is not under K2, so K2 may go under G.
    expect(F.moveRefusal(tree, K2, G)).toBeNull();
  });
  test('a replaced id resolves to the session that replaced it', () => {
    expect(tree.resolve(L0).id).toBe(L2);
    expect(F.moveRefusal(tree, K1, L0)).toBeNull();
  });
});

test.describe('#558 childrenToMove - which sessions are handed over', () => {
  const L = 'c0000000-0000-4000-8000-000000000001';
  const K1 = 'c0000000-0000-4000-8000-000000000002';
  const K2 = 'c0000000-0000-4000-8000-000000000003';
  const G = 'c0000000-0000-4000-8000-000000000004';
  const OLD = 'c0000000-0000-4000-8000-000000000005';
  const GONE = 'c0000000-0000-4000-8000-000000000006';
  const O1 = 'c0000000-0000-4000-8000-000000000007';
  // K2 still names L's OLD id (L replaced OLD); O1's parent GONE has closed.
  const rows = [row(L, null, [OLD]), row(K1, L), row(K2, OLD), row(G, K1), row(O1, GONE)];
  const tree = F.familyOf(rows);
  const ids = (r) => r.children.map((c) => c.id).sort();

  test('every DIRECT child, including one that names a replaced id - never a grandchild', () => {
    expect(ids(F.childrenToMove(tree, rows, L))).toEqual([K1, K2].sort());
    expect(ids(F.childrenToMove(tree, rows, OLD))).toEqual([K1, K2].sort());
  });
  test('a closed parent still hands over the sessions that name it', () => {
    expect(ids(F.childrenToMove(tree, rows, GONE))).toEqual([O1]);
  });
  test('a subset, and a session that is not a child is refused', () => {
    expect(ids(F.childrenToMove(tree, rows, L, [K2]))).toEqual([K2]);
    expect(F.childrenToMove(tree, rows, L, [G])).toMatchObject({ ok: false, status: 400 });
  });
  test('the children list shape', () => {
    expect(F.childrenListOf(undefined)).toEqual({ ok: true, ids: null });
    expect(F.childrenListOf([K1.toUpperCase()])).toEqual({ ok: true, ids: [K1] });
    expect(F.childrenListOf([])).toMatchObject({ ok: false });
    expect(F.childrenListOf(['x'])).toMatchObject({ ok: false });
    expect(F.childrenListOf(K1)).toMatchObject({ ok: false });
    expect(F.childrenListOf(Array(F.CHILDREN_MAX + 1).fill(K1))).toMatchObject({ ok: false });
  });
  test('the answer status', () => {
    expect(F.moveStatus([], [])).toBe(200);
    expect(F.moveStatus([{}], [])).toBe(200);
    expect(F.moveStatus([], [{ status: 409 }])).toBe(409);
    expect(F.moveStatus([{}], [{ status: 409 }])).toBe(207);
    expect(F.moveStatus([], [{ status: 409 }, { status: 404 }])).toBe(502);
  });
});

test.describe('#558 against the real server', () => {
  test.setTimeout(60000);

  test('move one session, refuse a loop, hand the children over, detach', async () => {
    const ctx = await authCtx();
    const made = [];
    const stamp = Date.now();
    const mk = async (name, extra = {}) => {
      const r = await ctx.post('/api/sessions', { data: { name: `${name}-${stamp}`, ...extra } });
      expect(r.status()).toBe(200);
      const id = (await r.json()).id;
      made.push(id);
      return id;
    };
    const parentOf = async (id) => {
      const list = await (await ctx.get('/api/sessions')).json();
      const s = list.find((x) => x.id === id);
      return s && s.spawn ? s.spawn.parentId : null;
    };
    const patch = (id, parentId) => ctx.patch(`/api/sessions/${id}/parent`, { data: { parentId } });
    try {
      const v = await (await ctx.get('/api/version')).json();
      expect(v.capabilities).toContain('session-parent');

      const lead = await mk('pt558-lead');
      const other = await mk('pt558-other');
      const kid = await mk('pt558-kid', { parentId: lead });
      const kid2 = await mk('pt558-kid2', { parentId: lead });
      expect(await parentOf(kid)).toBe(lead);

      // One session moves.
      let r = await patch(kid, other);
      expect(r.status()).toBe(200);
      expect(await r.json()).toMatchObject({ id: kid, parentId: other });
      expect(await parentOf(kid)).toBe(other);

      // Refusals: a loop, itself, an unknown parent, a bad body, an unknown session.
      expect((await patch(other, kid)).status()).toBe(409);
      expect((await patch(kid, kid)).status()).toBe(409);
      expect((await patch(kid, 'e0000000-0000-4000-8000-00000000dead')).status()).toBe(404);
      expect((await patch(kid, 'nope')).status()).toBe(400);
      expect((await ctx.patch(`/api/sessions/${kid}/parent`, { data: {} })).status()).toBe(400);
      expect((await patch('e0000000-0000-4000-8000-00000000beef', other)).status()).toBe(404);
      expect(await parentOf(kid)).toBe(other);

      // Hand-over: the lead's remaining child goes to `other`.
      r = await ctx.post(`/api/sessions/${lead}/children/move`, { data: { to: other } });
      expect(r.status()).toBe(200);
      const j = await r.json();
      expect(j.moved.map((m) => m.id)).toEqual([kid2]);
      expect(j.failed).toEqual([]);
      expect(await parentOf(kid2)).toBe(other);

      // A subset back to the lead; a non-child named is refused and nothing moves.
      expect((await ctx.post(`/api/sessions/${other}/children/move`, { data: { to: lead, children: [lead] } })).status()).toBe(400);
      r = await ctx.post(`/api/sessions/${other}/children/move`, { data: { to: lead, children: [kid] } });
      expect(r.status()).toBe(200);
      expect(await parentOf(kid)).toBe(lead);
      expect(await parentOf(kid2)).toBe(other);

      // Moving the children under one of themselves is a loop for that child only.
      r = await ctx.post(`/api/sessions/${other}/children/move`, { data: { to: kid2 } });
      expect(r.status()).toBe(409);
      expect((await r.json()).failed.map((f) => f.id)).toEqual([kid2]);

      // Detach.
      r = await patch(kid, null);
      expect(r.status()).toBe(200);
      expect(await parentOf(kid)).toBeNull();
    } finally {
      for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
      await ctx.dispose();
    }
  });
});
