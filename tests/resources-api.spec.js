// @ts-check
// GET /api/resources — #152 levels 2 and 3 against a REAL server: web-terminal's own
// footprint on this box, and a reading per live session.
//
// This spec asserts the CONTRACT, never a particular number: the machine it runs on has
// whatever load it has. What must hold everywhere is that a number is either honest or
// explicitly unknown — a fabricated 0 is the one answer that would send someone to the
// wrong server, which is the whole point of the feature.
const { test, expect } = require('@playwright/test');
const { authCtx, noAuthCtx } = require('./test-helpers');

/** A reading is either null (unknown) or a well-formed one. Never a half-filled object. */
function expectReadingShape(r) {
  if (r === null) return;
  expect(typeof r).toBe('object');
  expect(r.cpuPct === null || (typeof r.cpuPct === 'number' && r.cpuPct >= 0 && r.cpuPct <= 100)).toBe(true);
  expect(r.rssBytes === null || (typeof r.rssBytes === 'number' && r.rssBytes >= 0)).toBe(true);
  expect(typeof r.procCount).toBe('number');
  expect(r.topName === null || typeof r.topName === 'string').toBe(true);
}

test.describe('GET /api/resources', () => {
  test('requires auth', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/resources');
    // The auth middleware answers 401 for an API path; anything 2xx would mean this
    // route slipped in front of it.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await ctx.dispose();
  });

  test('always reports the machine, even if the process query cannot run', async () => {
    const ctx = await authCtx();
    const res = await ctx.get('/api/resources');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Level 1 is free and must never be taken down by a level-2/3 failure.
    expect(body.machine).toBeTruthy();
    expect(body.machine.memory.totalBytes).toBeGreaterThan(0);
    expect(body.machine.cpuPct === null || typeof body.machine.cpuPct === 'number').toBe(true);
    expect(typeof body.cpuCount).toBe('number');
    expect(body.cpuCount).toBeGreaterThan(0);

    // The one field that tells "cannot measure" apart from "idle".
    expect(typeof body.sampling.ok).toBe('boolean');
    if (body.sampling.ok) {
      expect(body.sampling.windowMs).toBeGreaterThan(0);
    } else {
      expect(typeof body.sampling.reason).toBe('string');
      // Degraded: absent, NOT zeroed.
      expect(body.webTerminal).toBeNull();
      expect(body.sessions).toEqual({});
    }
    await ctx.dispose();
  });

  test('reports web-terminal\'s own footprint when sampling works', async () => {
    const ctx = await authCtx();
    const body = await (await ctx.get('/api/resources')).json();
    test.skip(!body.sampling.ok, `process sampling unavailable here: ${body.sampling.reason}`);

    expectReadingShape(body.webTerminal);
    // The server answering this request is itself inside that tree, so on a box that can
    // sample at all, the footprint cannot be nothing.
    expect(body.webTerminal).not.toBeNull();
    expect(body.webTerminal.procCount).toBeGreaterThan(0);
    expect(body.webTerminal.rssBytes).toBeGreaterThan(0);
    await ctx.dispose();
  });

  test('a session created now appears with a well-formed reading', async () => {
    const ctx = await authCtx();
    const created = await ctx.post('/api/sessions', { data: { name: 'resources-probe' } });
    expect(created.ok()).toBeTruthy();
    const session = await created.json();
    try {
      const body = await (await ctx.get('/api/resources')).json();
      test.skip(!body.sampling.ok, `process sampling unavailable here: ${body.sampling.reason}`);

      // Present because it has a pid — its VALUE may still be null if the shell exited
      // between the two reads, which is exactly why null is a legal reading.
      expect(session.id in body.sessions).toBe(true);
      expectReadingShape(body.sessions[session.id]);
    } finally {
      await ctx.delete(`/api/sessions/${session.id}`);
      await ctx.dispose();
    }
  });

  test('a LIVE session actually measures — the root guard must not blank real shells', async () => {
    // The companion test to the one above. A session's root pid is checked against the
    // shells this box can legitimately spawn, because the pid is read from the session
    // list and Windows may have handed it to something else by the time the snapshot is
    // taken. Get that list wrong — hard-code it, or miss the configured shell — and every
    // session reads `—` forever: a total, silent failure of the feature that the
    // shape assertions above would happily pass.
    const ctx = await authCtx();
    const created = await ctx.post('/api/sessions', { data: { name: 'resources-live' } });
    const session = await created.json();
    try {
      let reading;
      // The shell needs a moment to exist, and a first reading may have no pair yet.
      for (let i = 0; i < 6 && (reading === undefined || reading === null); i++) {
        const body = await (await ctx.get('/api/resources')).json();
        test.skip(!body.sampling.ok, `process sampling unavailable here: ${body.sampling.reason}`);
        reading = body.sessions[session.id];
        if (reading == null) await new Promise((r) => setTimeout(r, 700));
      }
      expect(reading).toBeTruthy();
      // A real shell holds memory and is at least one process. CPU may honestly be null
      // on the very first pair, so it is not asserted here.
      expect(reading.rssBytes).toBeGreaterThan(0);
      expect(reading.procCount).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.delete(`/api/sessions/${session.id}`);
      await ctx.dispose();
    }
  });

  test('a killed session is not reported with zeros', async () => {
    // The failure this guards: a session whose shell is gone reading as "0% / 0 bytes"
    // is indistinguishable from a live idle one, and would be the most attractive row to
    // start new work on.
    const ctx = await authCtx();
    const created = await ctx.post('/api/sessions', { data: { name: 'resources-gone' } });
    const session = await created.json();
    await ctx.delete(`/api/sessions/${session.id}`);

    const body = await (await ctx.get('/api/resources')).json();
    const reading = body.sessions[session.id];
    expect(reading === undefined || reading === null).toBe(true);
    await ctx.dispose();
  });

  test('advertises the capability so a client can gate on it', async () => {
    // A client that cannot see this must render "unknown", not call an endpoint that
    // 404s and looks like a broken button.
    const ctx = await authCtx();
    const body = await (await ctx.get('/api/version')).json();
    expect(body.capabilities).toContain('session-resources');
    await ctx.dispose();
  });
});
