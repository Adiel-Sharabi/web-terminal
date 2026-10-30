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
    for (const p of [M.wrapUpPrompt('x', '/abs/wt-maintenance.js'), M.backPrompt('x'), M.calledOffPrompt('x')]) {
      expect(p).not.toMatch(/[\r\n]/);
      expect(classifyUserTurn(p)).toMatchObject({ kind: 'system', from: 'Restart' });
    }
    expect(M.wrapUpPrompt('Windows update')).toContain('Windows update');
  });

  test('a prompt is typed only into an agent IDLE at its composer - never into a selector, never queued', () => {
    expect(M.canPrompt(agentRow())).toBe(true);
    // Queued behind a running turn, an Esc would leave it unsent while the turn still ends.
    expect(M.canPrompt(agentRow({ status: 'working' }))).toBe(false);
    expect(M.canPrompt(shellRow())).toBe(false);
    expect(M.canPrompt(agentRow({ agentReady: false }))).toBe(false); // still booting (#147)
    // Text typed into a permission prompt or a menu would ANSWER it.
    expect(M.canPrompt(agentRow({ status: 'waiting' }))).toBe(false);
    expect(M.canPrompt(agentRow({ inMenu: true }))).toBe(false);
    expect(M.canPrompt(agentRow({ blockedPrompt: { kind: 'x' } }))).toBe(false);
    expect(M.canPrompt(agentRow({ waitingFor: 'question' }))).toBe(false);
    expect(M.canPrompt(null)).toBe(false);
  });

  test('delivery is the agent\'s own tagged UserPromptSubmit; the answer is the MAIN Stop after it', () => {
    let h = hold();
    // Before the prompt: nothing counts.
    expect(M.noteHook(h, 'a', 'Stop', {}, T0 + 1)).toBe(h);
    h = M.notePrompted(h, 'a', T0 + 10);
    expect(h.sessions.a).toMatchObject({ promptedAt: T0 + 10, tries: 1 });
    // A Stop before delivery is the PREVIOUS turn's, or a turn the prompt never started.
    expect(M.noteHook(h, 'a', 'Stop', {}, T0 + 15)).toBe(h);
    // Some other prompt is not delivery; a subagent's events never count.
    expect(M.noteHook(h, 'a', 'UserPromptSubmit', { prompt: 'something else' }, T0 + 16)).toBe(h);
    expect(M.noteHook(h, 'a', 'UserPromptSubmit', { prompt: M.wrapUpPrompt('x'), agent_id: 's1' }, T0 + 16)).toBe(h);
    h = M.noteHook(h, 'a', 'UserPromptSubmit', { prompt: M.wrapUpPrompt('x') }, T0 + 17);
    expect(h.sessions.a.deliveredAt).toBe(T0 + 17);
    expect(M.noteHook(h, 'a', 'Stop', { agent_id: 'sub-1' }, T0 + 20)).toBe(h);
    expect(M.noteHook(h, 'nope', 'Stop', {}, T0 + 20)).toBe(h);
    expect(M.noteHook(h, 'a', 'Stop', {}, T0 + 20).sessions.a.answeredAt).toBe(T0 + 20);
  });

  test('the worker\'s lastTurnEndAt answers for any agent - Codex has no Stop hook', () => {
    let h = M.notePrompted(hold(), 'a', T0 + 10);
    expect(M.noteStatus(h, agentRow())).toBe(h); // a worker older than the field
    expect(M.noteStatus(h, agentRow({ lastTurnEndAt: T0 + 5 }))).toBe(h); // the turn before the prompt
    expect(M.noteStatus(h, agentRow({ lastTurnEndAt: T0 + 30 })).sessions.a.answeredAt).toBe(T0 + 30);
    // An agent that reports through hooks must show DELIVERY first: the worker stamps even
    // a stray Stop on an idle session, which the prompt never caused.
    const hooked = agentRow({ hookStatus: true, lastTurnEndAt: T0 + 30 });
    expect(M.noteStatus(h, hooked)).toBe(h);
    h = M.noteHook(h, 'a', 'UserPromptSubmit', { prompt: M.wrapUpPrompt('x') }, T0 + 20);
    expect(M.noteStatus(h, hooked).sessions.a.answeredAt).toBe(T0 + 30);
  });

  test('#407: the prompt ASKS - a polite question that makes "no" and "later" fine, with an absolute answer command', () => {
    const p = M.wrapUpPrompt('Windows update', 'C:\\dev\\web-terminal\\scripts\\wt-maintenance.js');
    expect(p).toContain('Windows update');
    expect(p).toMatch(/A question, not an order/);
    expect(p).toMatch(/"no" or "later" is fine/);
    expect(p).toMatch(/reach a safe stop.*then answer yes/); // yes comes after a safe stop
    // The command carries the ABSOLUTE script path (sessions run in any cwd), with forward
    // slashes so neither bash nor PowerShell reads an escape in it, and every answer's flags.
    expect(p).toContain('node "C:/dev/web-terminal/scripts/wt-maintenance.js" answer yes|no|later [--minutes N] [--reason "why"]');
    expect(p).toMatch(/chat is not read/);
    expect(p).not.toContain('\\');
    expect(M.calledOffPrompt('Windows update')).toMatch(/called off\. Carry on as normal/);
  });

  test('#407: the hold prompts stay under Claude\'s 512-byte submit.bracketAbove, whatever the reason and path', () => {
    // Over it, Claude gets the text as a bracketed paste (#213) and delivery hangs on the
    // UserPromptSubmit prompt still starting with the tag.
    const longPath = `C:\\Users\\someone-long\\AppData\\Local\\Temp\\claude\\C--dev-web-terminal\\checkout\\scripts\\wt-maintenance.js`;
    const reason = 'r'.repeat(200);
    // A reason in Hebrew is two bytes a character: the byte budget, not the char count, binds.
    const wide = String.fromCodePoint(0x05d0).repeat(200);
    for (const r of [reason, wide]) {
      for (const p of [M.wrapUpPrompt(r, longPath), M.calledOffPrompt(r), M.backPrompt(r)]) {
        expect(Buffer.byteLength(p)).toBeLessThan(512);
      }
    }
    expect(longPath.length).toBeGreaterThan(100);
    // The hold itself keeps the full (200) reason; only the typed text is shortened.
    expect(M.startHold({ reason, now: T0, bootAt: BOOT, sessions: [] }).reason).toHaveLength(200);
  });

  test('#407: text we store or type loses C0, DEL and C1 control characters', () => {
    const c1 = String.fromCodePoint(0x85, 0x9b, 0x9f);
    const r = M.parseAnswer({ sessionId: 'a', answer: 'no', reason: `a${c1}b${String.fromCodePoint(0x7f)}c` });
    expect(r.reason).toBe('a   b c');
    expect(M.parseAnswer({ sessionId: 'a', answer: 'no', reason: `caf${String.fromCodePoint(0xe9)}` }).reason).toBe(`caf${String.fromCodePoint(0xe9)}`);
  });

  test('#407: an agent the hold does not track is never ready - it has not been asked', () => {
    const h = M.startHold({ reason: 'r', now: T0, bootAt: BOOT, sessions: [] });
    const rows = { n: agentRow({ id: 'n', name: 'N' }) };
    const st = M.status(h, rows, { n: [] });
    expect(st.safeToRestart).toBe(false);
    expect(st.sessions[0]).toMatchObject({ id: 'n', state: 'not-told', untracked: true });
    // Tracked, it is asked like the rest; an untracked plain shell keeps the old rule.
    expect(M.status(M.trackSession(h, rows.n), rows, { n: [] }).sessions[0]).toMatchObject({ state: 'not-told', untracked: false });
    expect(M.status(h, { s: shellRow() }, { s: [] }).safeToRestart).toBe(true);
  });

  test('#407: an answer is validated strictly - enum, clamped integer minutes, untrusted reason', () => {
    const ok = (b) => M.parseAnswer({ sessionId: 'a', ...b });
    expect(ok({ answer: 'yes' })).toMatchObject({ ok: true, answer: 'yes', minutes: M.MINUTES_DEFAULT, reason: null });
    expect(ok({ answer: 'later', minutes: 1 }).minutes).toBe(M.MINUTES_MIN);
    expect(ok({ answer: 'later', minutes: 99999 }).minutes).toBe(M.MINUTES_MAX);
    expect(ok({ answer: 'later', minutes: 12.6 }).minutes).toBe(13);
    for (const answer of ['maybe', 'YES', '', null, undefined, 1, ['yes']]) expect(ok({ answer }).ok).toBe(false);
    for (const minutes of ['30', NaN, Infinity, {}]) expect(ok({ answer: 'later', minutes }).ok).toBe(false);
    expect(ok({ answer: 'no', reason: 42 }).ok).toBe(false);
    expect(M.parseAnswer({ answer: 'yes' }).ok).toBe(false); // no sessionId
    expect(M.parseAnswer(null).ok).toBe(false);
    const r = ok({ answer: 'no', reason: `a${String.fromCodePoint(0)}b${String.fromCodePoint(13, 10)}${'x'.repeat(500)}` });
    expect(r.reason).not.toMatch(/[\x00-\x1f]/);
    expect(r.reason.length).toBeLessThanOrEqual(200);
  });

  test('#407: only a session the hold tracked AND asked can answer; no hold -> 409', () => {
    const h = M.notePrompted(hold(), 'a', T0 + 5);
    expect(M.noteAnswer(null, { sessionId: 'a', answer: 'yes' }, T0)).toMatchObject({ status: 409 });
    expect(M.noteAnswer(h, { sessionId: 'a', answer: 'maybe' }, T0)).toMatchObject({ status: 400 });
    expect(M.noteAnswer(h, { sessionId: 'zzz', answer: 'yes' }, T0)).toMatchObject({ status: 404 });
    expect(M.noteAnswer(h, { sessionId: 's', answer: 'yes' }, T0)).toMatchObject({ status: 409 }); // never asked
    const r = M.noteAnswer(h, { sessionId: 'a', answer: 'later', minutes: 20, reason: 'long build' }, T0 + 100);
    expect(r.status).toBe(200);
    expect(r.hold.sessions.a).toMatchObject({ answer: 'later', answerAt: T0 + 100, until: T0 + 100 + 20 * 60000, answerReason: 'long build' });
    // It may change its mind; "yes" carries no reason and no deadline.
    const y = M.noteAnswer(r.hold, { sessionId: 'a', answer: 'yes', reason: 'ignored' }, T0 + 200).hold.sessions.a;
    expect(y).toMatchObject({ answer: 'yes', answerReason: null, until: null });
  });

  test('#407: yes is ready only once the turn ended and nothing runs; silence is never agreement', () => {
    const S = M.STATES;
    const e = (over) => ({ promptedAt: T0 + 1, deliveredAt: T0 + 2, answeredAt: null, asks: 1, answer: null, ...over });
    // Turn over, never said anything: stays answering, with a clear why.
    expect(M.verdict(e({ answeredAt: T0 + 3 }), agentRow(), [])).toEqual({ state: S.ANSWERING, why: 'told; has not answered (yes, no or later)' });
    // yes, but the turn has not ended: not yet.
    expect(M.verdict(e({ answer: 'yes' }), agentRow(), [])).toEqual({ state: S.ANSWERING, why: 'said yes; its turn has not ended yet' });
    // yes + turn over + nothing running: ready. A running build still blocks it.
    expect(M.verdict(e({ answer: 'yes', answeredAt: T0 + 3 }), agentRow(), []).state).toBe(S.READY);
    expect(M.verdict(e({ answer: 'yes', answeredAt: T0 + 3 }), agentRow(), [{ name: 'dotnet.exe' }]).state).toBe(S.BUSY);
    // no: declined, with the reason, even while it carries on working; and it blocks SAFE.
    const no = e({ answer: 'no', answerReason: 'mid long build', answeredAt: T0 + 3 });
    expect(M.verdict(no, agentRow(), [])).toMatchObject({ state: S.DECLINED });
    expect(M.verdict(no, agentRow(), []).why).toContain('mid long build');
    expect(M.verdict(no, agentRow({ status: 'working' }), []).state).toBe(S.DECLINED);
    expect(M.verdict(no, null, null).state).toBe(S.GONE); // closed: gone
    // A plain shell has no question to answer.
    expect(M.verdict({ promptedAt: null }, shellRow(), []).state).toBe(S.READY);
    // Only ready/gone are clear.
    let h = { ...hold(), sessions: { a: { ...hold().sessions.a, ...no }, s: hold().sessions.s } };
    const st = M.status(h, { a: agentRow(), s: shellRow() }, { a: [], s: [] }, T0 + 10);
    expect(st.safeToRestart).toBe(false);
    expect(st.sessions.find((v) => v.id === 'a')).toMatchObject({ state: 'declined', answer: 'no', answerReason: 'mid long build' });
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, ...e({ answer: 'yes', answeredAt: T0 + 3 }) } } };
    expect(M.status(h, { a: agentRow(), s: shellRow() }, { a: [], s: [] }, T0 + 10).safeToRestart).toBe(true);
  });

  test('#407: a "later" is deferred until its time, then asked again - at most MAX_ASKS times', () => {
    const S = M.STATES;
    let h = M.notePrompted(hold(), 'a', T0);
    expect(h.sessions.a.asks).toBe(1);
    h = M.noteAnswer(h, { sessionId: 'a', answer: 'later', minutes: 10, reason: 'build' }, T0 + 1000).hold;
    const e = () => h.sessions.a;
    const until = T0 + 1000 + 10 * 60000;
    expect(M.verdict(e(), agentRow(), [], T0 + 2000)).toMatchObject({ state: S.DEFERRED });
    expect(M.verdict(e(), agentRow(), [], T0 + 2000).why).toMatch(/asked again in 10 min/);
    expect(M.verdict(e(), agentRow({ status: 'working' }), [], T0 + 2000).state).toBe(S.DEFERRED);
    // Not asked before its time, nor into a busy session; asked once time is up and idle.
    expect(M.shouldPrompt(e(), agentRow(), until - 1)).toBe(false);
    expect(M.shouldPrompt(e(), agentRow({ status: 'working' }), until)).toBe(false);
    expect(M.shouldPrompt(e(), agentRow(), until)).toBe(true);
    expect(M.verdict(e(), agentRow(), [], until).why).toMatch(/time is up/);
    // Asking again is a FRESH question: the old answer and turn end are void.
    h = M.notePrompted(h, 'a', until + 1);
    expect(e()).toMatchObject({ promptedAt: until + 1, asks: 2, answer: null, until: null, deliveredAt: null, answeredAt: null, tries: 1 });
    expect(M.shouldPrompt(e(), agentRow(), until + 2)).toBe(false);
    expect(M.verdict(e(), agentRow(), [], until + 2).state).toBe(S.ANSWERING);
    // Bounded: after MAX_ASKS asks a "later" is not asked again, and says so.
    for (let n = 2; n < M.MAX_ASKS; n++) {
      h = M.noteAnswer(h, { sessionId: 'a', answer: 'later', minutes: 5 }, T0 + n).hold;
      h = M.notePrompted(h, 'a', T0 + 10 + n);
    }
    expect(e().asks).toBe(M.MAX_ASKS);
    h = M.noteAnswer(h, { sessionId: 'a', answer: 'later', minutes: 5 }, T0).hold;
    expect(M.shouldPrompt(e(), agentRow(), T0 + 24 * 3600000)).toBe(false);
    expect(M.verdict(e(), agentRow(), [], T0 + 24 * 3600000).why).toMatch(/asked 4 times/);
  });

  test('a compacting session is not told and not ready; a capped one says why it waits', () => {
    expect(M.canPrompt(agentRow({ compacting: true }))).toBe(false);
    const told = { promptedAt: T0 + 1, deliveredAt: T0 + 2, answeredAt: T0 + 3 };
    expect(M.verdict(told, agentRow({ compacting: true }), [])).toEqual({ state: M.STATES.WORKING, why: 'compacting its context' });
    expect(M.verdict({ promptedAt: T0 + 1, deliveredAt: T0 + 2, answeredAt: null }, agentRow({ capBlocked: true }), []).why)
      .toBe('told, but capped at its usage limit until the reset');
  });

  test('a prompt the worker reports as not taken is typed again - at most MAX_TRIES times', () => {
    let h = hold();
    for (let i = 0; i < M.MAX_TRIES; i++) {
      expect(M.shouldPrompt(h.sessions.a, agentRow())).toBe(true);
      h = M.notePrompted(h, 'a', T0 + i);
      expect(M.shouldPrompt(h.sessions.a, agentRow())).toBe(false);
      h = M.noteUnconfirmed(h, 'a');
      expect(h.sessions.a.promptedAt).toBeNull();
    }
    expect(M.shouldPrompt(h.sessions.a, agentRow())).toBe(false);
    expect(M.verdict(h.sessions.a, agentRow(), []).why).toBe(`the wrap-up prompt did not land after ${M.MAX_TRIES} tries`);
    // Once delivered, a late "unconfirmed" changes nothing.
    let d = M.noteHook(M.notePrompted(hold(), 'a', T0), 'a', 'UserPromptSubmit', { prompt: M.wrapUpPrompt('x') }, T0 + 1);
    expect(M.noteUnconfirmed(d, 'a')).toBe(d);
  });

  test('a session started during the hold (force) is tracked and told like the rest', () => {
    const h = M.trackSession(hold(), { id: 'n', name: 'N', agent: 'claude' });
    expect(h.sessions.n).toMatchObject({ agent: 'claude', promptedAt: null, pid: null });
    expect(M.trackSession(h, { id: 'n', name: 'again' })).toBe(h);
    expect(M.trackSession(null, { id: 'x' })).toBeNull();
  });

  test('verdicts come from state, and only ready/gone allow the restart', () => {
    const told = { promptedAt: T0 + 1, answeredAt: T0 + 2, answer: 'yes' };
    const S = M.STATES;
    expect(M.verdict({ promptedAt: null }, agentRow(), []).state).toBe(S.NOT_TOLD);
    expect(M.verdict({ promptedAt: T0 + 1, answeredAt: null }, agentRow(), []))
      .toEqual({ state: S.ANSWERING, why: 'prompt typed; waiting for the agent to take it' });
    expect(M.verdict({ promptedAt: T0 + 1, deliveredAt: T0 + 2, answeredAt: null }, agentRow(), []).why).toBe('told; its turn has not ended yet');
    expect(M.verdict(told, agentRow({ status: 'waiting', waitingFor: 'permission' }), []).why).toBe('waiting for you: approve a tool');
    expect(M.verdict(told, agentRow({ blockedPrompt: { kind: 'trust' } }), []).state).toBe(S.NEEDS_YOU);
    expect(M.verdict(told, agentRow({ status: 'working' }), []).state).toBe(S.WORKING);
    expect(M.verdict(told, agentRow({ status: 'working', subagents: 2 }), []).why).toBe('working, waiting on 2 subagents');
    expect(M.verdict(told, agentRow({ status: 'waiting', waitingFor: 'question' }), []).why).toBe('waiting for you: answer a question');
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
    h = { ...h, sessions: { ...h.sessions, a: { ...h.sessions.a, promptedAt: T0 + 1, answeredAt: T0 + 2, answer: 'yes' } } };
    const rows = { a: agentRow(), s: shellRow() };
    expect(M.status(h, rows, { a: [], s: [] }).safeToRestart).toBe(true);
    expect(M.status(h, rows, { a: [], s: [{ name: 'node.exe' }] }).safeToRestart).toBe(false);
    // A work read that never happened is not "nothing running".
    expect(M.status(h, rows, { a: [] }).safeToRestart).toBe(false);
    // Closed since: still safe.
    expect(M.status(h, { a: agentRow() }, { a: [] }).safeToRestart).toBe(true);
    // A session the hold never registered: judged too, and flagged.
    const late = M.status(h, { ...rows, n: agentRow({ id: 'n', name: 'N', status: 'working' }) }, { a: [], s: [], n: [] });
    expect(late.safeToRestart).toBe(false);
    expect(late.sessions[0]).toMatchObject({ id: 'n', state: 'working', untracked: true });
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

  test('#406: a different WORKER is a restart even with no sessions to vote; the same worker (a hot reload) is not', () => {
    const W = { pid: 500, startedAt: T0 - 5000 };
    const empty = M.startHold({ reason: 'r', now: T0, bootAt: BOOT, sessions: [], worker: W });
    expect(empty.worker).toEqual(W);
    // Nothing tracked, same boot: before #406 only a reboot could clear it.
    expect(M.restarted(empty, {}, BOOT)).toBe(false);
    // A hot reload of server.js: the same worker answers the ping.
    expect(M.restarted(empty, {}, BOOT, { ...W })).toBe(false);
    // A cold restart: a new worker (new pid and start time)...
    expect(M.restarted(empty, {}, BOOT, { pid: 777, startedAt: T0 + 9000 })).toBe(true);
    // ...and either field alone is a different worker (pids are reused, clocks are not).
    expect(M.restarted(empty, {}, BOOT, { pid: 500, startedAt: T0 + 9000 })).toBe(true);
    expect(M.restarted(empty, {}, BOOT, { pid: 777, startedAt: W.startedAt })).toBe(true);
    // A hold made against a worker that reported nothing (older than the field): a worker
    // that started AFTER the hold is new; one that started before it is the one it knew.
    const blind = M.startHold({ reason: 'r', now: T0, bootAt: BOOT, sessions: [] });
    expect(blind.worker).toBeNull();
    expect(M.restarted(blind, {}, BOOT, { pid: 1, startedAt: T0 + 1 })).toBe(true);
    expect(M.restarted(blind, {}, BOOT, { pid: 1, startedAt: T0 - 1 })).toBe(false);
    // No worker identity now (none attached, or an older worker): the other signals decide.
    expect(M.restarted(empty, {}, BOOT, null)).toBe(false);
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
