// @ts-check
// #443 milestone 1 - everything that can wake a Claude session counts as live work.
//
// lib/background-tasks.js used to know one kind (a run_in_background shell). A self-wait
// kept alive by an async subagent, a Monitor, a ScheduleWakeup, a cron job or a child
// session read as STALE, so the #437 hand-off took it and #443's check-in would prompt it.
// Each kind below has a test that fails without its detector, and each END condition is
// tested by breaking it alone. Fixtures are hand-built from the measured shapes (Claude
// Code 2.1.319); no transcript content is checked in.
const { test, expect } = require('@playwright/test');
const B = require('../lib/background-tasks');
const { sessionReason } = require('../lib/session-reason');
const H = require('../lib/handoff');

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

/** The assistant line that calls a tool. */
const use = (id, name, input, at = T0) => JSON.stringify({
  type: 'assistant', timestamp: iso(at),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
/** The user line with that call's result, and the line-level structured result. */
const result = (id, text, toolUseResult, at = T0 + 1000) => JSON.stringify({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  ...(toolUseResult ? { toolUseResult } : {}),
});
/** An injected notification; `status` null = a Monitor EVENT (measured: no <status> tag). */
const notif = (taskId, { status = 'completed', event = null, at = T0 + 5 * MIN } = {}) => JSON.stringify({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n` +
    (status ? `<status>${status}</status>\n` : '') + `<summary>something</summary>\n` +
    (event ? `<event>${event}</event>\n` : '') + `</task-notification>` },
});
const scan = (...lines) => B.scanBackgroundTasks(lines.join('\n'));

// --- async subagent -----------------------------------------------------------------------
const AGENT = 'a1b2c3d4e5f6a7b8c';
const agentLaunch = (at = T0) => [
  use('tu_a', 'Agent', { description: 'Explore the input path', prompt: 'p', subagent_type: 'Explore' }, at),
  result('tu_a', [{ type: 'text', text: `Async agent launched successfully. agentId: ${AGENT}` }],
    { isAsync: true, agentId: AGENT, status: 'async_launched', description: 'Explore the input path' }, at + 1000),
];

test.describe('async subagent', () => {
  test('a launched async agent is live work, with its description', () => {
    expect(scan(...agentLaunch())).toEqual([
      { id: AGENT, kind: 'agent', description: 'Explore the input path', startedAt: T0 + 1000 },
    ]);
  });

  test('its notification ends it', () => {
    expect(scan(...agentLaunch(), notif(AGENT))).toEqual([]);
  });

  test('TaskStop naming it ends it', () => {
    expect(scan(...agentLaunch(), use('tu_k', 'TaskStop', { task_id: AGENT }, T0 + 2 * MIN))).toEqual([]);
  });

  test('a FOREGROUND agent result (no isAsync) is not live work - it already finished', () => {
    expect(scan(use('tu_a', 'Agent', { description: 'x', prompt: 'p' }),
      result('tu_a', 'the agent report', { agentId: AGENT, status: 'completed' }))).toEqual([]);
  });

  test('a launch is read off the RESULT, so an input without run_in_background still counts', () => {
    // Measured: 289 of 452 async launches carried no run_in_background in their input.
    const lines = agentLaunch();
    expect(JSON.parse(lines[0]).message.content[0].input.run_in_background).toBeUndefined();
    expect(scan(...lines)).toHaveLength(1);
  });

  test('the structured result alone is enough (text that names no id)', () => {
    expect(scan(agentLaunch()[0], result('tu_a', 'Async agent launched successfully.', { isAsync: true, agentId: AGENT })))
      .toMatchObject([{ id: AGENT, kind: 'agent' }]);
  });

  test('text fallback: an "Async agent launched ... agentId:" result with no structured result', () => {
    expect(scan(agentLaunch()[0], result('tu_a', `Async agent launched successfully. agentId: ${AGENT}`)))
      .toMatchObject([{ id: AGENT, kind: 'agent' }]);
  });

  test('an api-request-blob REPLAY of the result launches nothing, so the real line dates it', () => {
    // Measured on a real transcript: the replay (no timestamp) landed before the real result
    // line, registered the agent with startedAt null, and the 6 h backstop never dropped it.
    const blob = JSON.stringify({ type: 'api-request-blob', sessionId: 's', hash: 'h',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: `Async agent launched successfully. agentId: ${AGENT}` }] } });
    const [call, real] = agentLaunch();
    expect(scan(call, blob)).toEqual([]);
    expect(scan(call, blob, real)).toMatchObject([{ id: AGENT, startedAt: T0 + 1000 }]);
  });

  test('QUOTED launch text on an unpaired result is not a launch', () => {
    expect(scan(result('tu_grep', `Async agent launched successfully. agentId: ${AGENT}`,
      { isAsync: true, agentId: AGENT }))).toEqual([]);
  });

  test('SendMessage revives a finished agent; its next notification ends it again', () => {
    const revive = (at) => [
      use('tu_s', 'SendMessage', { to: AGENT, summary: 'follow-up', message: 'm' }, at),
      result('tu_s', '{"success":true,"message":"Resuming agent a1b2c3d"}',
        { success: true, message: 'Resuming agent a1b2c3d', resumedAgentId: AGENT }, at + 500),
    ];
    const finished = [...agentLaunch(), notif(AGENT, { at: T0 + 5 * MIN })];
    expect(scan(...finished)).toEqual([]);
    // ...and its run starts at the revival, so the 6 h age backstop does not drop it at once.
    expect(scan(...finished, ...revive(T0 + 10 * MIN))).toMatchObject([{ id: AGENT, kind: 'agent', startedAt: T0 + 10 * MIN + 500 }]);
    expect(scan(...finished, ...revive(T0 + 10 * MIN), notif(AGENT, { at: T0 + 20 * MIN }))).toEqual([]);
  });

  test('a SendMessage to another SESSION (no resumedAgentId) revives nothing', () => {
    expect(scan(use('tu_s', 'SendMessage', { to: 'other-session', message: 'm' }),
      result('tu_s', '{"success":true}', { success: true, msg_id: 'x' }))).toEqual([]);
  });
});

// --- Monitor ------------------------------------------------------------------------------
const MON = 'bqp0maisw';
const monitorLaunch = (input = {}, tur = {}) => [
  use('tu_m', 'Monitor', { command: 'node watch.js', description: 'PR checks', timeout_ms: 30 * MIN, ...input }),
  result('tu_m', `Monitor started (task ${MON}, expires in 30m unless the source ends first).`,
    { taskId: MON, timeoutMs: 30 * MIN, persistent: false, ...tur }),
];

test.describe('Monitor', () => {
  test('a started monitor is live work until its timeout', () => {
    expect(scan(...monitorLaunch())).toEqual([
      { id: MON, kind: 'monitor', description: 'PR checks', startedAt: T0 + 1000, until: T0 + 1000 + 30 * MIN },
    ]);
  });

  test('an EVENT does not end it (the rule that ends a command would)', () => {
    expect(scan(...monitorLaunch(), notif(MON, { status: null, event: 'check 3/9 passed' })))
      .toMatchObject([{ id: MON, kind: 'monitor' }]);
  });

  test('the expiry notice ends it', () => {
    expect(scan(...monitorLaunch(), notif(MON, { status: null,
      event: '[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]' }))).toEqual([]);
  });

  test('a notification carrying <status> ends it', () => {
    expect(scan(...monitorLaunch(), notif(MON, { status: 'completed' }))).toEqual([]);
  });

  test('TaskStop naming it ends it', () => {
    expect(scan(...monitorLaunch(), use('tu_k', 'TaskStop', { task_id: MON }, T0 + 2 * MIN))).toEqual([]);
  });

  test('a persistent monitor has no timeout', () => {
    const [m] = scan(...monitorLaunch({ persistent: true }, { persistent: true }));
    expect(m).toMatchObject({ id: MON, kind: 'monitor' });
    expect(m.until).toBeUndefined();
  });
});

// --- ScheduleWakeup -----------------------------------------------------------------------
const wake = (delayMin, at, extra = {}) => [
  use(`tu_w${at}`, 'ScheduleWakeup', { delaySeconds: delayMin * 60, prompt: 'continue', reason: 'r', ...extra }, at),
  result(`tu_w${at}`, `Next wakeup scheduled for 19:58:00 (in ${delayMin * 60}s).`,
    extra.stop ? null : { scheduledFor: at + delayMin * MIN, clampedDelaySeconds: delayMin * 60, wasClamped: false }, at + 100),
];

test.describe('ScheduleWakeup', () => {
  test('a pending wake-up is live work until it fires (plus a short grace)', () => {
    const [w] = scan(...wake(30, T0));
    expect(w).toMatchObject({ kind: 'wakeup', startedAt: T0 + 100 });
    expect(w.until).toBe(T0 + 30 * MIN + 2 * MIN);
  });

  test('the LATEST call wins - a shorter re-schedule replaces a longer one', () => {
    const [w, more] = scan(...wake(50, T0), ...wake(5, T0 + MIN));
    expect(more).toBeUndefined();
    expect(w.until).toBe(T0 + MIN + 5 * MIN + 2 * MIN);
  });

  test('stop: true cancels it', () => {
    expect(scan(...wake(30, T0), use('tu_stop', 'ScheduleWakeup', { stop: true }, T0 + MIN))).toEqual([]);
  });

  test('a replayed call with no timestamp cannot reorder the wake-ups', () => {
    const untimed = JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'tu_x', name: 'ScheduleWakeup', input: { stop: true } }] } });
    expect(scan(...wake(30, T0), untimed)).toHaveLength(1);
  });
});

// --- cron ---------------------------------------------------------------------------------
const JOB = 'ce9283e5';
const cronCreate = (recurring, nextFireAt = T0 + 10 * MIN) => [
  use('tu_c', 'CronCreate', { cron: '7,22,37,52 * * * *', prompt: 'tick', recurring }),
  result('tu_c', `Scheduled ${recurring ? 'recurring' : 'one-shot'} job ${JOB} (7,22,37,52 * * * *).`,
    { id: JOB, humanSchedule: '7,22,37,52 * * * *', recurring, durable: false, nextFireAt }),
];
const fire = (at, taskId = JOB) => JSON.stringify({
  type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task', timestamp: iso(at), taskId, cron: '7,22,37,52 * * * *', prompt: 'tick',
});

test.describe('cron', () => {
  test('a recurring job is live work until 6 h after its last sign of life (its next fire here)', () => {
    expect(scan(...cronCreate(true))).toEqual([{
      id: 'cron-' + JOB, kind: 'cron', description: 'scheduled task (7,22,37,52 * * * *)', startedAt: T0 + 1000,
      until: T0 + 10 * MIN + 6 * 60 * MIN,
    }]);
  });

  test('each fire extends it; a job that went quiet (died with Claude) ends; 7 days caps it', () => {
    const until = (...fires) => scan(...cronCreate(true), ...fires.map((m) => fire(T0 + m * MIN)))[0].until;
    expect(until(10, 25, 40)).toBe(T0 + 40 * MIN + 6 * 60 * MIN);
    // A job still firing every 15 min on day 7 is capped by the auto-expiry.
    const day7 = 7 * 24 * 60 - 5;
    expect(until(day7)).toBe(T0 + 1000 + 7 * 24 * 60 * MIN);
  });

  test('the structured result alone is enough, and the text alone is a fallback', () => {
    const [u] = cronCreate(true);
    expect(scan(u, result('tu_c', 'Scheduled.', { id: JOB, recurring: true, nextFireAt: T0 + MIN })))
      .toMatchObject([{ id: 'cron-' + JOB, kind: 'cron' }]);
    expect(scan(u, result('tu_c', `Scheduled recurring job ${JOB} (7,22,37,52 * * * *).`)))
      .toMatchObject([{ id: 'cron-' + JOB, kind: 'cron' }]);
    // Quoted on an unpaired result, the same text is not a job.
    expect(scan(result('tu_grep', `Scheduled recurring job ${JOB} (x).`, { id: JOB, recurring: true }))).toEqual([]);
  });

  test('firing does not end a recurring job', () => {
    expect(scan(...cronCreate(true), fire(T0 + 10 * MIN), fire(T0 + 25 * MIN))).toHaveLength(1);
  });

  test('CronDelete ends it', () => {
    expect(scan(...cronCreate(true), use('tu_d', 'CronDelete', { id: JOB }, T0 + 30 * MIN))).toEqual([]);
  });

  test('a one-shot is live until it fires, and its fire time bounds it', () => {
    const [c] = scan(...cronCreate(false));
    expect(c.until).toBe(T0 + 10 * MIN + 2 * MIN);
    expect(scan(...cronCreate(false), fire(T0 + 10 * MIN))).toEqual([]);
  });

  test('a job whose create scrolled out is still seen by its fires', () => {
    const [c] = scan(fire(T0 + 10 * MIN));
    expect(c).toMatchObject({ id: 'cron-' + JOB, kind: 'cron', startedAt: T0 + 10 * MIN });
  });
});

// --- the caller's end-instant rule ----------------------------------------------------------
test.describe('notEnded - a known end is applied at read time', () => {
  test('drops an entry at its `until`, keeps one without', () => {
    const tasks = [{ id: 'a', until: T0 }, { id: 'b', until: T0 + 1 }, { id: 'c' }];
    expect(B.notEnded(tasks, T0).map((t) => t.id)).toEqual(['b', 'c']);
    expect(B.notEnded(null, T0)).toEqual([]);
  });
});

// --- incremental feeding ------------------------------------------------------------------
test.describe('createBackgroundScanner - fed in pieces, same answer', () => {
  test('a launch fed in one read and its end in a later one', () => {
    const s = B.createBackgroundScanner();
    s.feed(agentLaunch().join('\n'));
    expect(s.running()).toHaveLength(1);
    s.feed(notif(AGENT));
    expect(s.running()).toEqual([]);
  });
});

// --- child sessions -----------------------------------------------------------------------
const row = (id, o = {}) => ({ id, name: id, status: 'idle', backgroundTasks: [], spawn: null, ...o });
const childOf = (id, parentId, o = {}) => row(id, { spawn: { parentId, createdAt: T0 }, ...o });
const childIds = (r) => r.backgroundTasks.filter((t) => t.kind === 'child').map((t) => t.id);

test.describe('addChildWork - a live child is live work for its parent', () => {
  test('a working child', () => {
    const rows = [row('P'), childOf('C', 'P', { status: 'working', name: 'worker 1' })];
    B.addChildWork(rows);
    expect(rows[0].backgroundTasks).toEqual([{ id: 'child-C', kind: 'child', description: 'session worker 1', startedAt: T0 }]);
    expect(rows[1].backgroundTasks).toEqual([]);
  });

  test('an idle child that is done is NOT live (nothing will wake the parent)', () => {
    const rows = [row('P'), childOf('C', 'P')];
    B.addChildWork(rows);
    expect(childIds(rows[0])).toEqual([]);
  });

  for (const [why, o] of [
    ['waiting on the person', { status: 'waiting' }],
    ['booting (active)', { status: 'active' }],
    ['compacting', { compacting: true }],
    ['armed to resume at a usage cap', { usageLimit: { waiting: true, armed: true } }],
    ['running background work of its own', { backgroundTasks: [{ id: 'b', kind: 'command' }] }],
  ]) {
    test(`an idle child ${why} is live`, () => {
      const rows = [row('P'), childOf('C', 'P', o)];
      B.addChildWork(rows);
      expect(childIds(rows[0])).toEqual(['child-C']);
    });
  }

  test('a capped child that will NOT resume, or stale work, does not count', () => {
    const rows = [row('P'), childOf('C1', 'P', { usageLimit: { waiting: true, armed: false } }),
      childOf('C2', 'P', { backgroundTasks: [{ id: 'p', stale: true }] })];
    B.addChildWork(rows);
    expect(childIds(rows[0])).toEqual([]);
  });

  test('a grandchild keeps the chain alive; a cycle counts as nothing', () => {
    const rows = [row('P'), childOf('C', 'P'), childOf('G', 'C', { status: 'working' })];
    B.addChildWork(rows);
    expect(childIds(rows[0])).toEqual(['child-C']);
    expect(childIds(rows[1])).toEqual(['child-G']);
    const loop = [childOf('X', 'Y'), childOf('Y', 'X')];
    B.addChildWork(loop);
    expect(childIds(loop[0])).toEqual([]);
  });

  test('a child whose parent is not in the list, or that names itself, adds nothing', () => {
    const rows = [childOf('C', 'elsewhere', { status: 'working' }), childOf('S', 'S', { status: 'working' })];
    B.addChildWork(rows);
    expect(rows.every((r) => r.backgroundTasks.length === 0)).toBe(true);
  });

  test('an unknown backgroundTasks (null) is left alone', () => {
    const rows = [row('P', { backgroundTasks: null }), childOf('C', 'P', { status: 'working' })];
    B.addChildWork(rows);
    expect(rows[0].backgroundTasks).toBeNull();
  });
});

// --- the consumers: the reason row and #437's stale-self rule read every kind --------------
test.describe('consumers - a self-wait with any live kind is not stale', () => {
  const cfg = H.handoffConfig(null);
  const now = T0 + 120 * MIN;
  /** An idle row that reported "self" 2 h ago - stale unless something is live. */
  const selfRow = (backgroundTasks) => {
    const r = { status: 'idle', backgroundTasks, brief: { turnAt: T0 - MIN, stoppedAt: T0, wait: { on: 'self', what: 'resume', at: T0 } } };
    return { ...r, reason: sessionReason(r) };
  };
  const kinds = {
    agent: scan(...agentLaunch()),
    monitor: scan(...monitorLaunch({ persistent: true }, { persistent: true })),
    wakeup: scan(...wake(60, now - 10 * MIN)),
    cron: scan(...cronCreate(true)),
    child: (() => { const rows = [row('P'), childOf('C', 'P', { status: 'working' })]; B.addChildWork(rows); return rows[0].backgroundTasks; })(),
  };

  test('nothing live: the reported self-wait is stale (the baseline the rest must break)', () => {
    const r = selfRow([]);
    expect(r.reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect(H.isStaleSelf(r, T0, now, cfg)).toBe(true);
  });

  for (const [kind, tasks] of Object.entries(kinds)) {
    test(`a live ${kind} makes the reason "self" from background work, and not stale`, () => {
      expect(tasks.map((t) => t.kind)).toEqual([kind]);
      const r = selfRow(B.notEnded(tasks, now));
      expect(r.reason).toMatchObject({ kind: 'self', source: 'background' });
      expect(H.isStaleSelf(r, T0, now, cfg)).toBe(false);
    });
  }

  test('an ask ("you") from the latest ENDED turn beats live work; an older one does not', () => {
    const r = { status: 'idle', backgroundTasks: kinds.child, brief: { turnAt: T0 - MIN, stoppedAt: T0, wait: { on: 'you', what: 'pick a port', at: T0 } } };
    expect(sessionReason(r)).toMatchObject({ kind: 'you', text: 'pick a port', source: 'reported' });
    // The ask predates the latest turn: that turn's live work wins, as before.
    const older = { ...r, brief: { ...r.brief, wait: { ...r.brief.wait, at: T0 - 2 * MIN } } };
    expect(sessionReason(older)).toMatchObject({ kind: 'self', source: 'background' });
    // The turn has not ended (no stop after it): not the turn's final word yet.
    const running = { ...r, brief: { ...r.brief, stoppedAt: T0 - 2 * MIN } };
    expect(sessionReason(running)).toMatchObject({ kind: 'self', source: 'background' });
  });

  test('a wake-up that already fired no longer keeps it', () => {
    const r = selfRow(B.notEnded(scan(...wake(5, T0)), now));
    expect(H.isStaleSelf(r, T0, now, cfg)).toBe(true);
  });
});

// --- the server's read path: GET /api/sessions ---------------------------------------------
// The suite server runs WT_BG_TASK_MAX_AGE_MS=2500, so an entry with no known end ages out
// in 2.5 s while one with `until` must not.
const fs = require('fs');
const path = require('path');
const { request: pwRequest } = require('@playwright/test');
const { claudeProjectsRoot } = require('./test-helpers');

const BASE = 'http://127.0.0.1:17681';
async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', { form: { user: 'testuser', password: 'testpass:colon' }, maxRedirects: 0 });
  const cookie = loginRes.headers()['set-cookie'].split(';')[0];
  await ctx.dispose();
  return pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Cookie: cookie } });
}

test.describe('GET /api/sessions reads every kind, incrementally, past the old 256KB tail', () => {
  const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-livework-fixture__');
  const fixture = path.join(FIXTURE_DIR, `wt_live_${process.pid}.jsonl`);
  let ctx;
  let sessionId;
  const ids = [];
  const rowOf = async (id, route = '/api/sessions') => {
    const body = await (await ctx.get(route)).json();
    const list = Array.isArray(body) ? body : body.sessions;
    return list.find((x) => x.id === id) || {};
  };
  const tasks = async (route) => ((await rowOf(sessionId, route)).backgroundTasks || []).map((t) => t.id);
  const poll = (fn) => expect.poll(fn, { timeout: 15000, intervals: [500] });
  /** A Monitor started a minute ago with an hour to run. A minute is far past the suite's
   *  2.5 s age horizon, so it can only be listed because its known end (`until`) exempts it:
   *  no assertion below can pass by the age backstop clearing or keeping it. */
  const monitor = (id) => {
    const at = Date.now() - 60 * 1000;
    return [
      use('tu_' + id, 'Monitor', { command: 'node w.js', description: 'watch ' + id, timeout_ms: 60 * MIN }, at),
      result('tu_' + id, `Monitor started (task ${id}).`, { taskId: id, timeoutMs: 60 * MIN, persistent: false }, at),
    ];
  };
  const filler = (n, ch = 'x') => Array(n).fill(JSON.stringify({ type: 'assistant', timestamp: iso(Date.now()), message: { content: [{ type: 'text', text: ch.repeat(4000) }] } }));

  test.beforeAll(async () => {
    ctx = await authCtx();
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    // A monitor started, then 400KB of ordinary turns: the old fixed 256KB tail lost it.
    fs.writeFileSync(fixture, [...monitor('bmon1'), ...filler(100)].join('\n') + '\n', 'utf8');
    expect(fs.statSync(fixture).size).toBeGreaterThan(400 * 1024);
    const res = await ctx.post('/api/sessions', { data: { name: `LiveWork-${Date.now()}`, agent: 'claude' } });
    sessionId = (await res.json()).id;
    ids.push(sessionId);
    const hr = await ctx.post('/api/hook', {
      headers: { 'X-WT-Session-ID': sessionId },
      data: { hook_event_name: 'UserPromptSubmit', transcript_path: fixture, prompt: 'go' },
    });
    expect(hr.status()).toBe(200);
  });

  test.afterAll(async () => {
    for (const id of ids) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {}
    await ctx.dispose();
  });

  test('a launch 400KB back is live, on both lists', async () => {
    await poll(() => tasks()).toEqual(['bmon1']);
    expect(await tasks('/api/cluster/sessions')).toEqual(['bmon1']);
  });

  test('an end appended in two writes is applied once its line is whole', async () => {
    const end = notif('bmon1', { status: null, event: '[Monitor expired after 60m with no events delivered.]', at: Date.now() });
    const cut = Math.floor(end.length / 2);
    fs.appendFileSync(fixture, end.slice(0, cut));
    // Past the 3 s rescan brake, so the half line is read - and held, not scanned.
    await new Promise((r) => setTimeout(r, 3500));
    expect(await tasks()).toEqual(['bmon1']);
    fs.appendFileSync(fixture, end.slice(cut) + '\n');
    await poll(() => tasks()).toEqual([]);
  });

  test('a REWRITTEN file (not appended) starts the scan over', async () => {
    // Bigger than before, so a reader that only checked the size would carry on mid-file
    // and never see this launch, which sits before the old end.
    // Different filler text, so the bytes at the old end differ whether or not an earlier
    // test appended there: this passes alone (--grep) or not at all.
    fs.writeFileSync(fixture, [...monitor('bmon2'), ...filler(150, 'y')].join('\n') + '\n', 'utf8');
    await poll(() => tasks()).toEqual(['bmon2']);
  });

  test('a live child session is live work for its parent on both lists; an idle one is not', async () => {
    const parent = (await (await ctx.post('/api/sessions', { data: { name: `LiveParent-${Date.now()}` } })).json()).id;
    ids.push(parent);
    const child = (await (await ctx.post('/api/sessions', { data: { name: `LiveChild-${Date.now()}`, parentId: parent, agent: 'claude' } })).json()).id;
    ids.push(child);
    const hook = (event) => ctx.post('/api/hook', { headers: { 'X-WT-Session-ID': child }, data: { hook_event_name: event, prompt: 'go' } });
    const childIdsOn = async (route) => ((await rowOf(parent, route)).backgroundTasks || [])
      .filter((t) => t.kind === 'child').map((t) => t.id);
    // A prompt makes the child `working` until its Stop: a state that does not drift.
    expect((await hook('UserPromptSubmit')).status()).toBe(200);
    await poll(async () => (await rowOf(child)).status).toBe('working');
    expect(await childIdsOn('/api/sessions')).toEqual(['child-' + child]);
    expect(await childIdsOn('/api/cluster/sessions')).toEqual(['child-' + child]);
    // Its turn ends with nothing running: an idle, finished child keeps nothing alive.
    expect((await hook('Stop')).status()).toBe(200);
    await poll(async () => (await rowOf(child)).status).toBe('idle');
    expect(await childIdsOn('/api/sessions')).toEqual([]);
  });
});
