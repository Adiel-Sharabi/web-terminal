// @ts-check
// lib/inbox-digest.js - the model-written summary of one inbox wait (#383).
//
// The rules (what is sent, what comes back, when a run may start) are exercised here
// against a REAL child process: tests/fixtures/fake-digest-cli.js stands in for
// `claude -p` and records what it was run with. Never the real model.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../lib/inbox-digest');

const FAKE = path.join(__dirname, 'fixtures', 'fake-digest-cli.js');

let tmp;
test.beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-spec-')); });
test.afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const setMode = (m) => fs.writeFileSync(path.join(tmp, 'mode.json'), JSON.stringify(m));
const runs = () => fs.readdirSync(tmp).filter((f) => f.startsWith('run-'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')));

/** A service wired to the fake CLI. [cfg] overrides the config, [extra] the deps. */
function service(cfg = {}, extra = {}) {
  const scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  return d.createDigestService({
    getConfig: () => ({ command: [process.execPath, FAKE], ...cfg }),
    scratchDir: () => scratch,
    env: { ...process.env, FAKE_DIGEST_DIR: tmp },
    ...extra,
  });
}
const input = (waitKey, prompt = 'PROMPT-BODY') => ({ waitKey, prompt });

test.describe('the model\'s answer is parsed strictly', () => {
  const digest = { about: 'It builds.', asking: ['Delete build/?'], know: ['Slow rebuild.'] };
  test('the claude wrapper, a bare object, a fenced block and trailing prose all parse', () => {
    const wrapped = JSON.stringify({ is_error: false, result: JSON.stringify(digest) });
    expect(d.parseModelOutput(wrapped)).toEqual(digest);
    expect(d.parseModelOutput(JSON.stringify(digest))).toEqual(digest);
    const fenced = JSON.stringify({ result: '```json\n' + JSON.stringify(digest) + '\n```' });
    expect(d.parseModelOutput(fenced)).toEqual(digest);
    // The reply may carry a sign-off after the object (this machine's CLAUDE.md asks for a TL;DR).
    const trailing = JSON.stringify({ result: JSON.stringify(digest) + '\n\n## TL;DR\nIt builds.' });
    expect(d.parseModelOutput(trailing)).toEqual(digest);
  });
  test('anything half-formed is null, never a partial digest', () => {
    const bad = [
      '', 'not json', '{}', '{"about":"x"}',
      JSON.stringify({ is_error: true, result: JSON.stringify(digest) }),
      JSON.stringify({ result: 'prose with no object' }),
      JSON.stringify({ result: JSON.stringify({ about: '', asking: [], know: [] }) }),
      JSON.stringify({ result: JSON.stringify({ about: 'a', asking: 'not a list', know: [] }) }),
      JSON.stringify({ result: JSON.stringify({ about: 'a', asking: [1], know: [] }) }),
      // Too many questions: cutting the list would hide one, so the answer is refused.
      JSON.stringify({ result: JSON.stringify({ about: 'a', asking: Array(9).fill('q'), know: [] }) }),
    ];
    for (const b of bad) expect(d.parseModelOutput(b), b).toBeNull();
  });
  test('a sixth fact keeps the first five rather than failing the whole summary', () => {
    // Seen live (1 in 4 real runs): asked for 0 to 5, the model gave more, and the whole
    // summary was refused although nothing in it was wrong.
    const know = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    const r = d.parseModelOutput(JSON.stringify({ result: JSON.stringify({ about: 'a', asking: ['q'], know }) }));
    expect(r).toEqual({ about: 'a', asking: ['q'], know: ['f1', 'f2', 'f3', 'f4', 'f5'] });
  });
  test('over-long strings are cut with an ellipsis rather than rejected', () => {
    const r = d.parseModelOutput(JSON.stringify({ about: 'a'.repeat(5000), asking: ['q'], know: [] }));
    expect(r.about.length).toBeLessThanOrEqual(600);
    expect(r.about.endsWith('\u2026')).toBe(true);
  });
});

test.describe('the environment handed to the child', () => {
  test('what makes it a nested session, and our hook and auth variables, are removed', () => {
    const out = d.scrubEnv({
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1',
      CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: 'pipe',
      claudecode: 'lower-case names are matched too',
      WT_SESSION_ID: 'abc', WT_HOOK_TOKEN: 'h', WT_IPC_TOKEN: 'i', WT_PASS: 'p', WT_ANYTHING_ELSE: 'x',
      PATH: '/bin', USERPROFILE: 'C:\\Users\\x', SystemRoot: 'C:\\Windows',
    });
    expect(Object.keys(out).sort()).toEqual(['PATH', 'SystemRoot', 'USERPROFILE']);
  });
  test('the rest of CLAUDE_CODE_* is KEPT: the child needs it to run and to log in', () => {
    const out = d.scrubEnv({
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bash.exe', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_SOMETHING_NEW: 'n',
      CLAUDECODE: '1',
    });
    expect(Object.keys(out).sort()).toEqual(['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SOMETHING_NEW']);
  });
});

test.describe('finding the CLI', () => {
  const exists = (set) => (p) => set.has(p);
  test('config first, then claude on PATH, then the installer\'s folder, else null', () => {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const onPath = path.join('/p', exe);
    const inHome = path.join('/home/u', '.local', 'bin', exe);
    const env = { PATH: ['/q', '/p'].join(path.delimiter), HOME: '/home/u', USERPROFILE: '/home/u' };
    expect(d.resolveCommand(['/c/x', '--flag'], env, () => true)).toEqual(['/c/x', '--flag']);
    expect(d.resolveCommand('bare-name', env, () => false)).toEqual(['bare-name']);
    expect(d.resolveCommand(undefined, env, exists(new Set([onPath, inHome])))).toEqual([onPath]);
    expect(d.resolveCommand(undefined, env, exists(new Set([inHome])))).toEqual([inHome]);
    expect(d.resolveCommand(undefined, env, () => false)).toBeNull();
    // A configured PATH-like command that does not exist is `no-cli`, not a spawn error later.
    expect(d.resolveCommand(['/nope/claude.exe'], env, () => false)).toBeNull();
  });
});

test.describe('the wait\'s identity', () => {
  const prompt = { role: 'user', text: 'do it', typedText: 'do it', ts: '2098-01-01T00:00:00Z' };
  const a1 = { role: 'assistant', text: 'one', toolUses: [], ts: '2098-01-01T00:00:01Z' };
  const a2 = { role: 'assistant', text: 'one and more', toolUses: [], ts: '2098-01-01T00:00:02Z' };
  test('stable while the wait is the same, new when the agent writes more', () => {
    const k1 = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1 });
    expect(d.waitKeyOf({ promptTurn: prompt, lastAssistant: { ...a1 } })).toBe(k1);
    expect(d.waitKeyOf({ promptTurn: prompt, lastAssistant: a2 })).not.toBe(k1);
  });
  test('a new prompt, a different question and a different permission each change it', () => {
    const base = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1 });
    expect(d.waitKeyOf({ promptTurn: { ...prompt, typedText: 'other', ts: 'later' }, lastAssistant: a1 })).not.toBe(base);
    const qa = [{ question: 'Which?', options: [{ label: 'A' }] }];
    const qb = [{ question: 'Which one instead?', options: [{ label: 'A' }] }];
    const q1 = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, question: { toolUseId: 'q1', questions: qa } });
    const q2 = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, question: { toolUseId: 'q1', questions: qb } });
    expect(q1).not.toBe(base);
    expect(q1).not.toBe(q2);
    const x1 = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, permission: { tool: 'Bash', input: { command: 'ls' } } });
    const x2 = d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, permission: { tool: 'Bash', input: { command: 'rm -rf x' } } });
    expect(x1).not.toBe(x2);
  });
});

