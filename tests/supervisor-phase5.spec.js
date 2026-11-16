// @ts-check
// #470 - supervisor phase 5, the pure rules: R7's fact (an agent seen running and gone, with no
// SessionEnd), R7's case and when it stops standing, R8 (capacity), which way a session is
// replaced, the brief the supervisor writes for a dead agent, the resume command, the successor's
// prompt, and the hand-off run's two #470 changes (the supervisor trigger, a dead run's close).
// Each negative mutates ONE gate of its positive, so a pass names the gate that held.
const { test, expect } = require('@playwright/test');
const rep = require('../lib/replacement');
const cases = require('../lib/supervisor-cases');
const sup = require('../lib/supervisor');
const handoff = require('../lib/handoff');
const brief = require('../lib/session-brief');
const safePrompt = require('../lib/safe-prompt');
const journal = require('../lib/session-journal');
const agents = require('../lib/agents');
const { EVENTS, patch, isWtHook } = require('../scripts/install-hooks');
const { HANDOFF_PROMPT_TAG } = require('../lib/user-turn');

const T0 = Date.parse('2026-11-16T10:00:00Z');
const MIN = 60 * 1000;
const GB = 1024 * 1024 * 1024;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test.describe('#470 R7 fact: seen running, then gone, with no exit hook (agentGoneField, diedAgo)', () => {
  test('gone after being seen is a death; a standing SessionEnd makes it a deliberate exit', () => {
    expect(rep.agentGoneField({ found: false, seenAt: T0, endedAt: null })).toEqual({ seenAt: T0, endedAt: null, reason: null });
    expect(rep.agentGoneField({ found: false, seenAt: T0, endedAt: T0 + 5, endReason: 'prompt_input_exit' }))
      .toEqual({ seenAt: T0, endedAt: T0 + 5, reason: 'prompt_input_exit' });
  });
  test('running, never seen, or a snapshot that cannot tell: no field (fails closed)', () => {
    expect(rep.agentGoneField({ found: true, seenAt: T0 })).toBeNull();
    expect(rep.agentGoneField({ found: false, seenAt: null })).toBeNull();
    expect(rep.agentGoneField({ found: null, seenAt: T0 })).toBeNull();
  });
  test('diedAgo: at goneMs and not before; never for a deliberate exit', () => {
    const g = { seenAt: T0, endedAt: null };
    expect(rep.diedAgo(g, T0 + 5 * MIN, 5 * MIN)).toBe(true);
    expect(rep.diedAgo(g, T0 + 5 * MIN - 1, 5 * MIN)).toBe(false);
    expect(rep.diedAgo({ ...g, endedAt: T0 }, T0 + 60 * MIN, 5 * MIN)).toBe(false);
    expect(rep.diedAgo(null, T0 + 60 * MIN, 5 * MIN)).toBe(false);
  });
  test('the exit hook is folded onto the brief, and ANY later hook clears it (the agent is back)', () => {
    const e = brief.foldHook(null, 'SessionEnd', { reason: 'prompt_input_exit' }, T0);
    expect(e.agentEnded).toEqual({ at: T0, reason: 'prompt_input_exit' });
    const back = brief.foldHook(e, 'UserPromptSubmit', { prompt: 'hi' }, T0 + 1);
    expect(back.agentEnded).toBeUndefined();
    const notif = brief.foldHook(e, 'Notification', {}, T0 + 1);
    expect(notif.agentEnded).toBeUndefined();
    // Nothing to clear: the entry is returned unchanged (no disk write).
    const plain = brief.foldHook(null, 'Notification', {}, T0);
    expect(brief.foldHook(plain, 'Notification', {}, T0 + 1)).toBe(plain);
  });
  test('SessionEnd is installed with the other hooks, as web-terminal\'s own http hook', () => {
    expect(EVENTS).toContain('SessionEnd');
    const out = patch({});
    expect(out.added).toContain('SessionEnd');
    expect(out.settings.hooks.SessionEnd).toHaveLength(1);
    expect(out.settings.hooks.SessionEnd[0].hooks.some(isWtHook)).toBe(true);
  });
  test('exitHookInstalled: only the web-terminal hook on that event counts', () => {
    const ours = { type: 'http', url: 'http://127.0.0.1:7681/api/hook' };
    expect(rep.exitHookInstalled({ hooks: { SessionEnd: [{ hooks: [ours] }] } }, 'SessionEnd', isWtHook)).toBe(true);
    expect(rep.exitHookInstalled({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, 'SessionEnd', isWtHook)).toBe(false);
    expect(rep.exitHookInstalled({ hooks: { Stop: [{ hooks: [ours] }] } }, 'SessionEnd', isWtHook)).toBe(false);
    expect(rep.exitHookInstalled(null, 'SessionEnd', isWtHook)).toBe(false);
  });
  test('the registry declares how claude dies, and nothing for an agent that declares nothing', () => {
    expect(agents.agentExitPolicy('claude')).toMatchObject({ process: 'claude.exe', hookEvent: 'SessionEnd' });
    expect(agents.agentExitPolicy('codex')).toBeNull();
    expect(agents.agentExitPolicy(null)).toBeNull();
  });
});

test.describe('#470 R7 case (lib/supervisor-cases.js)', () => {
  const cfg = { ...cases.dispatcherConfig(null), goneMs: 5 * MIN };
  const row = (over = {}) => ({ id: id(1), name: 'job', status: 'idle', agent: 'claude', brief: {}, agentGone: { seenAt: T0, endedAt: null }, ...over });
  const graphOf = (...rows) => sup.buildGraph([{ name: 'alpha', ok: true, sessions: rows }], T0);
  const cands = (g, now = T0 + 6 * MIN) => cases.caseCandidates({ graph: g, verdicts: {}, resolutions: {}, now, cfg });

  test('the graph node carries the fact; a malformed one is dropped', () => {
    expect(graphOf(row()).nodes[0].agentGone).toEqual({ seenAt: T0, endedAt: null, reason: null });
    expect(graphOf(row({ agentGone: { seenAt: 'x' } })).nodes[0].agentGone).toBeNull();
    expect(graphOf(row({ agentGone: undefined })).nodes[0].agentGone).toBeNull();
  });
  test('a dead agent opens R7 once its goneMs has passed, keyed on the sighting', () => {
    const k = cands(graphOf(row()));
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ rule: 'R7', id: id(1), key: `R7|${id(1)}|${T0}`, seenAt: T0 });
    expect(k[0].line).toMatch(/lost its agent/);
    expect(cases.openCase(k[0], 'abcd1234', T0).seenAt).toBe(T0);
    expect(cases.RULES).toContain('R7');
  });
  test('negatives: too recent; a deliberate exit; no fact', () => {
    expect(cands(graphOf(row()), T0 + 4 * MIN)).toHaveLength(0);
    expect(cands(graphOf(row({ agentGone: { seenAt: T0, endedAt: T0 + 1 } })))).toHaveLength(0);
    expect(cands(graphOf(row({ agentGone: null })))).toHaveLength(0);
  });
  test('R7 comes before R6: a dead agent\'s turn that never stopped is not a hung turn', () => {
    const hung = row({ status: 'working', brief: { turnAt: T0 - 60 * MIN, now: { text: 'Bash', at: T0 - 60 * MIN } } });
    expect(cands(graphOf(hung)).map((c) => c.rule)).toEqual(['R7']);
    // ...and without the fact the same row is R6, so the order is what held.
    expect(cands(graphOf({ ...hung, agentGone: null })).map((c) => c.rule)).toEqual(['R6']);
  });
  test('caseHolds: same sighting holds; a new sighting, a deliberate exit or the agent back retires it', () => {
    const c = cases.openCase(cands(graphOf(row()))[0], 'abcd1234', T0);
    const g = graphOf(row());
    expect(cases.caseHolds(c, g.nodes[0], g, {})).toBe(true);
    const g2 = graphOf(row({ agentGone: { seenAt: T0 + MIN, endedAt: null } }));
    expect(cases.caseHolds(c, g2.nodes[0], g2, {})).toBe(false);
    const g3 = graphOf(row({ agentGone: { seenAt: T0, endedAt: T0 + 2 } }));
    expect(cases.caseHolds(c, g3.nodes[0], g3, {})).toBe(false);
    const g4 = graphOf(row({ agentGone: null }));
    expect(cases.caseHolds(c, g4.nodes[0], g4, {})).toBe(false);
  });
  test('goneMin comes from supervisor.spawn, clamped', () => {
    expect(cases.dispatcherConfig({ spawn: { goneMin: 12 } }).goneMs).toBe(12 * MIN);
    expect(cases.dispatcherConfig(null).goneMs).toBe(5 * MIN);
    expect(cases.dispatcherConfig({ spawn: { goneMin: 0 } }).goneMs).toBe(1 * MIN);
  });
});

