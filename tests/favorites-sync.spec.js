// @ts-check
// #60 — a favorite is a SERVER-side property of the session (exactly like
// notifyLevel), not per-browser localStorage. This spec pins that SSOT: the
// route contract, the rank round-trip that gives the pinned group its order,
// auth, exposure on BOTH session lists (so a peer's pins ride the cluster
// payload), the on-disk store, and pruning.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx, noAuthCtx } = require('./test-helpers');

const FAV_FILE = path.join(__dirname, '..', 'favorites.json');
/** The store as it actually sits on disk — the "survives a re-read" check. */
function readFavFile() {
  try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { return {}; }
}

/** The pinned group's order, derived the way a client derives it. */
function pinnedOrder(sessions, only) {
  return sessions
    .filter(s => s.favorite && (!only || only.includes(s.id)))
    .sort((a, b) => (a.favoriteRank - b.favoriteRank) || (a.id < b.id ? -1 : 1))
    .map(s => s.id);
}

async function createSessions(ctx, names) {
  const ids = [];
  for (const name of names) {
    const r = await ctx.post('/api/sessions', { data: { name } });
    ids.push((await r.json()).id);
  }
  return ids;
}
async function killSessions(ids) {
  const ctx = await authCtx();
  for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
  await ctx.dispose();
}

