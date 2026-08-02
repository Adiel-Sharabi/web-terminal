// #73 — the agent task list: fold rules, both sources, and the registry seam.
//
// Every fixture below is a REAL shape, taken from a scan of 400 Claude transcripts and
// 56 Codex rollouts before the feature was built — not from the issue text, which
// describes a tool (`TodoWrite`) that appears as an actual tool_use exactly zero times.
const { test, expect } = require('@playwright/test');
const {
  normalizeStatus,
  parseClaudeTaskDelta,
  parseTaskListSnapshot,
  foldTaskEvent,
  parseCodexPlan,
} = require('../lib/task-list');
const agents = require('../lib/agents');

// --- real Claude payloads ----------------------------------------------------
const CREATE_IN = { subject: 'Wire AppConfig to ServerStore', description: 'x', activeForm: 'Wiring' };
const CREATE_OUT = 'Task #7 created successfully: Wire AppConfig to ServerStore';
const UPDATE_IN = { taskId: '7', status: 'in_progress' };
const UPDATE_OUT = 'Updated task #7 owner, status';
const DONE_OUT = 'Updated task #7 status\n\nTask completed. Call TaskList now to find your next available task.';
const LIST_OUT = [
  '#6 [completed] Build lib/services/server_store.dart (app-core-3)',
  '#7 [in_progress] Wire AppConfig to ServerStore (app-core-3)',
  '#8 [pending] React to server set changes (app-core-3)',
].join('\n');

// --- real Codex rollout lines ------------------------------------------------
const codexPlanLine = (plan) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) },
});

test.describe('status vocabulary', () => {
  test('both agents normalise into exactly three values', () => {
    expect(normalizeStatus('in_progress')).toBe('in_progress');
    expect(normalizeStatus('completed')).toBe('completed');
    expect(normalizeStatus('pending')).toBe('pending');
  });

  test('an unknown status becomes pending, never disappears', () => {
    // Over-reporting work remaining is the safe direction; claiming work is done is not.
    expect(normalizeStatus('blocked')).toBe('pending');
    expect(normalizeStatus('')).toBe('pending');
    expect(normalizeStatus(undefined)).toBe('pending');
  });
});

test.describe('Claude — deltas from the hook stream', () => {
  test('TaskCreate recovers the id from the RESULT, which is the only place it exists', () => {
    const d = parseClaudeTaskDelta('TaskCreate', CREATE_IN, CREATE_OUT);
    expect(d).toEqual({ kind: 'create', id: '7', subject: 'Wire AppConfig to ServerStore' });
    // Proving the premise: the input genuinely does not carry it.
    expect(Object.keys(CREATE_IN)).not.toContain('taskId');
  });

  test('TaskUpdate takes the id from its input and normalises the status', () => {
    expect(parseClaudeTaskDelta('TaskUpdate', UPDATE_IN, UPDATE_OUT))
      .toEqual({ kind: 'update', id: '7', status: 'in_progress' });
  });

  test('an owner-only TaskUpdate (no status) is not a task-list event', () => {
    expect(parseClaudeTaskDelta('TaskUpdate', { taskId: '7', owner: 'app-core-3' }, UPDATE_OUT)).toBeNull();
  });

  test('an unrelated tool is ignored', () => {
    expect(parseClaudeTaskDelta('Bash', { command: 'ls' }, 'files')).toBeNull();
    // TaskStop/TaskOutput are the BACKGROUND-AGENT family (snake_case task_id) and have
    // nothing to do with the task list — they must not be folded into it.
    expect(parseClaudeTaskDelta('TaskStop', { task_id: 'abc' }, 'stopped')).toBeNull();
  });

  test('a tool_response arriving as an envelope is unwrapped', () => {
    expect(parseClaudeTaskDelta('TaskCreate', CREATE_IN, { content: CREATE_OUT }))
      .toEqual({ kind: 'create', id: '7', subject: 'Wire AppConfig to ServerStore' });
  });

  test('TaskList result is a whole-list snapshot', () => {
    const d = parseClaudeTaskDelta('TaskList', {}, LIST_OUT);
    expect(d.kind).toBe('snapshot');
    expect(d.items.map((t) => `${t.id}:${t.status}`)).toEqual(['6:completed', '7:in_progress', '8:pending']);
  });

  test('"No tasks found" is an EMPTY list, not an unparsed one', () => {
    expect(parseTaskListSnapshot('No tasks found')).toEqual([]);
  });
});

