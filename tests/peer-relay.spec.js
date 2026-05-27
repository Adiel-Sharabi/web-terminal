// @ts-check
const { test, expect, request: pwRequest } = require('@playwright/test');

const BASE = 'http://127.0.0.1:17681';

async function ctx() {
  return pwRequest.newContext({ baseURL: BASE });
}

async function status(c) {
  const r = await c.get('/api/relay/status');
  return r.json();
}

// Drain both agent inboxes so tests don't see each other's leftovers. The
// relay only delivers messages whose conversations are "ready" (more=false),
// so any open batch from a previous test stays buffered — fine for isolation
// because no new batch reuses an old conv_id.
async function drainAll(c) {
  await c.get('/api/relay/recv?agent=claude&wait=0');
  await c.get('/api/relay/recv?agent=codex&wait=0');
}

test.beforeEach(async () => {
  const c = await ctx();
  await drainAll(c);
  await c.dispose();
});

test.describe('peer relay — basic send/recv', () => {
  test('send + immediate recv roundtrip', async () => {
    const c = await ctx();
    const sendRes = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: 'hello' },
    });
    expect(sendRes.status()).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody.ok).toBe(true);
    expect(sendBody.conv_id).toMatch(/^[0-9a-f-]{8,}$/i);
    expect(sendBody.turn).toBe(1);
    expect(sendBody.more).toBe(false);

    const recvRes = await c.get('/api/relay/recv?agent=codex');
    expect(recvRes.status()).toBe(200);
    const recvBody = await recvRes.json();
    expect(recvBody.messages).toHaveLength(1);
    expect(recvBody.messages[0].message).toBe('hello');
    expect(recvBody.messages[0].from).toBe('claude');
    expect(recvBody.messages[0].conv_id).toBe(sendBody.conv_id);
    await c.dispose();
  });

  test('recv drains queue (second recv is empty)', async () => {
    const c = await ctx();
    await c.post('/api/relay/send', { data: { from: 'claude', to: 'codex', message: 'one' } });
    const first = await (await c.get('/api/relay/recv?agent=codex')).json();
    expect(first.messages.length).toBeGreaterThanOrEqual(1);
    const second = await (await c.get('/api/relay/recv?agent=codex')).json();
    expect(second.messages).toEqual([]);
    await c.dispose();
  });

  test('reply on same conv_id keeps turn counting', async () => {
    const c = await ctx();
    const a = await (await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: 'q1' },
    })).json();
    const b = await (await c.post('/api/relay/send', {
      data: { from: 'codex', to: 'claude', conv_id: a.conv_id, message: 'r1' },
    })).json();
    expect(b.turn).toBe(2);
    expect(b.remaining_turns).toBeLessThan(a.remaining_turns);
    await c.dispose();
  });
});

test.describe('peer relay — batch mode (more flag)', () => {
  test('messages with more=true are withheld; closing message flushes batch', async () => {
    const c = await ctx();
    const m1 = await (await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: 'part 1', more: true },
    })).json();
    expect(m1.more).toBe(true);
    expect(m1.buffered).toBe(1);

    // recv with wait=0 should see nothing yet — batch is open
    const peek = await (await c.get('/api/relay/recv?agent=codex&wait=0')).json();
    expect(peek.messages).toEqual([]);

    await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', conv_id: m1.conv_id, message: 'part 2', more: true },
    });
    const peek2 = await (await c.get('/api/relay/recv?agent=codex&wait=0')).json();
    expect(peek2.messages).toEqual([]);

    // Close the batch — three messages now delivered together
    await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', conv_id: m1.conv_id, message: 'part 3 — answer please' },
    });
    const final = await (await c.get('/api/relay/recv?agent=codex&wait=0')).json();
    expect(final.messages).toHaveLength(3);
    expect(final.messages.map(m => m.message)).toEqual(['part 1', 'part 2', 'part 3 — answer please']);
    await c.dispose();
  });

  test('long-poll wakes when batch closes', async () => {
    const c = await ctx();
    // Start the recv long-poll first; should block while batch is open
    const recvP = c.get('/api/relay/recv?agent=codex&wait=10');

    // Open a batch (should NOT wake the long-poll)
    const m1 = await (await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: 'open', more: true },
    })).json();

    // Wait a moment to confirm the long-poll is still parked
    await new Promise(r => setTimeout(r, 200));

    // Close the batch — this should wake recv
    const t0 = Date.now();
    await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', conv_id: m1.conv_id, message: 'close' },
    });
    const recvBody = await (await recvP).json();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(recvBody.messages).toHaveLength(2);
    await c.dispose();
  });
});

test.describe('peer relay — rate limits', () => {
  test('conv-cap returns 429 after WT_RELAY_MAX_TURNS_PER_CONV messages', async () => {
    const c = await ctx();
    const s = await status(c);
    const cap = s.limits.max_turns_per_conv;
    const first = await (await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: 'turn 1' },
    })).json();
    for (let i = 2; i <= cap; i++) {
      const r = await c.post('/api/relay/send', {
        data: { from: i % 2 ? 'claude' : 'codex', to: i % 2 ? 'codex' : 'claude', conv_id: first.conv_id, message: `turn ${i}` },
      });
      expect(r.status()).toBe(200);
    }
    // The (cap+1)th attempt must fail
    const over = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', conv_id: first.conv_id, message: 'overflow' },
    });
    expect(over.status()).toBe(429);
    const body = await over.json();
    expect(body.error).toBe('conv-cap');
    expect(body.max_turns).toBe(cap);
    await c.dispose();
  });

  test('rejects message larger than max_msg_bytes', async () => {
    const c = await ctx();
    const s = await status(c);
    const big = 'x'.repeat(s.limits.max_msg_bytes + 1);
    const r = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: big },
    });
    expect(r.status()).toBe(413);
    await c.dispose();
  });
});

test.describe('peer relay — input validation', () => {
  test('invalid agent name returns 400', async () => {
    const c = await ctx();
    const r = await c.post('/api/relay/send', {
      data: { from: 'has spaces!', to: 'codex', message: 'x' },
    });
    expect(r.status()).toBe(400);
    await c.dispose();
  });

  test('from === to returns 400', async () => {
    const c = await ctx();
    const r = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'claude', message: 'x' },
    });
    expect(r.status()).toBe(400);
    await c.dispose();
  });

  test('empty message returns 400', async () => {
    const c = await ctx();
    const r = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', message: '' },
    });
    expect(r.status()).toBe(400);
    await c.dispose();
  });

  test('unknown conv_id returns 404', async () => {
    const c = await ctx();
    const r = await c.post('/api/relay/send', {
      data: { from: 'claude', to: 'codex', conv_id: 'does-not-exist', message: 'x' },
    });
    expect(r.status()).toBe(404);
    await c.dispose();
  });

  test('recv with invalid agent returns 400', async () => {
    const c = await ctx();
    const r = await c.get('/api/relay/recv?agent=bad%20name');
    expect(r.status()).toBe(400);
    await c.dispose();
  });
});

test.describe('peer relay — status endpoint', () => {
  test('exposes limits, daily counter, and queue depths', async () => {
    const c = await ctx();
    const s = await status(c);
    expect(s.limits.max_turns_per_conv).toBeGreaterThan(0);
    expect(s.limits.daily_max).toBeGreaterThan(0);
    expect(typeof s.daily_used).toBe('number');
    expect(typeof s.daily_remaining).toBe('number');
    expect(typeof s.queues).toBe('object');
    expect(Array.isArray(s.conversations)).toBe(true);
    await c.dispose();
  });
});
