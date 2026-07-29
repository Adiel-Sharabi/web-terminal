// @ts-check
// A session's status tracks the AGENT'S TURN, not the work running inside it.
// `run_in_background` returns as soon as the command is LAUNCHED, so PostToolUse
// fires immediately, the turn ends, Stop flips the session to idle — and the dot
// is green while a build is still running. Reported on Office: a session running
// "Launch host unit-test gate" showed idle.
//
// Status is deliberately NOT changed (from the agent's point of view it really is
// idle). This is the separate fact, and the transcript carries both ends of it,
// which is why no new hook — and no cold restart — is required.
//
// Every shape below was copied from a REAL transcript (~/.claude/projects/*.jsonl),
// not invented: the launch text, the task-notification block, and the statuses
// (`completed`, `killed`) are all as Claude Code actually writes them.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { scanBackgroundTasks } = require('../lib/background-tasks');
const agents = require('../lib/agents');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

/** One JSONL line: the assistant launching a backgrounded Bash. */
function launchLine(toolUseId, description, timestamp = '2026-07-29T09:47:00.000Z') {
  return JSON.stringify({
    timestamp,
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command: 'npm run build', description, run_in_background: true },
      }],
    },
  });
}

/** One JSONL line: the tool_result that hands back the background id. */
function launchResultLine(toolUseId, bgId, timestamp = '2026-07-29T09:47:01.000Z') {
  return JSON.stringify({
    timestamp,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Command running in background with ID: ${bgId}. Output is being ` +
          `written to: C:\\Users\\adiel\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\${bgId}.output. ` +
          `You will be notified when it completes.`,
      }],
    },
  });
}

/** One JSONL line: the injected notification that the task reached a terminal state. */
function finishLine(bgId, status = 'completed') {
  return JSON.stringify({
    timestamp: '2026-07-29T09:53:00.000Z',
    message: {
      content: [{
        type: 'text',
        text: `<task-notification>\n<task-id>${bgId}</task-id>\n` +
          `<tool-use-id>toolu_01ABC</tool-use-id>\n<status>${status}</status>\n` +
          `<summary>Background command "npm run build" completed</summary>\n</task-notification>`,
      }],
    },
  });
}

test.describe('scanBackgroundTasks — running = launched − finished', () => {
  test('a launched, unfinished command is reported running (the reported bug)', () => {
    const text = [
      launchLine('toolu_1', 'Launch host unit-test gate'),
      launchResultLine('toolu_1', 'bzsosbai7'),
    ].join('\n');
    const running = scanBackgroundTasks(text);
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('bzsosbai7');
    // The description is what makes the badge worth reading.
    expect(running[0].description).toBe('Launch host unit-test gate');
    expect(running[0].startedAt).toBe(Date.parse('2026-07-29T09:47:01.000Z'));
  });

  test('a finished command is not running', () => {
    const text = [
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bzsosbai7'),
      finishLine('bzsosbai7', 'completed'),
    ].join('\n');
    expect(scanBackgroundTasks(text)).toHaveLength(0);
  });

  test('a killed command is finished too — any notification for that id ends it', () => {
    const text = [
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bd5n06po2'),
      finishLine('bd5n06po2', 'killed'),
    ].join('\n');
    expect(scanBackgroundTasks(text)).toHaveLength(0);
  });

  test('only the unfinished one of several is reported', () => {
    const text = [
      launchLine('toolu_1', 'windows build'),
      launchResultLine('toolu_1', 'bbqnf6nhn'),
      launchLine('toolu_2', 'apk build'),
      launchResultLine('toolu_2', 'bht81bbyu'),
      finishLine('bbqnf6nhn', 'completed'),
    ].join('\n');
    const running = scanBackgroundTasks(text);
    expect(running.map(t => t.id)).toEqual(['bht81bbyu']);
    expect(running[0].description).toBe('apk build');
  });

  test('a task KILLED from the orchestrator is finished (no notification is written)', () => {
    // Caught against the live API: a suite I had stopped was still listed as
    // running. TaskStop writes NO <task-notification> — only the tool call — so
    // the launch never got an end and lingered until the age backstop.
    const killLine = JSON.stringify({
      timestamp: '2026-07-29T10:07:26.000Z',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_kill', name: 'TaskStop', input: { task_id: 'bockzxmlr' } }],
      },
    });
    const text = [
      launchLine('toolu_1', 'Final full server suite run'),
      launchResultLine('toolu_1', 'bockzxmlr'),
      killLine,
    ].join('\n');
    expect(scanBackgroundTasks(text)).toEqual([]);
  });

  test('a QUOTED "Successfully stopped task" cannot end a running command', () => {
    // Same discipline as the launch side: the kill is read off the tool_use, never
    // off result text, so grepping transcripts can neither invent nor cancel a task.
    const quotedStop = JSON.stringify({
      timestamp: '2026-07-29T10:08:00.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_grep',
          content: 'Successfully stopped task: bzsosbai7 (some command)',
        }],
      },
    });
    const text = [
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bzsosbai7'),
      quotedStop,
    ].join('\n');
    expect(scanBackgroundTasks(text).map(t => t.id)).toEqual(['bzsosbai7']);
  });

  test('a subagent task-notification cannot finish what it never launched', () => {
    // Subagents notify under their OWN ids (af5772d…). A finish is only ever
    // applied to an id seen launching, so an unrelated id matches nothing.
    const text = [
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bzsosbai7'),
      finishLine('af5772d171a4d131d', 'completed'),
    ].join('\n');
    expect(scanBackgroundTasks(text).map(t => t.id)).toEqual(['bzsosbai7']);
  });

  test('a subagent notification alone never invents a running task', () => {
    expect(scanBackgroundTasks(finishLine('af5772d171a4d131d'))).toHaveLength(0);
  });

  test('QUOTED launch text is not a launch (caught against a real transcript)', () => {
    // This is the one that matters. A session that greps its own transcripts
    // records the sentence "Command running in background with ID: …" as
    // ordinary tool OUTPUT. Matching on the text alone reported 12 long-finished
    // builds as still running against a live 4.5MB transcript — a badge that
    // could never clear. A launch counts only when the result pairs back to a
    // run_in_background Bash tool_use, which quoted text never does.
    const quoted = JSON.stringify({
      timestamp: '2026-07-29T10:00:00.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_grep', // a Bash GREP, not a background launch
          content: 'RESULT(bg Bash) = Command running in background with ID: bzsosbai7. ' +
            'Output is being written to: ...',
        }],
      },
    });
    expect(scanBackgroundTasks(quoted)).toEqual([]);
  });

  test('an unpaired launch result is ignored — pairing is the discriminator', () => {
    // The cost of the rule above: a tail slicing between the tool_use and its
    // result loses that task. They are written as ADJACENT lines, so this is
    // vanishingly rare, and silence beats a badge that can never clear.
    expect(scanBackgroundTasks(launchResultLine('toolu_1', 'bzsosbai7'))).toEqual([]);
  });

  test('a partial first line (the usual tail fragment) does not throw', () => {
    const text = [
      '{"timestamp":"2026-07-29T09:00:00.000Z","message":{"cont', // truncated JSON
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bzsosbai7'),
    ].join('\n');
    expect(scanBackgroundTasks(text).map(t => t.id)).toEqual(['bzsosbai7']);
  });

  test('the same command is never double-counted', () => {
    const text = [
      launchLine('toolu_1', 'build'),
      launchResultLine('toolu_1', 'bzsosbai7'),
      launchResultLine('toolu_1', 'bzsosbai7'), // replayed/duplicated line
    ].join('\n');
    expect(scanBackgroundTasks(text)).toHaveLength(1);
  });

  test('empty and absent input yield nothing and do not throw', () => {
    expect(scanBackgroundTasks('')).toEqual([]);
    // @ts-expect-error — deliberately abusive input
    expect(scanBackgroundTasks(null)).toEqual([]);
    // @ts-expect-error
    expect(scanBackgroundTasks(undefined)).toEqual([]);
  });

  test('an ordinary transcript with no background work reports nothing', () => {
    const text = JSON.stringify({
      timestamp: '2026-07-29T09:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] },
    });
    expect(scanBackgroundTasks(text)).toEqual([]);
  });
});

test.describe('the registry gates who is scanned at all', () => {
  test('only an agent that DECLARES the channel is scanned', () => {
    expect(agents.hasBackgroundTasksInTranscript('claude')).toBe(true);
    // Codex's rollout records no such thing — and a plain shell has no transcript
    // to resolve, so the default keeps their poll cost at exactly zero.
    expect(agents.hasBackgroundTasksInTranscript('codex')).toBe(false);
    expect(agents.hasBackgroundTasksInTranscript(null)).toBe(false);
    expect(agents.hasBackgroundTasksInTranscript('nope')).toBe(false);
  });
});

test.describe('GET /api/sessions carries backgroundTasks', () => {
  let ctx;
  let sessionId;

  test.beforeAll(async () => {
    ctx = await authCtx();
    const res = await ctx.post('/api/sessions', { data: { name: `BgTasks-${Date.now()}` } });
    sessionId = (await res.json()).id;
    expect(sessionId).toBeTruthy();
  });

  test.afterAll(async () => {
    if (sessionId) { try { await ctx.delete(`/api/sessions/${sessionId}`); } catch {} }
    await ctx.dispose();
  });

  test('every session reports the field, as an array', async () => {
    const list = await (await ctx.get('/api/sessions')).json();
    const s = list.find(x => x.id === sessionId);
    expect(s).toBeTruthy();
    expect(Array.isArray(s.backgroundTasks)).toBe(true);
    // A brand-new shell session has launched nothing.
    expect(s.backgroundTasks).toEqual([]);
  });

  test('the cluster list carries it for LOCAL sessions too', async () => {
    // The cluster merge shapes local rows field-by-field while spreading a peer's
    // row whole, so a field added only to /api/sessions shows a peer's builds and
    // never your own. Pin both paths.
    const data = await (await ctx.get('/api/cluster/sessions')).json();
    const s = data.sessions.find(x => x.id === sessionId);
    expect(s).toBeTruthy();
    expect(Array.isArray(s.backgroundTasks)).toBe(true);
  });

  test('the badge is independent of status — a session can be idle AND building', async () => {
    // The whole point: this rides alongside `status`, it does not modify it.
    const list = await (await ctx.get('/api/sessions')).json();
    const s = list.find(x => x.id === sessionId);
    expect(s.status).toBeTruthy();
    expect(s).toHaveProperty('backgroundTasks');
  });
});