test.describe('one open question is ONE wait, whoever named it (N4)', () => {
  const prompt = { role: 'user', text: 'do it', typedText: 'do it', ts: 't0' };
  const a1 = { role: 'assistant', text: 'one', toolUses: [], ts: 't1' };
  const questions = [{ question: 'Delete which folder?', options: [{ label: 'build/' }, { label: 'dist/' }] }];
  test('the live hook capture and the transcript fallback give the same key', () => {
    const live = { toolUseId: 'hook-sess-7', questions };
    const fromTranscript = { toolUseId: 'toolu_01ABC', questions: JSON.parse(JSON.stringify(questions)) };
    expect(d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, question: live }))
      .toBe(d.waitKeyOf({ promptTurn: prompt, lastAssistant: a1, question: fromTranscript }));
  });
});

test.describe('the permission call is named only when it is unambiguous (SF1)', () => {
  const open = (name, input = {}) => ({ name, input, id: name, result: undefined });
  const done = (name, input = {}) => ({ name, input, id: name, result: 'ok' });
  const asst = (...toolUses) => ({ role: 'assistant', text: '', toolUses });
  test('the good case: one open call that the now-line names', () => {
    const turns = [asst(done('Read')), asst(open('Bash', { command: 'rm -rf build' }))];
    expect(d.permissionCallOf(turns, 'Bash \u00b7 remove the build folder')).toEqual({ tool: 'Bash', input: { command: 'rm -rf build' } });
    expect(d.permissionCallOf([asst(open('mcp__github__create_issue', { t: 1 }))], 'github \u00b7 create_issue'))
      .toEqual({ tool: 'mcp__github__create_issue', input: { t: 1 } });
  });
  test('an open Agent/Task call is the SUBAGENT\'s brief, not what is being asked', () => {
    expect(d.permissionCallOf([asst(open('Agent', { prompt: 'go' }))], 'Subagent \u00b7 go')).toBeNull();
    expect(d.permissionCallOf([asst(open('Task', { prompt: 'go' }))], 'Task')).toBeNull();
    // A subagent's own Bash asks while the Agent call is still open in the main transcript.
    expect(d.permissionCallOf([asst(open('Agent'))], 'Subagent: Bash \u00b7 rm')).toBeNull();
  });
  test('two open calls (in one message, or as separate turns): which one asks is not on disk', () => {
    const turns = [asst(open('Bash', { command: 'rm -rf dist' }), open('Bash', { command: 'git push --force' }))];
    expect(d.permissionCallOf(turns, 'Bash \u00b7 something')).toBeNull();
    // Codex writes parallel calls as separate turns.
    expect(d.permissionCallOf([asst(open('Bash', { command: 'a' })), asst(open('Bash', { command: 'b' }))], 'Bash')).toBeNull();
  });
  test('an older message\'s open call is not the newest wait (its result may sit on a newer page)', () => {
    const turns = [asst(open('Bash', { command: 'old' })), asst(done('Read'))];
    expect(d.permissionCallOf(turns, 'Bash')).toBeNull();
  });
  test('no now-line, a subagent line, or another tool\'s line names no call', () => {
    const turns = [asst(open('Bash', { command: 'ls' }))];
    expect(d.permissionCallOf(turns, undefined)).toBeNull();
    expect(d.permissionCallOf(turns, '  ')).toBeNull();
    expect(d.permissionCallOf(turns, 'Subagent: Bash \u00b7 ls')).toBeNull();
    expect(d.permissionCallOf(turns, 'Edit \u00b7 x.js')).toBeNull();
  });
  test('with no tool the prompt says a permission is waiting and forbids guessing one', () => {
    const turn = { role: 'user', text: 'x', typedText: 'x', ts: 't' };
    const p = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn: turn, turns: [], permission: { tool: null } });
    expect(p).toContain('PENDING PERMISSION');
    expect(p).toContain('NOT known');
    expect(p).not.toContain('Tool:');
    const k = (permission) => d.waitKeyOf({ promptTurn: turn, lastAssistant: null, permission });
    expect(k({ tool: null })).not.toBe(k({ tool: 'Bash', input: { command: 'ls' } }));
  });
  test('an unfinished call is marked as not run, so the summary never reports it as done', () => {
    // Measured on the rig: with `rm` awaiting approval the digest said the agent "ran the
    // delete". A call with no result is waiting or running, and the prompt must say so.
    const turn = { role: 'user', text: 'x', typedText: 'x', ts: 't' };
    const turns = [asst(done('Read', { file_path: 'a.js' })), asst(open('Bash', { command: 'rm -rf build' }))];
    const p = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn: turn, turns, permission: { tool: null } });
    const lines = p.split('\n');
    expect(lines.find((l) => l.includes('rm -rf build'))).toContain('NO RESULT YET');
    expect(lines.find((l) => l.startsWith('[tool] Read: a.js'))).not.toContain('NO RESULT YET');
    expect(p).toContain('has NOT completed');
  });
});

