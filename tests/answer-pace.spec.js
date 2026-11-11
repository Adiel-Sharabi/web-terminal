// @ts-check
// #271 - the server paces an AskUserQuestion answer (POST /api/sessions/:id/answer), so an
// app pause or socket reattach mid-answer cannot cut the key sequence short.
const { test, expect } = require('@playwright/test');
const { authCtx, noAuthCtx } = require('./test-helpers');
const { validateAnswer, createPacer, MAX_FRAMES, MAX_DELAY_MS, MAX_TOTAL_MS } = require('../lib/answer-pace');
const { stripAnsi } = require('../lib/ansi');

const CAP = 256 * 1024;
const UNKNOWN = '00000000-0000-4000-8000-000000000271';

test.describe('answer pacing rules (#271)', () => {
  test('accepts the frames the companion builds and totals every gap but the last', () => {
    const v = validateAnswer({ frames: [{ keys: '1', delayMs: 250 }, { keys: '\x1b[B', delayMs: 600 }, { keys: '\r', delayMs: 600 }] }, CAP);
    expect(v.error).toBeUndefined();
    expect(v.frames).toEqual([{ keys: '1', delayMs: 250 }, { keys: '\x1b[B', delayMs: 600 }, { keys: '\r', delayMs: 600 }]);
    expect(v.totalMs).toBe(850);
  });

  test('refuses a malformed answer rather than typing part of it', () => {
    const bad = [
      undefined, {}, { frames: [] }, { frames: 'x' },
      { frames: [{ keys: '' }] },
      { frames: [{ keys: 1 }] },
      { frames: [null] },
      { frames: [{ keys: '1', delayMs: -1 }] },
      { frames: [{ keys: '1', delayMs: 1.5 }] },
      { frames: [{ keys: '1', delayMs: MAX_DELAY_MS + 1 }] },
      { frames: [{ keys: '1', delayMs: '600' }] },
      { frames: Array.from({ length: MAX_FRAMES + 1 }, () => ({ keys: '1' })) },
      { frames: [{ keys: 'x'.repeat(CAP) }, { keys: 'y' }] },
      { frames: Array.from({ length: 14 }, () => ({ keys: '1', delayMs: MAX_DELAY_MS })) },
    ];
    for (const b of bad) expect(validateAnswer(b, CAP).error, JSON.stringify(b && b.frames && b.frames.length)).toBeTruthy();
    // The boundaries themselves are allowed.
    expect(validateAnswer({ frames: [{ keys: 'x'.repeat(CAP) }] }, CAP).error).toBeUndefined();
    const atTotal = Array.from({ length: MAX_TOTAL_MS / MAX_DELAY_MS + 1 }, () => ({ keys: '1', delayMs: MAX_DELAY_MS }));
    expect(validateAnswer({ frames: atTotal }, CAP).error).toBeUndefined();
  });

  test('writes every frame in order, sleeping each gap between them and none after the last', async () => {
    const log = [];
    const r = await createPacer().run('s', [{ keys: 'a', delayMs: 250 }, { keys: 'b', delayMs: 0 }, { keys: 'c', delayMs: 600 }, { keys: 'd', delayMs: 600 }], {
      write: (k) => { log.push(k); return true; },
      sleep: async (ms) => { log.push(ms); },
    });
    expect(r).toEqual({ written: 4, stopped: false });
    expect(log).toEqual(['a', 250, 'b', 'c', 600, 'd']);
  });

  test('stops at the first write that reached nobody', async () => {
    const log = [];
    const r = await createPacer().run('s', [{ keys: 'a', delayMs: 1 }, { keys: 'b', delayMs: 1 }, { keys: 'c', delayMs: 1 }], {
      write: (k) => { log.push(k); return k !== 'b'; },
      sleep: async () => {},
    });
    expect(r).toEqual({ written: 1, stopped: true });
    expect(log).toEqual(['a', 'b']);
  });

  test('one answer per session at a time, and the slot frees when it ends', async () => {
    const p = createPacer();
    let release;
    const gate = new Promise((r) => { release = r; });
    const io = { write: () => true, sleep: () => gate };
    const first = p.run('s', [{ keys: 'a', delayMs: 5 }, { keys: 'b' }], io);
    expect(p.busy('s')).toBe(true);
    expect(p.busy('other')).toBe(false);
    await expect(p.run('s', [{ keys: 'x' }], io)).rejects.toThrow(/already/);
    release();
    await first;
    expect(p.busy('s')).toBe(false);
  });
});

