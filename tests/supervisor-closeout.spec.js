// @ts-check
// #469 - supervisor phase 4, the pure rules: R5's close-out plan (ask, close, mark ready,
// Needs you), the session's answer as state, what new work clears it, the gated close every
// server re-checks before the kill, the gated prompt's template, and how the journal state
// reads the plan. Each negative mutates ONE gate of its positive, so a pass names the gate.
const { test, expect } = require('@playwright/test');
const co = require('../lib/closeout');
const sup = require('../lib/supervisor');
const brief = require('../lib/session-brief');
const safePrompt = require('../lib/safe-prompt');
const workItems = require('../lib/work-items');
const { oneLine } = require('../lib/one-line');
const cases = require('../lib/supervisor-cases');

const T0 = Date.parse('2026-11-16T10:00:00Z');
const MIN = 60 * 1000;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = co.closeoutConfig(null);

/** A done session as the graph holds it, idle since T0. */
const done = (n, over = {}) => ({
  id: id(n), server: 'alpha', name: `s${n}`, status: 'idle', clients: 0, liveWork: 0, compacting: false, waitingFor: null,
  capped: false, role: null, by: 'agent', favorite: false, children: [], closeout: null,
  turnAt: T0 - 2 * MIN, stoppedAt: T0, reportAt: T0, wait: { on: 'done', what: 'finished', at: T0 }, ...over,
});
const plan = (nodes, now, extra = {}) => co.closeoutPlan({ graph: { nodes, complete: true }, asks: {}, now, cfg: CFG, ...extra });
const clean = (at) => ({ askedAt: at - MIN, state: 'clean', left: '', at });