test.describe('#60 favorites: server-side store', () => {
  test('PATCH a favorite then re-fetch — flag + rank round-trip, and it is on /api/sessions', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav SSOT']);
    try {
      // Default: a session is not favorited and has no rank.
      const before = await (await ctx.get(`/api/sessions/${id}/favorite`)).json();
      expect(before).toEqual({ id, favorite: false, favoriteRank: null });

      const res = await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 3 } });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ id, favorite: true, favoriteRank: 3 });

      // Re-fetch: the server, not the caller, is the one remembering it.
      const after = await (await ctx.get(`/api/sessions/${id}/favorite`)).json();
      expect(after).toEqual({ id, favorite: true, favoriteRank: 3 });

      // …and it rides on the session list every client already polls.
      const list = await (await ctx.get('/api/sessions')).json();
      const row = list.find(s => s.id === id);
      expect(row.favorite).toBe(true);
      expect(row.favoriteRank).toBe(3);
    } finally {
      await ctx.dispose();
      await killSessions([id]);
    }
  });

  test('rank order survives a re-fetch — the pinned group order round-trips', async () => {
    const ctx = await authCtx();
    const ids = await createSessions(ctx, ['Rank A', 'Rank B', 'Rank C']);
    const [a, b, c] = ids;
    try {
      // Deliberately NOT creation order: C, A, B.
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: 0 } });
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: 1 } });
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: 2 } });

      const list = await (await ctx.get('/api/sessions')).json();
      expect(pinnedOrder(list, ids)).toEqual([c, a, b]);

      // A reorder = PATCHing the ranks of the rows that moved (B to the front).
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: 0 } });
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: 1 } });
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: 2 } });

      const list2 = await (await ctx.get('/api/sessions')).json();
      expect(pinnedOrder(list2, ids)).toEqual([b, c, a]);
    } finally {
      await ctx.dispose();
      await killSessions(ids);
    }
  });

  test('the store is persisted to disk (survives a re-read), and unfavoriting removes it', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav Disk']);
    try {
      await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 7 } });
      expect(readFavFile()[id]).toBe(7);

      const off = await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: false } });
      expect(await off.json()).toEqual({ id, favorite: false, favoriteRank: null });
      expect(readFavFile()[id]).toBeUndefined();

      const list = await (await ctx.get('/api/sessions')).json();
      const row = list.find(s => s.id === id);
      expect(row.favorite).toBe(false);
      expect(row.favoriteRank).toBeNull();
    } finally {
      await ctx.dispose();
      await killSessions([id]);
    }
  });

  test('favorite + favoriteRank are exposed on /api/cluster/sessions', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav Cluster']);
    try {
      await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 2 } });
      const data = await (await ctx.get('/api/cluster/sessions')).json();
      const row = data.sessions.find(s => s.id === id);
      expect(row.favorite).toBe(true);
      expect(row.favoriteRank).toBe(2);
    } finally {
      await ctx.dispose();
      await killSessions([id]);
    }
  });

  test('killing a session prunes its favorite (no orphan pins)', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav Prune']);
    try {
      await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 0 } });
      expect(readFavFile()[id]).toBe(0);
      await ctx.delete(`/api/sessions/${id}`);
      await expect.poll(() => readFavFile()[id], { timeout: 8000 }).toBeUndefined();
    } finally {
      await ctx.dispose();
    }
  });

  test('unauthenticated PATCH is rejected and writes nothing', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav Auth']);
    const anon = await noAuthCtx();
    try {
      const res = await anon.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 0 } });
      expect(res.status()).toBe(401);
      expect(readFavFile()[id]).toBeUndefined();

      const anonGet = await anon.get(`/api/sessions/${id}/favorite`);
      expect(anonGet.status()).toBe(401);

      const still = await (await ctx.get(`/api/sessions/${id}/favorite`)).json();
      expect(still.favorite).toBe(false);
    } finally {
      await anon.dispose();
      await ctx.dispose();
      await killSessions([id]);
    }
  });

  test('a malformed body or a non-session id is rejected, and never becomes a stored key', async () => {
    const ctx = await authCtx();
    const [id] = await createSessions(ctx, ['Fav Guard']);
    try {
      expect((await ctx.patch(`/api/sessions/${id}/favorite`, { data: {} })).status()).toBe(400);
      expect((await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: 'yes' } })).status()).toBe(400);
      expect((await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: -1 } })).status()).toBe(400);
      expect((await ctx.patch(`/api/sessions/${id}/favorite`, { data: { favorite: true, rank: 'top' } })).status()).toBe(400);

      // Session ids are UUIDs — anything else can never land in the store.
      const bogus = await ctx.patch('/api/sessions/__proto__/favorite', { data: { favorite: true, rank: 0 } });
      expect(bogus.status()).toBe(404);
      expect(Object.prototype.hasOwnProperty.call(readFavFile(), '__proto__')).toBe(false);

      expect(readFavFile()[id]).toBeUndefined();
    } finally {
      await ctx.dispose();
      await killSessions([id]);
    }
  });

  test('a favorite with no rank appends after the existing ones', async () => {
    const ctx = await authCtx();
    const ids = await createSessions(ctx, ['App A', 'App B']);
    const [a, b] = ids;
    try {
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: 5 } });
      const res = await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true } });
      const body = await res.json();
      expect(body.favorite).toBe(true);
      expect(body.favoriteRank).toBeGreaterThan(5);   // appended, never colliding with A
    } finally {
      await ctx.dispose();
      await killSessions(ids);
    }
  });

  // BUG 1 — rank allocation must need NO global knowledge.
  //
  // An "index" rank (max + 1) can only ever be computed from a PARTIAL view: no server
  // holds another server's sessions, and a client can only see the peers that are UP.
  // So a pin made while a peer is offline reuses a rank that peer already holds, and the
  // pinned group silently rearranges when it reconnects. A wall-clock timestamp needs no
  // coordination — that is the whole point, and it is what this pins.
  test('a new pin is ranked by WALL CLOCK, so it can never reuse an offline peer\'s rank', async () => {
    const ctx = await authCtx();
    const ids = await createSessions(ctx, ['Clock A', 'Clock B']);
    const [a, b] = ids;
    try {
      const t0 = Date.now();
      const rankA = (await (await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true } })).json()).favoriteRank;
      const rankB = (await (await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true } })).json()).favoriteRank;

      // A timestamp — not 0, not "one past the biggest rank I happen to be able to see".
      expect(rankA).toBeGreaterThanOrEqual(t0);
      expect(rankA).toBeLessThan(t0 + 60000);
      // Strictly increasing even inside the same millisecond, so an append is an append.
      expect(rankB).toBeGreaterThan(rankA);
    } finally {
      await ctx.dispose();
      await killSessions(ids);
    }
  });

  // BUG 4 — a mixed fleet is the NORMAL state (the boxes upgrade one at a time), so a
  // client must be able to ask "can the server that owns this session even take this
  // write?" BEFORE it offers the star. That answer is a capability, and it has to reach
  // the client on the payload it already polls.
  test('favorites-sync is advertised as a capability — on /api/version and on the cluster servers[]', async () => {
    const ctx = await authCtx();
    try {
      const caps = (await (await ctx.get('/api/version')).json()).capabilities || [];
      expect(caps).toContain('favorites-sync');

      // …and the same list rides on each servers[] entry of the cluster payload, which is
      // where a browser learns what the OWNING server of a remote session can do.
      const data = await (await ctx.get('/api/cluster/sessions')).json();
      const local = data.servers.find(s => s.url === null);
      expect(Array.isArray(local.capabilities)).toBe(true);
      expect(local.capabilities).toContain('favorites-sync');
    } finally {
      await ctx.dispose();
    }
  });
});
