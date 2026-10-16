// @ts-check
// Unit tests for lib/maintenance.js (#359): the rules of a restart hold.

const { test, expect } = require('@playwright/test');
const M = require('../lib/maintenance');
const { classifyUserTurn } = require('../lib/user-turn');

const T0 = 1_000_000;
const BOOT = 500_000;
const agentRow = (over = {}) => ({ id: 'a', name: 'A', agent: 'claude', status: 'idle', agentReady: true, pid: 11, ...over });
const shellRow = (over = {}) => ({ id: 's', name: 'S', agent: null, status: 'idle', pid: 22, ...over });
const hold = () => M.startHold({ reason: 'Windows update', now: T0, bootAt: BOOT, sessions: [agentRow(), shellRow()] });

test.describe('restart hold (#359)', () => {
  test('a new hold tracks every session; nothing is told yet', () => {
    const h = hold();
    expect(h.reason).toBe('Windows update');
    expect(Object.keys(h.sessions).sort()).toEqual(['a', 's']);
    expect(h.sessions.a).toMatchObject({ pid: 11, agent: 'claude', promptedAt: null, answeredAt: null });
    expect(M.startHold({ reason: '', now: T0, bootAt: BOOT, sessions: [] }).reason).toBe('restart');
  });

  test('the prompts are tagged, so the chat lens never shows them as "You"', () => {
    for (const p of [M.wrapUpPrompt('x'), M.backPrompt('x')]) {
      expect(p).not.toMatch(/[\r\n]/);
      expect(classifyUserTurn(p)).toMatchObject({ kind: 'system', from: 'Restart' });
    }
    expect(M.wrapUpPrompt('Windows update')).toContain('Windows update');
  });

  test('a prompt is typed only into an agent that can take it - never into a selector', () => {
    expect(M.canPrompt(agentRow())).toBe(true);
    expect(M.canPrompt(agentRow({ status: 'working' }))).toBe(true); // queues behind the turn
    expect(M.canPrompt(shellRow())).toBe(false);
    expect(M.canPrompt(agentRow({ agentReady: false }))).toBe(false); // still booting (#147)
    // Text typed into a permission prompt or a menu would ANSWER it.
    expect(M.canPrompt(agentRow({ status: 'waiting' }))).toBe(false);
    expect(M.canPrompt(agentRow({ inMenu: true }))).toBe(false);
    expect(M.canPrompt(agentRow({ blockedPrompt: { kind: 'x' } }))).toBe(false);
    expect(M.canPrompt(agentRow({ waitingFor: 'question' }))).toBe(false);
    expect(M.canPrompt(null)).toBe(false);
  });

  test('the answer is the MAIN agent\'s Stop after the prompt - never prose, never a subagent', () => {
    let h = hold();
    // Before the prompt: a Stop answers nothing.
    expect(M.noteHook(h, 'a', 'Stop', {}, T0 + 1)).toBe(h);
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, promptedAt: T0 + 10 } } };
    expect(M.noteHook(h, 'a', 'Stop', { agent_id: 'sub-1' }, T0 + 20)).toBe(h);
    expect(M.noteHook(h, 'a', 'PostToolUse', {}, T0 + 20)).toBe(h);
    expect(M.noteHook(h, 'nope', 'Stop', {}, T0 + 20)).toBe(h);
    expect(M.noteHook(h, 'a', 'Stop', {}, T0 + 20).sessions.a.answeredAt).toBe(T0 + 20);
  });

  test('an agent with no Stop hook is answered by working-then-idle after the prompt', () => {
    let h = hold();
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, promptedAt: T0 + 10 } } };
    expect(M.noteStatus(h, agentRow(), T0 + 20).sessions.a.answeredAt).toBeNull(); // idle, never seen working
    h = M.noteStatus(h, agentRow({ status: 'working' }), T0 + 20);
    expect(h.sessions.a.sawWorking).toBe(true);
    expect(M.noteStatus(h, agentRow(), T0 + 30).sessions.a.answeredAt).toBe(T0 + 30);
  });

  test('verdicts come from state, and only ready/gone allow the restart', () => {
    const told = { promptedAt: T0 + 1, answeredAt: T0 + 2 };
    const S = M.STATES;
    expect(M.verdict({ promptedAt: null }, agentRow(), []).state).toBe(S.NOT_TOLD);
    expect(M.verdict({ promptedAt: T0 + 1, answeredAt: null }, agentRow(), []).state).toBe(S.ANSWERING);
    expect(M.verdict(told, agentRow({ status: 'working' }), []).state).toBe(S.WORKING);
    expect(M.verdict(told, agentRow({ status: 'working', subagents: 2 }), []).why).toBe('working, waiting on 2 subagents');
    expect(M.verdict(told, agentRow({ status: 'waiting', waitingFor: 'question' }), []).why).toBe('waiting for you: a question');
    expect(M.verdict(told, agentRow({ inMenu: true }), []).state).toBe(S.NEEDS_YOU);
    expect(M.verdict(told, agentRow(), [{ pid: 5, name: 'dotnet.exe' }]))
      .toEqual({ state: S.BUSY, why: 'still running: dotnet.exe' });
    // Could not read the process tree: not "ready" on a guess.
    expect(M.verdict(told, agentRow(), null).state).toBe(S.UNKNOWN);
    expect(M.verdict(told, agentRow(), []).state).toBe(S.READY);
    // A plain shell is never told; it is ready when nothing runs under it.
    expect(M.verdict({ promptedAt: null }, shellRow(), []).state).toBe(S.READY);
    expect(M.verdict({ promptedAt: null }, shellRow(), [{ name: 'npm.cmd' }]).state).toBe(S.BUSY);
    expect(M.verdict(told, null, null).state).toBe(S.GONE);
  });

  test('safeToRestart is true only when every session is ready or gone - a late session counts', () => {
    let h = hold();
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, promptedAt: T0 + 1, answeredAt: T0 + 2 } } };
    const rows = { a: agentRow(), s: shellRow() };
    expect(M.status(h, rows, { a: [], s: [] }).safeToRestart).toBe(true);
    expect(M.status(h, rows, { a: [], s: [{ name: 'node.exe' }] }).safeToRestart).toBe(false);
    // A work read that never happened is not "nothing running".
    expect(M.status(h, rows, { a: [] }).safeToRestart).toBe(false);
    // Closed since: still safe.
    expect(M.status(h, { a: agentRow() }, { a: [] }).safeToRestart).toBe(true);
    // Started after the hold (with force): judged too, and flagged.
    const late = M.status(h, { ...rows, n: agentRow({ id: 'n', name: 'N', status: 'working' }) }, { a: [], s: [], n: [] });
    expect(late.safeToRestart).toBe(false);
    expect(late.sessions[0]).toMatchObject({ id: 'n', state: 'working', startedDuringHold: true });
    expect(M.status(null, rows, {})).toEqual({ hold: null, safeToRestart: null, sessions: [] });
  });

  test('the restart is detected by a new boot OR new processes - a hot reload is neither', () => {
    const h = hold();
    // Same boot, same pids: a hot reload of server.js. The hold stays.
    expect(M.restarted(h, { a: agentRow(), s: shellRow() }, BOOT + 1000)).toBe(false);
    // A reboot.
    expect(M.restarted(h, {}, BOOT + 10 * 60 * 1000)).toBe(true);
    // A cold restart of web-terminal: same boot, every surviving session respawned.
    expect(M.restarted(h, { a: agentRow({ pid: 99 }), s: shellRow({ pid: 98 }) }, BOOT)).toBe(true);
    // ...but ONE session in its old process means it has not happened.
    expect(M.restarted(h, { a: agentRow({ pid: 99 }), s: shellRow() }, BOOT)).toBe(false);
    // Every tracked session closed by hand proves nothing.
    expect(M.restarted(h, { z: agentRow({ id: 'z', pid: 7 }) }, BOOT)).toBe(false);
    expect(M.restarted(null, {}, BOOT)).toBe(false);
  });

  test('the "back" notice goes to the sessions that were told, once they are at the composer', () => {
    let h = hold();
    expect(M.backList(h, T0)).toBeNull(); // nobody was told
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, promptedAt: T0 + 1 } } };
    expect(M.backList(h, T0 + 5)).toEqual({ reason: 'Windows update', since: T0 + 5, pending: ['a'] });
    expect(M.canSendBack(agentRow())).toBe(true);
    expect(M.canSendBack(agentRow({ status: 'working' }))).toBe(false);
    expect(M.canSendBack(agentRow({ agentReady: false }))).toBe(false);
  });
});
