// @ts-check
// Favorites feature (UI): a star toggle on each session row plus a pinned
// "Favorites" group at the top of the sidebar that spans all servers and badges
// each favorite with the server it lives on.
//
// #60: the star is no longer per-browser localStorage — it writes the SERVER-side
// favorite/rank of the session (see favorites-sync.spec.js for the route/SSOT
// contract). These tests therefore assert the SERVER's state after a UI action,
// and seed state through the API, not through localStorage.
const { test, expect } = require('@playwright/test');
const { BASE, authCtx, loginPage } = require('./test-helpers');

/** The server's view of one session's pin. */
async function favOf(ctx, id) {
  return (await ctx.get(`/api/sessions/${id}/favorite`)).json();
}
/** DOM order of the pinned group, restricted to the ids this test owns. */
async function pinnedIds(page, ids) {
  const dom = await page.$$eval('.sb-fav-item', els => els.map(e => e.getAttribute('data-fav-id')));
  return dom.filter(id => ids.includes(id));
}
/** Native HTML5 drag-and-drop: drop `srcId` onto the TOP half of `tgtId` (i.e. above it). */
async function dragFav(page, srcId, tgtId) {
  await page.evaluate(({ srcId, tgtId }) => {
    const src = document.querySelector(`.sb-fav-item[data-fav-id="${srcId}"]`);
    const tgt = document.querySelector(`.sb-fav-item[data-fav-id="${tgtId}"]`);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = tgt.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 2 };
    tgt.dispatchEvent(new DragEvent('dragover', opts));
    tgt.dispatchEvent(new DragEvent('drop', opts));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, { srcId, tgtId });
}

