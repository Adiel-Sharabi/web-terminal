// @ts-check
// #443 milestone 2 - check in on a session whose reported self-wait nothing can keep. The
// rule is pure (lib/check-in.js). Pinned here: a check-in may be typed only when EVERY gate
// holds, and each gate is tested by breaking it ALONE on an otherwise-perfect candidate
// (#249's lesson: a negative that breaks two gates proves nothing about either), asserting
// WHICH gate said no. Also: once per idle period, the off switches, the prompt (bytes, tag,
// classification), delivery and the answer read as state, and the published field.
const { test, expect } = require('@playwright/test');
const C = require('../lib/check-in');
const H = require('../lib/handoff');
const agents = require('../lib/agents');
const { sessionReason } = require('../lib/session-reason');
const { classifyUserTurn, typedTextOf, USER_KINDS, CHECKIN_PROMPT_TAG } = require('../lib/user-turn');
const briefLib = require('../lib/session-brief');

const T = 1_700_000_000_000;
const MIN = 60 * 1000;

/** A session that should be checked in on: its turn ended [idleMin] ago having reported
 *  "self", nothing is running, and every safety field is clear. Its reason is the REAL
 *  rule's (lib/session-reason.js) - the same row the server stamps. */
function candidate(idleMin = 120) {
  const row = {
    id: 's1', agent: 'claude', status: 'idle', waitingFor: null, compacting: false, agentReady: true,
    blockedPrompt: null, inMenu: false, capBlocked: false, autoResumeArmed: false, usageLimit: null,
    backgroundTasks: [],
    brief: { turnAt: T - (idleMin + 5) * MIN, stoppedAt: T - idleMin * MIN,
      wait: { on: 'self', what: 'watch the CI run', at: T - idleMin * MIN - 1000 },
      handoff: null, checkIn: null, checkInOff: false },
  };
  return { ...row, reason: sessionReason(row) };
}
const block = (row, over = {}) => C.checkInBlock(row, { now: T, supported: true, ...over });