test.describe('#469 R5: the close-out plan (lib/closeout.js closeoutPlan)', () => {
  test('a done, idle, unwatched session is asked once it has settled askAfterMin', () => {
    const p = plan([done(1)], T0 + CFG.askAfterMs);
    expect(p.ask).toEqual([{ key: `closeout|${id(1)}|${T0}`, id: id(1), server: 'alpha', name: 's1', expectWaitAt: T0 }]);
    expect(p.ready).toEqual([]);
    // One gate at a time: still settling, not done, working, watched, live work, compacting,
    // owing an answer, capped, the dispatcher itself, skipped.
    expect(plan([done(1)], T0 + CFG.askAfterMs - 1).ask).toEqual([]);
    expect(plan([done(1)], T0 + CFG.askAfterMs - 1).why[id(1)]).toBe('settling');
    for (const over of [{ wait: { on: 'self', what: 'x', at: T0 } }, { wait: null }, { status: 'working' }, { clients: 1 }, { liveWork: 1 },
      { compacting: true }, { waitingFor: 'answer' }, { capped: true }, { role: 'supervisor' }, { openAsks: 1 }]) {
      expect(plan([done(1, over)], T0 + CFG.askAfterMs).ask, JSON.stringify(over)).toEqual([]);
    }
    expect(plan([done(1)], T0 + CFG.askAfterMs, { skip: new Set([id(1)]) }).ask).toEqual([]);
  });

  test('asked, it waits for the answer; no answer in answerMin is the owner\'s', () => {
    const asked = done(1, { closeout: { askedAt: T0 + MIN, state: null, left: '', at: null } });
    expect(plan([asked], T0 + MIN + CFG.answerMs)).toMatchObject({ ask: [], needs: [], why: { [id(1)]: 'asked' } });
    const late = plan([asked], T0 + MIN + CFG.answerMs + 1);
    expect(late.needs).toEqual([expect.objectContaining({ id: id(1), why: 'no-answer', key: `closeout|${id(1)}|${T0 + MIN}` })]);
    expect(late.ready).toEqual([]);
  });

  test('asked maxAsks times in 24 h with no clean answer goes to the owner instead of a fourth ask', () => {
    const asks = { [id(1)]: [T0 - 3 * 60 * MIN, T0 - 2 * 60 * MIN, T0 - 60 * MIN] };
    const p = plan([done(1)], T0 + CFG.askAfterMs, { asks });
    expect(p.ask).toEqual([]);
    expect(p.needs).toEqual([expect.objectContaining({ why: 'no-clean-answer', key: `closeout|${id(1)}|asks` })]);
    // Mutate the count: one ask fewer, or one aged out of the day, and it is asked again.
    expect(plan([done(1)], T0 + CFG.askAfterMs, { asks: { [id(1)]: asks[id(1)].slice(1) } }).ask).toHaveLength(1);
    expect(plan([done(1)], T0 + CFG.askAfterMs, { asks: { [id(1)]: [T0 - 25 * 60 * MIN, ...asks[id(1)].slice(1)] } }).ask).toHaveLength(1);
  });

  test('blocked is the owner\'s, with what is left; never a close', () => {
    const p = plan([done(1, { closeout: { askedAt: T0, state: 'blocked', left: 'a branch to push', at: T0 + MIN } })], T0 + 60 * MIN);
    expect(p.needs).toEqual([expect.objectContaining({ why: 'blocked', left: 'a branch to push' })]);
    expect(p.close).toEqual([]);
    expect(p.ready).toEqual([]);
  });

  test('clean, an agent\'s session closes once quiet closeAfterMin; each gate holds it', () => {
    const at = T0 + MIN;
    const due = at + CFG.closeAfterMs;
    const p = plan([done(1, { closeout: clean(at) })], due);
    expect(p.close).toEqual([{ key: `close|${id(1)}|${at}`, id: id(1), server: 'alpha', name: 's1', closeoutAt: at }]);
    expect(p.ready).toEqual([id(1)]);
    const held = (over, now = due) => { const q = plan([done(1, { closeout: clean(at), ...over })], now); return q.close.length ? null : q.why[id(1)]; };
    expect(held({}, due - 1)).toBe('quiet-wait');
    // A report after the answer (the close-out turn reporting done again) restarts the quiet.
    expect(held({ reportAt: at + 2 * MIN, wait: { on: 'done', what: 'x', at: at + 2 * MIN } })).toBe('quiet-wait');
    expect(held({ by: 'human' })).toBe('owner');
    expect(held({ by: null })).toBe('owner'); // opener not known: the owner's, never closed
    expect(held({ favorite: true })).toBe('favorite');
    expect(held({ children: [id(2)] })).toBe('live-child'); // children close before their lead
    expect(co.closeoutPlan({ graph: { nodes: [done(1, { closeout: clean(at) })], complete: true }, now: due, cfg: { ...CFG, close: false } }).why[id(1)]).toBe('close-off');
    // A scan some server did not answer cannot say the lead has no child there: no close
    // (fails closed); it is still marked ready, and an unasked session is still asked.
    const part = co.closeoutPlan({ graph: { nodes: [done(1, { closeout: clean(at) }), done(2)], complete: false }, asks: {}, now: due, cfg: CFG });
    expect(part.close).toEqual([]);
    expect(part.why[id(1)]).toBe('incomplete-scan');
    expect(part.ready).toEqual([id(1)]);
    expect(part.ask.map((x) => x.id)).toEqual([id(2)]);
    expect(co.closeoutPlan({ graph: { nodes: [done(1, { closeout: clean(at) })] }, now: due, cfg: CFG }).why[id(1)]).toBe('incomplete-scan');
  });

  test('the dispatcher\'s close verb holds wherever R5 would: off, close off, quiet wait, incomplete scan', () => {
    const at = T0 + MIN;
    const due = at + CFG.closeAfterMs;
    const n = done(1, { closeout: clean(at) });
    const v = (over = {}, o = {}) => co.dispatcherClose(over === null ? null : { ...n, ...over }, { complete: true, now: due, cfg: CFG, ...o });
    expect(v().close).toEqual({ key: `close|${id(1)}|${at}`, id: id(1), server: 'alpha', name: 's1', closeoutAt: at });
    expect(v({}, { cfg: co.closeoutConfig({ enabled: false }) }).why).toBe('closeout-off');
    expect(v({}, { cfg: co.closeoutConfig({ close: false }) }).why).toBe('close-off');
    expect(v({}, { now: due - 1 }).why).toBe('quiet-wait');
    expect(v({}, { complete: false }).why).toBe('incomplete-scan');
    expect(v({ favorite: true }).why).toBe('favorite');
    expect(v({ children: [id(2)] }).why).toBe('live-child');
    expect(v({ status: 'working' }).why).toBe('not-due');
    expect(v(null).why).toBe('not-due');
  });

  test('the owner\'s clean session is marked ready to close and never closed, however long it waits', () => {
    const p = plan([done(1, { by: 'human', closeout: clean(T0) })], T0 + 30 * 24 * 60 * MIN);
    expect(p).toMatchObject({ close: [], ready: [id(1)], needs: [], ask: [] });
  });

  test('#526 a done session that holds open asks is never asked, marked ready, nor closed: closing would drop them', () => {
    const later = T0 + 30 * 24 * 60 * MIN;
    const holding = (over = {}) => done(1, { openAsks: 2, closeout: clean(T0), ...over });
    expect(plan([holding({ closeout: null })], T0 + CFG.askAfterMs)).toMatchObject({ ask: [], close: [], ready: [] });
    expect(plan([holding()], later)).toMatchObject({ ask: [], close: [], ready: [] });
    expect(plan([holding({ by: 'human' })], later)).toMatchObject({ ask: [], close: [], ready: [] });
    // The dispatcher's own close verb holds the same, whatever the plan says of the rest.
    expect(co.dispatcherClose(holding(), { complete: true, now: later, cfg: CFG }).close).toBeUndefined();
    // Answered (the list is empty again), the same session closes as before.
    expect(plan([holding({ openAsks: 0 })], later).close).toHaveLength(1);
  });

  test('switched off, nothing is asked or closed, and ready-to-close is the plain done-and-idle', () => {
    const off = co.closeoutConfig({ enabled: false });
    const p = co.closeoutPlan({ graph: { nodes: [done(1), done(2, { closeout: clean(T0) })], complete: true }, now: T0 + 60 * MIN, cfg: off });
    expect(p).toMatchObject({ ask: [], close: [], ready: [id(1), id(2)] });
  });

  test('config: defaults, bounds, and the minute seam', () => {
    expect(CFG).toEqual({ enabled: true, close: true, askAfterMs: 5 * MIN, answerMs: 60 * MIN, closeAfterMs: 15 * MIN, maxAsks: 3 });
    expect(co.closeoutConfig({ askAfterMin: -4, answerMin: 1, closeAfterMin: 0, maxAsks: 99 })).toMatchObject({ askAfterMs: 0, answerMs: 5 * MIN, closeAfterMs: MIN, maxAsks: 10 });
    expect(co.closeoutConfig({ closeAfterMin: 2 }, 300).closeAfterMs).toBe(600);
    expect(co.closeoutConfig('junk')).toEqual(CFG);
  });
});

