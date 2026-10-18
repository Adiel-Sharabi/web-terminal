// @ts-check
// Issue #137 — the 5h wait period on the wire and its per-session cancel.
//
// The UI half of auto-resume lives HERE rather than in the worker on purpose: the
// derivation (lib/usage-limit.js) and the opt-out are server-side, which is what
// lets the badge and the cancel ship on a hot reload while the worker keeps
// owning the timer. Same shape as notifyLevel/favorite before it.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BASE, authCtx, loginPage } = require('./test-helpers');

async function autoResumeOf(ctx, id) {
  return (await ctx.get(`/api/sessions/${id}/auto-resume`)).json();
}
async function sessionRow(ctx, id) {
  const list = await (await ctx.get('/api/sessions')).json();
  return (list.sessions || list).find((s) => s.id === id);
}

// #227 — THE WIRING GATE. `armed` is the WORKER's `autoResumeArmed`, not a re-derivation
// of its decision from the metrics the server happens to hold. That distinction is
// invisible to every pure test in tests/usage-limit.spec.js: delete the one line in
// server.js that passes the worker's answer through and they all stay green, because
// they call the module directly. This drives the whole chain instead — status line ->
// metrics -> capBlocked push -> the worker arming a real timer -> a hook cancelling it
// -> what the session list then says.
//
// It is also the only test here that reproduces the reported failure end to end: a row
// reading "resumes ..." for a session whose timer had already been destroyed.
test.describe('#227 — the badge REPORTS the timer, it does not predict it', () => {
  test('a hook cancelling the timer flips the row to NOT armed, while the derivation still says armed', async () => {
    const ctx = await authCtx();
    const uuid = '227ca9ed-0000-0000-0000-0000000000c1';
    const cwd = path.join(process.env.TEMP || os.tmpdir(), `wt-ar227-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR 227', cwd, agent: 'claude' } })).json()).id;
    try {
      // Bind the claude session id, which is what the status-line payload is keyed on.
      await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });

      // A spent 5h window with a reset comfortably ahead — the shape a real cap
      // produces. resets_at is SECONDS in Claude's payload, not milliseconds.
      const resetAtSec = Math.floor(Date.now() / 1000) + 3600;
      await ctx.post('/api/claude-status', {
        data: {
          session_id: uuid,
          model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
          rate_limits: { five_hour: { used_percentage: 100, resets_at: resetAtSec } },
        },
      });

      // Reading the list is what pushes capBlocked to the worker, and the worker arms
      // on its own clock afterwards — so poll rather than assert on the first read.
      await expect.poll(async () => (await sessionRow(ctx, id)).usageLimit.armed,
        { timeout: 8000, message: 'the metrics -> push -> worker-arms chain never completed' })
        .toBe(true);
      expect((await sessionRow(ctx, id)).usageLimit.waiting).toBe(true);

      // Now a TOOL runs. That genuinely proves the cap is not in force, so the worker
      // cancels the timer (#227 keeps this behaviour — only a PROMPT re-arms). The
      // metrics have not moved, so the old derivation still computes `armed: true`:
      // this is exactly the divergence that rendered "resumes 21:51" all night.
      await ctx.post(`/api/session/${id}/hook`, { data: { event: 'PreToolUse', session_id: uuid, tool: 'Bash' } });

      await expect.poll(async () => (await sessionRow(ctx, id)).usageLimit.armed,
        { timeout: 8000, message: 'the row kept claiming a resume the worker had cancelled' })
        .toBe(false);
      const after = await sessionRow(ctx, id);
      // NB: the row does not republish the worker's raw `autoResumeArmed` — the list is
      // shaped field by field and that field is consumed server-side, inside
      // usageLimitFields. Asserting on it here was this test's own first bug. It does
      // not weaken the gate: after a PreToolUse the metrics have not moved, so the OLD
      // derivation still computes `armed: true` (capBlocked, enabled, canArm, resetAt
      // all unchanged), and only the worker's answer can make this false.
      //
      // ...and the session is STILL HELD. Reporting the timer honestly must not erase
      // the block, or the row would go blank on a session that is genuinely capped.
      expect(after.usageLimit.waiting).toBe(true);
      expect(after.usageLimit.resumeAt).toBeTruthy();
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

test.describe('#137 — auto-resume opt-out API', () => {
  test('a session is opted IN by default, and the list says so', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR default' } })).json()).id;
    try {
      // #137 flipped the default. Absence of a stored preference must read as ON,
      // which is why the prefs file stores opt-OUTs only.
      expect((await autoResumeOf(ctx, id)).enabled).toBe(true);

      const row = await sessionRow(ctx, id);
      expect(row.usageLimit).toBeTruthy();
      expect(row.usageLimit.enabled).toBe(true);
      // A brand-new shell has no metrics, so it is not capped and renders nothing.
      expect(row.usageLimit.waiting).toBe(false);
      expect(row.usageLimit.armed).toBe(false);
      expect(row.usageLimit.resumeAt).toBeNull();
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('turning it off persists, rides the session list, and turning it back on restores', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR toggle' } })).json()).id;
    try {
      const off = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: false } });
      expect(off.status()).toBe(200);
      expect((await off.json()).enabled).toBe(false);

      expect((await autoResumeOf(ctx, id)).enabled).toBe(false);
      expect((await sessionRow(ctx, id)).usageLimit.enabled).toBe(false);

      const on = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: true } });
      expect((await on.json()).enabled).toBe(true);
      expect((await sessionRow(ctx, id)).usageLimit.enabled).toBe(true);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('rejects a non-boolean and a non-UUID id rather than storing junk', async () => {
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR validate' } })).json()).id;
    try {
      const bad = await ctx.patch(`/api/sessions/${id}/auto-resume`, { data: { enabled: 'yes' } });
      expect(bad.status()).toBe(400);
      // A bogus id must never become a persisted key in the prefs file — same guard
      // as /favorite, and for the same reason.
      const bogus = await ctx.patch('/api/sessions/not-a-uuid/auto-resume', { data: { enabled: false } });
      expect(bogus.status()).toBe(404);
      expect((await autoResumeOf(ctx, id)).enabled).toBe(true); // unchanged
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('the routes are behind auth', async ({ request }) => {
    // Unauthenticated: every other session route refuses, and so must these — the
    // PATCH writes server-side state and the GET discloses a session id.
    const g = await request.get(`${BASE}/api/sessions/00000000-0000-4000-8000-000000000000/auto-resume`);
    expect([401, 403]).toContain(g.status());
    const p = await request.patch(`${BASE}/api/sessions/00000000-0000-4000-8000-000000000000/auto-resume`, {
      data: { enabled: false },
    });
    expect([401, 403]).toContain(p.status());
  });
});

test.describe('#137 — the wait-period badge in the sidebar', () => {
  test('an uncapped session shows no wait badge and no capped row state', async ({ page }) => {
    await loginPage(page);
    const ctx = await authCtx();
    const id = (await (await ctx.post('/api/sessions', { data: { name: 'AR nobadge' } })).json()).id;
    try {
      await page.reload();
      await page.waitForSelector(`.sb-item[data-session-id="${id}"]`, { timeout: 15000 });
      const row = page.locator(`.sb-item[data-session-id="${id}"]`);
      await expect(row.locator('.sb-wait')).toHaveCount(0);
      await expect(row).not.toHaveClass(/capped/);
    } finally {
      await ctx.delete(`/api/sessions/${id}`);
    }
  });

  test('waitBadge renders the resume CLOCK TIME and flips label when switched off', async ({ page }) => {
    await loginPage(page);
    // Drive the pure renderer with a shaped row: the badge must read the server's
    // derived `usageLimit` and never recompute the threshold itself. Asserting on the
    // rendered text is what catches a badge that promises a resume nothing will do.
    const out = await page.evaluate(() => {
      const at = new Date();
      at.setHours(14, 32, 0, 0);
      const on = window.waitBadge({ usageLimit: { waiting: true, armed: true, enabled: true, resumeAt: at.getTime(), resetAt: at.getTime() } });
      const off = window.waitBadge({ usageLimit: { waiting: true, armed: false, enabled: false, resumeAt: at.getTime(), resetAt: at.getTime() } });
      const unarmed = window.waitBadge({ usageLimit: { waiting: true, armed: false, enabled: true, resumeAt: null, resetAt: null } });
      const none = window.waitBadge({ usageLimit: { waiting: false, armed: false, enabled: true, resumeAt: null, resetAt: null } });
      const missing = window.waitBadge({});
      const expected = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { on, off, unarmed, none, missing, expected };
    });
    expect(out.on).toContain('resumes');
    expect(out.on).toContain(out.expected);       // the time it will actually fire
    expect(out.off).toContain('on hold');
    expect(out.off).not.toContain('resumes');     // nothing is scheduled — don't say it is
    // Capped but with no reset time yet (the cap prompt seen before any resets_at):
    // still shown as held, but it must NOT promise a resume no timer can schedule.
    expect(out.unarmed).toContain('on hold');
    expect(out.unarmed).not.toContain('resumes');
    expect(out.none).toBe('');                    // not capped => no chip at all
    expect(out.missing).toBe('');                 // a server too old to send the field
  });
});

// #240 — THE API WAS MISREPORTING ITS OWN SERVER, AND A REPLACE-NOT-MERGE PUT MADE THAT
// MISREPORT STICK.
//
// `GET /api/config` fills in a value for every key the file omits, and it answered
// `autoResumeOnReset: false` — #69's opt-in default, which #137 flipped and that line
// never followed — for a feature `pty-worker.js` was running as `true` and
// docs/CONFIGURATION.md documents as `true`. An endpoint reporting a setting the server
// does not have is a defect on its own, whoever reads it.
//
// `PUT /api/config` then REPLACED rather than merged, so anything echoing the served
// object back wrote that misreport to disk. (#242 has since made the PUT merge. That
// does NOT make this test redundant: a merge still WRITES every key the body carries, so
// a served value that disagrees with the worker is still persisted by a round-trip. The
// served default being right is the fix; the merge only stops the OTHER half, which is
// keys the body omits.) In this repo exactly two things echo it back:
// `exclusive-viewer.spec.js` and `keep-sessions-open.spec.js`, which round-trip the whole
// config deliberately — so EVERY RUN was writing the opt-out into the GITIGNORED
// `config.test.json`. No checkout restores that file, so one interrupted run disabled
// arming permanently on that machine while CI, having no such file, stayed green.
//
// Deliberately NOT a claim about the shipped clients — the first draft of this comment
// said "a settings client edits one field and PUTs the whole object back" and no client
// does that. `app.html` and `lobby.html` build a FRESH object from their form fields and
// never mention this key; the companion only GETs. Their bug is the opposite one, dropping
// keys they do not render (#242). Checking cost one grep and the claim was wrong.
test.describe('#240 — a config round-trip must not silently opt out of auto-resume', () => {
  test('the served default is the one the worker acts on, so GET -> PUT changes nothing', async () => {
    const ctx = await authCtx();
    try {
      // Asserted BEFORE the round-trip: this is the value any client is about to write
      // back, so the served default is the defect itself, not a symptom of it.
      const served = await (await ctx.get('/api/config')).json();
      expect(served.autoResumeOnReset).toBe(true);

      // The round-trip, verbatim — the shape every settings client uses.
      const put = await ctx.put('/api/config', { data: served });
      expect(put.status()).toBe(200);

      // Read back from disk (this route re-reads the file, so there is no cache between
      // the write and this assertion): the round-trip must be a no-op.
      const after = await (await ctx.get('/api/config')).json();
      expect(after.autoResumeOnReset).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  // The consequence, driven end to end. This is the issue's own "corrupt the flag, then
  // the #227 chain still works" check, and it is the half that would survive somebody
  // "fixing" the drift by changing the WORKER's default instead of the server's.
  //
  // It waits out the worker's live-config TTL first, on purpose. `liveConfig` re-reads
  // the file every 5s (LIVE_CONFIG_TTL, pty-worker.js), so a chain driven immediately
  // after the PUT arms off the PRE-write cache and passes whatever is on disk — which is
  // exactly how the first draft of this test went green against the unfixed server. The
  // wait is a documented constant, not a latency bet.
  test('and the worker still arms once it has re-read the file', async () => {
    // 5.5s of deliberate waiting plus a session spawn plus an 8s poll sits close enough to
    // the 30s default that a loaded machine would report a TIMEOUT rather than the failure
    // this test exists to show. Raised explicitly rather than by trimming the TTL wait,
    // which is the one thing here that must not be shortened.
    test.setTimeout(60000);
    // The whole body is inside the try: the round-trip, the TTL wait and the mkdirSync all
    // happen before the session exists, and a throw in any of them would otherwise leak the
    // request context and the temp cwd. `ctx` is created first so `finally` can always
    // dispose it.
    const ctx = await authCtx();
    // `id` and `cwd` are declared out here because the `finally` reads them — moving the
    // setup inside the try is what makes them assignable-but-possibly-unset.
    let id = null;
    let cwd = null;
    try {
      const uuid = '240ca9ed-0000-0000-0000-0000000000c1';
      cwd = path.join(process.env.TEMP || os.tmpdir(), `wt-ar240-${process.pid}`);
      fs.mkdirSync(cwd, { recursive: true });

      const served = await (await ctx.get('/api/config')).json();
      expect((await ctx.put('/api/config', { data: served })).status()).toBe(200);
      await new Promise((r) => setTimeout(r, 5500)); // > LIVE_CONFIG_TTL, so the worker re-reads

      id = (await (await ctx.post('/api/sessions', { data: { name: 'AR 240', cwd, agent: 'claude' } })).json()).id;
      await ctx.post(`/api/session/${id}/hook`, { data: { event: 'UserPromptSubmit', session_id: uuid } });
      const resetAtSec = Math.floor(Date.now() / 1000) + 3600;
      await ctx.post('/api/claude-status', {
        data: {
          session_id: uuid,
          model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
          rate_limits: { five_hour: { used_percentage: 100, resets_at: resetAtSec } },
        },
      });

      await expect.poll(async () => (await sessionRow(ctx, id)).usageLimit.armed,
        { timeout: 8000, message: 'the worker never armed — a config round-trip wrote an autoResumeOnReset opt-out nobody chose (#240)' })
        .toBe(true);
    } finally {
      if (id) await ctx.delete(`/api/sessions/${id}`);
      await ctx.dispose();
      if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  });
});
