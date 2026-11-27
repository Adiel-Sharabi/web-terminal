// @ts-check
// #567 - lib/mc-board.js: the work board (step 1, read-only). Pure, from SYNTHETIC subjects and efforts (the
// shapes lib/mc-subjects.js and lib/mc-efforts.js serve). The route is pinned in mc-board-routes.spec.js.
// Each gate below was mutated once to see its test fail.
const { test, expect } = require('@playwright/test');
const B = require('../lib/mc-board');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** One subject as lib/mc-subjects.js buildView serves it (only the fields the board reads). */
function subject(key, { title = `Title of ${key}`, stage = null, station = null, history = [], live = [], closedSessions = [], meta = {}, buckets = [],
  project = null, line = null, bound = false, reported = true } = {}) {
  const ref = (id, closed) => ({ server: 'alpha', id, name: `session ${id}`, status: 'idle', closed, bound,
    lastReport: { state: reported ? 'in-progress' : null, stage: null, note: null, headline: null, at: NOW - MIN }, wait: null });
  return {
    key, ref: key, url: `https://t.example.test/${key}`, title, project, area: null, meta: { key, closed: false, ...meta },
    stage: { current: stage, reported: null, evidence: null, station, history },
    sessions: [...live.map((id) => ref(id, false)), ...closedSessions.map((id) => ref(id, true))],
    needsYou: null, waitsOn: null, buckets, runId: null, updatedAt: NOW - MIN, line,
  };
}
const step = (stage, at, source = 'report') => ({ stage, at, source, detail: null });
/** The efforts view, reduced to what the board reads: per-session verdicts and the cards that owe an answer. */
const efforts = ({ sessions = [], needsYou = [], complete = true } = {}) => ({ efforts: [{ id: 'lead', sessions, needsYou }], complete });
const verdict = (kind, text, at = NOW - 10 * MIN, rule = 'R1') => ({ kind, rule, text, at });
const board = (o) => B.buildBoard({ efforts: efforts(), subjects: [], candidates: [], projects: [], now: NOW, ...o });
const col = (b, id) => b.columns.find((c) => c.id === id);
const keys = (b, id) => col(b, id).cards.map((c) => c.key);

test.describe('#567 board: which column a work item is in (evidence only, furthest wins)', () => {
  test('a live session on an item with no later evidence -> In progress', () => {
    const b = board({ subjects: [subject('acme/widgets#1', { stage: 'fixing', live: ['s1'] })] });
    expect(keys(b, 'in-progress')).toEqual(['acme/widgets#1']);
    expect(col(b, 'in-progress').cards[0]).toMatchObject({ live: true, sessions: [{ id: 's1', server: 'alpha' }] });
    expect(['pr-review', 'committed-merged', 'ready-for-test'].flatMap((c) => keys(b, c))).toEqual([]);
  });

  test('an open PR (stage pr-open or in-review) -> PR / in review, even while its session is still on it', () => {
    const b = board({ subjects: [subject('acme/widgets#2', { stage: 'pr-open', live: ['s1'] }), subject('acme/widgets#3', { stage: 'in-review' })] });
    expect(keys(b, 'pr-review').sort()).toEqual(['acme/widgets#2', 'acme/widgets#3']);
    expect(keys(b, 'in-progress')).toEqual([]);
  });

  test('a merged PR on an open GitHub item (stage merged) -> Committed / merged', () => {
    const b = board({ subjects: [subject('acme/widgets#4', { stage: 'merged' })] });
    expect(keys(b, 'committed-merged')).toEqual(['acme/widgets#4']);
  });

  test('the ADO station is the authority: Ready for test, Committed and Merged each land in their own column', () => {
    const b = board({ subjects: [
      subject('ado:1', { stage: 'merged', station: 'Ready for test' }), // its stage says merged; the station says the QA desk
      subject('ado:2', { stage: 'pr-open', station: 'Committed' }), // the stage is capped at pr-open; the board's column is Committed
      subject('ado:3', { stage: 'merged', station: 'Merged' }), // an ADO Merged item's stage is merged
      subject('acme/widgets#4', { stage: 'merged', station: null }),
      subject('ado:4', { stage: 'pr-open', station: 'Parked' }), // held on a feature branch: a PR, not committed
    ] });
    expect(keys(b, 'ready-for-test')).toEqual(['ado:1']);
    expect(keys(b, 'committed-merged').sort()).toEqual(['acme/widgets#4', 'ado:2', 'ado:3']);
    expect(keys(b, 'pr-review')).toEqual(['ado:4']);
  });

  test('the station outranks what a session last reported', () => {
    const b = board({ subjects: [subject('ado:5', { stage: 'fixing', station: 'Ready for test', live: ['s1'] })] });
    expect(keys(b, 'ready-for-test')).toEqual(['ado:5']);
    expect(keys(b, 'in-progress')).toEqual([]);
  });

  test('begun with nobody on it (ADO In Progress, no live session) is In progress, shown as not live', () => {
    const b = board({ subjects: [subject('ado:6', { station: 'In Progress', stage: null, closedSessions: ['gone'] })] });
    expect(keys(b, 'in-progress')).toEqual(['ado:6']);
    expect(col(b, 'in-progress').cards[0].live).toBe(false);
  });

  test('finished work is off the board: Done, tested, closed, or every session said done', () => {
    const b = board({ subjects: [
      subject('ado:7', { station: 'Done', stage: 'tested', live: ['s1'] }),
      subject('acme/widgets#8', { stage: 'merged', meta: { closed: true } }),
      subject('acme/widgets#9', { stage: 'fixing', buckets: ['doneWeek'], closedSessions: ['gone'] }),
    ] });
    expect(b.columns.flatMap((c) => c.cards)).toEqual([]);
  });

  test('a session started from Start work that has not reported yet is In progress from birth', () => {
    const b = board({ subjects: [subject('ado:11', { bound: true, reported: false, live: ['s1'] })] });
    expect(keys(b, 'in-progress')).toEqual(['ado:11']);
  });

  test('a start binding no session ever reported on is no card (its tracker lists it as a candidate)', () => {
    const b = board({ subjects: [subject('ado:10', { bound: true, live: [] })] });
    expect(b.columns.flatMap((c) => c.cards)).toEqual([]);
  });
});