test.describe('#469 the close-out answer is state, and new work clears it', () => {
  test('answerOf: clean or blocked-with-what-is-left, for a done session only', () => {
    const d = { on: 'done', what: 'x', at: T0 };
    expect(co.answerOf({ state: 'clean' }, d)).toEqual({ answer: { state: 'clean', left: '' } });
    expect(co.answerOf({ state: 'blocked', left: 'push\nthe branch' }, d)).toEqual({ answer: { state: 'blocked', left: 'push the branch' } });
    expect(co.answerOf({ state: 'blocked' }, d).error).toMatch(/what is left/);
    expect(co.answerOf({ state: 'maybe' }, d).error).toMatch(/clean, blocked/);
    expect(co.answerOf({ state: 'clean' }, { on: 'self', what: 'x', at: T0 }).error).toMatch(/done first/);
    expect(co.answerOf({ state: 'clean' }, null).error).toMatch(/done first/);
    expect(co.answerOf([], d).error).toMatch(/object/);
  });

  test('the record: asked, then answered; a row\'s copy is validated', () => {
    const a = co.askedRecord(T0);
    expect(co.recordOf(a)).toEqual({ askedAt: T0, state: null, left: '', at: null });
    const r = co.applyAnswer(a, { state: 'clean', left: '' }, T0 + MIN);
    expect(co.recordOf(r)).toEqual({ askedAt: T0, state: 'clean', left: '', at: T0 + MIN });
    // Closed out on its own, never asked: kept.
    expect(co.recordOf(co.applyAnswer(null, { state: 'clean', left: '' }, T0))).toEqual({ askedAt: null, state: 'clean', left: '', at: T0 });
    expect(co.recordOf({ state: 'clean' })).toBeNull(); // an answer with no time is no answer
    expect(co.recordOf({ askedAt: 'x', state: 'nope', at: 5 })).toBeNull();
    expect(co.recordOf(null)).toBeNull();
  });

  test('a typed prompt and a report of a non-done wait clear it; a report of done, or of no wait, keeps it', () => {
    const entry = { ...brief.emptyEntry(), reported: { items: [], headline: 'h', at: T0, wait: { on: 'done', what: 'x', at: T0 } }, closeout: clean(T0 + MIN) };
    const rep = (wait) => brief.applyReport(entry, { items: [{ ref: '#1', title: 't', state: 'done' }], headline: 'h', wait }, T0 + 2 * MIN);
    expect(rep({ on: 'done', what: 'again' }).closeout).toEqual(entry.closeout);
    expect(rep(null).closeout).toEqual(entry.closeout);
    expect(rep({ on: 'self', what: 'the build' }).closeout).toBeUndefined();
    expect(rep({ on: 'you', what: 'a choice' }).closeout).toBeUndefined();
    expect(brief.foldHook(entry, 'UserPromptSubmit', { prompt: 'one more thing' }, T0 + 2 * MIN).closeout).toBeUndefined();
    // The close-out's own turn (a system turn) keeps the OPEN ask: the answer comes after it.
    const asked = { ...entry, closeout: co.askedRecord(T0 + MIN) };
    expect(brief.foldHook(asked, 'UserPromptSubmit', { prompt: '[web-terminal supervisor] Close-out: you reported done.' }, T0 + 2 * MIN).closeout).toEqual(asked.closeout);
    // Any turn after the ANSWER - nobody typed it (a task notification, a Monitor event, a
    // supervisor prompt) - is work the answer did not audit: the clean answer is gone.
    expect(brief.foldHook(entry, 'UserPromptSubmit', { prompt: '<task-notification>the build finished</task-notification>' }, T0 + 2 * MIN).closeout).toBeUndefined();
    expect(brief.foldHook(entry, 'UserPromptSubmit', { prompt: '[web-terminal supervisor] Close-out: you reported done.' }, T0 + 2 * MIN).closeout).toBeUndefined();
    expect(co.clearedBy('turn', null, co.askedRecord(T0))).toBe(false);
    expect(co.clearedBy('turn', null, clean(T0))).toBe(true);
    expect(co.clearedBy('turn', null, null)).toBe(false);
    // The brief publishes it, validated.
    expect(brief.buildBrief(entry, { reporting: true }).closeout).toEqual(co.recordOf(entry.closeout));
    expect(brief.buildBrief(brief.emptyEntry(), { reporting: true }).closeout).toBeNull();
  });

  test('the graph node carries it, validated, and the favourite flag', () => {
    const row = { id: id(1), status: 'idle', favorite: true, spawn: { by: 'agent' }, brief: { closeout: { askedAt: T0, state: 'clean', left: '', at: T0 + 1, junk: 1 } } };
    const n = sup.nodeOf(row, 'alpha');
    expect(n.closeout).toEqual({ askedAt: T0, state: 'clean', left: '', at: T0 + 1 });
    expect(n.favorite).toBe(true);
    // #526 - the open asks the brief carries, counted only when they are objects.
    expect(sup.nodeOf({ ...row, brief: { asks: [{ question: 'q' }, 'junk', null, { question: 'r' }] } }, 'alpha').openAsks).toBe(2);
    expect(sup.nodeOf({ ...row, brief: {} }, 'alpha').openAsks).toBe(0);
    expect(sup.nodeOf({ ...row, favorite: 'yes', brief: {} }, 'alpha')).toMatchObject({ closeout: null, favorite: false });
  });
});