test.describe('the transcript is read once per change (SF2)', () => {
  test('an unchanged file costs a stat; a changed size or mtime reads again', () => {
    let reads = 0;
    let st = { size: 10, mtimeMs: 100 };
    const w = d.createWaitCache({ stat: () => st, derive: (p) => ({ n: ++reads, p }) });
    expect(w.get('/t').n).toBe(1);
    expect(w.get('/t').n).toBe(1);
    expect(reads).toBe(1);
    st = { size: 11, mtimeMs: 100 };
    expect(w.get('/t').n).toBe(2);
    st = { size: 11, mtimeMs: 101 };
    expect(w.get('/t').n).toBe(3);
    expect(w.get('/t').n).toBe(3);
  });
  test('each path has its own entry, and the table is bounded', () => {
    let reads = 0;
    const w = d.createWaitCache({ stat: () => ({ size: 1, mtimeMs: 1 }), derive: () => ++reads, max: 2 });
    w.get('/a'); w.get('/b'); w.get('/c');
    expect(reads).toBe(3);
    w.get('/c'); w.get('/b');
    expect(reads).toBe(3);
    w.get('/a');
    expect(reads).toBe(4);
  });
  test('a failing stat or derive is not remembered', () => {
    let fail = true;
    const w = d.createWaitCache({ stat: () => ({ size: 1, mtimeMs: 1 }), derive: () => { if (fail) throw new Error('x'); return 'ok'; } });
    expect(() => w.get('/a')).toThrow();
    fail = false;
    expect(w.get('/a')).toBe('ok');
  });
});