test.describe('checkInBlock (#443)', () => {
  test('the perfect candidate may be checked in on', () => {
    const r = candidate();
    expect(r.reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect(block(r)).toBeNull();
  });

  test('the fleet switch, the per-session switch and the registry each say no alone', () => {
    expect(block(candidate(), { cfg: C.checkInConfig({ enabled: false }) })).toBe('disabled');
    expect(block(candidate(), { supported: false })).toBe('unsupported');
    const off = candidate(); off.brief.checkInOff = true;
    expect(block(off)).toBe('off');
    // Default ON (the owner's call): no config at all, or any other value, is on.
    expect(C.checkInConfig(null).enabled).toBe(true);
    expect(C.checkInConfig({ enabled: 'no' }).enabled).toBe(true);
    // Declared for Claude only; a plain shell and Codex never.
    expect(agents.checksIn('claude')).toBe(true);
    expect(agents.checksIn('codex')).toBe(false);
    expect(agents.checksIn(null)).toBe(false);
    expect(agents.checksIn('nope')).toBe(false);
  });

  test('never into another prompt\'s turn: a restart hold or a hand-off in flight', () => {
    expect(block(candidate(), { hold: true })).toBe('restart-hold');
    const h = candidate(); h.brief.handoff = { state: 'wrapping' };
    expect(block(h)).toBe('handoff');
    // A hand-off that ended kept or failed told it to stop (a successor may hold the work):
    // never "pick it back up" until the session has been active again.
    for (const state of ['kept', 'failed']) {
      // Its wrap-up prompt started the session's latest turn (a turn inside the run).
      const k = candidate(); k.brief.handoff = { state, startedAt: k.brief.turnAt - 1000, at: k.brief.stoppedAt + 1000 };
      expect(block(k)).toBe('handed-off');
      k.brief.handoff = { state, startedAt: k.brief.turnAt - 2000, at: k.brief.turnAt - 1000 }; // a turn began after it ended
      expect(block(k)).toBeNull();
    }
    // A FAILED run whose wrap-up started no turn may still have its words unsubmitted in
    // the composer (a lost CR): a check-in's CR would submit both. It blocks - unless the
    // worker link refused the write (`typed: false`), which typed nothing.
    // Built through H.publicRun, the shaper server.js serves the row from: a stored field
    // the gate reads must survive it (the first cut read `typed`, which it dropped).
    const never = (state, extra) => { const k = candidate(); k.brief.handoff = H.publicRun({ state, startedAt: k.brief.turnAt + 500, at: k.brief.stoppedAt + 1000, ...extra }); return block(k); };
    expect(never('failed')).toBe('handed-off');
    expect(never('failed', { typed: false })).toBeNull();
    expect(never('kept')).toBe('handed-off');
    expect(never('kept', { typed: false })).toBe('handed-off'); // a successor holds the work
    // A run with no end time, or a brief with no turn time, cannot prove a later turn: block.
    const noAt = candidate(); noAt.brief.handoff = { state: 'kept', startedAt: 1 };
    expect(block(noAt)).toBe('handed-off');
    const noTurn = candidate(); noTurn.brief.handoff = { state: 'failed', startedAt: 1, at: 2 }; noTurn.brief.turnAt = null;
    expect(block(noTurn)).toBe('handed-off');
  });

  test('an API error is its own owner\'s (the worker\'s auto-continue), never a check-in', () => {
    const r = candidate(); r.apiError = true;
    expect(block(r)).toBe('api-error');
  });

  test('fails CLOSED when live work cannot be read', () => {
    // A transcript that cannot be found or read, or no process snapshot yet, reads as
    // "nothing running" to the badge readers; before a write it is "cannot tell".
    expect(block(candidate(), { liveKnown: false })).toBe('cannot-tell');
    expect(block(candidate(), { liveKnown: true })).toBeNull();
  });

  // Each safety field is broken ALONE; the row's reason is left as the candidate's (a
  // reported self), so the field's own gate is the only thing that can say no.
  for (const [what, mutate, why] of /** @type {[string, (r: any) => void, string][]} */ ([
    ['working', (r) => { r.status = 'working'; }, 'not-idle'],
    ['a pending question', (r) => { r.waitingFor = 'question'; }, 'waiting'],
    ['a permission prompt', (r) => { r.waitingFor = 'permission'; }, 'waiting'],
    ['compacting', (r) => { r.compacting = true; }, 'compacting'],
    ['not ready (#147)', (r) => { r.agentReady = false; }, 'not-ready'],
    ['a startup selector on screen (#190)', (r) => { r.blockedPrompt = { kind: 'folder-trust' }; }, 'not-ready'],
    ['in a menu (#316)', (r) => { r.inMenu = true; }, 'menu'],
    ['cap-blocked', (r) => { r.capBlocked = true; }, 'capped'],
    ['auto-resume armed', (r) => { r.autoResumeArmed = true; }, 'capped'],
    ['a usage cap in force', (r) => { r.usageLimit = { waiting: true, armed: false }; }, 'capped'],
  ])) {
    test(`never while ${what}`, () => {
      const r = candidate();
      mutate(r);
      expect(block(r)).toBe(why);
    });
  }

  test('waits on you or done are never stale; nor is self with a live waker before the backstop', () => {
    for (const on of ['you', 'done']) {
      const r = candidate();
      r.brief.wait = { ...r.brief.wait, on };
      expect(block({ ...r, reason: sessionReason(r) })).toBe('not-stale');
    }
    const live = candidate();
    live.backgroundTasks = [{ id: 'm1', kind: 'monitor', description: 'CI watcher', startedAt: T - 200 * MIN }];
    expect(block({ ...live, reason: sessionReason(live) }, { cfg: C.checkInConfig({ withLiveWorkMin: 500 }) })).toBe('not-stale');
    // A stale-flagged entry is not alive (milestone 1): the self-wait is stale again.
    const dead = candidate();
    dead.backgroundTasks = [{ id: 'b1', kind: 'command', description: 'build', startedAt: T - 900 * MIN, stale: true }];
    expect(block({ ...dead, reason: sessionReason(dead) })).toBeNull();
    // No report at all (the turn ended with no wait): nothing claims a self-wait.
    const none = candidate();
    none.brief.wait = null;
    expect(block({ ...none, reason: sessionReason(none) })).toBe('not-stale');
  });

  test('the threshold: afterMin past the point the self-wait went stale (default 30 + 30, #458)', () => {
    expect(C.DEFAULTS.afterMin).toBe(30);
    expect(H.handoffConfig(null).staleSelfMin).toBe(30);
    expect(block(candidate(59))).toBe('recent');
    expect(block(candidate(60))).toBeNull();
    // 20 min idle is not even stale yet.
    expect(block(candidate(20))).toBe('not-stale');
    // Both halves are configurable; bad values fall back. (The backstop is moved out of the
    // way: by default it asks at the same hour, whatever afterMin says.)
    expect(block(candidate(90), { cfg: C.checkInConfig({ afterMin: 120, withLiveWorkMin: 500 }) })).toBe('recent');
    expect(block(candidate(45), { cfg: C.checkInConfig({ afterMin: 10 }) })).toBeNull();
    expect(block(candidate(45), { hcfg: H.handoffConfig({ staleSelfMin: 60 }), cfg: C.checkInConfig({ afterMin: 10 }) })).toBe('not-stale');
    expect(C.checkInConfig({ afterMin: -5 }).afterMin).toBe(30);
    expect(C.checkInConfig({ afterMin: 'x' }).afterMin).toBe(30);
  });

  test('someone typing in the last 10 minutes defers it', () => {
    expect(block(candidate(), { inputAt: T - 5 * MIN })).toBe('typing');
    expect(block(candidate(), { inputAt: T - 11 * MIN })).toBeNull();
    // Keystrokes live in memory only: after a reload nobody knows, so the quiet period
    // counts from the server's start at least.
    expect(block(candidate(), { startedAt: T - 2 * MIN })).toBe('typing');
    expect(block(candidate(), { inputAt: T - 60 * MIN, startedAt: T - 5 * MIN })).toBe('typing');
    expect(block(candidate(), { startedAt: T - 11 * MIN })).toBeNull();
  });

  test('the cheap pre-filter passes only what the full rule could allow', () => {
    const e = (over = {}) => ({ turnAt: T - 125 * MIN, stoppedAt: T - 120 * MIN,
      reported: { wait: { on: 'self', what: 'x', at: T - 121 * MIN } }, checkIn: null, ...over });
    const worth = (x) => C.worthReading(x, { now: T });
    expect(worth(e())).toBe(true);
    expect(worth(e({ checkInOff: true }))).toBe(false);
    expect(worth(e({ reported: { wait: { on: 'done', at: T - 121 * MIN } } }))).toBe(false);
    expect(worth(e({ reported: null }))).toBe(false);
    expect(worth(e({ stoppedAt: T - 50 * MIN }))).toBe(false);
    expect(worth(e({ stoppedAt: T - 130 * MIN }))).toBe(false); // a turn running (stoppedAt < turnAt)
    expect(worth(e({ checkIn: C.startRecord(T - 10 * MIN, 110) }))).toBe(false);
    expect(worth(null)).toBe(false);
  });

  test('a check-in still landing is in flight for the other writers', () => {
    const rec = C.startRecord(T - MIN, 90);
    expect(C.inFlight(rec, T)).toBe(true);
    expect(C.inFlight({ ...rec, deliveredAt: T - 50000 }, T)).toBe(false);
    expect(C.inFlight(rec, T + 3 * MIN)).toBe(false); // past deliverMs: lost, not landing
    expect(C.inFlight(null, T)).toBe(false);
  });
});

test.describe('once per idle period (#443)', () => {
  test('a check-in in this idle period blocks the next, through its own turn and after it', () => {
    const r = candidate();
    // Sent, not yet delivered.
    r.brief.checkIn = C.startRecord(T - 30 * MIN, 90);
    expect(block(r)).toBe('asked');
    // Delivered: its own turn is the session's latest turn. Answered "self" with nothing
    // running, so the row is stale-self again - and still never asked a second time.
    const sent = T - 40 * MIN;
    const a = candidate();
    a.brief.checkIn = { ...C.startRecord(sent, 90), deliveredAt: sent + 2000, endedAt: sent + 60000, answer: { on: 'self', what: 'x' } };
    a.brief.turnAt = sent + 2000;
    a.brief.stoppedAt = sent + 60000;
    a.brief.wait = { on: 'self', what: 'x', at: sent + 50000 };
    const again = { ...a, reason: sessionReason(a) };
    expect(again.reason).toMatchObject({ kind: 'self', source: 'reported' });
    expect(block(again, { now: sent + 10 * 60 * MIN })).toBe('asked');
  });

  test('the period ends when the session is active again: a later turn re-arms it', () => {
    const sent = T - 300 * MIN;
    const r = candidate(120);
    r.brief.checkIn = { ...C.startRecord(sent, 90), deliveredAt: sent + 2000, endedAt: sent + 60000, answer: { on: 'self', what: 'x' } };
    // turnAt (T - 125 min) is a later turn than the check-in's own.
    expect(C.periodOpen(r.brief.checkIn, r.brief.turnAt)).toBe(false);
    expect(block(r)).toBeNull();
    // Never delivered: the period lasts until ANY turn starts after the send.
    expect(C.periodOpen(C.startRecord(sent, 90), sent - 1)).toBe(true);
    expect(C.periodOpen(C.startRecord(sent, 90), sent + 1)).toBe(false);
  });
});

test.describe('the check-in prompt (#443)', () => {
  test('starts with the tag, stays under 512 bytes in the worst case, and reads as automated', () => {
    const p = C.checkInPrompt({ idleMin: 95, what: 'watch the CI run' });
    expect(p.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
    expect(p).toContain('95 min');
    expect(p).toContain('("watch the CI run")');
    expect(p).toContain('report wait done');
    expect(p).not.toMatch(/[\r\n]/);
    // Worst case: days idle, the longest what, every char 3 bytes, quotes and newlines.
    const worst = C.checkInPrompt({ idleMin: 99999, what: `"\n${'א…'.repeat(200)}` });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(511);
    expect(worst.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
    expect(worst).toContain('1667 h');
    // The session's words reach the PTY as keystrokes: no control character survives
    // (an ESC would interrupt, a paste close would end a bracket, a CR would submit).
    const esc = String.fromCodePoint(0x1b);
    const nasty = C.checkInPrompt({ idleMin: 95, what: `a${esc}[201~b\rc${String.fromCodePoint(0x7f)}d${String.fromCodePoint(0x9b)}e` });
    expect(nasty).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(nasty).toContain('("a [201~b c d e")');
    // 4-byte characters do not fit beside the rest: the session's words are dropped, the
    // question stays whole.
    const emoji = C.checkInPrompt({ idleMin: 99999, what: '\u{1F600}'.repeat(100) });
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(511);
    expect(emoji).toContain('report wait done');
    expect(Buffer.byteLength(C.checkInPrompt({ idleMin: 90 }))).toBeLessThanOrEqual(511);
    // The chat lens and the recap: a system turn, never "You".
    const k = classifyUserTurn(p);
    expect(k.kind).toBe(USER_KINDS.SYSTEM);
    expect(k.from).toBe('Check-in');
    expect(typedTextOf(p)).toBe('');
  });

  test('delivered, it clears the self-wait and is NOT the person\'s prompt', () => {
    const e0 = { ...briefLib.emptyEntry(), turnAt: T - 100 * MIN, stoppedAt: T - 95 * MIN,
      reported: { items: [], headline: null, at: T - 96 * MIN, wait: { on: 'self', what: 'x', at: T - 96 * MIN } },
      prompt: { text: 'the last thing I typed', at: T - 100 * MIN } };
    const e1 = briefLib.foldHook(e0, 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 95 }) }, T);
    expect(e1.reported.wait).toBeNull();
    expect(e1.prompt).toEqual(e0.prompt);
    expect(e1.promptsSinceReport || 0).toBe(e0.promptsSinceReport || 0);
  });
});