test.describe('#567 board: the wait badge is the efforts view\'s, never worked out here', () => {
  const subjects = () => [subject('ado:20', { stage: 'fixing', live: ['s1'] })];

  test('suspect, legit and unknown are the supervisor\'s verdict on the item\'s live session, text and all', () => {
    for (const kind of ['suspect', 'legit', 'unknown']) {
      const b = board({ subjects: subjects(), efforts: efforts({ sessions: [{ id: 's1', verdict: verdict(kind, `says ${kind}`) }] }) });
      expect(col(b, 'in-progress').cards[0].badge).toMatchObject({ kind, text: `says ${kind}`, rule: 'R1' });
    }
  });

  test('no verdict (the supervisor is off, or has nothing to say) is none', () => {
    const b = board({ subjects: subjects(), efforts: efforts({ sessions: [{ id: 's1', verdict: null }] }) });
    expect(col(b, 'in-progress').cards[0].badge).toMatchObject({ kind: 'none', text: '' });
  });

  test('suspect beats legit across an item\'s live sessions; the oldest suspect is named', () => {
    const s = subject('ado:21', { stage: 'fixing', live: ['a', 'b', 'c'] });
    const b = board({ subjects: [s], efforts: efforts({ sessions: [
      { id: 'a', verdict: verdict('legit', 'CI running') },
      { id: 'b', verdict: verdict('suspect', 'newer', NOW - MIN) },
      { id: 'c', verdict: verdict('suspect', 'older', NOW - 30 * MIN) },
    ] }) });
    expect(col(b, 'in-progress').cards[0].badge).toMatchObject({ kind: 'suspect', text: 'older' });
  });

  test('a card that owes the person an answer ON THIS ITEM is "you", over any verdict', () => {
    const b = board({ subjects: subjects(), efforts: efforts({
      sessions: [{ id: 's1', verdict: verdict('suspect', 'x') }],
      needsYou: [{ kind: 'wait', sessionId: 's1', subjectKey: 'ado:20', what: 'OK to re-run?', askedAt: NOW - MIN }] }) });
    expect(col(b, 'in-progress').cards[0].badge).toMatchObject({ kind: 'you', text: 'OK to re-run?' });
  });

  test('a card that is only a guess (a possible ask, an answer that may have gone elsewhere) is not "you"', () => {
    for (const guess of [{ kind: 'possible-ask' }, { kind: 'wait', maybeAnswered: true }]) {
      const b = board({ subjects: subjects(), efforts: efforts({ needsYou: [{ sessionId: 's1', subjectKey: 'ado:20', what: 'maybe', ...guess }] }) });
      expect(col(b, 'in-progress').cards[0].badge.kind, JSON.stringify(guess)).toBe('none');
    }
  });

  test('a wait that names another item is not this item\'s "you"', () => {
    const b = board({ subjects: subjects(), efforts: efforts({ needsYou: [{ kind: 'wait', sessionId: 's1', subjectKey: 'ado:999', what: 'about another', askedAt: NOW }] }) });
    expect(col(b, 'in-progress').cards[0].badge.kind).toBe('none');
  });

  test('an item nobody runs has no verdict to show: none', () => {
    const b = board({ subjects: [subject('ado:22', { station: 'Ready for test', stage: 'merged' })] });
    expect(col(b, 'ready-for-test').cards[0].badge.kind).toBe('none');
  });
});