test.describe('#469 the gated close, re-checked by the session\'s own server (closeRefusal)', () => {
  const ok = () => ({
    row: { status: 'idle', compacting: false, clients: 0 },
    brief: { reported: { wait: { on: 'done', what: 'x', at: T0 } }, closeout: clean(T0 + MIN) },
    by: 'agent', viewers: 0, favorite: false, work: [], hold: false, handoff: null, closeoutAt: T0 + MIN, typing: false, children: 0,
  });
  test('every gate, one at a time', () => {
    expect(co.closeRefusal(ok())).toBeNull();
    const why = (patch) => co.closeRefusal({ ...ok(), ...patch });
    expect(why({ hold: true })).toBe('restart-hold');
    expect(why({ handoff: 'handoff' })).toBe('handoff');
    expect(why({ by: 'human' })).toBe('owner');
    expect(why({ by: null })).toBe('owner');
    expect(why({ brief: { ...ok().brief, reported: { wait: { on: 'self', what: 'x', at: T0 } } } })).toBe('not-done');
    expect(why({ brief: { ...ok().brief, closeout: { askedAt: T0, state: 'blocked', left: 'x', at: T0 + MIN } } })).toBe('not-clean');
    expect(why({ brief: { ...ok().brief, closeout: co.askedRecord(T0) } })).toBe('not-clean');
    expect(why({ closeoutAt: T0 + 2 * MIN })).toBe('stale'); // a newer answer than the one acted on
    expect(why({ closeoutAt: undefined })).toBe('stale');
    // A turn begun after the answer (the brief's turnAt) is work it did not audit.
    expect(why({ brief: { ...ok().brief, turnAt: T0 + 2 * MIN } })).toBe('stale');
    expect(why({ brief: { ...ok().brief, turnAt: T0 } })).toBeNull(); // the close-out's own turn
    expect(why({ row: { status: 'working', clients: 0 } })).toBe('not-idle');
    expect(why({ row: { status: 'idle', compacting: true, clients: 0 } })).toBe('compacting');
    expect(why({ viewers: 1 })).toBe('viewer');
    expect(why({ viewers: undefined })).toBe('viewer'); // not counted is not an empty room
    expect(why({ row: { status: 'idle', clients: 1 } })).toBe('viewer'); // a background socket counts
    expect(why({ favorite: true })).toBe('favorite');
    expect(why({ typing: true })).toBe('typing');
    expect(why({ children: 1 })).toBe('live-child');
    expect(why({ work: null })).toBe('work-unknown');
    expect(why({ work: [{ kind: 'command' }] })).toBe('live-work');
    // #526 - decisions it still holds for the owner: the session's own server refuses too.
    expect(why({ brief: { ...ok().brief, reported: { ...ok().brief.reported, asks: [{ question: 'q' }] } } })).toBe('open-asks');
    expect(why({ brief: { ...ok().brief, reported: { ...ok().brief.reported, asks: [] } } })).toBeNull();
  });

  test('the ask\'s own gate: still done, and not already asked', () => {
    const b = { reported: { wait: { on: 'done', what: 'x', at: T0 } } };
    expect(co.askRefusal(b)).toBeNull();
    expect(co.askRefusal({ reported: { wait: { on: 'self', what: 'x', at: T0 } } })).toBe('not-done');
    expect(co.askRefusal({ ...b, reported: { ...b.reported, asks: [{ question: 'q' }] } })).toBe('open-asks'); // #526
    expect(co.askRefusal({ ...b, closeout: co.askedRecord(T0) })).toBe('asked');
    expect(co.askRefusal(null)).toBe('not-done');
  });
});