test.describe('delivery and the answer, as state (#443)', () => {
  const sent = T - 10 * MIN;
  const base = () => ({ ...briefLib.emptyEntry(), turnAt: T - 200 * MIN, stoppedAt: T - 190 * MIN,
    reported: { items: [], headline: null, at: T - 191 * MIN, wait: { on: 'self', what: 'x', at: T - 191 * MIN } },
    checkIn: C.startRecord(sent, 190) });
  /** Fold a hook exactly as server.js does: the brief first, then the check-in, one clock. */
  const fold = (e, event, body, now) => C.noteHook(briefLib.foldHook(e, event, body, now), event, body, now);
  const report = (e, wait, now) => briefLib.applyReport(e, { items: [], headline: null, wait, partial: true }, now);

  test('delivery is the tagged UserPromptSubmit only', () => {
    const e = base();
    expect(fold(e, 'UserPromptSubmit', { prompt: 'hello' }, sent + 1000).checkIn.deliveredAt).toBeNull();
    expect(fold(e, 'UserPromptSubmit', { prompt: '<task-notification>x</task-notification>' }, sent + 1000).checkIn.deliveredAt).toBeNull();
    const d = fold(e, 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 190 }) }, sent + 1000);
    expect(d.checkIn.deliveredAt).toBe(sent + 1000);
    expect(d.turnAt).toBe(sent + 1000);
    // No record, no change.
    const none = { ...base(), checkIn: null };
    expect(C.noteHook(none, 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 1 }) }, sent)).toBe(none);
  });

  for (const on of ['done', 'you', 'external', 'self']) {
    test(`the wait reported in the check-in's turn is the answer (${on})`, () => {
      let e = fold(base(), 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 190 }) }, sent + 1000);
      e = report(e, { on, what: 'w' }, sent + 5000);
      e = fold(e, 'Stop', {}, sent + 6000);
      expect(e.checkIn).toMatchObject({ endedAt: sent + 6000, answer: { on, what: 'w' } });
    });
  }

  test('no report in that turn is no answer - the old self-wait never counts', () => {
    let e = fold(base(), 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 190 }) }, sent + 1000);
    e = fold(e, 'Stop', {}, sent + 6000);
    expect(e.checkIn).toMatchObject({ endedAt: sent + 6000, answer: null });
  });

  test('only the check-in\'s own turn answers it; a later Stop changes nothing', () => {
    let e = fold(base(), 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 190 }) }, sent + 1000);
    e = fold(e, 'Stop', {}, sent + 6000);
    const ended = e.checkIn;
    e = fold(e, 'UserPromptSubmit', { prompt: '<task-notification>x</task-notification>' }, sent + 9000);
    e = report(e, { on: 'done' }, sent + 9500);
    e = fold(e, 'Stop', {}, sent + 10000);
    expect(e.checkIn).toEqual(ended);
    // A Stop before delivery (the turn that was running when it was typed) answers nothing.
    const pre = fold(base(), 'Stop', {}, sent + 500);
    expect(pre.checkIn.endedAt).toBeNull();
  });

  test('a check-in turn that never Stopped (Esc) is not answered by the NEXT turn', () => {
    let e = fold(base(), 'UserPromptSubmit', { prompt: C.checkInPrompt({ idleMin: 190 }) }, sent + 1000);
    e = fold(e, 'UserPromptSubmit', { prompt: '<task-notification>x</task-notification>' }, sent + 9000);
    e = report(e, { on: 'done' }, sent + 9500);
    e = fold(e, 'Stop', {}, sent + 10000);
    expect(e.checkIn).toMatchObject({ deliveredAt: sent + 1000, endedAt: null, answer: null });
  });

  test('a wait reported BEFORE delivery is never the answer', () => {
    // foldHook clears a self-wait on delivery; this pins the check-in's own guard too.
    const e = { ...base(), turnAt: sent + 1000, stoppedAt: sent + 6000,
      reported: { items: [], headline: null, at: sent - 1, wait: { on: 'external', what: 'x', at: sent - 1 } },
      checkIn: { ...C.startRecord(sent, 190), deliveredAt: sent + 1000 } };
    expect(C.noteHook(e, 'Stop', {}, sent + 6000).checkIn).toMatchObject({ endedAt: sent + 6000, answer: null });
  });
});