test.describe('#470 R8 and which way a session is replaced', () => {
  test('capacityRefusal: room; the slot cap; a commit that cannot be read; below the floor', () => {
    const ok = { sessions: 3, cap: 10, commitAvailBytes: 20 * GB, floorBytes: 8 * GB };
    expect(rep.capacityRefusal(ok)).toBeNull();
    expect(rep.capacityRefusal({ ...ok, sessions: 10 })).toBe('slot-cap');
    expect(rep.capacityRefusal({ ...ok, commitAvailBytes: null })).toBe('commit-unknown');
    expect(rep.capacityRefusal({ ...ok, commitAvailBytes: 8 * GB - 1 })).toBe('commit-floor');
  });
  test('spawnConfig: defaults 5 min and 8 GB, per machine', () => {
    expect(rep.spawnConfig(null)).toEqual({ goneMs: 5 * MIN, commitFloorBytes: 8 * GB });
    expect(rep.spawnConfig({ commitFloorGb: 15 }).commitFloorBytes).toBe(15 * GB);
  });
  test('replaceMode: dead, handoff, and each refusal on its own gate', () => {
    const dead = { agent: { state: 'gone', gone: { seenAt: T0, endedAt: null } }, hold: false, handoffActive: false,
      handedOff: false, declined: false, typing: false, dispatcher: false };
    expect(rep.replaceMode(dead)).toEqual({ mode: 'dead' });
    expect(rep.replaceMode({ ...dead, agent: { state: 'running', gone: null } })).toEqual({ mode: 'handoff' });
    expect(rep.replaceMode({ ...dead, agent: { state: 'gone', gone: { seenAt: T0, endedAt: T0 } } })).toEqual({ why: 'deliberate' });
    expect(rep.replaceMode({ ...dead, hold: true })).toEqual({ why: 'restart-hold' });
    expect(rep.replaceMode({ ...dead, handoffActive: true })).toEqual({ why: 'in-progress' });
    expect(rep.replaceMode({ ...dead, handedOff: true })).toEqual({ why: 'handed-off' });
    expect(rep.replaceMode({ ...dead, declined: true })).toEqual({ why: 'declined' });
    expect(rep.replaceMode({ ...dead, typing: true })).toEqual({ why: 'typing' });
    expect(rep.replaceMode({ ...dead, dispatcher: true })).toEqual({ why: 'supervisor' });
  });
  test('replaceMode: an agent NOT seen running is never handed off (the wrap-up would be typed into a shell)', () => {
    const base = { hold: false, handoffActive: false, handedOff: false, declined: false, typing: false, dispatcher: false };
    expect(rep.replaceMode({ ...base, agent: { state: 'running', gone: null } })).toEqual({ mode: 'handoff' });
    expect(rep.replaceMode({ ...base, agent: { state: 'unknown', gone: null } })).toEqual({ why: 'agent-unknown' });
    expect(rep.replaceMode({ ...base, agent: null })).toEqual({ why: 'agent-unknown' });
    // 'gone' with no field (a malformed reading) is not a death either.
    expect(rep.replaceMode({ ...base, agent: { state: 'gone', gone: null } })).toEqual({ why: 'agent-unknown' });
  });
  test('agentState: gone only from a snapshot newer than the sighting and the last hook, with the exit hook installed', () => {
    const dead = { found: false, snapAt: T0 + 10, seenAt: T0, hookAt: T0 + 5, hooked: true, endedAt: null };
    expect(rep.agentState(dead)).toEqual({ state: 'gone', gone: { seenAt: T0, endedAt: null, reason: null } });
    expect(rep.agentState({ ...dead, found: true })).toEqual({ state: 'running', gone: null });
    const unknown = { state: 'unknown', gone: null };
    // Each gate alone.
    expect(rep.agentState({ ...dead, found: null })).toEqual(unknown); // cannot read
    expect(rep.agentState({ ...dead, snapAt: null })).toEqual(unknown); // no snapshot time
    expect(rep.agentState({ ...dead, seenAt: null })).toEqual(unknown); // never seen under this shell
    expect(rep.agentState({ ...dead, snapAt: T0, hookAt: null })).toEqual(unknown); // not newer than the sighting
    expect(rep.agentState({ ...dead, hookAt: T0 + 10 })).toEqual(unknown); // a hook since that snapshot
    expect(rep.agentState({ ...dead, hooked: false })).toEqual(unknown); // no exit hook: an exit reads as a death
    expect(rep.agentState({ ...dead, hookAt: null }).state).toBe('gone'); // no hook since start is not proof of life
    expect(rep.agentState({ ...dead, endedAt: T0 + 5, endReason: 'prompt_input_exit' }).gone.endedAt).toBe(T0 + 5);
  });
  test('noteOf: one line, at most NOTE_MAX, refused never cut', () => {
    expect(rep.noteOf(undefined)).toEqual({ ok: true, note: null });
    expect(rep.noteOf('  carry on with the tests  ')).toEqual({ ok: true, note: 'carry on with the tests' });
    expect(rep.noteOf('a\nb').ok).toBe(false);
    expect(rep.noteOf(`a${String.fromCodePoint(0x2028)}b`).ok).toBe(false);
    expect(rep.noteOf('x'.repeat(rep.NOTE_MAX + 1)).ok).toBe(false);
    expect(rep.noteOf(5).ok).toBe(false);
  });
  test('a safe prompt is never typed into a session whose agent is gone', () => {
    const row = { status: 'idle', agent: 'claude', agentReady: true, agentGone: { seenAt: T0, endedAt: null } };
    expect(safePrompt.promptRefusal(row, { brief: {}, now: T0 })).toBe('agent-gone');
    expect(safePrompt.REASONS).toContain('agent-gone');
    expect(safePrompt.promptRefusal({ ...row, agentGone: null }, { brief: {}, now: T0 })).not.toBe('agent-gone');
  });
});