test.describe('POST /api/sessions/:id/answer (#271)', () => {
  test('requires authentication', async () => {
    const ctx = await noAuthCtx();
    const r = await ctx.post(`/api/sessions/${UNKNOWN}/answer`, { data: { frames: [{ keys: '1' }] } });
    expect(r.status()).toBe(401);
    await ctx.dispose();
  });

  test('400 for a bad body, 404 for an unknown session', async () => {
    const ctx = await authCtx();
    const bad = await ctx.post(`/api/sessions/${UNKNOWN}/answer`, { data: { frames: [] } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBeTruthy();
    const gone = await ctx.post(`/api/sessions/${UNKNOWN}/answer`, { data: { frames: [{ keys: '1' }] } });
    expect(gone.status()).toBe(404);
    expect((await gone.json()).error).toBe('session not found');
    const notUuid = await ctx.post('/api/sessions/not-a-session/answer', { data: { frames: [{ keys: '1' }] } });
    expect(notUuid.status()).toBe(404);
    await ctx.dispose();
  });

  test('types the frames into the PTY with no socket attached, and refuses a second answer meanwhile', async () => {
    test.setTimeout(120000);
    const ctx = await authCtx();
    const created = await ctx.post('/api/sessions', { data: { name: 'Answer Pace', autoCommand: '' } });
    expect(created.ok()).toBeTruthy();
    const { id } = await created.json();
    try {
      // Let the shell come up before typing into it.
      await expect.poll(async () => {
        const sb = await (await ctx.get(`/api/sessions/${id}/scrollback`)).json();
        return (sb.data || '').length;
      }, { timeout: 15000 }).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1500));
      // Split across frames with a gap: only a server that writes EVERY frame, in order,
      // produces the joined word as the command's output.
      const r = await ctx.post(`/api/sessions/${id}/answer`, {
        data: { frames: [{ keys: 'echo pace', delayMs: 1200 }, { keys: 'd-271-ok', delayMs: 600 }, { keys: '\r' }] },
      });
      expect(r.status()).toBe(202);
      expect(await r.json()).toEqual({ ok: true, frames: 3, ms: 1800 });
      // Still typing (1.8 s), so a second answer is refused, never interleaved.
      const second = await ctx.post(`/api/sessions/${id}/answer`, { data: { frames: [{ keys: 'x' }] } });
      expect(second.status()).toBe(409);
      await expect.poll(async () => {
        const sb = await (await ctx.get(`/api/sessions/${id}/scrollback`)).json();
        // The output line, not the echoed command line: the word stands alone after a newline.
        return /\n\r?paced-271-ok\r?\n/.test(stripAnsi(sb.data || ''));
      }, { timeout: 15000 }).toBe(true);
      // A frame over the IPC socket's 16 KB high-water mark makes the write return
      // false while the bytes are still delivered; the frames AFTER it must still go
      // out (gate review: reading false as "link down" cut the submit keys off).
      const big = await ctx.post(`/api/sessions/${id}/answer`, {
        data: { frames: [{ keys: 'x'.repeat(40000), delayMs: 1500 }, { keys: '\x15', delayMs: 600 }, { keys: 'echo after-big-271\r' }] },
      });
      expect(big.status()).toBe(202);
      await expect.poll(async () => {
        // The TAIL: the default slice is the first 32 KB, and the echoed x's outgrow it.
        const { total } = await (await ctx.get(`/api/sessions/${id}/scrollback?limit=1`)).json();
        const sb = await (await ctx.get(`/api/sessions/${id}/scrollback?offset=${Math.max(0, total - 32768)}`)).json();
        return /\n\r?after-big-271\r?\n/.test(stripAnsi(sb.data || ''));
      }, { timeout: 45000 }).toBe(true);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
    }
  });
});