test.describe('#543 clean means the subject is finished in full; a shared PR keeps one owner open', () => {
  const d = { on: 'done', what: 'x', at: T0 };
  const ME = id(1);
  /** Clean, naming [owner] as the session that owns the still-open shared PR #9. */
  const shared = (at, owner) => ({ ...clean(at), pr: '#9', owner });
  const owner = (n, over = {}) => ({ ...done(n), wait: { on: 'self', what: 'watching PR #9', at: T0 }, name: `owner${n}`, replaces: [], ...over });

  test('answerOf: a shared PR needs both refs and goes with clean; naming yourself is not clean', () => {
    expect(co.answerOf({ state: 'clean', pr: '#9', owner: id(2) }, d, ME)).toEqual({ answer: { state: 'clean', left: '', pr: '#9', owner: id(2) } });
    expect(co.answerOf({ state: 'clean', pr: ' #9\n', owner: 'the\nwatcher' }, d, ME).answer).toMatchObject({ pr: '#9', owner: 'the watcher' });
    // A PR the session owns, still open, is never clean: refused, nothing recorded.
    expect(co.answerOf({ state: 'clean', pr: '#9', owner: ME }, d, ME).error).toMatch(/you own still open is not clean/);
    expect(co.answerOf({ state: 'clean', pr: '#9' }, d, ME).error).toMatch(/needs both/);
    expect(co.answerOf({ state: 'clean', owner: id(2) }, d, ME).error).toMatch(/needs both/);
    expect(co.answerOf({ state: 'blocked', left: 'x', pr: '#9', owner: id(2) }, d, ME).error).toMatch(/go with clean/);
    expect(co.answerOf({ state: 'clean', pr: 9, owner: id(2) }, d, ME).error).toMatch(/strings/);
    // Without them, as before: no pr, no owner on the answer.
    expect(co.answerOf({ state: 'clean' }, d, ME)).toEqual({ answer: { state: 'clean', left: '' } });
  });

  test('the record carries the shared PR and its owner, for a clean answer only', () => {
    const r = co.applyAnswer(co.askedRecord(T0), { state: 'clean', left: '', pr: '#9', owner: id(2) }, T0 + MIN);
    expect(co.recordOf(r)).toEqual({ askedAt: T0, state: 'clean', left: '', at: T0 + MIN, pr: '#9', owner: id(2) });
    expect(co.recordOf({ ...r, state: 'blocked', left: 'x' })).toEqual({ askedAt: T0, state: 'blocked', left: 'x', at: T0 + MIN });
    expect(co.recordOf({ ...r, owner: '' })).toEqual({ askedAt: T0, state: 'clean', left: '', at: T0 + MIN });
    // The graph node keeps it (a peer's row is data: validated on the way).
    const n = sup.nodeOf({ id: ME, status: 'idle', brief: { closeout: { ...r, pr: `#9\u2028${'x'.repeat(200)}` } } }, 'alpha');
    expect(n.closeout.owner).toBe(id(2));
    expect(n.closeout.pr.length).toBe(co.REF_MAX);
  });

  test('ready to close only while the named owner is a live session: by id, a replaces alias, or a unique name', () => {
    const at = T0 + MIN;
    const due = at + CFG.closeAfterMs;
    const me = (o) => done(1, { closeout: shared(at, o) });
    for (const [label, o, nodes] of [['id', id(2), [owner(2)]], ['alias', id(7), [owner(2, { replaces: [id(7)] })]], ['name', 'owner2', [owner(2)]]]) {
      const p = plan([me(o), ...nodes], due);
      expect(p.ready, label).toEqual([ME]);
      expect(p.close.map((x) => x.id), label).toEqual([ME]);
      expect(p.needs, label).toEqual([]);
    }
    // The owner is gone (a complete scan): the owner's, with what is open - never ready, never closed.
    const gone = plan([me(id(2))], due);
    expect(gone.ready).toEqual([]);
    expect(gone.close).toEqual([]);
    expect(gone.needs).toEqual([expect.objectContaining({ id: ME, why: 'owner-gone', key: `closeout|${ME}|${at}` })]);
    expect(gone.needs[0].left).toMatch(/PR #9 is still open and its owner ".+" is not a running session/);
    // A name two sessions carry names nobody.
    expect(plan([me('owner2'), owner(2), owner(3, { name: 'owner2' })], due).needs.map((x) => x.why)).toEqual(['owner-gone']);
    // A scan some server did not answer cannot say the owner is gone: held, asked of nobody.
    const part = co.closeoutPlan({ graph: { nodes: [me(id(2))], complete: false }, asks: {}, now: due, cfg: CFG });
    expect(part).toMatchObject({ ready: [], close: [], needs: [], why: { [ME]: 'owner-unknown' } });
    // Named itself by its name (the id is refused at the answer): it owns the open PR.
    const self = plan([done(1, { name: 'me', closeout: shared(at, 'me') })], due);
    expect(self.ready).toEqual([]);
    expect(self.needs).toEqual([expect.objectContaining({ id: ME, why: 'owns-pr' })]);
    // #543 review: an owner that reported done watches nothing. Two sessions naming each other
    // would otherwise both close and leave the PR with no owner; the owner that finished is
    // asked to check it, and neither sharer is ready or closed.
    const mutual = plan([me(id(2)), done(2, { closeout: shared(at, ME) })], due);
    expect(mutual.ready).toEqual([]);
    expect(mutual.close).toEqual([]);
    expect(mutual.needs.map((x) => [x.id, x.why])).toEqual([[ME, 'owner-done'], [id(2), 'owner-done']]);
    expect(plan([me(id(2)), owner(2, { wait: { on: 'done', what: 'merged', at: T0 } })], due).needs.map((x) => x.why)).toEqual(['owner-done']);
    // The dispatcher is always live, and watches no PR: naming it is naming nobody.
    expect(plan([me(id(2)), owner(2, { role: 'supervisor' })], due).needs.map((x) => x.why)).toEqual(['owner-gone']);
    // The owner's own session (never closed) is not marked ready either while its owner is gone.
    expect(plan([done(1, { by: 'human', closeout: shared(at, id(2)) })], due).ready).toEqual([]);
  });

  test('the dispatcher\'s close verb looks the owner up in the whole last scan', () => {
    const at = T0 + MIN;
    const due = at + CFG.closeAfterMs;
    const n = done(1, { closeout: shared(at, id(2)) });
    expect(co.dispatcherClose(n, { complete: true, now: due, cfg: CFG, peers: [n, owner(2)] }).close).toMatchObject({ id: ME, closeoutAt: at });
    expect(co.dispatcherClose(n, { complete: true, now: due, cfg: CFG, peers: [n] }).close).toBeUndefined();
    expect(co.dispatcherClose(n, { complete: true, now: due, cfg: CFG }).close).toBeUndefined();
  });

  test('stateOf: a clean close-out whose PR owner is gone is in Needs you, not Ready to close', () => {
    const g = sup.buildGraph([{ name: 'alpha', ok: true, sessions: [
      { id: ME, status: 'idle', clients: 0, spawn: { by: 'agent' }, brief: { wait: { on: 'done', what: 'x', at: T0 }, closeout: shared(T0 + MIN, id(2)) } },
    ] }], T0);
    const closeout = co.closeoutPlan({ graph: g, asks: {}, now: T0 + 2 * MIN, cfg: CFG });
    const st = sup.stateOf({ graph: g, verdicts: {}, journal: [], cfg: sup.supervisorConfig(null), now: T0 + 2 * MIN, closeout });
    expect(st.readyToClose).toEqual([]);
    expect(st.needsYou).toEqual([ME]);
    expect(st.sessions[0].closeoutState).toMatchObject({ needs: 'owner-gone' });
  });
});

test.describe('#469 the close-out prompt, the template, and the journal state', () => {
  test('the prompt is built by the receiving server, names its own script once, and fits 512 bytes', () => {
    const cli = 'C:/dev/web-terminal/scripts/wt-closeout.js';
    const p = safePrompt.promptOf({ template: 'closeout', expectWaitAt: T0 }, { closeout: co.closeoutText(cli) });
    expect(p.template).toBe('closeout');
    expect(p.expectWaitAt).toBe(T0);
    expect(p.prompt.startsWith('[web-terminal supervisor] Close-out: you reported done.')).toBe(true);
    expect(p.prompt.split(cli)).toHaveLength(2);
    // #543: clean means the subject is finished in full - the prompt says what that is.
    for (const word of ['Fix what you can', 'done in full', 'merged, not just pushed', 'every PR you opened completed', 'reviews answered',
      'tracker item', 'worktree or process you started', 'Your PR still open: watch it', '--pr "<ref>" --owner <its owner>', 'clean', 'blocked']) expect(p.prompt).toContain(word);
    expect(Buffer.byteLength(p.prompt, 'utf8')).toBeLessThanOrEqual(safePrompt.PROMPT_BYTES_MAX);
    // A checkout path 70 bytes longer than this one still fits (a machine whose checkout lives deeper).
    expect(Buffer.byteLength(`[web-terminal supervisor] ${co.closeoutText(`C:/dev/web-terminal${'x'.repeat(70)}/scripts/wt-closeout.js`)}`, 'utf8')).toBeLessThanOrEqual(511);
    // An unknown template, or text beside one, is refused: nothing is typed.
    expect(safePrompt.promptOf({ template: 'rm' }, { closeout: 'x' }).error).toMatch(/template must be one of: closeout/);
    expect(safePrompt.promptOf({ template: 'closeout', text: 'x' }, { closeout: 'x' }).error).toMatch(/not both/);
    expect(safePrompt.promptOf({ template: 'closeout' }).error).toMatch(/template must be one of/);
    expect(safePrompt.promptOf({ template: '__proto__' }, { closeout: 'x' }).error).toMatch(/template must be/);
  });

  test('stateOf: ready-to-close is the plan\'s, blocked close-outs join Needs you, each with closeoutState', () => {
    const g = sup.buildGraph([{ name: 'alpha', ok: true, sessions: [
      { id: id(1), status: 'idle', clients: 0, brief: { wait: { on: 'done', what: 'x', at: T0 } } },
      { id: id(2), status: 'idle', clients: 0, brief: { wait: { on: 'done', what: 'x', at: T0 } } },
      { id: id(3), status: 'idle', clients: 0, brief: { wait: { on: 'you', what: 'pick', at: T0 - 5 } } },
    ] }], T0);
    const closeout = { ask: [], close: [], ready: [id(1)], needs: [{ id: id(2), why: 'blocked', left: 'a branch' }], why: {} };
    const st = sup.stateOf({ graph: g, verdicts: {}, journal: [], cfg: sup.supervisorConfig(null), now: T0, closeout });
    expect(st.readyToClose).toEqual([id(1)]);
    expect(st.needsYou).toEqual([id(3), id(2)]);
    expect(st.live).toEqual([]);
    expect(st.sessions.find((n) => n.id === id(2)).closeoutState).toEqual({ needs: 'blocked', left: 'a branch' });
    // Without a plan (R5 not run yet): phase 1's done-and-idle, so the page never empties.
    const plain = sup.stateOf({ graph: g, verdicts: {}, journal: [], cfg: sup.supervisorConfig(null), now: T0 });
    expect(plain.readyToClose).toEqual([id(1), id(2)]);
    // Mutate the plan's ready: a session the plan does not mark is not ready, it is live.
    const none = sup.stateOf({ graph: g, verdicts: {}, journal: [], cfg: sup.supervisorConfig(null), now: T0, closeout: { ...closeout, ready: [], needs: [] } });
    expect(none.readyToClose).toEqual([]);
    expect(none.live).toEqual([id(1), id(2)]);
  });

  test('the journal names how it ended: closed-out', () => {
    expect(workItems.endEvent({ killedHow: 'closed-out' })).toBe('closed-out');
    expect(workItems.END_EVENTS).toContain('closed-out');
    expect(workItems.endEvent({ killedHow: 'something' })).toBe('exited');
  });

  test('oneLine moved to lib/one-line.js and supervisor-cases still folds the same way', () => {
    const s = `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(7)}c   d`;
    expect(oneLine(s, 20)).toBe('a b c d');
    expect(cases.caseText(s, 20)).toBe('a b c d');
  });
});