test.describe('Sidebar UI: favorites', () => {
  test('starring a session pins it, writes the server, and persists across a reload', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Target' } });
    const created = (await r.json()).id;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      // Not favorited on the server yet.
      expect((await favOf(ctx, created)).favorite).toBe(false);

      // Star it.
      await row.locator('.sb-star').click();

      // Favorites group shows a pinned copy carrying a server badge.
      await expect(page.locator('.sb-fav-header')).toHaveCount(1);
      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();
      const badge = favItem.locator('.sb-server-badge');
      await expect(badge).toBeVisible();
      expect((await badge.textContent() || '').trim().length).toBeGreaterThan(0);

      // The SERVER now holds the pin (this is what makes it show up on the phone).
      await expect.poll(async () => (await favOf(ctx, created)).favorite, { timeout: 5000 }).toBe(true);
      expect((await favOf(ctx, created)).favoriteRank).toBeGreaterThanOrEqual(0);

      // This browser keeps no copy of its own.
      expect(await page.evaluate(() => localStorage.getItem('wt.favorites'))).toBeNull();

      // Persists across reload — read back from the server, not from localStorage.
      await page.reload();
      await expect(page.locator(`.sb-fav-item[data-fav-id="${created}"]`)).toBeVisible({ timeout: 5000 });
    } finally {
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  test('unfavoriting from the Favorites group removes the pin on the server', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Toggle' } });
    const created = (await r.json()).id;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      await row.locator('.sb-star').click();
      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();
      await expect.poll(async () => (await favOf(ctx, created)).favorite, { timeout: 5000 }).toBe(true);

      // Click the filled star inside the favorites pin to remove it.
      await favItem.locator('.sb-star').click();
      await expect(page.locator(`.sb-fav-item[data-fav-id="${created}"]`)).toHaveCount(0);
      await expect.poll(async () => (await favOf(ctx, created)).favorite, { timeout: 5000 }).toBe(false);
    } finally {
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  test('favorites render in the order the server ranks them', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const ids = [];
    for (const n of ['Ord A', 'Ord B', 'Ord C']) {
      const r = await ctx.post('/api/sessions', { data: { name: n } });
      ids.push((await r.json()).id);
    }
    const [a, b, c] = ids;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      // Seed a deliberately non-creation order on the SERVER: C, A, B.
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: 0 } });
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: 1 } });
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: 2 } });

      await page.goto(BASE + '/');
      await page.waitForSelector('.sb-fav-item', { timeout: 5000 });
      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([c, a, b]);
    } finally {
      for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('dragging a favorite reorders it and writes the new ranks to the server', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const ids = [];
    for (const n of ['Drag A', 'Drag B', 'Drag C']) {
      const r = await ctx.post('/api/sessions', { data: { name: n } });
      ids.push((await r.json()).id);
    }
    const [a, b, c] = ids;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: 0 } });
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: 1 } });
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: 2 } });

      await page.goto(BASE + '/');
      await page.waitForSelector(`.sb-fav-item[data-fav-id="${c}"]`, { timeout: 5000 });
      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([a, b, c]);

      // Simulate native HTML5 drag-and-drop: drag C onto the top half of A.
      await dragFav(page, c, a);

      // C dropped above A → C, A, B — in the DOM immediately…
      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([c, a, b]);

      // …and on the SERVER, as ranks (this is what syncs the order to other devices).
      await expect.poll(async () => {
        const list = await (await ctx.get('/api/sessions')).json();
        return list.filter(s => s.favorite && ids.includes(s.id))
          .sort((x, y) => x.favoriteRank - y.favoriteRank).map(s => s.id);
      }, { timeout: 5000 }).toEqual([c, a, b]);
    } finally {
      for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('clicking a favorite row switches to that session', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Switch' } });
    const created = (await r.json()).id;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });
      await row.locator('.sb-star').click();

      const favItem = page.locator(`.sb-fav-item[data-fav-id="${created}"]`);
      await expect(favItem).toBeVisible();
      // Click the row body (not the star) — should activate the session.
      await favItem.locator('.sb-name').click();
      await expect(page.locator('#sessionName')).toContainText('Fav Switch', { timeout: 8000 });
    } finally {
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  // #60 migration: the pre-upgrade per-browser list is pushed UP to the server on
  // first load — in its stored order — and then stops being a source of truth.
  test('an existing localStorage favorites list is migrated to the server on first load', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const ids = [];
    for (const n of ['Mig A', 'Mig B']) {
      const r = await ctx.post('/api/sessions', { data: { name: n } });
      ids.push((await r.json()).id);
    }
    const [a, b] = ids;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      await page.waitForSelector('.sb-item', { timeout: 5000 });
      // The old world: an ordered array of ids in localStorage, nothing on the server.
      expect((await favOf(ctx, a)).favorite).toBe(false);
      await page.evaluate((order) => localStorage.setItem('wt.favorites', JSON.stringify(order)), [b, a]);
      await page.reload();

      // The pins now exist ON THE SERVER, in the local list's order.
      await expect.poll(async () => {
        const list = await (await ctx.get('/api/sessions')).json();
        return list.filter(s => s.favorite && ids.includes(s.id))
          .sort((x, y) => x.favoriteRank - y.favoriteRank).map(s => s.id);
      }, { timeout: 8000 }).toEqual([b, a]);

      // …the sidebar renders them from the server…
      await expect.poll(() => pinnedIds(page, ids), { timeout: 8000 }).toEqual([b, a]);

      // …and the local list is gone: it must not survive as a second truth.
      await expect.poll(() => page.evaluate(() => localStorage.getItem('wt.favorites')), { timeout: 8000 }).toBeNull();
    } finally {
      for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  // BUG 1 (client half) — the browser must not invent a rank out of the peers it happens
  // to be able to see. It sends NO rank; the owning server stamps a wall clock.
  test('starring sends no rank — the owning server stamps a wall-clock one', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Fav Clock' } });
    const created = (await r.json()).id;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await page.goto(BASE + '/');
      const row = page.locator(`.sb-item[data-session-id="${created}"]`);
      await expect(row).toBeVisible({ timeout: 5000 });

      const t0 = Date.now();
      await row.locator('.sb-star').click();
      await expect.poll(async () => (await favOf(ctx, created)).favorite, { timeout: 5000 }).toBe(true);

      // Not 0 — which is what "next index in the union I can see" hands out whenever the
      // union happens to be empty, and which collides head-on with an offline peer's pins.
      const rank = (await favOf(ctx, created)).favoriteRank;
      expect(rank).toBeGreaterThanOrEqual(t0);
      expect(rank).toBeLessThan(t0 + 60000);
    } finally {
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  // BUG 1 (reorder half) — a drag must PERMUTE the rank values the group already holds,
  // never renumber them to 0..N-1: those small indices would jump the whole visible group
  // ahead of an offline peer's (timestamp-ranked) pins the moment it came back.
  test('a drag permutes the ranks the group already holds — it never rewrites them to 0,1,2', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const ids = [];
    for (const n of ['Slot A', 'Slot B', 'Slot C']) {
      const r = await ctx.post('/api/sessions', { data: { name: n } });
      ids.push((await r.json()).id);
    }
    const [a, b, c] = ids;
    const base = Date.now();   // the ranks a real pin gets: wall clocks, seconds apart

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: base } });
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: base + 1000 } });
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: base + 2000 } });

      await page.goto(BASE + '/');
      await page.waitForSelector(`.sb-fav-item[data-fav-id="${c}"]`, { timeout: 5000 });
      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([a, b, c]);

      await dragFav(page, c, a);

      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([c, a, b]);
      // The SAME three slots in the global order, just occupied by different sessions.
      await expect.poll(async () => {
        const list = await (await ctx.get('/api/sessions')).json();
        const by = {};
        for (const s of list) if (ids.includes(s.id)) by[s.id] = s.favoriteRank;
        return by;
      }, { timeout: 5000 }).toEqual({ [c]: base, [a]: base + 1000, [b]: base + 2000 });
    } finally {
      for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  // BUG 2 — a reorder is N writes to N INDEPENDENT servers. There is no transaction, so
  // when one refuses, the cluster really is half-renumbered. The UI must not paper over
  // that: it must say which server refused, and then show what the servers actually hold.
  test('a reorder whose write fails names the server that refused, and the sidebar falls back to the servers\' truth', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const ids = [];
    for (const n of ['Half A', 'Half B', 'Half C']) {
      const r = await ctx.post('/api/sessions', { data: { name: n } });
      ids.push((await r.json()).id);
    }
    const [a, b, c] = ids;
    const base = Date.now();
    const serverName = (await (await ctx.get('/api/cluster/sessions')).json()).servers[0].name;

    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    try {
      await ctx.patch(`/api/sessions/${a}/favorite`, { data: { favorite: true, rank: base } });
      await ctx.patch(`/api/sessions/${b}/favorite`, { data: { favorite: true, rank: base + 1000 } });
      await ctx.patch(`/api/sessions/${c}/favorite`, { data: { favorite: true, rank: base + 2000 } });

      // Exactly ONE of the three writes fails. The other two land — which is precisely the
      // half-renumbered cluster the old Promise.all left behind, silently.
      await page.route(u => u.pathname === `/api/sessions/${c}/favorite`,
        (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }));

      await page.goto(BASE + '/');
      await page.waitForSelector(`.sb-fav-item[data-fav-id="${c}"]`, { timeout: 5000 });
      await expect.poll(() => pinnedIds(page, ids), { timeout: 5000 }).toEqual([a, b, c]);

      await dragFav(page, c, a);

      // (1) The user is TOLD, and told which server didn't take it.
      await expect.poll(() => dialogs.join(' || '), { timeout: 8000 }).toContain(serverName);
      expect(dialogs.some(m => /favorites/i.test(m) && /didn't save/i.test(m))).toBe(true);

      // (2) The sidebar ends up showing exactly what the servers hold — never the order
      //     the drag pretended to make.
      const serverOrder = async () => {
        const list = await (await ctx.get('/api/sessions')).json();
        return list.filter(s => s.favorite && ids.includes(s.id))
          .sort((x, y) => (x.favoriteRank - y.favoriteRank) || (x.id < y.id ? -1 : 1))
          .map(s => s.id);
      };
      await expect.poll(async () => (await pinnedIds(page, ids)).join(','), { timeout: 8000 })
        .toBe((await serverOrder()).join(','));
    } finally {
      for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  // BUG 3 — the migration is ONE SHOT. An id it cannot push must not keep the local list
  // alive: a surviving queue re-PATCHes `favorite:true` on every load, so a pin the user
  // later unstarred elsewhere is resurrected by a file that stopped being the truth.
  test('the migration runs once: the key is dropped even when an id cannot be pushed, and no unstarred pin comes back', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Mig OneShot' } });
    const created = (await r.json()).id;
    const GHOST = '11111111-2222-4333-8444-555555555555';   // a session this browser cannot route

    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    try {
      await page.goto(BASE + '/');
      await page.waitForSelector('.sb-item', { timeout: 5000 });
      await page.evaluate((order) => localStorage.setItem('wt.favorites', JSON.stringify(order)), [created, GHOST]);
      await page.reload();

      // The routable one lands on the server…
      await expect.poll(async () => (await favOf(ctx, created)).favorite, { timeout: 8000 }).toBe(true);
      // …the key is GONE anyway (the old code kept it forever because GHOST never pushed)…
      await expect.poll(() => page.evaluate(() => localStorage.getItem('wt.favorites')), { timeout: 8000 }).toBeNull();
      // …and the user was told, once, that something needs re-starring.
      expect(dialogs.some(m => /could not be moved/i.test(m))).toBe(true);

      // Now unstar it elsewhere and come back. A surviving queue would push it back up.
      await ctx.patch(`/api/sessions/${created}/favorite`, { data: { favorite: false } });
      await page.reload();
      await page.waitForSelector('.sb-item', { timeout: 5000 });
      await page.waitForTimeout(1500);   // long enough for a migration pass to have run
      expect((await favOf(ctx, created)).favorite).toBe(false);
      expect(await page.locator(`.sb-fav-item[data-fav-id="${created}"]`).count()).toBe(0);
    } finally {
      try { await ctx.delete(`/api/sessions/${created}`); } catch {}
      await ctx.dispose();
    }
  });

  // BUG 4 — the fleet upgrades one box at a time, so a peer with no favorite route at all
  // is the NORMAL state. Gate the star on the OWNING server's advertised capability: no
  // failing PATCH, no star that flashes on and snaps off with nothing said.
  test('a session on a peer without the favorites-sync capability gets a disabled star and fires no PATCH', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const r = await ctx.post('/api/sessions', { data: { name: 'Cap Local' } });
    const localId = (await r.json()).id;
    const OLD_URL = 'http://old-peer.invalid:7681';
    const OLD_ID = '99999999-8888-4777-8666-555555555555';
    let peerPatches = 0;

    page.on('dialog', d => d.dismiss().catch(() => {}));
    try {
      // A peer on an OLDER build: online, serving sessions, but its /api/version
      // advertises no 'favorites-sync' — it has no /favorite route at all.
      await page.route('**/api/cluster/sessions', async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        data.servers.push({
          name: 'OldBox', url: OLD_URL, online: true, needsAuth: false,
          version: '1.30.0 (deadbee)', capabilities: ['attention', 'clear', 'transcript'],
        });
        data.sessions.push({
          id: OLD_ID, name: 'Old Peer Session', cwd: 'C:\\dev', status: 'idle', clients: 0,
          server: 'OldBox', serverUrl: OLD_URL, notifyLevel: 'important',
          favorite: false, favoriteRank: null,
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      // Any favorite write proxied to a peer is a bug — count them.
      await page.route(u => u.pathname.includes('/cluster/') && u.pathname.endsWith('/favorite'),
        (route) => { peerPatches++; return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }); });

      await page.goto(BASE + '/');
      const oldStar = page.locator(`.sb-item[data-session-id="${OLD_ID}"] .sb-star`);
      await expect(oldStar).toBeVisible({ timeout: 5000 });
      await expect(oldStar).toBeDisabled();
      expect(await oldStar.getAttribute('title')).toMatch(/upgrade/i);

      // Even a synthetic click (which the `disabled` attribute alone does not stop) must
      // not fire a write at a route that isn't there.
      await oldStar.dispatchEvent('click');
      await page.waitForTimeout(500);
      expect(peerPatches).toBe(0);
      await expect(page.locator(`.sb-fav-item[data-fav-id="${OLD_ID}"]`)).toHaveCount(0);

      // …and the LOCAL server (which serves this page, so it is the same build) is not
      // over-gated: its star still works.
      const localStar = page.locator(`.sb-item[data-session-id="${localId}"] .sb-star`);
      await expect(localStar).toBeEnabled();
      await localStar.click();
      await expect.poll(async () => (await favOf(ctx, localId)).favorite, { timeout: 5000 }).toBe(true);
    } finally {
      try { await ctx.delete(`/api/sessions/${localId}`); } catch {}
      await ctx.dispose();
    }
  });
});
