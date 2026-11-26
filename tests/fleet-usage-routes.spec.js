// #529 - the fleet usage ledger through the real server: the routes a peer reads, the work/private
// override, and a whole collection pass over a fixture ~/.claude tree (a worker and an orchestrator of
// the bug hunter, a subagent, a tool error, a run dir with events) - proving the records, that nothing
// said is stored, that a second pass writes nothing, that a settings change is a new record, and
// that the report reads the same ledger. The suite's own paths are set in playwright.config.js.
const { test, expect, request: pwRequest } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BASE, authCtx, noAuthCtx, readHookToken, emptyCwd } = require('./test-helpers');
const { unitsOf } = require('../lib/usage-weights');
const { createUsageStore } = require('../lib/usage-store');
const sync = require('../lib/usage-sync');

const LEDGER = process.env.WT_FLEET_USAGE_DIR;
const CLAUDE = process.env.WT_FLEET_USAGE_CLAUDE_DIR;
const ROOTS = process.env.WT_FLEET_USAGE_ROOTS;
const SESSIONS_FILE = process.env.WT_AGENT_SESSIONS_FILE;
const line = (o) => `${JSON.stringify(o)}\n`;
const linesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); }
}

test.describe.serial('the fleet usage ledger on the server', () => {
  let ctx; let origin; const made = [];
  const get = async (p) => (await ctx.get(p)).json();
  const feed = async () => (await get(`/api/usage/feed?origin=${origin}&after=0&limit=1000`)).records;

  test.beforeAll(async () => {
    expect(LEDGER && CLAUDE && ROOTS && SESSIONS_FILE, 'playwright.config.js must set the fleet usage paths').toBeTruthy();
    ctx = await authCtx();
    origin = (await get('/api/usage/heads')).origin;
  });
  test.afterAll(async () => {
    for (const id of made) { try { await ctx.delete(`/api/sessions/${id}`); } catch { /* gone */ } }
    await ctx.dispose();
  });

  test('every route sits behind auth, and a peer\'s bad query is refused with a reason', async () => {
    const anon = await noAuthCtx();
    for (const p of ['/api/usage/heads', '/api/usage/feed?origin=x', '/api/usage/report', '/api/usage/status']) expect((await anon.get(p)).status(), p).toBe(401);
    expect((await anon.post('/api/usage/classify', { data: { project: 'x', as: 'work' } })).status()).toBe(401);
    await anon.dispose();
    const heads = await get('/api/usage/heads');
    expect(heads).toMatchObject({ machine: expect.any(String), origin: expect.any(String), heads: expect.any(Object) });
    expect((await ctx.get('/api/usage/feed?origin=..%2Fx')).status()).toBe(400);
    expect((await ctx.get(`/api/usage/feed?origin=${origin}&after=-3`)).status()).toBe(400);
    expect((await ctx.get(`/api/usage/feed?origin=${origin}&limit=100000`)).status()).toBe(400);
    expect((await ctx.get('/api/usage/report?days=0')).status()).toBe(400);
    expect((await ctx.get('/api/usage/report?scope=everything')).status()).toBe(400);
  });

  test('a work/private override is written into this machine\'s own feed, where a peer can read it', async () => {
    const before = (await get('/api/usage/heads')).heads[origin] || 0;
    const r = await ctx.post('/api/usage/classify', { data: { project: 'Alpha-529', as: 'work' } });
    expect(r.status()).toBe(200);
    const rec = (await r.json()).record;
    expect(rec).toMatchObject({ type: 'classify', origin, seq: before + 1, key: 'classify|alpha-529', project: 'alpha-529', as: 'work' });
    expect((await get('/api/usage/heads')).heads[origin]).toBe(before + 1);
    expect((await feed()).some((x) => x.key === 'classify|alpha-529')).toBe(true);
    expect((await ctx.post('/api/usage/classify', { data: { project: 'x', as: 'maybe' } })).status()).toBe(400);
    expect((await ctx.post('/api/usage/classify', { data: { as: 'work' } })).status()).toBe(400);
  });

  test('a pass over a fixture tree writes sessions with their web-terminal session, a bug-hunter item, the inventory and the settings; a second pass writes nothing', async () => {
    // two real sessions: the orchestrator, and a worker it started
    const lead = (await (await ctx.post('/api/sessions', { data: { name: 'bh-lead-529', cwd: emptyCwd('fleet-lead') } })).json()).id;
    made.push(lead);
    const worker = (await (await ctx.post('/api/sessions', { data: { name: 'BH worker #4242', cwd: emptyCwd('fleet-worker'), parentId: lead, spawnedBy: 'bh-lead-529' } })).json()).id;
    made.push(worker);
    const convLead = crypto.randomUUID();
    const convWorker = crypto.randomUUID();
    const hook = await pwRequest.newContext({ baseURL: BASE });
    for (const [wt, conv] of [[lead, convLead], [worker, convWorker]]) {
      const h = await hook.post('/api/hook', { data: { hook_event_name: 'UserPromptSubmit', session_id: conv, prompt: 'secret-529-hookprompt' }, headers: { 'X-WT-Hook-Token': readHookToken(), 'X-WT-Session-ID': wt } });
      expect(h.status()).toBe(200);
    }
    await hook.dispose();
    const pairs = await until(() => { const l = linesOf(SESSIONS_FILE); return l.length >= 2 ? l : null; }, 'the agent-session lines');
    expect(pairs.find((p) => p.agentSid === convWorker)).toMatchObject({ wtId: worker, name: 'BH worker #4242', parentId: lead, spawnedBy: 'bh-lead-529' });
    expect(fs.readFileSync(SESSIONS_FILE, 'utf8')).not.toContain('secret-529');

    // the fixture tree: a repo with an origin, two transcripts, one subagent, settings, a bug-hunter run dir
    const repo = path.join(ROOTS, 'example-529');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://example.test/org/Example-529.git\n');
    const t0 = Date.now() - 3 * 3600e3;
    const at = (min) => new Date(t0 + min * 60e3).toISOString();
    const pdir = path.join(CLAUDE, 'projects', 'p1');
    fs.mkdirSync(path.join(pdir, convWorker, 'subagents'), { recursive: true });
    const usage = (id, min, u, tools = []) => line({ type: 'assistant', timestamp: at(min), requestId: `r-${id}`, cwd: repo, message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: tools, usage: u } });
    const U1 = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000 };
    const U2 = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 60000, cache_creation_input_tokens: 500 };
    fs.writeFileSync(path.join(pdir, `${convWorker}.jsonl`),
      line({ type: 'user', timestamp: at(0), cwd: repo, gitBranch: 'bug/4242', message: { role: 'user', content: 'secret-529-prompt: fix bug 4242' } })
      + usage('w1', 1, U1, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'run' } }])
      + line({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'secret-529-output' }] } })
      + usage('w2', 3, U2));
    fs.writeFileSync(path.join(pdir, convWorker, 'subagents', 'agent-s1.jsonl'), line({ type: 'assistant', timestamp: at(1), requestId: 'r-s1', message: { id: 's1', model: 'claude-haiku-5-5', usage: { output_tokens: 7 } } }));
    fs.writeFileSync(path.join(pdir, convWorker, 'subagents', 'agent-s1.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    fs.writeFileSync(path.join(pdir, `${convLead}.jsonl`), line({ type: 'user', timestamp: at(0), cwd: repo, message: { role: 'user', content: '/dds-bug-hunter run' } }) + usage('l1', 1, { output_tokens: 20, cache_read_input_tokens: 1000 }));
    fs.writeFileSync(path.join(CLAUDE, 'settings.json'), JSON.stringify({ autoCompactWindow: 300000, effortLevel: 'high', model: 'opus' }));
    const bhDir = path.join(repo, '.claude', 'bug-hunter');
    fs.mkdirSync(bhDir, { recursive: true });
    fs.writeFileSync(path.join(bhDir, 'state.json'), JSON.stringify({ processed: { 4242: { outcome: 'fixed-pushed', startedAt: at(0), finishedAt: at(10), band: 'easy' } } }));
    fs.writeFileSync(path.join(bhDir, 'events.jsonl'), [
      { at: at(0), item: 4242, kind: 'worker', wtId: worker, name: 'BH worker #4242', attempt: 1, model: 'opus' },
      { at: at(5), item: 4242, kind: 'gate', phase: 'fix', criterion: 'build', status: 'FAIL', detail: 'x' },
      { at: at(6), item: 4242, kind: 'gate', phase: 'fix', criterion: 'build', status: 'PASS' },
    ].map(line).join(''));

    const pass = await (await ctx.post('/api/usage/collect')).json();
    expect(pass.error).toBeUndefined();
    expect(pass).toMatchObject({ scanned: 2, left: 0, bhItems: 1, settingsChanged: true });
    expect(pass.written).toBeGreaterThanOrEqual(5); // 2 sessions, 1 item, the inventory, the settings

    const recs = await feed();
    const w = recs.find((r) => r.type === 'session' && r.sid === convWorker);
    expect(w).toMatchObject({ origin, wtId: worker, name: 'BH worker #4242', parentWt: lead, spawnedBy: 'bh-lead-529', cls: 'bh-worker', project: 'example-529', branch: 'bug/4242', bh: { item: 4242, role: 'worker' } });
    expect(w.units).toBe(Math.round(unitsOf({ in: 10, out: 100, cr: 50000, cw: 2000 }) + unitsOf({ in: 5, out: 50, cr: 60000, cw: 500 }) + unitsOf({ out: 7 })));
    expect(w.sub.byType.Explore.n).toBe(1);
    expect(w.cwd).toBeUndefined();                       // no folder path leaves the machine in a record
    expect(w.quality).toMatchObject({ toolCalls: 1, toolErrors: 1, humanCorrections: 0 });
    expect(w.peakCtx).toBe(5 + 60000 + 500);
    const l = recs.find((r) => r.type === 'session' && r.sid === convLead);
    expect(l).toMatchObject({ wtId: lead, cls: 'bh-orchestrator', bh: { item: null, role: 'orchestrator' } });
    const item = recs.find((r) => r.type === 'bh-item');
    expect(item).toMatchObject({ item: 4242, outcome: 'fixed-pushed', band: 'easy', workers: [worker], gates: { pass: 1, fail: 1, byGate: { build: { pass: 1, fail: 1 } } } });
    expect(recs.find((r) => r.type === 'inventory').projects).toContain('example-529');
    expect(recs.find((r) => r.type === 'settings')).toMatchObject({ autoCompactWindow: 300000, effort: 'high', defaultModel: 'opus' });
    // no word of any prompt, tool output or hook text reached the ledger
    for (const f of fs.readdirSync(LEDGER)) expect(fs.readFileSync(path.join(LEDGER, f), 'utf8'), f).not.toContain('secret-529');

    // nothing changed: nothing written
    const again = await (await ctx.post('/api/usage/collect')).json();
    expect(again).toMatchObject({ scanned: 0, written: 0, bhItems: 0, settingsChanged: false });
    // a settings change is a record of its own
    fs.writeFileSync(path.join(CLAUDE, 'settings.json'), JSON.stringify({ autoCompactWindow: 150000, effortLevel: 'high', model: 'opus' }));
    expect(await (await ctx.post('/api/usage/collect')).json()).toMatchObject({ written: 1, settingsChanged: true });
    expect((await feed()).filter((r) => r.type === 'settings').map((r) => r.autoCompactWindow)).toEqual([300000, 150000]);
  });

  test('the report reads the same ledger: totals, class, project, work scope after an override, and the bug-hunter item with its worker tokens', async () => {
    const rep = await get('/api/usage/report?days=7');
    expect(rep.totals.sessions).toBeGreaterThanOrEqual(2);
    expect(rep.byProject.map((p) => p.project)).toContain('example-529');
    expect(rep.byClass.map((c) => c.cls)).toEqual(expect.arrayContaining(['bh-worker', 'bh-orchestrator']));
    expect(rep.bugHunter.items).toBe(1);
    expect(rep.bugHunter.fixed).toBe(1);
    expect(rep.bugHunter.list[0]).toMatchObject({ item: 4242, workerSessions: 1, gateFails: 1 });
    expect(rep.bugHunter.orchestratorOverheadUnitsM).toBeGreaterThanOrEqual(0);
    expect(rep.quality.regimes.length).toBe(2);
    // example-529 is private until someone says otherwise (no work-source inventory here)
    expect((await get('/api/usage/report?days=7&scope=work')).byProject.map((p) => p.project)).not.toContain('example-529');
    expect((await ctx.post('/api/usage/classify', { data: { project: 'example-529', as: 'work' } })).status()).toBe(200);
    expect((await get('/api/usage/report?days=7&scope=work')).byProject.map((p) => p.project)).toContain('example-529');
    expect((await get('/api/usage/report?days=7&scope=private')).byProject.map((p) => p.project)).not.toContain('example-529');
  });

  test('a second machine copies this one\'s ledger over the real routes and ends with the same heads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fleet-rep-'));
    const fresh = createUsageStore({ dir, origin: 'Replica' });
    const peer = { name: 'self', url: BASE };
    const getJson = async (_p, p) => { const r = await ctx.get(p); return { status: r.status(), json: await r.json() }; };
    const r = await sync.pullRound({ store: fresh, peers: [peer], getJson });
    expect(r.answered).toBe(1);
    const theirs = (await get('/api/usage/heads')).heads;
    expect(fresh.heads()).toEqual(theirs);
    expect(r.pulled).toBe(theirs[origin]);
    expect(fresh.get(`${origin}|inventory`)).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