test.describe('#567 board: the age in the column, and the order inside it', () => {
  test('where the ADO STATION decided the column, the item\'s own state change is its age (Ready for test, Committed)', () => {
    const a = subject('ado:30', { station: 'Ready for test', stage: 'merged', meta: { stateAt: NOW - 3 * DAY }, history: [step('merged', NOW - DAY, 'report')] });
    const c = subject('ado:31', { station: 'Committed', stage: 'pr-open', meta: { stateAt: NOW - 8 * DAY }, history: [step('pr-open', NOW - 2 * DAY, 'report')] });
    const g = subject('acme/widgets#31', { stage: 'pr-open', history: [step('fixing', NOW - 5 * DAY), step('pr-open', NOW - 2 * DAY)], meta: { stateAt: NOW - 20 * DAY } });
    const b = board({ subjects: [a, c, g] });
    expect(col(b, 'ready-for-test').cards[0].since).toBe(NOW - 3 * DAY);
    expect(col(b, 'committed-merged').cards[0].since).toBe(NOW - 8 * DAY);
    expect(col(b, 'pr-review').cards[0].since).toBe(NOW - 2 * DAY); // a GitHub item's is when a session reported the stage
  });

  test('where the STAGE decided the column, the station\'s change time is no age: an item In Progress for a month whose PR opened yesterday is a day old in PR / in review', () => {
    const reported = subject('ado:60', { station: 'In Progress', stage: 'pr-open', meta: { stateAt: NOW - 26 * DAY }, history: [step('fixing', NOW - 25 * DAY, 'report'), step('pr-open', NOW - DAY, 'report')] });
    const seen = subject('ado:61', { station: 'In Progress', stage: 'pr-open', meta: { stateAt: NOW - 26 * DAY }, history: [step('pr-open', NOW - 6 * MIN, 'pr')] });
    const merged = subject('ado:62', { station: 'Merged', stage: 'merged', meta: { stateAt: NOW - 9 * DAY }, history: [step('merged', NOW - 2 * DAY, 'report')] });
    const working = subject('ado:63', { station: 'In Progress', stage: 'fixing', live: ['s'], meta: { stateAt: NOW - 30 * DAY }, history: [step('fixing', NOW - 3 * DAY, 'report')] });
    const b = board({ subjects: [reported, seen, merged, working] });
    expect(col(b, 'pr-review').cards.map((c) => [c.key, c.since])).toEqual([['ado:60', NOW - DAY], ['ado:61', NOW - 6 * MIN]]); // oldest first
    expect(col(b, 'committed-merged').cards[0].since).toBe(NOW - 2 * DAY);
    expect(col(b, 'in-progress').cards[0].since).toBe(NOW - 3 * DAY);
  });

  test('with no report, the first time the tracker was seen to prove the stage is the age (a late bound); a close time is never one', () => {
    const closedAt = subject('acme/widgets#33', { stage: 'merged', history: [step('merged', NOW - DAY, 'pr')], meta: { stateAt: NOW - 4 * DAY } });
    const seenOnly = subject('acme/widgets#34', { stage: 'pr-open', history: [step('pr-open', NOW - 6 * MIN, 'pr')], meta: { stateAt: null } });
    const b = board({ subjects: [closedAt, seenOnly] });
    expect(col(b, 'committed-merged').cards[0].since).toBe(NOW - DAY);
    expect(col(b, 'pr-review').cards[0].since).toBe(NOW - 6 * MIN);
  });

  test('an unknown time is null, never a guess', () => {
    const b = board({ subjects: [subject('acme/widgets#32', { stage: 'merged', history: [] })] });
    expect(col(b, 'committed-merged').cards[0].since).toBeNull();
  });

  test('a column lists what needs the person first (you, suspect), then the oldest', () => {
    const subjects = ['k1', 'k2', 'k3', 'k4'].map((k, i) => subject(`ado:${40 + i}`, { stage: 'fixing', live: [k], history: [step('fixing', NOW - (i + 1) * DAY)] }));
    const b = board({ subjects, efforts: efforts({
      sessions: [{ id: 'k2', verdict: verdict('suspect', 's') }, { id: 'k3', verdict: verdict('legit', 'l') }],
      needsYou: [{ kind: 'wait', sessionId: 'k4', subjectKey: 'ado:43', what: 'q', askedAt: NOW }] }) });
    // ado:43 = you, ado:41 = suspect, then by badge rank: ado:42 (legit) before ado:40 (none)
    expect(keys(b, 'in-progress')).toEqual(['ado:43', 'ado:41', 'ado:42', 'ado:40']);
  });

  test('a column is capped and says how many it left out', () => {
    const subjects = Array.from({ length: B.COLUMN_CAP + 7 }, (_, i) => subject(`ado:${1000 + i}`, { stage: 'fixing', live: [`s${i}`] }));
    const c = col(board({ subjects }), 'in-progress');
    expect(c.count).toBe(B.COLUMN_CAP + 7);
    expect(c.cards).toHaveLength(B.COLUMN_CAP);
    expect(c.more).toBe(7);
  });
});