test.describe('Claude — the fold', () => {
  test('create then update produces the current list', () => {
    let s = foldTaskEvent([], parseClaudeTaskDelta('TaskCreate', CREATE_IN, CREATE_OUT));
    expect(s).toEqual([{ id: '7', subject: 'Wire AppConfig to ServerStore', status: 'pending' }]);
    s = foldTaskEvent(s, parseClaudeTaskDelta('TaskUpdate', UPDATE_IN, UPDATE_OUT));
    expect(s[0].status).toBe('in_progress');
    s = foldTaskEvent(s, parseClaudeTaskDelta('TaskUpdate', { taskId: '7', status: 'completed' }, DONE_OUT));
    expect(s[0].status).toBe('completed');
    expect(s).toHaveLength(1); // updates PATCH, they never append duplicates
  });

  test('creation order is preserved', () => {
    let s = [];
    for (const n of [1, 2, 3]) {
      s = foldTaskEvent(s, parseClaudeTaskDelta('TaskCreate', { subject: `t${n}` }, `Task #${n} created successfully: t${n}`));
    }
    expect(s.map((t) => t.id)).toEqual(['1', '2', '3']);
  });

  test('an update for a task we never saw created still shows up', () => {
    // The mid-session-start case (server restarted, hot reload). Dropping it would hide
    // in-progress work, which is the one thing this panel exists to show.
    const s = foldTaskEvent([], parseClaudeTaskDelta('TaskUpdate', { taskId: '42', status: 'in_progress' }, ''));
    expect(s).toEqual([{ id: '42', subject: '', status: 'in_progress' }]);
  });

  test('a TaskList snapshot REPLACES the folded state — this is the repair path', () => {
    const stale = [{ id: '9', subject: 'gone', status: 'in_progress' }];
    const s = foldTaskEvent(stale, parseClaudeTaskDelta('TaskList', {}, LIST_OUT));
    expect(s.map((t) => t.id)).toEqual(['6', '7', '8']);
    expect(s.find((t) => t.id === '9')).toBeUndefined();
  });

  test('a snapshot keeps a subject we already know, so the owner suffix cannot mangle it', () => {
    // The snapshot line appends " (owner)" and real subjects end in parentheses too
    // ("… (desktop)"), so the create's subject wins where we have one.
    const known = [{ id: '6', subject: 'Build lib/services/server_store.dart', status: 'pending' }];
    const s = foldTaskEvent(known, parseClaudeTaskDelta('TaskList', {}, LIST_OUT));
    expect(s[0].subject).toBe('Build lib/services/server_store.dart');
    expect(s[1].subject).toContain('Wire AppConfig'); // unknown one falls back to the line
  });

  test('a create whose prose id is unreadable falls back to sequential order', () => {
    // The id-from-prose parse is the brittle part; it must degrade to correct, not empty.
    let s = foldTaskEvent([], parseClaudeTaskDelta('TaskCreate', { subject: 'a' }, 'created, wording changed'));
    s = foldTaskEvent(s, parseClaudeTaskDelta('TaskCreate', { subject: 'b' }, 'created, wording changed'));
    expect(s.map((t) => `${t.id}:${t.subject}`)).toEqual(['1:a', '2:b']);
  });

  test('folding returns a NEW array and never mutates the previous state', () => {
    const before = [{ id: '1', subject: 'a', status: 'pending' }];
    const after = foldTaskEvent(before, { kind: 'update', id: '1', status: 'completed' });
    expect(before[0].status).toBe('pending');
    expect(after[0].status).toBe('completed');
  });
});

