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
const SKIPS = path.join(HANDOFF_DIR, 'check-in-skips.jsonl'); // #463
const skipsOf = (id) => (fs.existsSync(SKIPS) ? fs.readFileSync(SKIPS, 'utf8') : '').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);
// #540 - the usage ledger this suite's server appends its decisions to (playwright.config.js), and the fake
// `claude -p` the pre-check runs (tests/fixtures/fake-precheck-cli.js): its mode.json and what it recorded.
const LEDGER = process.env.WT_USAGE_LEDGER_FILE || path.join(HANDOFF_DIR, 'usage-ledger.test.jsonl');
const ledgerOf = (id) => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id.slice(0, 8));
const FAKE_DIR = process.env.FAKE_PRECHECK_DIR;
const setFake = (mode) => { fs.mkdirSync(FAKE_DIR, { recursive: true }); fs.writeFileSync(path.join(FAKE_DIR, 'mode.json'), JSON.stringify(mode)); };
const fakeRuns = () => (fs.existsSync(FAKE_DIR) ? fs.readdirSync(FAKE_DIR).filter((f) => f.startsWith('run-')) : [])
  .map((f) => JSON.parse(fs.readFileSync(path.join(FAKE_DIR, f), 'utf8')));
const clearFake = () => { fs.rmSync(FAKE_DIR, { recursive: true, force: true }); };

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
    clearFake();
  });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    clearFake();
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

  test('#458 an external wait is asked in its own words; a wait on you or done never is', async () => {
    const stamp = Date.now();
    const ext = await endedTurn(`checkin-ext-${stamp}`, { on: 'external', what: 'PR review by the platform team' });
    const you = await endedTurn(`checkin-you-${stamp}`, { on: 'you', what: 'pick a threshold' });
    const done = await endedTurn(`checkin-fin-${stamp}`, { on: 'done', what: 'all merged' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, externalMin: 0.01 } });
    await until(async () => (await rowOf(ext))?.checkIn, 'a check-in on the external wait');
    const sb = await until(async () => { const t = await scrollback(ext); return t.includes(TAG) ? t : null; }, 'the check-in in the terminal');
    expect(sb).toContain('waiting on someone or something else');
    expect(sb).toContain('PR review by the platform team');
    expect(sb).toContain('report wait external');
    expect(logOf(ext).filter((l) => l.event === 'sent')).toMatchObject([{ why: 'external' }]);
    // One check-in per scan, every 300 ms: well past the scans that would have reached them.
    await sleep(4000);
    for (const id of [you, done]) {
      expect((await rowOf(id)).checkIn).toBeNull();
      expect(await scrollback(id)).not.toContain(TAG);
      expect(logOf(id)).toHaveLength(0);
    }
    expect(logOf(ext).filter((l) => l.event === 'sent')).toHaveLength(1);
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
  test('#461: a turn an API error cut is asked in its own words; one that then Stopped never is', async () => {
    // The ladder off, so only the check-in types; apiErrorMin short.
    await setConfig({ ...FAST, autoContinueOnApiError: false, checkIn: { ...FAST.checkIn, apiErrorMin: 0.02 } });
    const open = async (name) => {
      const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
      expect(r.status()).toBe(200);
      const id = (await r.json()).id;
      made.push(id);
      await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
      return id;
    };
    // The error line reaches the PTY the way Claude's does: as output while the turn runs.
    // Built from parts so this file is not itself the line (#138).
    const line = ['API', 'Error:', 'Connection', 'lost', 'mid-response.'].join(' ');
    const cutTurnIn = async (id, endWith) => {
      const conv = crypto.randomUUID();
      const tp = { transcript_path: transcript(id.slice(0, 8)) };
      expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work', ...tp })).toBe(200);
      const typed = await ctx.post(`/api/sessions/${id}/answer`, { data: { frames: [{ keys: `echo ${line}\r`, delayMs: 0 }] } });
      expect(typed.status()).toBe(202);
      // The public row does not carry the flag (the check-in reads the worker's own): wait for the output.
      await until(async () => (await scrollback(id)).includes(line), 'the line in the terminal');
      // Claude's idle Notification (its 60 s idle_prompt): any other kind is dropped by the server.
      const idle = endWith === 'Notification' ? { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } : {};
      expect(await hook(id, endWith, { session_id: conv, ...tp, ...idle })).toBe(200);
      await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
    };
    const cut = await open(`checkin-apierr-${Date.now()}`);
    const ended = await open(`checkin-apierr-stop-${Date.now()}`);
    await cutTurnIn(ended, 'Stop');         // the line printed, then the turn ENDED: a sighting
    await cutTurnIn(cut, 'Notification');   // no Stop: Claude's idle after a cut turn

    const sb = await until(async () => { const t = await scrollback(cut); return t.includes(TAG) ? t : null; }, 'the check-in in the cut session');
    expect(sb).toContain('cut off by an API error');
    expect(sb).toContain('Connection lost mid-response');
    expect(logOf(cut).filter((l) => l.event === 'sent').map((l) => l.why)).toEqual(['api-error']);
    // The session whose turn ended was never asked, though it shows the same line.
    await sleep(3000);
    expect(await scrollback(ended)).not.toContain(TAG);
    expect(logOf(ended)).toHaveLength(0);
    // Asked once: it stays asked through more scans.
    expect(logOf(cut).filter((l) => l.event === 'sent')).toHaveLength(1);
  });

  test('#463 a session the full rule refuses is logged with the gate that said no', async () => {
    // No transcript_path in its hooks: live work cannot be told, so the rule says cannot-tell.
    const r = await ctx.post('/api/sessions', { data: { name: `checkin-skip-${Date.now()}`, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await report(id, { on: 'self', what: 'x' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'idle');
    await setConfig(FAST);
    const line = await until(async () => skipsOf(id).find((l) => l.reason === 'cannot-tell'), 'the skip line');
    expect(line).toMatchObject({ event: 'skipped', source: 'row', agent: 'claude', status: 'idle' });
    // The same gate on every scan (each 300 ms): one line, not one per scan.
    await sleep(3000);
    expect(skipsOf(id).filter((l) => l.reason === 'cannot-tell')).toHaveLength(1);
    expect(logOf(id)).toHaveLength(0);
  });

  test('#463 an answered check-in is asked again after repeatMin, and counted', async () => {
    const id = await endedTurn(`checkin-repeat-${Date.now()}`, { on: 'self', what: 'wait for the build' });
    // repeatMin 0.1 min: the second ask is due 6 s after the first answer, not at once.
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, repeatMin: 0.1, changeCheckMin: 0.05 } });
    const ci = await until(async () => (await rowOf(id))?.checkIn, 'a check-in');
    await until(async () => (await scrollback(id)).includes(TAG), 'the check-in in the terminal');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} You have been idle 1 min.` })).toBe(200);
    expect(await report(id, { on: 'self', what: 'a new watcher on the build' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => { const r = await rowOf(id); return r?.checkIn?.state === 'stuck' && r.status === 'idle'; }, 'answered');
    // #540 - the first look after the answer records the world it left (the baseline) ...
    await until(async () => (await rowOf(id))?.brief?.checkIn?.base, 'the baseline');
    // ... so the clock alone (repeatMin passes) asks nothing: the check-in is not repeated on an unchanged world.
    await sleep(8000);
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(1);
    expect((await rowOf(id)).checkIn.state).toBe('stuck');
    // The session reports a different wait (its world moved): now the ladder's clock asks.
    expect(await report(id, { on: 'self', what: 'a different watcher on the build' })).toBe(200);
    const again = await until(async () => { const c = (await rowOf(id))?.checkIn; return c && c.sentAt > ci.sentAt ? c : null; }, 'the repeat check-in', 30000);
    expect(again.state).toBe('sent');
    expect(logOf(id).filter((l) => l.event === 'sent').map((l) => l.n)).toEqual([1, 2]);
  });

  test('#540 layer 1: an answered check-in on an unchanged world is not asked again; the ledger says so once', async () => {
    const id = await endedTurn(`checkin-unchanged-${Date.now()}`, { on: 'external', what: 'review of the PR' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, externalMin: 0.01, repeatMin: 0.05, changeCheckMin: 0.05 } });
    await until(async () => (await rowOf(id))?.checkIn, 'the first check-in');
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: `${TAG} You have been idle 1 min.` })).toBe(200);
    expect(await report(id, { on: 'external', what: 'review of the PR' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv })).toBe(200);
    await until(async () => (await rowOf(id))?.checkIn?.state === 'external', 'the answer');
    await until(async () => (await rowOf(id))?.brief?.checkIn?.base, 'the baseline');
    // The clock is due (3 s) many times over; nothing moved: no second check-in, one ledger line.
    const held = await until(async () => ledgerOf(id).find((l) => l.decision === 'skipped'), 'the ledger line for the held check-in', 20000);
    expect(held).toMatchObject({ event: 'check-in', by: 'rule', why: 'external', n: 2, changed: [] });
    expect(held.machine).toBeTruthy();
    await sleep(4000);
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(1);
    expect(ledgerOf(id).filter((l) => l.decision === 'skipped')).toHaveLength(1);
    expect(skipsOf(id).some((l) => l.reason === 'unchanged')).toBe(true);
    // The first check-in was a wake, recorded with the session's context size (none reported here).
    expect(ledgerOf(id).filter((l) => l.decision === 'woken')).toHaveLength(1);
    // Something moves (a PR item appears on its report): asked again, as the second of the period.
    expect(await ctx.post(`/api/session/${id}/report`, { data: { items: [{ ref: '#9', title: 'the PR', state: 'in-progress', stage: 'pr-open' }], wait: { on: 'external', what: 'review of the PR' } },
      headers: { 'X-WT-Hook-Token': readHookToken() } }).then((r) => r.status())).toBe(200);
    await until(async () => logOf(id).filter((l) => l.event === 'sent').length === 2, 'the repeat after a change', 30000);
    expect(logOf(id).filter((l) => l.event === 'sent').map((l) => l.n)).toEqual([1, 2]);
  });

  /** An external wait the check-in may ask about at once, with the pre-check on the fake CLI. */
  async function externalIdle(name, config = {}) {
    const id = await endedTurn(name, { on: 'external', what: 'CI of the PR' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, externalMin: 0.01, ...config } });
    return id;
  }

  test('#540 layer 2: skip - nothing is typed, the verdict and reason are logged, the ledger has it, the model asked is the registry\'s', async () => {
    setFake({ mode: 'skip', reason: 'CI is still running on the PR' });
    const id = await externalIdle(`checkin-pre-skip-${Date.now()}`);
    const row = await until(async () => { const r = await rowOf(id); return r?.checkIn?.state === 'skipped' ? r : null; }, 'the skipped check-in');
    expect(row.brief.checkIn).toMatchObject({ n: 1, why: 'external', answer: { on: 'external' }, pre: { verdict: 'skip', reason: 'CI is still running on the PR', model: 'haiku' } });
    await sleep(2500);
    expect(await scrollback(id)).not.toContain(TAG);
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(0);
    expect(logOf(id).find((l) => l.event === 'precheck')).toMatchObject({ verdict: 'skip', reason: 'CI is still running on the PR', model: 'haiku', why: 'external' });
    expect(ledgerOf(id)).toEqual([expect.objectContaining({ event: 'check-in', decision: 'skipped', by: 'precheck', verdict: 'skip', why: 'external', model: 'haiku', n: 1 })]);
    // It read the session's words and facts, tools off, on the registry's tier - and asked ONCE (a virtual answer holds it).
    const runs = fakeRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].stdin).toContain('CI of the PR');
    expect(runs[0].argv).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--tools', '']));
  });

  test('#540 layer 2: tell - a card for the owner, nothing typed', async () => {
    setFake({ mode: 'tell', reason: 'It asks whether to merge the PR or wait.' });
    const id = await externalIdle(`checkin-pre-tell-${Date.now()}`);
    const row = await until(async () => { const r = await rowOf(id); return r?.checkIn?.state === 'told' ? r : null; }, 'the told check-in');
    expect(row.brief.possibleAsk).toMatchObject({ text: 'Pre-check: It asks whether to merge the PR or wait.' });
    await sleep(2500);
    expect(await scrollback(id)).not.toContain(TAG);
    expect(ledgerOf(id)).toEqual([expect.objectContaining({ decision: 'told', by: 'precheck', verdict: 'tell' })]);
  });

  test('#540 layer 2: wake, and every failure of the model, types the check-in as it always did', async () => {
    // wake: typed, and the record carries the verdict.
    setFake({ mode: 'wake', reason: 'it may have missed the event' });
    const a = await externalIdle(`checkin-pre-wake-${Date.now()}`);
    await until(async () => (await scrollback(a)).includes(TAG), 'the check-in in the terminal', 60000);
    expect(logOf(a).find((l) => l.event === 'sent')).toMatchObject({ verdict: 'wake', reason: 'it may have missed the event', model: 'haiku' });
    expect(ledgerOf(a)).toEqual([expect.objectContaining({ decision: 'woken', by: 'precheck', verdict: 'wake' })]);
    // The model fails (exit 1), answers prose, or names a verdict that does not exist: asked anyway, the failure logged.
    for (const mode of [{ mode: 'exit1' }, { mode: 'bad' }, { mode: 'verdict', verdict: 'ignore' }]) {
      setFake(mode);
      const b = await externalIdle(`checkin-pre-fail-${mode.mode}-${Date.now()}`);
      await until(async () => (await scrollback(b)).includes(TAG), `the check-in despite ${mode.mode}`);
      expect(logOf(b).find((l) => l.event === 'precheck')).toMatchObject({ verdict: 'wake', failed: expect.any(String) });
      expect(ledgerOf(b)).toEqual([expect.objectContaining({ decision: 'woken', by: 'rule', reason: expect.stringContaining('pre-check failed') })]);
    }
  });

  test('#540 layer 2: "skip" is never honoured where the reading proves the session stranded (stale-self); the off switch asks nobody', async () => {
    setFake({ mode: 'skip', reason: 'still waiting' });
    // A reported self-wait with nothing alive can wake it: stale-self. The model's "still pending" is not believed.
    const id = await endedTurn(`checkin-pre-stale-${Date.now()}`, { on: 'self', what: 'watch the CI run' });
    await setConfig(FAST);
    await until(async () => (await scrollback(id)).includes(TAG), 'the check-in despite a skip', 60000);
    expect(logOf(id).find((l) => l.event === 'sent')).toMatchObject({ why: 'stale-self', verdict: 'wake' });
    // Off: no model run at all, and the check-in goes out.
    clearFake();
    const before = fakeRuns().length;
    const other = await endedTurn(`checkin-pre-off-${Date.now()}`, { on: 'external', what: 'CI' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, externalMin: 0.01 }, checkInPrecheck: { enabled: false } });
    await until(async () => (await scrollback(other)).includes(TAG), 'the check-in with the pre-check off', 60000);
    expect(fakeRuns().length).toBe(before);
  });

  /** A session at 80% of a 1M window, idle, reporting an external wait - the hand-off's candidate (lib/handoff.js). */
  async function bigExternalIdle(name, config = {}, handoff = {}) {
    // The previous call's config is still live while this session becomes idle: with check-ins ON it could be
    // asked (or handed off) under THAT config before this call's own lands. Off first, the real config last.
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, enabled: false } });
    const r = await ctx.post('/api/sessions', { data: { name, agent: 'claude', autoCommand: LAUNCH } });
    const id = (await r.json()).id;
    made.push(id);
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const tp = transcript(name);
    const conv = crypto.randomUUID();
    expect(await hook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work', transcript_path: tp })).toBe(200);
    expect(await report(id, { on: 'external', what: 'PR review' })).toBe(200);
    expect(await hook(id, 'Stop', { session_id: conv, transcript_path: tp })).toBe(200);
    expect((await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 80 } } })).status()).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'idle');
    await setConfig({ ...FAST, handoff: { ...FAST.handoff, idleMin: 0.01, auto: true, autoEveryMs: 600000, ...handoff }, checkIn: { ...FAST.checkIn, externalMin: 0.01, ...config } });
    return id;
  }

  test('#540 layer 3: a wake of a big session idle an hour starts the hand-off instead; the ledger has its size', async () => {
    const id = await bigExternalIdle(`checkin-handoff-${Date.now()}`, { bigIdleMin: 0.01 });
    const row = await until(async () => { const r = await rowOf(id); return r?.handoff?.run ? r : null; }, 'the hand-off to start');
    expect(row.handoff.run).toMatchObject({ state: 'wrapping', trigger: 'auto' });
    await sleep(1500);
    // No check-in was typed, and the log and the ledger say what happened and how big the session was.
    expect(await scrollback(id)).not.toContain(TAG);
    expect(logOf(id).filter((l) => l.event === 'sent')).toHaveLength(0);
    expect(logOf(id).find((l) => l.event === 'handed-off')).toMatchObject({ why: 'external', ctxTokens: 800000 });
    expect(ledgerOf(id)).toEqual([expect.objectContaining({ decision: 'handed-off', by: 'handoff', why: 'external', ctxK: 800 })]);
  });

  test('#540 layer 3: not idle long enough, or the switch off, or the hand-off refused: the check-in is typed', async () => {
    test.setTimeout(240000); // three sessions, each with its own config round (5.5 s past the config cache)
    // Idle only seconds against an hour's bigIdleMin: the wake is a check-in.
    const a = await bigExternalIdle(`checkin-handoff-short-${Date.now()}`);
    await until(async () => (await scrollback(a)).includes(TAG), 'the check-in on a session not idle long enough to hand off', 60000);
    expect((await rowOf(a)).handoff.run).toBeNull();
    expect(ledgerOf(a)).toEqual([expect.objectContaining({ decision: 'woken', ctxK: 800 })]);
    // The switch off: the same big idle session is asked.
    const b = await bigExternalIdle(`checkin-handoff-off-${Date.now()}`, { bigIdleMin: 0.01, handoffInstead: false });
    await until(async () => (await scrollback(b)).includes(TAG), 'the check-in with handoffInstead off', 60000);
    expect((await rowOf(b)).handoff.run).toBeNull();
    // The owner turned the automatic hand-off off (handoff.auto): the hand-off's own gate refuses, and it is asked.
    const c = await bigExternalIdle(`checkin-handoff-noauto-${Date.now()}`, { bigIdleMin: 0.01 }, { auto: false });
    await until(async () => (await scrollback(c)).includes(TAG), 'the check-in when the hand-off refuses', 60000);
    expect((await rowOf(c)).handoff.run).toBeNull();
    expect(await until(async () => skipsOf(c).find((l) => l.reason === 'handoff-auto-off'), 'the refused hand-off in the skip log')).toMatchObject({ source: 'handoff-instead' });
  });

  test('#463 no wait reported since a typed prompt, a watcher still running: asked as live-unreported', async () => {
    const at = Date.now() - 60 * 1000;
    const watcher = transcript('unreported', [
      JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_u', name: 'Monitor', input: { command: 'node w.js', description: 'watch the PR builds', timeout_ms: 3600000 } }] } }),
      JSON.stringify({ type: 'user', timestamp: iso(at + 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_u', content: 'Monitor started (task cu1).' }] }, toolUseResult: { taskId: 'cu1', timeoutMs: 3600000, persistent: false } }),
    ]);
    const id = await endedTurn(`checkin-unreported-${Date.now()}`, { on: 'self', what: 'verify-ci on the PR' }, watcher);
    // A lead types a follow-up: that clears the self-wait, and the reply reports none.
    await turn(id, 'if review finds a must-fix, revert that part', null, watcher);
    await until(async () => ((await rowOf(id))?.backgroundTasks || []).some((t) => t.id === 'cu1'), 'the watcher to be live work');
    const row = await rowOf(id);
    expect(row.brief.wait).toBeNull();
    expect(row.reason).toMatchObject({ kind: 'self', source: 'background' });
    await setConfig({ ...FAST, checkIn: { ...FAST.checkIn, withLiveWorkMin: 0.02 } });
    await until(async () => (await rowOf(id))?.checkIn, 'the check-in');
    const sb = await until(async () => { const t = await scrollback(id); return t.includes(TAG) ? t : null; }, 'the check-in in the terminal');
    expect(sb).toContain('reported no wait');
    expect(sb).toContain('watch the PR builds');
    expect(logOf(id).filter((l) => l.event === 'sent')).toEqual([expect.objectContaining({ why: 'live-unreported', n: 1 })]);
  });
});
