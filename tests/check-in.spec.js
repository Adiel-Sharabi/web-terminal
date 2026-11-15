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
  test('a check-in in this idle period blocks the next, through its own turn and until a repeat is due (#463)', () => {
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
    expect(block(again, { now: sent + 60000 + 59 * MIN })).toBe('asked');
    // #463: an hour after its answer it may be asked again (see the #463 block below).
    expect(block(again, { now: sent + 60000 + 60 * MIN })).toBeNull();
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
      at: new Date(T).toISOString(), event: 'answered', id: 's1', sentAt: sent, idleMin: 125, why: 'stale-self', n: 1, answer: 'done', name: 'n' });
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

test.describe('a turn an API error cut, with nothing retrying it, is asked (#461)', () => {
  const ERR = 'API Error: Connection lost mid-response. The response above may be incomplete.';
  /** A session whose turn began [idleMin + 2] min ago and was cut by an API error [idleMin]
   *  ago: no Stop since the turn began (Claude fires none), so it reported no wait. */
  function cut(idleMin = 120, over = {}) {
    const r = candidate(idleMin + 30); // its PREVIOUS turn ended normally, long before
    r.brief = { ...r.brief, turnAt: T - (idleMin + 2) * MIN, wait: null };
    Object.assign(r, { apiError: true, apiErrorText: ERR, apiErrorAt: T - idleMin * MIN }, over);
    return { ...r, reason: sessionReason(r) };
  }
  const why = (row, over = {}) => C.checkInReading(row, { now: T, ...over });

  test('the measured case is asked at apiErrorMin (default 60), not before: the auto-continue owns it until then', () => {
    expect(C.DEFAULTS.apiErrorMin).toBe(60);
    expect(H.turnEndedAt(cut().brief)).toBeNull(); // the precondition: the turn never ended
    expect(block(cut(59))).toBe('api-error');
    expect(block(cut(60))).toBeNull();
    expect(why(cut(60))).toBe('api-error');
    expect(block(cut(26 * 60))).toBeNull(); // the 26 h the measured child slept
    expect(block(cut(40), { cfg: C.checkInConfig({ apiErrorMin: 30 }) })).toBeNull();
    expect(block(cut(90), { cfg: C.checkInConfig({ apiErrorMin: 120 }) })).toBe('api-error');
    expect(C.checkInConfig({ apiErrorMin: -1 }).apiErrorMin).toBe(60);
  });

  test('only a turn the error CUT: a sighting over a turn that ended blocks nothing, a row that cannot tell blocks', () => {
    // The turn ended normally after the line was printed (a session echoing "API Error"):
    // not cut, so not asked by this reading - and the flag is no longer the auto-continue's.
    const ended = cut(); ended.brief = { ...ended.brief, stoppedAt: T - 100 * MIN };
    expect(why(ended)).toBeNull();
    expect(block(ended)).toBe('not-stale');
    // ...so a self-wait session showing a stale sighting is still asked as before.
    const selfWait = candidate(); Object.assign(selfWait, { apiError: true, apiErrorAt: selfWait.brief.turnAt + 1000 });
    expect(block(selfWait)).toBeNull();
    expect(why(selfWait)).toBe('stale-self');
    // A FRESH sighting over a turn that ended is no ladder's either: it blocks nothing.
    const freshSight = candidate(); Object.assign(freshSight, { apiError: true, apiErrorAt: T - 5 * MIN });
    freshSight.brief = { ...freshSight.brief, turnAt: T - 125 * MIN, stoppedAt: T - 2 * MIN };
    expect(block(freshSight)).not.toBe('api-error');
    // The error was seen BEFORE the current turn began: not this turn's.
    expect(why(cut(120, { apiErrorAt: T - 125 * MIN }))).toBeNull();
    // An older worker publishes no apiErrorAt: cannot tell, blocked as before.
    expect(block(cut(120, { apiErrorAt: null }))).toBe('api-error');
    expect(block(cut(120, { apiErrorAt: undefined }))).toBe('api-error');
    expect(block(selfWait.brief && { ...selfWait, apiErrorAt: null })).toBe('api-error');
    // No standing error: a cut turn with no report is nothing the check-in can read.
    expect(block(cut(120, { apiError: false }))).toBe('not-stale');
    // No turn time at all: cannot prove a cut.
    const noTurn = cut(); noTurn.brief = { ...noTurn.brief, turnAt: null };
    expect(why(noTurn)).toBeNull();
  });

  test('a wait on the owner or done, reported in the turn before it was cut, is never asked (#458 still binds)', () => {
    for (const on of ['you', 'done']) {
      const r = cut(600); r.brief = { ...r.brief, wait: { on, what: 'approve the plan', at: r.brief.turnAt + 1000 } };
      expect(why(r)).toBeNull();
      // Reported in an EARLIER turn: this turn's prompt answered it, so the cut turn is asked.
      const old = cut(600); old.brief = { ...old.brief, wait: { on, what: 'approve the plan', at: old.brief.turnAt - 1000 } };
      expect(why(old)).toBe('api-error');
    }
    // The raw entry (the pre-filter's view) keeps it under reported.
    const entry = { turnAt: T - 122 * MIN, stoppedAt: T - 150 * MIN, reported: { wait: { on: 'you', what: 'x', at: T - 121 * MIN } }, checkIn: null };
    expect(C.worthReading(entry, { now: T, listed: { apiError: true, apiErrorAt: T - 120 * MIN } })).toBe(false);
  });

  test('every earlier gate still says no first', () => {
    const r = cut(600);
    expect(block({ ...r, status: 'working' })).toBe('not-idle');
    expect(block({ ...r, waitingFor: { kind: 'question' } })).toBe('waiting');
    expect(block({ ...r, compacting: true })).toBe('compacting');
    expect(block({ ...r, capBlocked: true })).toBe('capped');
    expect(block(r, { inputAt: T - 2 * MIN })).toBe('typing');
    expect(block(r, { liveKnown: false })).toBe('cannot-tell');
    expect(block(r, { hold: true })).toBe('restart-hold');
    expect(block({ ...r, brief: { ...r.brief, checkInOff: true } })).toBe('off');
  });

  test('asked once per RUN of cut turns: neither its own cut turn nor the ladder\'s later ones re-ask it; a turn that ends does', () => {
    const r = cut(600);
    const rec = { ...C.startRecord(T - 30 * MIN, 570, 'api-error'), deliveredAt: T - 29 * MIN };
    // Its turn began at delivery and an API error cut it too: no Stop, a newer error.
    const again = { ...r, apiErrorAt: T - 28 * MIN, brief: { ...r.brief, checkIn: rec, turnAt: T - 29 * MIN } };
    expect(block(again)).toBe('api-error'); // the new error is fresh: the auto-continue's
    expect(block(again, { now: T + 10 * 60 * MIN })).toBe('asked'); // stale, but already asked
    // The worker's ladder then typed `continue`: a LATER turn, which ends the idle period -
    // and was cut as well (an outage). Hours on, still not asked again.
    const ladder = { ...again, brief: { ...again.brief, turnAt: T - 10 * MIN }, apiErrorAt: T - 9 * MIN };
    for (const later of [120, 600, 6000]) expect(block(ladder, { now: T + later * MIN })).toBe('not-stale');
    // A turn that ENDED after the check-in re-arms it: the next cut is a new run.
    const next = { ...ladder, brief: { ...ladder.brief, stoppedAt: T - 20 * MIN } };
    expect(block(next, { now: T + 120 * MIN })).toBeNull();
    expect(why(next, { now: T + 120 * MIN })).toBe('api-error');
  });

  test('the cheap pre-filter lets it through from the worker\'s list row, which carries the error', () => {
    const entry = { turnAt: T - 122 * MIN, stoppedAt: T - 150 * MIN, reported: { wait: null }, checkIn: null };
    const listed = (min, over = {}) => ({ apiError: true, apiErrorAt: T - min * MIN, ...over });
    expect(C.worthReading(entry, { now: T, listed: listed(60) })).toBe(true);
    expect(C.worthReading(entry, { now: T, listed: listed(59) })).toBe(false);
    expect(C.worthReading(entry, { now: T })).toBe(false); // no list row: the old rule, no wait
    expect(C.worthReading(entry, { now: T, listed: listed(60, { apiError: false }) })).toBe(false);
    expect(C.worthReading(entry, { now: T, listed: listed(60, { apiErrorAt: null }) })).toBe(false);
    expect(C.worthReading({ ...entry, stoppedAt: T - 100 * MIN }, { now: T, listed: listed(120) })).toBe(false);
    expect(C.worthReading({ ...entry, checkInOff: true }, { now: T, listed: listed(120) })).toBe(false);
    const open = { ...entry, checkIn: { sentAt: T - 30 * MIN, deliveredAt: T - 29 * MIN }, turnAt: T - 29 * MIN };
    expect(C.worthReading(open, { now: T, listed: listed(120) })).toBe(false);
  });

  test('its idle clock is the error, since the turn has no end', () => {
    expect(C.idleSince(cut(90), 'api-error')).toBe(T - 90 * MIN);
    expect(C.idleSince(cut(90), 'stale-self')).toBeNull();
    expect(C.idleSince(candidate(45), 'stale-self')).toBe(T - 45 * MIN);
  });

  test('asks in its own words: the error that cut it, and to pick the work back up', () => {
    const p = C.checkInPrompt({ idleMin: 26 * 60, what: ERR, why: 'api-error' });
    expect(p.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
    expect(p).toContain('You have been idle 26 h. Your last turn was cut off by an API error');
    expect(p).toContain('("Connection lost mid-response');
    // Never the phrase the worker sniffs: the agent echoes its prompt (#138).
    expect(p).not.toContain('API Error');
    expect(C.checkInPrompt({ idleMin: 90, what: 'x API Error y', why: 'api-error' })).not.toContain('API Error');
    expect(p).toContain('nothing retried it');
    for (const w of ['pick it back up', 'report wait done', 'report wait you']) expect(p).toContain(w);
    // It reported nothing: never claim it said it would resume, or waited on someone.
    expect(p).not.toContain('You last reported');
    expect(p).not.toMatch(/[\r\n]/);
    expect(classifyUserTurn(p).kind).toBe(USER_KINDS.SYSTEM);
    const worst = C.checkInPrompt({ idleMin: 99999, what: `\u001b[201~"\n${'א…'.repeat(200)}`, why: 'api-error' });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(511);
    expect(worst).not.toMatch(/[\u0000-\u001f]/);
    // The other readings keep their words.
    expect(C.checkInPrompt({ idleMin: 75, why: 'stale-self' })).toContain('You last reported you would resume on your own');
  });
});

// #463 - two sessions sat on a CI watcher that missed its event (2026-11-15). One had its
// self-wait cleared by a lead's typed prompt and reported none after it, so no reading saw it
// (102 min). The other was asked once, answered self with a fresh watcher, and the period
// never let it be asked again (3 h 23 min). Each gate is broken alone.
test.describe('a stuck watcher with no report, and a repeat after the answer (#463)', () => {
  /** Case 1: no wait reported (cleared by a typed prompt), has reported before, a watcher
   *  still listed as running, its turn ended [idleMin] ago. */
  function unreported(idleMin = 120) {
    const r = candidate(idleMin);
    r.brief.wait = null;
    r.brief.reporting = 'on';
    r.brief.reportAt = T - (idleMin + 6) * MIN;
    r.backgroundTasks = [{ id: 'w1', kind: 'command', description: 'Wait for PR builds to finish', startedAt: T - (idleMin + 1) * MIN }];
    return { ...r, reason: sessionReason(r) };
  }
  const why = (row, over = {}) => C.checkInReading(row, { now: T, ...over });

  test('no wait reported, live work listed: asked at withLiveWorkMin, as live-unreported', () => {
    expect(unreported(60).reason).toMatchObject({ kind: 'self', source: 'background' });
    expect(block(unreported(59))).toBe('not-stale');
    expect(block(unreported(60))).toBeNull();
    expect(why(unreported(60))).toBe('live-unreported');
    expect(block(unreported(130), { cfg: C.checkInConfig({ withLiveWorkMin: 120 }) })).toBeNull();
    expect(block(unreported(119), { cfg: C.checkInConfig({ withLiveWorkMin: 120 }) })).toBe('not-stale');
  });

  test('each of its conditions, broken alone, says no', () => {
    // Never reported anything: a session that does not use the dashboard is not asked.
    const never = unreported(600); never.brief.reportAt = null;
    expect(block(never)).toBe('not-stale');
    // Reporting off (dashboard off, opted out, an excluded cwd): the brief publishes no wait
    // whatever was reported, so "no wait" is not a reading.
    const off = unreported(600); off.brief.reporting = 'off';
    expect(block(off)).toBe('not-stale');
    const absent = unreported(600); delete absent.brief.reporting;
    expect(block(absent)).toBe('not-stale');
    // Nothing listed as running (the task went stale): no reading claims work runs.
    const gone = unreported(600); gone.backgroundTasks = [{ ...gone.backgroundTasks[0], stale: true }];
    expect(block({ ...gone, reason: sessionReason(gone) })).toBe('not-stale');
    // A reported wait on the owner or done is never asked, live work or not (#458).
    for (const on of ['you', 'done']) {
      const w = unreported(600); w.brief.wait = { on, what: 'x', at: w.brief.stoppedAt - 1000 };
      expect(block({ ...w, reason: sessionReason(w) })).toBe('not-stale');
    }
    // Every earlier gate still says no first.
    const r = unreported(600);
    expect(block({ ...r, status: 'working' })).toBe('not-idle');
    expect(block(r, { inputAt: T - 2 * MIN })).toBe('typing');
    expect(block(r, { liveKnown: false })).toBe('cannot-tell');
    expect(block({ ...r, brief: { ...r.brief, checkInOff: true } })).toBe('off');
  });

  test('the cheap pre-filter lets an unreported session through at withLiveWorkMin, only if it reported before', () => {
    const e = (stoppedMin, reported) => ({ turnAt: T - (stoppedMin + 5) * MIN, stoppedAt: T - stoppedMin * MIN, reported, checkIn: null });
    const cleared = { items: [], headline: 'h', at: T - 200 * MIN, wait: null };
    expect(C.worthReading(e(59, cleared), { now: T })).toBe(false);
    expect(C.worthReading(e(60, cleared), { now: T })).toBe(true);
    expect(C.worthReading(e(600, null), { now: T })).toBe(false);
    expect(C.worthReading(e(600, { wait: null }), { now: T })).toBe(false); // no report time
  });

  test('its prompt says nothing was reported and names the work, never "you last reported"', () => {
    const p = C.checkInPrompt({ idleMin: 102, what: 'Wait for PR builds to finish', why: 'live-unreported' });
    expect(p.startsWith(CHECKIN_PROMPT_TAG)).toBe(true);
    expect(p).toContain('reported no wait');
    expect(p).toContain('("Wait for PR builds to finish")');
    expect(p).not.toContain('You last reported');
    expect(p).not.toContain('nothing that could wake you is running');
    expect(p).toContain('report wait self');
    expect(p).toContain('report wait done');
    expect(classifyUserTurn(p).kind).toBe(USER_KINDS.SYSTEM);
    const worst = C.checkInPrompt({ idleMin: 99999, what: `"\n${'א…'.repeat(200)}`, why: 'live-unreported' });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(511);
    expect(worst).toContain('report wait you');
  });

  /** Case 2: the [n]th check-in of the period, answered [on] [answeredMin] ago, idle since. */
  function answered(answeredMin, on = 'self', n = 1, row = null) {
    const r = row || candidate(answeredMin);
    const ended = T - answeredMin * MIN;
    const sent = ended - 2 * MIN;
    const rec = { ...C.startRecord(sent, 61, 'long-self', n), deliveredAt: sent + 1000, endedAt: ended, answer: on ? { on, what: 'x' } : null };
    const brief = { ...r.brief, checkIn: C.publicRecord(rec), turnAt: sent + 1000, stoppedAt: ended,
      wait: on ? { on, what: 'x', at: ended - 1000 } : r.brief.wait };
    const out = { ...r, brief };
    return { ...out, reason: sessionReason(out) };
  }
  /** A session with a fresh watcher listed as running. */
  const watching = (min) => {
    const r = candidate(min);
    r.backgroundTasks = [{ id: 'w2', kind: 'command', description: 'watch PR', startedAt: T - min * MIN }];
    return r;
  };

  test('answered self with a fresh watcher: asked again an hour after the answer, then 2 h, then 4 h', () => {
    expect(block(answered(59, 'self', 1, watching(59)))).toBe('asked');
    expect(block(answered(60, 'self', 1, watching(60)))).toBeNull();
    expect(why(answered(60, 'self', 1, watching(60)))).toBe('long-self');
    expect(block(answered(119, 'self', 2, watching(119)))).toBe('asked');
    expect(block(answered(120, 'self', 2, watching(120)))).toBeNull();
    expect(block(answered(239, 'self', 3, watching(239)))).toBe('asked');
    expect(block(answered(240, 'self', 3, watching(240)))).toBeNull();
    // maxPerPeriod (4) asks: no fifth, however long.
    expect(block(answered(60000, 'self', 4, watching(60000)))).toBe('asked');
    expect(block(answered(600, 'self', 2, watching(600)), { cfg: C.checkInConfig({ maxPerPeriod: 2 }) })).toBe('asked');
    expect(block(answered(30, 'self', 1, watching(30)), { cfg: C.checkInConfig({ repeatMin: 20, withLiveWorkMin: 20 }) })).toBeNull();
  });

  test('answered external (waiting on a lead that reported done) repeats too; no report repeats only while work is listed', () => {
    expect(block(answered(59, 'external'))).toBe('asked');
    expect(block(answered(60, 'external'))).toBeNull();
    expect(why(answered(60, 'external'))).toBe('external');
    // No report in the check-in's turn. The check-in is a SYSTEM turn, so its own
    // UserPromptSubmit cleared the self-wait (session-brief foldHook): the wait is gone, as
    // in production. With work still listed it repeats as live-unreported...
    const listed = watching(60); listed.brief.wait = null; listed.brief.reporting = 'on'; listed.brief.reportAt = T - 200 * MIN;
    const a = answered(60, null, 1, listed);
    expect(a.brief.wait).toBeNull();
    expect(block(a)).toBeNull();
    expect(why(a)).toBe('live-unreported');
    // ...with nothing alive, no reading applies: never asked again (a no-report finish).
    const bare = candidate(60); bare.brief.wait = null; bare.brief.reporting = 'on'; bare.brief.reportAt = T - 200 * MIN;
    expect(block(answered(6000, null, 1, bare))).toBe('not-stale');
  });

  test('never repeats after a wait on the owner, done, an Esc, or a check-in that never landed', () => {
    for (const on of ['you', 'done']) {
      const rec = { ...C.startRecord(T - 600 * MIN, 61), deliveredAt: T - 599 * MIN, endedAt: T - 598 * MIN, answer: { on, what: 'x' } };
      expect(C.repeatDue(rec, T)).toBe(false); // the gate itself, apart from the reading
    }
    const esc = { ...C.startRecord(T - 600 * MIN, 61), deliveredAt: T - 599 * MIN, endedAt: null, answer: null };
    expect(C.repeatDue(esc, T)).toBe(false);
    const r = candidate(600);
    expect(block({ ...r, brief: { ...r.brief, checkIn: esc, turnAt: T - 599 * MIN, stoppedAt: T - 610 * MIN } })).toBe('asked');
    const lost = C.startRecord(T - 600 * MIN, 61);
    expect(C.repeatDue(lost, T)).toBe(false);
    expect(block({ ...r, brief: { ...r.brief, checkIn: lost } })).toBe('asked');
    // The same records with an answer that may repeat ARE due: the negatives above are the gate's.
    expect(C.repeatDue({ ...esc, endedAt: T - 598 * MIN, answer: { on: 'self', what: 'x' } }, T)).toBe(true);
  });

  test('a repeat due also passes the cheap pre-filter; a real turn still ends the period', () => {
    const ended = T - 61 * MIN;
    const rec = { ...C.startRecord(ended - 2 * MIN, 61, 'long-self'), deliveredAt: ended - MIN, endedAt: ended, answer: { on: 'self', what: 'x' } };
    const e = { turnAt: ended - MIN, stoppedAt: ended, reported: { at: ended - 1000, wait: { on: 'self', what: 'x', at: ended - 1000 } }, checkIn: rec };
    expect(C.worthReading(e, { now: T })).toBe(true);
    expect(C.worthReading(e, { now: T - 2 * MIN })).toBe(false); // repeat not due yet
    // A later turn (a person, a notification): the period is over, the count starts again.
    expect(C.periodOpen(rec, T - 30 * MIN)).toBe(false);
  });

  test('the count travels: record, published field, log line; an older record counts as the first', () => {
    expect(C.startRecord(T, 61).n).toBe(1);
    expect(C.startRecord(T, 61, 'external', 3).n).toBe(3);
    expect(C.publicRecord(C.startRecord(T, 61, 'external', 3)).n).toBe(3);
    expect(C.logRecord('sent', 's1', C.startRecord(T, 61, 'long-self', 2), T)).toMatchObject({ n: 2, why: 'long-self' });
    const old = { sentAt: T, idleMin: 61, why: 'long-self', deliveredAt: null, endedAt: null, answer: null };
    expect(C.askCount(old)).toBe(1);
    expect(C.publicRecord(old).n).toBe(1);
    expect(C.checkInConfig({ repeatMin: 0 }).repeatMin).toBe(60);
    expect(C.checkInConfig({ maxPerPeriod: 'x' }).maxPerPeriod).toBe(4);
    expect(C.checkInConfig({ maxPerPeriod: 2.7 }).maxPerPeriod).toBe(2);
  });

  test('the skip log keeps the gates that refused, not "no reading yet"', () => {
    for (const r of ['not-stale', 'recent']) expect(C.skipWorthLogging(r)).toBe(false);
    for (const r of ['cannot-tell', 'typing', 'asked', 'handed-off', 'not-ready', 'menu', 'capped', 'api-error', 'waiting']) {
      expect(C.skipWorthLogging(r)).toBe(true);
    }
    expect(C.skipWorthLogging(null)).toBe(false);
  });
});