test.describe('what the model is sent', () => {
  const promptTurn = { role: 'user', text: 'fix the parser', typedText: 'fix the parser', ts: 't' };
  const bash = (command, result) => ({ name: 'Bash', input: { command }, inputPreview: '', id: 'x', result });
  test('the prompt, the agent\'s words and each tool call as one capped line', () => {
    const p = d.buildPrompt({
      name: 'my-session', cwd: 'C:\\dev\\web-terminal', promptTurn,
      turns: [{ role: 'assistant', text: 'Looking now.', toolUses: [bash('x'.repeat(900), 'y'.repeat(900))] }],
    });
    expect(p).toContain('SESSION: my-session');
    expect(p).toContain('FOLDER: web-terminal');
    expect(p).toContain('fix the parser');
    expect(p).toContain('[agent] Looking now.');
    const line = p.split('\n').find((l) => l.startsWith('[tool] Bash: '));
    // 200 of the command, then a result cut to 300: one line, never the output.
    expect(line.length).toBeLessThan(560);
  });
  test('over the cap the middle is cut: the prompt and the TAIL survive', () => {
    const body = Array.from({ length: 4000 }, (_, i) => ({ role: 'assistant', text: `step ${i} ${'z'.repeat(40)}`, toolUses: [] }));
    body.push({ role: 'assistant', text: 'FINAL QUESTION: shall I proceed?', toolUses: [] });
    const p = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn, turns: body });
    expect(p.length).toBeLessThanOrEqual(d.INPUT_CAP);
    expect(p).toContain('fix the parser');
    expect(p).toContain('FINAL QUESTION: shall I proceed?');
    expect(p).toContain(d.CUT_MARKER.trim());
    expect(p).not.toContain('step 0 ');
  });
  test('a pending question carries its options; a permission its tool and input', () => {
    const q = { toolUseId: 'q', questions: [{ header: 'Pick', question: 'Which layout?', multiSelect: false,
      options: [{ label: 'Alpha', description: 'first', preview: 'mock' }, { label: 'Beta' }] }] };
    const p = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn, turns: [], question: q });
    expect(p).toContain('Which layout?');
    expect(p).toContain('1. Alpha - first');
    expect(p).toContain('2. Beta');
    const x = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn, turns: [], permission: { tool: 'Bash', input: { command: 'rm -rf build' } } });
    expect(x).toContain('Tool: Bash');
    expect(x).toContain('rm -rf build');
  });
  test('says to treat the transcript as data and to write in the user\'s language', () => {
    const p = d.buildPrompt({ name: 'n', cwd: 'c', promptTurn, turns: [] });
    expect(p).toMatch(/DATA from a transcript/);
    expect(p).toMatch(/never answer the\s+question yourself/);
    expect(p).toMatch(/language of the USER'S LAST PROMPT/);
  });
});