test.describe('#470 the dead agent\'s replacement: transcript, resume, brief, prompt', () => {
  test('transcriptSound: its last complete line is a JSON object', () => {
    expect(rep.transcriptSound('{"a":1}\n{"type":"assistant"}\n')).toBe(true);
    expect(rep.transcriptSound('{"a":1}\n{"type":"assis')).toBe(false);
    expect(rep.transcriptSound('{"a":1}\n[1,2]\n')).toBe(false);
    expect(rep.transcriptSound('')).toBe(false);
    expect(rep.transcriptSound(null)).toBe(false);
  });
  test('resumeLaunchCommand: the fresh command plus the agent\'s own resume flag', () => {
    const conv = '11111111-2222-4333-8444-555555555555';
    const policy = agents.handoffPolicy('claude');
    expect(rep.resumeLaunchCommand('claude --dangerously-skip-permissions', policy, conv)).toBe(`claude --dangerously-skip-permissions --resume ${conv}`);
    expect(rep.resumeLaunchCommand('claude', policy, 'not-an-id')).toBeNull();
    expect(rep.resumeLaunchCommand('claude', null, conv)).toBeNull();
    expect(rep.resumeLaunchCommand('', policy, conv)).toBeNull();
    // What freshLaunchCommand strips is exactly what this adds: a resumed command made fresh again is the fresh one.
    const fresh = 'claude --x';
    const back = handoff.freshLaunchCommand(rep.resumeLaunchCommand(fresh, policy, conv), (c) => /claude/.test(c), policy, agents.launchGrammar('claude'));
    expect(back).toBe(fresh);
  });
  test('briefText carries the report, items, refs, the dispatcher\'s note and the last turns', () => {
    const text = rep.briefText({
      old: { id: id(1), name: 'phase job', cwd: 'C:\\dev\\x', conversationId: '11111111-2222-4333-8444-555555555555' },
      reported: { headline: 'building R7', items: [{ ref: '#470', title: 'phase 5', state: 'in-progress', note: 'tests next' }], wait: { on: 'self', what: 'the suite' }, at: T0 },
      touches: [{ ref: '#373', kind: 'item' }], goal: 'ship phase 5', tail: [{ role: 'user', text: 'go on' }, { role: 'assistant', text: 'running the suite' }],
      gone: { seenAt: T0 }, note: 'the suite was at 2800 of 2900', resumed: true, now: T0 + MIN,
    });
    for (const s of ['# Replacement brief: phase job', 'building R7', '#470 phase 5: in-progress (tests next)', 'Waiting on: self "the suite"',
      '#373', 'ship phase 5', 'the suite was at 2800 of 2900', '**Prompt:** go on', '**Agent:** running the suite', 'RESUMES', 'C:\\dev\\x']) {
      expect(text).toContain(s);
    }
    const bare = rep.briefText({ old: { id: id(2) }, now: T0 });
    expect(bare).toContain('(no work items reported)');
    expect(bare).toContain('starts FRESH');
    expect(bare).not.toContain('## From the supervisor');
  });
  test('replacementPrompt: tagged, one line, under 512 bytes, names the brief; refuses when it cannot fit', () => {
    const f = 'C:\\dev\\web-terminal\\handoffs\\handoff-00000000-0000-4000-8000-000000000001.md';
    for (const resumed of [true, false]) {
      const p = rep.replacementPrompt({ briefFile: f, oldName: 'a "quoted" name '.repeat(10), resumed });
      expect(p.startsWith(HANDOFF_PROMPT_TAG)).toBe(true);
      expect(p).toContain(f);
      expect(p).not.toMatch(/[\r\n]/);
      expect(p).not.toContain('"quoted"');
      expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(511);
    }
    expect(rep.replacementPrompt({ briefFile: `C:\\${'x'.repeat(400)}`, oldName: 'n', resumed: true })).toBeNull();
  });
});