test.describe('Codex — the whole plan from the rollout', () => {
  test('the newest update_plan is the current state', () => {
    const text = [
      codexPlanLine([{ step: 'first', status: 'completed' }, { step: 'second', status: 'pending' }]),
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
      codexPlanLine([{ step: 'first', status: 'completed' }, { step: 'second', status: 'in_progress' }]),
    ].join('\n');
    const items = parseCodexPlan(text);
    expect(items.map((t) => `${t.subject}:${t.status}`)).toEqual(['first:completed', 'second:in_progress']);
  });

  test('a plan step has no id of its own — position is its identity', () => {
    const items = parseCodexPlan(codexPlanLine([{ step: 'a', status: 'pending' }, { step: 'b', status: 'pending' }]));
    expect(items.map((t) => t.id)).toEqual(['1', '2']);
  });

  test('arguments is a JSON STRING, not an object (the documented Codex trap)', () => {
    const line = JSON.parse(codexPlanLine([{ step: 'x', status: 'pending' }]));
    expect(typeof line.payload.arguments).toBe('string');
    expect(parseCodexPlan(codexPlanLine([{ step: 'x', status: 'pending' }]))).toHaveLength(1);
  });

  test('no plan in the window is UNKNOWN (null), never an empty list', () => {
    // Reporting [] would blank a live panel whenever one long turn pushed the plan out
    // of the tail read.
    expect(parseCodexPlan('{"type":"event_msg"}\n{"type":"response_item"}')).toBeNull();
    expect(parseCodexPlan('')).toBeNull();
  });

  test('a malformed line is skipped, not fatal', () => {
    const text = ['{ this is not json update_plan', codexPlanLine([{ step: 'ok', status: 'pending' }])].join('\n');
    expect(parseCodexPlan(text).map((t) => t.subject)).toEqual(['ok']);
  });
});

test.describe('the registry seam — no agent branching downstream', () => {
  test('each agent declares where its task list comes from', () => {
    expect(agents.taskListSource('claude')).toBe('hooks');
    expect(agents.taskListSource('codex')).toBe('transcript');
  });

  test('a plain shell and an unknown agent have no task list at all', () => {
    // The default that keeps the cost at zero for them: nothing read, nothing parsed.
    expect(agents.taskListSource(null)).toBeNull();
    expect(agents.taskListSource('nethack')).toBeNull();
  });

  test('a hook-sourced agent parses deltas; a transcript-sourced one does not', () => {
    expect(agents.parseTaskDelta('claude', 'TaskCreate', CREATE_IN, CREATE_OUT)).not.toBeNull();
    expect(agents.parseTaskDelta('codex', 'TaskCreate', CREATE_IN, CREATE_OUT)).toBeNull();
  });

  test('an unknown agent id falls back to discovery across hook-sourced providers', () => {
    // The hook layer has only a session id; asking the worker which agent it runs would
    // cost an RPC per tool call to answer what the tool name already settles.
    expect(agents.parseTaskDelta(null, 'TaskCreate', CREATE_IN, CREATE_OUT))
      .toEqual({ kind: 'create', id: '7', subject: 'Wire AppConfig to ServerStore' });
  });

  test('transcript reading is only offered to the agent that declares it', () => {
    const text = codexPlanLine([{ step: 'a', status: 'pending' }]);
    expect(agents.readTaskListFromText('codex', text)).toHaveLength(1);
    expect(agents.readTaskListFromText('claude', text)).toBeNull();
    expect(agents.readTaskListFromText(null, text)).toBeNull();
  });

  test('no agent branching leaks into the server or the worker (ratchet)', () => {
    // The registry rule from CLAUDE.md, enforced: an `if (agent === ...)` in server.js or
    // pty-worker.js means the change belongs in lib/agents.js instead.
    //
    // This is a RATCHET, not a clean-slate assertion. One such branch predates #73 —
    // pty-worker.js sessionSummary()'s claudeSessionId adoption, which is genuinely
    // Claude-specific (only Claude records a conversation id in the cwd's project dir)
    // and arguably wants a registry field of its own. Pinning the count keeps it visible
    // and stops a NEW one appearing, without smuggling an unrelated refactor into this
    // feature. If that branch is ever moved into the registry, drop this to 0.
    const fs = require('fs');
    const KNOWN = { '../server.js': 0, '../pty-worker.js': 1 };
    const re = /agent\s*===\s*['"](?:claude|codex)['"]/g;
    for (const [f, allowed] of Object.entries(KNOWN)) {
      const src = fs.readFileSync(require.resolve(f), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(src.match(re) || [], `${f} gained a new agent branch`).toHaveLength(allowed);
    }
  });
});
