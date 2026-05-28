// @ts-check
// Issue: scroll-up backfill (1.16.0)
// Verifies GET /api/sessions/:id/scrollback?offset&limit:
//   - returns { data, total, offset, limit } shape
//   - slices correctly (data matches the corresponding window of a full read)
//   - clamps offset+limit > total to the available tail (no error)
//   - 401 without auth
//   - 404 for unknown session id
//   - clamps limit to SCROLLBACK_RANGE_MAX (524288)

const { test, expect } = require('@playwright/test');
const { authCtx, noAuthCtx } = require('./test-helpers');

const SCROLLBACK_RANGE_MAX = 524288;

async function settle(ms) { return new Promise(r => setTimeout(r, ms)); }

test.describe('GET /api/sessions/:id/scrollback', () => {
  test('returns shape and slices correctly against natural PTY output', async () => {
    const ctx = await authCtx();
    let id;
    try {
      // Create a session — PTY startup banner gives us some bytes to slice.
      const createRes = await ctx.post('/api/sessions', { data: { name: 'sb-shape' } });
      expect(createRes.status()).toBe(200);
      id = (await createRes.json()).id;

      // Let the shell banner land in scrollback.
      await settle(800);

      // Full read — request more than the worker cap so we get everything.
      const fullRes = await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=${SCROLLBACK_RANGE_MAX}`);
      expect(fullRes.status()).toBe(200);
      const full = await fullRes.json();
      expect(typeof full.data).toBe('string');
      expect(typeof full.total).toBe('number');
      expect(full.offset).toBe(0);
      expect(full.limit).toBe(full.data.length);
      expect(full.total).toBe(full.data.length); // for a fresh session, total <= max
      expect(full.total).toBeGreaterThan(0);     // banner should produce at least one byte

      // Mid-buffer slice — pick the middle 8 chars of the full data and assert
      // the endpoint returns exactly those.
      if (full.total >= 16) {
        const mid = Math.floor(full.total / 2);
        const want = full.data.slice(mid, mid + 8);
        const midRes = await ctx.get(`/api/sessions/${id}/scrollback?offset=${mid}&limit=8`);
        expect(midRes.status()).toBe(200);
        const midJson = await midRes.json();
        expect(midJson.data).toBe(want);
        expect(midJson.offset).toBe(mid);
        expect(midJson.limit).toBe(8);
        expect(midJson.total).toBe(full.total);
      }
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('offset >= total returns empty tail without error', async () => {
    const ctx = await authCtx();
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'sb-tail' } })).json()).id;
      await settle(500);
      const totalProbe = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=${SCROLLBACK_RANGE_MAX}`)).json();
      const oversized = await ctx.get(`/api/sessions/${id}/scrollback?offset=${totalProbe.total + 1000}&limit=1024`);
      expect(oversized.status()).toBe(200);
      const j = await oversized.json();
      expect(j.data).toBe('');
      expect(j.limit).toBe(0);
      expect(j.offset).toBeLessThanOrEqual(totalProbe.total);
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('limit is clamped to SCROLLBACK_RANGE_MAX', async () => {
    const ctx = await authCtx();
    let id;
    try {
      id = (await (await ctx.post('/api/sessions', { data: { name: 'sb-clamp' } })).json()).id;
      await settle(300);
      // Request a huge limit; server must clamp to 524288 (and then to total).
      const res = await ctx.get(`/api/sessions/${id}/scrollback?offset=0&limit=999999999`);
      expect(res.status()).toBe(200);
      const j = await res.json();
      expect(j.limit).toBeLessThanOrEqual(SCROLLBACK_RANGE_MAX);
      expect(j.limit).toBe(j.data.length);
    } finally {
      if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
      await ctx.dispose();
    }
  });

  test('unauthenticated request returns 401', async () => {
    const ctx = await noAuthCtx();
    try {
      const res = await ctx.get('/api/sessions/anything/scrollback?offset=0&limit=10');
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('unknown session id returns 404', async () => {
    const ctx = await authCtx();
    try {
      const res = await ctx.get('/api/sessions/this-id-does-not-exist-zzz/scrollback?offset=0&limit=10');
      expect(res.status()).toBe(404);
      const j = await res.json();
      expect(j.error).toMatch(/not found/i);
    } finally {
      await ctx.dispose();
    }
  });
});