test.describe('#470 the hand-off run: the supervisor trigger, and a dead run\'s close', () => {
  test('startRun keeps the supervisor trigger; the journal records it', () => {
    expect(handoff.startRun(T0, 'b.md', 'supervisor').trigger).toBe('supervisor');
    expect(handoff.startRun(T0, 'b.md', 'bogus').trigger).toBe('manual');
    expect(journal.handoffRecord({ id: id(1), to: id(2), at: T0, trigger: 'supervisor' }).trigger).toBe('supervisor');
  });
  test('closeDecision: a dead run kills the shell left while the agent is still gone, though its cut turn never stopped', () => {
    const cfg = handoff.handoffConfig(null);
    const run = { state: 'closing', at: T0, verdict: { canClose: true }, verdictAt: T0, dead: true };
    const old = { status: 'working', turnAt: T0 - 10 * MIN, stoppedAt: T0 - 20 * MIN, agentGone: true };
    expect(handoff.closeDecision(run, old, T0 + 1, cfg)).toEqual({ action: 'kill' });
    // Each gate alone: not a dead run; the agent back; someone prompted it since.
    expect(handoff.closeDecision({ ...run, dead: undefined }, old, T0 + 1, cfg).action).toBe('wait');
    expect(handoff.closeDecision(run, { ...old, agentGone: false }, T0 + 1, cfg).action).toBe('wait');
    expect(handoff.closeDecision(run, { ...old, turnAt: T0 + 5 }, T0 + 10, cfg)).toEqual({ action: 'keep', reason: 'in-use' });
  });
  test('closeDecision: a dead run is killed ONLY while gone - idle with its turn over is not enough', () => {
    const cfg = handoff.handoffConfig(null);
    const run = { state: 'closing', at: T0, verdict: { canClose: true }, verdictAt: T0, dead: true };
    // Someone restarted the agent and it finished a turn BEFORE the verdict: idle, turn over.
    const idle = { status: 'idle', turnAt: T0 - 10 * MIN, stoppedAt: T0 - 5 * MIN };
    expect(handoff.closeDecision({ ...run, dead: undefined }, idle, T0 + 1, cfg)).toEqual({ action: 'kill' }); // a normal run would
    expect(handoff.closeDecision(run, { ...idle, agentRunning: true }, T0 + 1, cfg)).toEqual({ action: 'keep', reason: 'agent-back' });
    expect(handoff.closeDecision(run, idle, T0 + 1, cfg)).toEqual({ action: 'wait' }); // cannot tell: waits
    expect(handoff.closeDecision(run, idle, T0 + cfg.closeTimeoutMs + 1, cfg)).toEqual({ action: 'keep', reason: 'still-busy' });
    expect(handoff.closeDecision(run, { ...idle, agentGone: true }, T0 + 1, cfg)).toEqual({ action: 'kill' });
  });
  test('closeDecision: a keystroke after the verdict keeps any run (in-use)', () => {
    const cfg = handoff.handoffConfig(null);
    const run = { state: 'closing', at: T0, verdict: { canClose: true }, verdictAt: T0 };
    const idle = { status: 'idle', turnAt: T0 - 10 * MIN, stoppedAt: T0 - 5 * MIN };
    expect(handoff.closeDecision(run, { ...idle, inputAt: T0 - 1 }, T0 + 1, cfg)).toEqual({ action: 'kill' });
    expect(handoff.closeDecision(run, { ...idle, inputAt: T0 + 1 }, T0 + 2, cfg)).toEqual({ action: 'keep', reason: 'in-use' });
    expect(handoff.closeDecision({ ...run, dead: true }, { ...idle, agentGone: true, inputAt: T0 + 1 }, T0 + 2, cfg))
      .toEqual({ action: 'keep', reason: 'in-use' });
  });
  test('declinedStanding: a Cancel or Dismiss stands until a person types', () => {
    expect(handoff.declinedStanding({ handoffDeclinedAt: T0 })).toBe(true);
    expect(handoff.declinedStanding({ handoffDeclinedAt: T0, prompt: { at: T0 + 1 } })).toBe(false);
    expect(handoff.declinedStanding({ handoffDeclinedAt: T0, prompt: { at: T0 - 1 } })).toBe(true);
    expect(handoff.declinedStanding({})).toBe(false);
    expect(handoff.declinedStanding(null)).toBe(false);
    // autoBlock still reads the same rule.
    const cfg = { ...handoff.handoffConfig(null), enabled: true, auto: true };
    expect(handoff.autoBlock({ handoffDeclinedAt: T0 }, cfg, { now: T0 + 1 })).toBe('declined');
  });
});