test.describe('#567 board: candidates', () => {
  const src = (over = {}) => ({ id: 'github:acme/widgets', kind: 'github', name: 'acme/widgets', project: { id: 'w', name: 'Widgets' }, own: false, dispatcher: false, ...over });
  const cand = (key, over = {}) => ({ key, ref: key, tracker: key.startsWith('ado:') ? 'ado' : 'github', repo: 'acme/widgets', adoProject: key.startsWith('ado:') ? 'Proj' : null,
    title: `T ${key}`, url: `https://t.example.test/${key}`, state: 'open', type: 'Issue', priority: null, severity: null, createdAt: NOW - DAY, ...over });
  const list = (items, over = {}) => ({ source: src(), state: 'ok', why: null, fetchedAt: NOW - MIN, total: items.length, more: false, items, ...over });

  test('the next N per source, ranked by priority, then severity, then the oldest', () => {
    const items = [
      cand('acme/widgets#1', { createdAt: NOW - 1 * DAY }),
      cand('acme/widgets#2', { createdAt: NOW - 9 * DAY }),
      cand('acme/widgets#3', { priority: 1, createdAt: NOW - 2 * DAY }),
      cand('acme/widgets#4', { priority: 1, severity: 2, createdAt: NOW - 3 * DAY }),
      cand('acme/widgets#5', { priority: 1, severity: 1, createdAt: NOW - 1 * DAY }),
    ];
    const out = board({ candidates: [list(items)], perSource: 4 }).candidates[0];
    expect(out.cards.map((c) => c.key)).toEqual(['acme/widgets#5', 'acme/widgets#4', 'acme/widgets#3', 'acme/widgets#2']);
    expect(out.cards[0]).toMatchObject({ source: { kind: 'github', name: 'acme/widgets' }, project: 'Widgets', station: 'open', badge: { kind: 'none' }, live: false, sessions: [] });
  });

  test('what ties keeps the order the tracker listed it in', () => {
    const items = ['9', '3', '7'].map((n) => cand(`acme/widgets#${n}`, { createdAt: NOW - DAY }));
    expect(board({ candidates: [list(items)] }).candidates[0].cards.map((c) => c.key)).toEqual(['acme/widgets#9', 'acme/widgets#3', 'acme/widgets#7']);
  });

  test('an item with a card on the board, or a live session, is not a candidate (and the count says so)', () => {
    const subjects = [subject('acme/widgets#1', { stage: 'pr-open' }), subject('acme/widgets#2', { stage: 'fixing', live: ['s'] }),
      subject('acme/widgets#3', { bound: true, live: ['b'] }), subject('acme/widgets#4', { stage: 'merged', meta: { closed: true } })];
    const items = ['1', '2', '3', '4', '5'].map((n) => cand(`acme/widgets#${n}`));
    const out = board({ subjects, candidates: [list(items)] }).candidates[0];
    // #1 has a card, #2 and #3 have a card and a live session; #4 is finished (no card, no session) and the tracker still lists it: shown.
    expect(out.cards.map((c) => c.key).sort()).toEqual(['acme/widgets#4', 'acme/widgets#5']);
    expect(out.hidden).toBe(3);
  });

  test('an item with a live session but no card (finished by the tracker\'s word) is still not offered as a candidate', () => {
    const subjects = [subject('acme/widgets#6', { stage: 'merged', meta: { closed: true }, live: ['s'] })];
    const out = board({ subjects, candidates: [list([cand('acme/widgets#6'), cand('acme/widgets#7')])] }).candidates[0];
    expect(board({ subjects }).columns.flatMap((c) => c.cards)).toEqual([]);
    expect(out.cards.map((c) => c.key)).toEqual(['acme/widgets#7']);
  });

  test('the bug hunter\'s queue keeps its dispatcher\'s order and claims its items from the tracker lists', () => {
    const queue = list([cand('ado:3', { queuedAt: NOW - 3 * MIN, priority: 3 }), cand('ado:1', { queuedAt: NOW - 2 * MIN, priority: 1 }), cand('ado:2', { handsOff: true })],
      { source: src({ id: 'bug-hunter:x', kind: 'bug-hunter', name: 'Bug hunter', project: null, dispatcher: true }) });
    const ado = list([cand('ado:1'), cand('ado:9', { priority: 2 }), cand('ado:2')], { source: src({ id: 'ado:proj', kind: 'ado', name: 'Proj' }) });
    const out = board({ candidates: [ado, queue] }).candidates;
    expect(out[1].cards.map((c) => c.key)).toEqual(['ado:3', 'ado:1', 'ado:2']);
    expect(out[1].cards[2].handsOff).toBe(true);
    expect(out[1].cards[0].since).toBe(NOW - 3 * MIN); // its age is the time it was queued
    expect(out[0].cards.map((c) => c.key)).toEqual(['ado:9']);
    expect(out[0].hidden).toBe(2);
  });

  test('the bug hunter claims its WHOLE queue, not only the entries whose titles were read', () => {
    const queue = list([cand('ado:1')], { source: src({ id: 'bug-hunter', kind: 'bug-hunter', name: 'Bug hunter', project: null, dispatcher: true }), claims: ['ado:1', 'ado:2', 'ado:3'], total: 3 });
    const ado = list([cand('ado:2'), cand('ado:3'), cand('ado:4')], { source: src({ id: 'ado:proj', kind: 'ado', name: 'Proj' }) });
    const out = board({ candidates: [ado, queue] }).candidates;
    expect(out[0].cards.map((c) => c.key)).toEqual(['ado:4']);
    expect(out[0].hidden).toBe(2);
    expect(out[1].cards.map((c) => c.key)).toEqual(['ado:1']); // only what was read is listed; the claim never shows a card
  });

  test('a source\'s state is passed through as the cache says it: not wired yet, loading, error, stale', () => {
    const states = ['not-wired', 'loading', 'error', 'stale', 'ok'].map((state) => list([], { state, why: `why ${state}`, fetchedAt: state === 'ok' ? NOW : null }));
    const out = board({ candidates: states }).candidates;
    expect(out.map((c) => [c.state, c.why])).toEqual([['not-wired', 'why not-wired'], ['loading', 'why loading'], ['error', 'why error'], ['stale', 'why stale'], ['ok', 'why ok']]);
    expect(out.every((c) => Array.isArray(c.cards) && c.cards.length === 0)).toBe(true);
  });

  test('refreshedAt is the latest source read; complete follows the efforts view', () => {
    const b = board({ candidates: [list([], { fetchedAt: NOW - 9 * MIN }), list([], { fetchedAt: NOW - 2 * MIN }), list([], { state: 'loading', fetchedAt: null })],
      efforts: efforts({ complete: false }) });
    expect(b.refreshedAt).toBe(NOW - 2 * MIN);
    expect(b.complete).toBe(false);
    expect(board({}).refreshedAt).toBeNull();
    expect(board({}).complete).toBe(true);
  });
});

test.describe('#567 board: the shape', () => {
  test('all four work columns are always there, in order, with their counts', () => {
    const b = board({});
    expect(b.columns.map((c) => c.id)).toEqual(['in-progress', 'pr-review', 'committed-merged', 'ready-for-test']);
    expect(b.columns.every((c) => c.count === 0 && c.more === 0 && c.cards.length === 0)).toBe(true);
    expect(b.generatedAt).toBe(NOW);
  });

  test('a card carries its source, project name, station, stage, line and live sessions', () => {
    const s = subject('ado:50', { stage: 'fixing', station: 'In Progress', live: ['s1'], project: 'am8', line: { id: 'l1', name: 'Line one' }, meta: { adoProject: 'Amadeus8Core' } });
    const c = col(board({ subjects: [s], projects: [{ id: 'am8', name: 'AM8' }] }), 'in-progress').cards[0];
    expect(c).toMatchObject({ key: 'ado:50', source: { kind: 'ado', name: 'Amadeus8Core' }, project: 'AM8', station: 'In Progress', stage: 'fixing', line: { id: 'l1', name: 'Line one' } });
    expect(c.sessions).toEqual([{ server: 'alpha', id: 's1', name: 'session s1', status: 'idle' }]);
  });
});
