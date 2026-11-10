// @ts-check
// #443 milestone 2 - the check-in, end to end against the real test server and worker. The
// rules are pinned in check-in.spec.js; this pins that the server APPLIES them: a stale
// self-wait gets exactly ONE check-in typed into its terminal, delivery and the answer are
// read off the session's own hooks and report (state, never prose), a live waker or an off
// switch means none at all, and a new turn is what re-arms it.
//
// The "agent" is a bash session declared `claude` whose launch prints Claude's composer
// marker (#190), so the worker reads it as ready. Hooks and the agent's reports are driven
// through the same routes Claude itself uses. The clocks are shortened through the live
// config the server re-reads (LIVE_CONFIG_TTL, 5 s), restored after each test.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx, readHookToken, claudeProjectsRoot } = require('./test-helpers');

const TAG = '[web-terminal check-in]';
const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n\\x1b[>0q'; echo claude";
const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, '..', 'handoffs.test');
const LOG = path.join(HANDOFF_DIR, 'check-in-log.jsonl');
const CFG_FILE = process.env.WT_CONFIG_FILE || path.join(__dirname, '..', 'config.test.json');
// typingQuietMin too: the typing gate counts from the server's start (keystrokes are not
// remembered across a reload), and a suite server may have started a moment ago.
const FAST = { handoff: { staleSelfMin: 0.01 }, checkIn: { afterMin: 0.01, everyMs: 300, typingQuietMin: 0.01 } };
// Every session gets a real (tiny) transcript: with none, live work "cannot be told" and
// the check-in fails closed - the last test pins exactly that.
const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-checkin-fixture__');
const iso = (ms) => new Date(ms).toISOString();
function transcript(name, lines = []) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `wt_checkin_${process.pid}_${name}.jsonl`);
  fs.writeFileSync(p, [JSON.stringify({ type: 'user', timestamp: iso(Date.now() - 60000), message: { role: 'user', content: 'work' } }), ...lines].join('\n') + '\n', 'utf8');
  return p;
}

async function hook(id, event, body = {}) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post('/api/hook', {
    data: { hook_event_name: event, ...body },
    headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': id } });
  await c.dispose();
  return r.status();
}
async function report(id, wait) {
  const c = await pwRequest.newContext({ baseURL: BASE });
  const r = await c.post(`/api/session/${id}/report`, {
    data: { items: [{ ref: '#1', title: 'x', state: 'in-progress' }], wait },
    headers: { 'X-WT-Hook-Token': readHookToken() } });
  await c.dispose();
  return r.status();
}
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (s, sub) => s.split(sub).length - 1;
const logOf = (id) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);