test.describe('the published field (#443)', () => {
  const sent = T - 10 * MIN;
  const rowWith = (rec, over = {}) => {
    const r = candidate(120);
    r.brief.checkIn = C.publicRecord(rec);
    if (Number.isFinite(rec.deliveredAt)) r.brief.turnAt = rec.deliveredAt;
    return { ...r, ...over };
  };
  const field = (row, now = T) => C.checkInField(row, { now, supported: true });

  test('what came back, in one word', () => {
    const rec = C.startRecord(sent, 125);
    expect(field(rowWith(rec), sent + MIN)).toEqual({ sentAt: sent, idleMin: 125, state: 'sent', answeredAt: null });
    expect(field(rowWith(rec), sent + 4 * MIN).state).toBe('lost');
    const dl = { ...rec, deliveredAt: sent + 1000 };
    expect(field(rowWith(dl, { status: 'working' })).state).toBe('answering');
    // An Esc ends the turn with no Stop (Claude fires no hook; the worker flips it idle):
    // idle past the grace with no answer means none is coming.
    expect(field(rowWith(dl)).state).toBe('interrupted');
    expect(field(rowWith(dl), dl.deliveredAt + 10000).state).toBe('answering'); // a Stop may still be folding
    expect(field(rowWith(dl), dl.deliveredAt + 31000).state).toBe('interrupted');
    const ans = (on) => ({ ...dl, endedAt: sent + 9000, answer: on ? { on, what: '' } : null });
    expect(field(rowWith(ans('done')))).toMatchObject({ state: 'done', answeredAt: sent + 9000 });
    expect(field(rowWith(ans('you'))).state).toBe('you');
    expect(field(rowWith(ans('external'))).state).toBe('external');
    expect(field(rowWith(ans('self'))).state).toBe('stuck');
    expect(field(rowWith(ans(null))).state).toBe('stuck');
    expect(field(rowWith(ans('self'), { backgroundTasks: [{ id: 'm', kind: 'monitor', startedAt: sent }] })).state).toBe('resumed');
    expect(field(rowWith(ans('self'), { backgroundTasks: [{ id: 'm', kind: 'monitor', startedAt: sent, stale: true }] })).state).toBe('stuck');
  });

  test('gone once the session is active again, and never for an agent that does not check in', () => {
    const r = rowWith({ ...C.startRecord(sent, 125), deliveredAt: sent + 1000, endedAt: sent + 9000, answer: { on: 'done', what: '' } });
    expect(field(r)).not.toBeNull();
    r.brief.turnAt = sent + 20000;
    expect(field(r)).toBeNull();
    expect(C.checkInField(rowWith(C.startRecord(sent, 1)), { now: T, supported: false })).toBeNull();
    expect(field(candidate())).toBeNull();
  });

  test('the log line names the event, the session and the answer', () => {
    const rec = { ...C.startRecord(sent, 125), answer: { on: 'done', what: '' } };
    expect(C.logRecord('answered', 's1', rec, T, { name: 'n' })).toEqual({
      at: new Date(T).toISOString(), event: 'answered', id: 's1', sentAt: sent, idleMin: 125, why: 'stale-self', answer: 'done', name: 'n' });
  });
});