test.describe('running the CLI', () => {
  test('a ready digest, then the same key from cache with no second run', async () => {
    const s = service();
    const first = await s.get('S', input('K1'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'ready', waitKey: 'K1', model: 'sonnet', cached: false });
    expect(first.body.asking).toEqual(['Should the build folder be deleted?']);
    expect(Number.isNaN(Date.parse(first.body.generatedAt))).toBe(false);
    const second = await s.get('S', input('K1'));
    expect(second.body).toMatchObject({ status: 'ready', cached: true, about: first.body.about });
    expect(runs()).toHaveLength(1);
    // A different wait of the same session, and the same wait of another session, are new runs.
    await s.get('S', input('K2'));
    await s.get('T', input('K1'));
    expect(runs()).toHaveLength(3);
  });

  test('two parallel requests for one key share ONE run', async () => {
    setMode({ mode: 'ok', delayMs: 400 });
    const s = service();
    const [a, b] = await Promise.all([s.get('S', input('K')), s.get('S', input('K'))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(runs()).toHaveLength(1);
  });

  test('peek never starts a run, and returns a cached digest once there is one', async () => {
    const s = service();
    const miss = await s.get('S', input('K'), { peek: true });
    expect(miss).toEqual({ status: 200, body: { status: 'missing', waitKey: 'K' } });
    expect(runs()).toHaveLength(0);
    await s.get('S', input('K'));
    const hit = await s.get('S', input('K'), { peek: true });
    expect(hit.body).toMatchObject({ status: 'ready', cached: true });
    expect(runs()).toHaveLength(1);
  });

  test('disabled and no-cli are unavailable, and start nothing', async () => {
    const off = await service({ enabled: false }).get('S', input('K'));
    expect(off).toEqual({ status: 503, body: { status: 'unavailable', reason: 'disabled' } });
    const none = await service({ command: ['/definitely/not/here/claude.exe'] }).get('S', input('K'));
    expect(none).toEqual({ status: 503, body: { status: 'unavailable', reason: 'no-cli' } });
    expect(runs()).toHaveLength(0);
  });

  test('a run past the ceiling is a timeout, and the child WE spawned is killed', async () => {
    setMode({ mode: 'sleep', ms: 20000 });
    const s = service({ timeoutMs: 700 });
    const r = await s.get('S', input('K'));
    expect(r).toEqual({ status: 502, body: { status: 'failed', reason: 'timeout' } });
    const pid = runs()[0].pid;
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; } },
      { timeout: 5000 }).toBe('gone');
  });

  test('bad output, a non-zero exit and is_error are each a failure, never a half result', async () => {
    for (const [mode, want] of [['bad', 'bad-output'], ['partial', 'bad-output'], ['iserror', 'bad-output'], ['exit1', 'error']]) {
      setMode({ mode });
      const r = await service().get('S', input(`K-${mode}`));
      expect(r, mode).toEqual({ status: 502, body: { status: 'failed', reason: want } });
    }
  });

  test('a failure is remembered for a minute so a broken CLI is not a storm, then retried', async () => {
    setMode({ mode: 'bad' });
    let t = 1_000_000;
    const s = service({}, { now: () => t });
    await s.get('S', input('K'));
    await s.get('S', input('K'));
    await s.get('S', input('K'));
    expect(runs()).toHaveLength(1);
    t += 61_000;
    setMode({ mode: 'ok' });
    const r = await s.get('S', input('K'));
    expect(r.body.status).toBe('ready');
    expect(runs()).toHaveLength(2);
  });

  test('during a failure window a PEEK reports the failure, in the same shape as a run does (N5)', async () => {
    setMode({ mode: 'bad' });
    let t = 1_000_000;
    const s = service({}, { now: () => t });
    const first = await s.get('S', input('K'));
    const peek = await s.get('S', input('K'), { peek: true });
    expect(peek).toEqual(first);
    expect(peek).toEqual({ status: 502, body: { status: 'failed', reason: 'bad-output' } });
    expect(runs()).toHaveLength(1);
    // Past the window the peek is `missing` again, and still starts nothing.
    t += 61_000;
    expect((await s.get('S', input('K'), { peek: true })).body.status).toBe('missing');
    expect(runs()).toHaveLength(1);
  });

  test('shutdown kills the children THIS service spawned, by recorded handle (N9)', async () => {
    setMode({ mode: 'sleep', ms: 30000 });
    const s = service({ timeoutMs: 60000 });
    const p = s.get('S', input('K'));
    await expect.poll(() => runs().length, { timeout: 8000 }).toBe(1);
    const pid = runs()[0].pid;
    expect(s._stats().children).toBe(1);
    expect(s.shutdown()).toBe(1);
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; } },
      { timeout: 5000 }).toBe('gone');
    await p; // the run ends (as a failure), nothing hangs
    expect(s._stats().children).toBe(0);
    expect(s.shutdown()).toBe(0);
  });

  test('past the running slots and the short queue the answer is busy', async () => {
    setMode({ mode: 'ok', delayMs: 800 });
    const s = service({}, { limits: { maxRunning: 1, maxQueued: 1 } });
    const all = await Promise.all([1, 2, 3].map((n) => s.get('S', input(`K${n}`))));
    expect(all.map((r) => r.status).sort()).toEqual([200, 200, 503]);
    expect(all.find((r) => r.status === 503).body).toEqual({ status: 'unavailable', reason: 'busy' });
    // Busy is not remembered: a later ask for the key that was refused runs.
    const again = await s.get('S', input('K3'));
    expect(again.status).toBe(200);
  });

  test('the cache is bounded: the oldest entry is the one that goes', async () => {
    const s = service({}, { limits: { cacheMax: 2 } });
    for (const k of ['A', 'B', 'C']) await s.get('S', input(k));
    expect(s._stats().cached).toBe(2);
    const n = runs().length;
    await s.get('S', input('C'));
    expect(runs()).toHaveLength(n);       // newest still cached
    await s.get('S', input('A'));
    expect(runs()).toHaveLength(n + 1);   // oldest was evicted
  });

  test('the prompt arrives on stdin; argv carries no transcript text; env is scrubbed; cwd is the scratch dir', async () => {
    const secret = 'TRANSCRIPT-SECRET-TEXT';
    const s = service({}, {
      env: {
        ...process.env, FAKE_DIGEST_DIR: tmp,
        CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1',
        WT_SESSION_ID: 'x', WT_HOOK_TOKEN: 'y', CLAUDE_CONFIG_DIR: tmp,
      },
    });
    await s.get('S', input('K', `please summarise ${secret}`));
    const [run] = runs();
    expect(run.stdin).toBe(`please summarise ${secret}`);
    expect(run.argv.join(' ')).not.toContain(secret);
    expect(run.argv).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--output-format', 'json',
      '--no-session-persistence', '--strict-mcp-config', '--tools']));
    // Tools off and no settings: the empty values are present as their own arguments.
    expect(run.argv[run.argv.indexOf('--tools') + 1]).toBe('');
    expect(run.argv[run.argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(run.argv).not.toContain('--bare');
    for (const n of run.envNames) expect(n).not.toMatch(/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|WT_)/i);
    // A kept variable must arrive. Not PATH: on Windows libuv re-adds PATH to any child
    // env that lacks it, so a PATH check here passes even when the scrub drops it.
    expect(run.envNames).toContain('CLAUDE_CONFIG_DIR');
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(path.join(tmp, 'scratch')));
  });

  test('a prompt given as a function is built only when a run starts', async () => {
    let built = 0;
    const s = service();
    const lazy = { waitKey: 'K', prompt: () => { built++; return 'p'; } };
    await s.get('S', lazy, { peek: true });
    expect(built).toBe(0);
    await s.get('S', lazy);
    await s.get('S', lazy);
    expect(built).toBe(1);
  });
});