test.describe('#443 check-in - server', () => {
  test.setTimeout(120000);
  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string[]} */
  let made = [];
  /** @type {string|null} */
  let cfgBefore = null;

  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
  const scrollback = async (id) => (await ctx.get(`/api/sessions/${id}/scrollback`)).text();
  const setConfig = async (extra) => {
    const base = cfgBefore ? JSON.parse(cfgBefore) : {};
    fs.writeFileSync(CFG_FILE, JSON.stringify({ ...base, ...extra }, null, 2));
    await sleep(5500); // past LIVE_CONFIG_TTL, so the server reads it
  };

  /** A ready Claude-declared session whose turn ended reporting [wait]. */
  async function endedTurn(name, wait, transcriptPath = transcript(name)) {
    const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    await turn(id, 'work', wait, transcriptPath);
    return id;
  }
  async function turn(id, prompt, wait, transcriptPath) {
    const conv = crypto.randomUUID();
    const tp = transcriptPath ? { transcript_path: transcriptPath } : {};
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt, ...tp })).toBe(200);
    if (wait) expect(await report(id, wait)).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv, ...tp })).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
  }

  test.beforeEach(async () => {
    ctx = await authCtx(); made = [];
    cfgBefore = fs.existsSync(CFG_FILE) ? fs.readFileSync(CFG_FILE, 'utf8') : null;
  });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    // Never delete it: a missing file is skipped by _refreshLiveConfig, which would pin the
    // short clocks in the server's cache for the rest of the run.
    fs.writeFileSync(CFG_FILE, cfgBefore === null ? '{}' : cfgBefore);
    await sleep(5500);
  });

  test('a stale self-wait gets exactly one check-in; the wait it then reports is the answer', async () => {
    const id = await endedTurn(`checkin-done-${Date.now()}`, { on: 'self', what: 'watch the CI run' });
    expect((await rowOf(id)).reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect((await rowOf(id)).checkIn).toBeNull();
    await setConfig(FAST);
    const ci = await until(async () => (await rowOf(id))?.checkIn, 'a check-in');
    expect(ci.state).toBe('sent');
    const sb = await until(async () => { const t = await scrollback(id); return t.includes(TAG) ? t : null; }, 'the check-in in the terminal');
    expect(sb).toContain('watch the CI run');
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(1);

    // Delivery: the agent's own UserPromptSubmit with the tagged prompt.
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} You have been idle 1 min.` })).toBe(200);
    expect((await rowOf(id)).checkIn.state).toBe('answering');
    // It is not the person's prompt: the card's "You" line is the last thing typed.
    expect((await rowOf(id)).brief.prompt.text).toBe('work');
    // The answer is state: the wait it reports in that turn.
    expect(await report(id, { on: 'done', what: 'all merged' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    const row = await until(async () => { const r = await rowOf(id); return r?.checkIn?.state === 'done' && r.status === 'idle' ? r : null; }, 'the answer');
    expect(row.reason.kind).toBe('done');
    expect(row.checkIn.sentAt).toBe(ci.sentAt);
    expect(logOf(id).find((l) => l.event === 'answered')).toMatchObject({ answer: 'done', sentAt: ci.sentAt });
    // (A "done" session is never stale, so "not asked again" proves nothing here: the
    // once-per-period rule is pinned by the "stuck" test below.)
  });

  test('fails closed: a session whose transcript cannot be found is never checked in on', async () => {
    // No transcript_path in its hooks, so live work cannot be read: "nothing running" is
    // what the badge shows, but it is not a reading, and the check-in must refuse.
    const r = await ctx.post('/api/sessions', { data: { name: `checkin-blind-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await report(id, { on: 'self', what: 'x' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'idle');
    // A control session WITH a transcript, under the same config, IS asked - so the scan
    // ran, and the blind one was refused, not merely missed.
    const seen = await endedTurn(`checkin-seen-${Date.now()}`, { on: 'self', what: 'y' });
    await setConfig(FAST);
    await until(async () => (await rowOf(seen))?.checkIn, 'the control session\'s check-in');
    await sleep(3000);
    expect((await rowOf(id)).reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect((await rowOf(id)).checkIn).toBeNull();
    expect(await scrollback(id)).not.toContain(TAG);
  });

  test('answered "self" with nothing alive: shown stuck, never asked again until a new turn', async () => {
    const id = await endedTurn(`checkin-stuck-${Date.now()}`, { on: 'self', what: 'wait for the build' });
    await setConfig(FAST);
    const ci = await until(async () => (await rowOf(id))?.checkIn, 'a check-in');
    // Its echo first: under a loaded suite the shell can print it seconds after the send,
    // and a count taken before that would read a late echo as a second check-in.
    await until(async () => (await scrollback(id)).includes(TAG), 'the check-in in the terminal');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} You have been idle 1 min.` })).toBe(200);
    expect(await report(id, { on: 'self', what: 'still the build' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => { const r = await rowOf(id); return r?.checkIn?.state === 'stuck' && r.status === 'idle'; }, 'stuck');
    // Stale-self again, past every threshold - and not asked a second time.
    expect((await rowOf(id)).reason).toMatchObject({ kind: 'self', source: 'reported' });
    const before = count(await scrollback(id), TAG);
    await sleep(4000);
    expect((await rowOf(id)).checkIn).toMatchObject({ sentAt: ci.sentAt, state: 'stuck' });
    expect(count(await scrollback(id), TAG)).toBe(before);
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(1);

    // Active again (a person's turn that ends on a self-wait): a new idle period, a new check-in.
    await turn(id, 'carry on', { on: 'self', what: 'wait for the build' });
    const again = await until(async () => { const c = (await rowOf(id))?.checkIn; return c && c.sentAt > ci.sentAt ? c : null; }, 'a second check-in');
    expect(again.state).toBe('sent');
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(2);
  });

  test('a live waker (a Monitor in the transcript) means no check-in', async () => {
    const dir = path.join(claudeProjectsRoot(), '__wt-checkin-fixture__');
    const fixture = path.join(dir, `wt_checkin_${process.pid}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    const at = Date.now() - 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    fs.writeFileSync(fixture, [
      JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_m', name: 'Monitor', input: { command: 'node w.js', description: 'watch CI', timeout_ms: 3600000 } }] } }),
      JSON.stringify({ type: 'user', timestamp: iso(at + 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_m', content: 'Monitor started (task cm1).' }] }, toolUseResult: { taskId: 'cm1', timeoutMs: 3600000, persistent: false } }),
    ].join('\n') + '\n', 'utf8');
    try {
      const id = await endedTurn(`checkin-live-${Date.now()}`, { on: 'self', what: 'CI watcher' }, fixture);
      await until(async () => ((await rowOf(id))?.backgroundTasks || []).some((t) => t.id === 'cm1'), 'the monitor to be live work');
      await setConfig(FAST);
      await sleep(4000);
      const row = await rowOf(id);
      expect(row.reason).toMatchObject({ kind: 'self', source: 'background' });
      expect(row.checkIn).toBeNull();
      expect(await scrollback(id)).not.toContain(TAG);
      expect(logOf(id)).toHaveLength(0);
      // #456 - the backstop: past withLiveWorkMin it IS asked, live waker or not, in words
      // that do not claim nothing is running.
      await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, withLiveWorkMin: 0.02 } });
      await until(async () => (await rowOf(id))?.checkIn, 'the backstop check-in');
      const sb = await until(async () => { const t = await scrollback(id); return t.includes(TAG) ? t : null; }, 'the check-in in the terminal');
      expect(sb).toContain('still listed as running');
      expect(logOf(id).filter((l) => l.event === 'sent')).toEqual([expect.objectContaining({ why: 'long-self' })]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#456 a lead whose watcher still runs is asked once every child has stopped', async () => {
    // The night of 2026-11-09: the lead's watcher ran all night and saw nothing; its
    // children had finished and were waiting on it.
    const at = Date.now() - 60 * 1000;
    const watcher = transcript('lead', [
      JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_w', name: 'Monitor', input: { command: 'node w.js', description: 'watch my workers', timeout_ms: 3600000 } }] } }),
      JSON.stringify({ type: 'user', timestamp: iso(at + 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_w', content: 'Monitor started (task cw1).' }] }, toolUseResult: { taskId: 'cw1', timeoutMs: 3600000, persistent: false } }),
    ]);
    const lead = await endedTurn(`checkin-lead-${Date.now()}`, { on: 'self', what: 'my workers' }, watcher);
    const cr = await ctx.post('/api/sessions', { data: { name: `checkin-worker-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH, parentId: lead } });
    expect(cr.status()).toBe(200);
    const child = (await cr.json()).id;
    made.push(child);
    await until(async () => (await rowOf(child))?.agentReady === true, 'the child to be ready');
    const childTp = transcript('worker');
    // The child mid-turn: live, so the lead has a live waker beside its watcher - not asked.
    const conv = crypto.randomUUID();
    expect(await hook(child, 'UserPromptSubmit', { session_id: conv, prompt: 'build it', transcript_path: childTp })).toBe(200);
    await until(async () => ((await rowOf(lead))?.backgroundTasks || []).some((t) => t.id === 'cw1'), 'the watcher to be live work');
    await setConfig(FAST);
    await sleep(4000);
    expect((await rowOf(lead)).checkIn).toBeNull();
    expect(await scrollback(lead)).not.toContain(TAG);
    // The child stops, waiting on its lead. The watcher still runs - and the lead is asked.
    expect(await report(child, { on: 'external', what: 'lead starts the next step' })).toBe(200);
    expect(await hook(child, 'Stop', { session_id: conv, transcript_path: childTp })).toBe(200);
    await until(async () => (await rowOf(lead))?.checkIn, 'the lead\'s check-in');
    expect(((await rowOf(lead)).backgroundTasks || []).some((t) => t.id === 'cw1')).toBe(true);
    const sb = await until(async () => { const t = await scrollback(lead); return t.includes(TAG) ? t : null; }, 'the check-in in the terminal');
    expect(sb).toContain('child session');
    expect(logOf(lead).filter((l) => l.event === 'sent')).toEqual([expect.objectContaining({ why: 'children-parked' })]);
    // The child itself reported external: never asked.
    expect((await rowOf(child)).checkIn).toBeNull();
  });

  test('fails closed through children: a child whose work cannot be read blocks its parent\'s check-in', async () => {
    const parent = await endedTurn(`checkin-parent-${Date.now()}`, { on: 'self', what: 'wait for my helper' });
    // A child with no transcript at all: its own work "cannot be told".
    const cr = await ctx.post('/api/sessions', { data: { name: `checkin-child-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH, parentId: parent } });
    expect(cr.status()).toBe(200);
    const child = (await cr.json()).id;
    made.push(child);
    await until(async () => (await rowOf(child))?.agentReady === true, 'the child to be ready');
    // Idle and done, so it is not a `child` waker (addChildWork) - yet its own work, with no
    // transcript, cannot be read. Only the descendant walk in checkInLiveKnown sees that.
    await turn(child, 'help', null, null);
    await setConfig(FAST);
    await sleep(3000);
    // Still a reported self-wait (the child is not live work), so only the child gate holds it.
    expect((await rowOf(parent)).reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect((await rowOf(parent)).checkIn).toBeNull();
    // The child gone, the parent's reading is whole again - and it is asked.
    expect((await ctx.delete(`/api/sessions/${child}`)).status()).toBe(200);
    await until(async () => (await rowOf(parent))?.checkIn, 'the parent\'s check-in once the child is gone');
  });

  test('the per-session and the fleet off switches each mean none at all', async () => {
    const id = await endedTurn(`checkin-off-${Date.now()}`, { on: 'self', what: 'x' });
    expect((await ctx.patch(`/api/sessions/${id}/brief`, { data: { checkInOff: 'yes' } })).status()).toBe(400);
    expect((await ctx.patch(`/api/sessions/${id}/brief`, { data: { checkInOff: true } })).status()).toBe(200);
    expect((await rowOf(id)).brief.checkInOff).toBe(true);
    const fleet = await endedTurn(`checkin-fleet-${Date.now()}`, { on: 'self', what: 'y' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, enabled: false } });
    await sleep(3000);
    for (const s of [id, fleet]) {
      expect((await rowOf(s)).checkIn).toBeNull();
      expect(await scrollback(s)).not.toContain(TAG);
    }
    // Fleet on again: the per-session switch still holds; the other session is asked.
    await setConfig(FAST);
    await until(async () => (await rowOf(fleet))?.checkIn, 'a check-in once the fleet switch is on');
    await sleep(2000);
    expect((await rowOf(id)).checkIn).toBeNull();
    expect(await scrollback(id)).not.toContain(TAG);
  });

  test('the per-session switch needs a login; a hook token is not one', async () => {
    const r = await ctx.post('/api/sessions', { data: { name: `checkin-auth-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    const anon = await pwRequest.newContext({ baseURL: BASE });
    expect((await anon.patch(`/api/sessions/${id}/brief`, { data: { checkInOff: true } })).status()).toBe(401);
    expect((await anon.patch(`/api/sessions/${id}/brief`, { data: { checkInOff: true }, headers: { 'X-WT-Hook-Token': readHookToken() } })).status()).toBe(401);
    await anon.dispose();
  });
});