// #456 - a self-wait whose live work cannot wake it. Night of 2026-11-09: a lead waited on
// child sessions that had all finished and were waiting on IT, while its own watcher (a
// background command whose filter swallowed every event) kept it "live" for 7.5 h. Two more
// readings may ask; each is pinned by breaking it ALONE, and the old gates still hold.
test.describe('a self-wait whose live work cannot wake it (#456)', () => {
  /** The night's lead: self-wait [idleMin] ago, a background watcher still running. */
  function lead(idleMin = 120) {
    const r = candidate(idleMin);
    r.backgroundTasks = [{ id: 'w1', kind: 'command', description: 'Wait for the next worker event', startedAt: T - idleMin * MIN }];
    return { ...r, reason: sessionReason(r) };
  }
  const parked = (endedMinAgo) => ({ live: false, endedAt: T - endedMinAgo * MIN });
  const why = (row, over = {}) => C.checkInReading(row, { now: T, ...over });

  test('the old reading is named: a stale self-wait with nothing alive', () => {
    expect(why(candidate(60))).toBe('stale-self');
    expect(why(candidate(59))).toBeNull();
  });

  test('children parked: every child stopped, so the lead is asked despite its watcher', () => {
    // The backstop moved out of the way (by default it asks at the same hour, #458), so
    // this reading is pinned on its own.
    const cfg = C.checkInConfig({ withLiveWorkMin: 10000 });
    const r = lead(120);
    expect(r.reason).toMatchObject({ kind: 'self', source: 'background' });
    // Without children: live work, not stale.
    expect(block(r, { cfg })).toBe('not-stale');
    const kids = [parked(100), parked(95)];
    expect(block(r, { cfg, children: kids })).toBeNull();
    expect(why(r, { cfg, children: kids })).toBe('children-parked');
    // At the default backstop too, the words are the children's.
    expect(why(r, { children: kids })).toBe('children-parked');
    // Break each condition ALONE.
    expect(block(r, { cfg, children: [parked(100), { live: true, endedAt: T - 95 * MIN }] })).toBe('not-stale');
    expect(block(r, { cfg, children: [parked(100), parked(59)] })).toBe('not-stale');  // the last child stopped too recently
    expect(block(lead(59), { cfg, children: kids })).toBe('not-stale');                // the lead itself too recently
    expect(block(r, { cfg, children: [] })).toBe('not-stale');                         // no children: nothing parked
    expect(block(r, { cfg, children: [parked(100), { live: false, endedAt: null }] })).toBe('not-stale'); // unknown end: fail closed
    // Same clock as the stale-self reading: staleSelfMin + afterMin.
    expect(block(r, { children: kids, cfg: C.checkInConfig({ afterMin: 70, withLiveWorkMin: 10000 }) })).toBe('not-stale');
  });

  test('the backstop: a self-wait idle withLiveWorkMin (default 60, #458) is asked even with live work', () => {
    expect(C.DEFAULTS.withLiveWorkMin).toBe(60);
    expect(block(lead(59))).toBe('not-stale');
    expect(block(lead(60))).toBeNull();
    expect(why(lead(60))).toBe('long-self');
    // A live child is live work like any other: the backstop still asks.
    const kid = lead(200);
    expect(block(kid, { children: [{ live: true, endedAt: null }] })).toBeNull();
    expect(why(kid, { children: [{ live: true, endedAt: null }] })).toBe('long-self');
    // Configurable; bad values fall back.
    expect(block(lead(200), { cfg: C.checkInConfig({ withLiveWorkMin: 240 }) })).toBe('not-stale');
    expect(block(lead(130), { cfg: C.checkInConfig({ withLiveWorkMin: 120 }) })).toBeNull();
    // A backstop shorter than the stale-self clock: nothing alive still reads stale-self,
    // so the words never claim work is listed as running.
    expect(why(candidate(35), { cfg: C.checkInConfig({ withLiveWorkMin: 20 }) })).toBe('stale-self');
    expect(why(lead(35), { cfg: C.checkInConfig({ withLiveWorkMin: 20 }) })).toBe('long-self');
    expect(C.checkInConfig({ withLiveWorkMin: 0 }).withLiveWorkMin).toBe(60);
    expect(C.checkInConfig({ withLiveWorkMin: 'x' }).withLiveWorkMin).toBe(60);
  });

  test('only a REPORTED self or external wait: you, done or no report are never asked, however long', () => {
    for (const on of ['you', 'done']) {
      const r = lead(600);
      r.brief.wait = { ...r.brief.wait, on };
      const row = { ...r, reason: sessionReason(r) };
      expect(block(row, { children: [parked(500)] })).toBe('not-stale');
    }
    const none = lead(600);
    none.brief.wait = null;
    expect(block({ ...none, reason: sessionReason(none) }, { children: [parked(500)] })).toBe('not-stale');
  });

  test('every earlier gate still says no first', () => {
    const r = lead(600);
    const kids = [parked(500)];
    expect(block({ ...r, waitingFor: { kind: 'question' } }, { children: kids })).toBe('waiting');
    expect(block({ ...r, status: 'working' }, { children: kids })).toBe('not-idle');
    expect(block(r, { children: kids, inputAt: T - 2 * MIN })).toBe('typing');
    expect(block(r, { children: kids, liveKnown: false })).toBe('cannot-tell');
    expect(block({ ...r, brief: { ...r.brief, checkIn: C.startRecord(T - 10 * MIN, 590) } }, { children: kids })).toBe('asked');
    expect(block({ ...r, brief: { ...r.brief, checkInOff: true } }, { children: kids })).toBe('off');
  });

  test('the cheap pre-filter lets through whatever the earliest reading could allow', () => {
    const e = (stoppedMin) => ({ turnAt: T - (stoppedMin + 5) * MIN, stoppedAt: T - stoppedMin * MIN,
      reported: { wait: { on: 'self', what: 'x', at: T - stoppedMin * MIN - 1000 } }, checkIn: null });
    const late = { cfg: C.checkInConfig({ afterMin: 300 }) };
    expect(C.worthReading(e(59), { now: T, ...late })).toBe(false);
    expect(C.worthReading(e(60), { now: T, ...late })).toBe(true);  // the backstop comes first here
  });

  test('each reading asks in its own words, never claiming nothing runs when something does', () => {
    const stale = C.checkInPrompt({ idleMin: 95, what: 'w', why: 'stale-self' });
    expect(stale).toBe(C.checkInPrompt({ idleMin: 95, what: 'w' })); // the default reading is unchanged
    expect(stale).toContain('nothing that could wake you is running');
    const kids = C.checkInPrompt({ idleMin: 120, what: 'workers', why: 'children-parked' });
    const long = C.checkInPrompt({ idleMin: 200, what: 'watcher', why: 'long-self' });
    for (const p of [kids, long]) {
      expect(p.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
      expect(p).not.toContain('nothing that could wake you is running');
      expect(p).toContain('report wait done');
      expect(p).toContain('report wait you');
      expect(p).not.toMatch(/[\r\n]/);
      expect(classifyUserTurn(p).kind).toBe(USER_KINDS.SYSTEM);
    }
    expect(kids).toContain('child session');
    expect(long).toContain('3 h');
    expect(long).toContain('still listed as running');
    for (const w of ['children-parked', 'long-self']) {
      const worst = C.checkInPrompt({ idleMin: 99999, what: `"\n${'א…'.repeat(200)}`, why: w });
      expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(511);
      expect(worst).toContain('report wait you');
    }
  });

  test('the record and the log line carry the reading', () => {
    const rec = C.startRecord(T, 200, 'long-self');
    expect(rec.why).toBe('long-self');
    expect(C.startRecord(T, 95).why).toBe('stale-self');
    expect(C.logRecord('sent', 's1', rec, T)).toMatchObject({ event: 'sent', why: 'long-self' });
  });
});

// #458 - the owner's call: an idle hour is the point to ask, and a session waiting on
// someone else may have missed what it waited for, as surely as a self-wait's waker. Every
// reported self-wait is asked at an idle hour (the readings above only pick the words), an
// external wait too; a wait on the owner and a session that reported done never are.
test.describe('an external wait idle an hour is asked too (#458)', () => {
  /** A session that reported waiting on someone else [idleMin] ago. */
  function ext(idleMin = 120, over = {}) {
    const r = candidate(idleMin);
    r.brief.wait = { on: 'external', what: 'PR review by the platform team', at: T - idleMin * MIN - 1000 };
    Object.assign(r, over);
    return { ...r, reason: sessionReason(r) };
  }
  const why = (row, over = {}) => C.checkInReading(row, { now: T, ...over });

  test('asked at externalMin (default 60), not before', () => {
    expect(C.DEFAULTS.externalMin).toBe(60);
    expect(block(ext(59))).toBe('not-stale');
    expect(block(ext(60))).toBeNull();
    expect(why(ext(60))).toBe('external');
    // Configurable; bad values fall back.
    expect(block(ext(100), { cfg: C.checkInConfig({ externalMin: 120 }) })).toBe('not-stale');
    expect(block(ext(30), { cfg: C.checkInConfig({ externalMin: 20 }) })).toBeNull();
    expect(C.checkInConfig({ externalMin: 0 }).externalMin).toBe(60);
    expect(C.checkInConfig({ externalMin: 'x' }).externalMin).toBe(60);
  });

  test('its own clock: the self-wait clocks do not move it, nor it them', () => {
    const fast = C.checkInConfig({ afterMin: 1, withLiveWorkMin: 1 });
    expect(block(ext(40), { cfg: fast, hcfg: H.handoffConfig({ staleSelfMin: 1 }) })).toBe('not-stale');
    expect(block(candidate(60), { cfg: C.checkInConfig({ externalMin: 500 }) })).toBeNull();
  });

  test('live work and children do not hold it back: it waits on neither', () => {
    const busy = ext(90, { backgroundTasks: [{ id: 'w1', kind: 'monitor', description: 'PR watcher', startedAt: T - 90 * MIN }] });
    expect(block(busy, { children: [{ live: true, endedAt: null }] })).toBeNull();
    expect(why(busy, { children: [{ live: true, endedAt: null }] })).toBe('external');
  });

  test('every earlier gate still says no first, and it is asked once per idle period', () => {
    const r = ext(600);
    expect(block({ ...r, waitingFor: { kind: 'question' } })).toBe('waiting');
    expect(block({ ...r, status: 'working' })).toBe('not-idle');
    expect(block(r, { inputAt: T - 2 * MIN })).toBe('typing');
    expect(block(r, { liveKnown: false })).toBe('cannot-tell');
    expect(block({ ...r, brief: { ...r.brief, checkInOff: true } })).toBe('off');
    // Answered "external" again: the period stays open until a later turn starts.
    const rec = { ...C.startRecord(T - 30 * MIN, 570, 'external'), deliveredAt: T - 29 * MIN, endedAt: T - 28 * MIN,
      answer: { on: 'external', what: 'still in review' } };
    const asked = { ...r, brief: { ...r.brief, checkIn: rec, turnAt: T - 29 * MIN, stoppedAt: T - 28 * MIN } };
    expect(block(asked)).toBe('asked');
    expect(C.outcome(rec, asked, T)).toBe('external');
  });

  test('the cheap pre-filter lets an external wait through on its own clock, never you or done', () => {
    const e = (on, stoppedMin) => ({ turnAt: T - (stoppedMin + 5) * MIN, stoppedAt: T - stoppedMin * MIN,
      reported: { wait: { on, what: 'x', at: T - stoppedMin * MIN - 1000 } }, checkIn: null });
    expect(C.worthReading(e('external', 59), { now: T })).toBe(false);
    expect(C.worthReading(e('external', 60), { now: T })).toBe(true);
    const cfg = C.checkInConfig({ externalMin: 120, afterMin: 1, withLiveWorkMin: 1 });
    expect(C.worthReading(e('external', 100), { now: T, cfg })).toBe(false);
    expect(C.worthReading(e('self', 100), { now: T, cfg })).toBe(true);
    for (const on of ['you', 'done']) expect(C.worthReading(e(on, 600), { now: T })).toBe(false);
  });

  test('asks in its own words: waiting on someone else, and how to say it still is', () => {
    const p = C.checkInPrompt({ idleMin: 75, what: 'PR review', why: 'external' });
    expect(p.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
    expect(p).toContain('waiting on someone or something else ("PR review")');
    expect(p).not.toContain('resume on your own');
    expect(p).not.toContain('nothing that could wake you is running');
    // An external wait can stand across turns that DID wake the session (a task
    // notification ends only a self-wait), so its words never claim nothing woke it.
    expect(p).not.toMatch(/woken/);
    for (const w of ['report wait external', 'report wait done', 'report wait you', 'pick the work back up']) expect(p).toContain(w);
    expect(p).not.toMatch(/[\r\n]/);
    expect(classifyUserTurn(p).kind).toBe(USER_KINDS.SYSTEM);
    // The self readings keep their words.
    for (const w of ['stale-self', 'children-parked', 'long-self']) expect(C.checkInPrompt({ idleMin: 75, why: w })).toContain('resume on your own');
    const worst = C.checkInPrompt({ idleMin: 99999, what: `"\n${'א…'.repeat(200)}`, why: 'external' });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(511);
    expect(worst).toContain('report wait external');
  });

  test('no report to an external check-in: the wait still standing is the state, never "still nothing running"', () => {
    const r = ext(600);
    const rec = (why) => ({ ...C.startRecord(T - 30 * MIN, 570, why), deliveredAt: T - 29 * MIN, endedAt: T - 28 * MIN, answer: null });
    const row = (why, wait = r.brief.wait) => ({ ...r, brief: { ...r.brief, wait, checkIn: C.publicRecord(rec(why)), turnAt: T - 29 * MIN, stoppedAt: T - 28 * MIN } });
    // The published record carries the reading, so the row's field can tell.
    expect(C.publicRecord(rec('external')).why).toBe('external');
    expect(C.checkInField(row('external'), { now: T, supported: true }).state).toBe('external');
    // Break each half alone: a self reading, or the wait no longer external, is stuck as before.
    expect(C.checkInField(row('stale-self'), { now: T, supported: true }).state).toBe('stuck');
    expect(C.checkInField(row('external', null), { now: T, supported: true }).state).toBe('stuck');
    expect(C.checkInField(row('external', { ...r.brief.wait, on: 'self' }), { now: T, supported: true }).state).toBe('stuck');
  });
});
