// @ts-check
// Issue #138 — the rule that decides whether a session is blocked on its 5-hour
// usage cap. Pure, so it is unit-tested directly rather than through a worker.
//
// This module is the reason #137 could turn auto-resume ON by default: #69 fired
// on an elapsed timestamp alone, which cannot tell a capped session from one the
// user finished with. Every case below is a session #69 would have typed
// 'continue' into.

const { test, expect } = require('@playwright/test');
const u = require('../lib/usage-limit');

const NOW = 1_700_000_000_000;
const SOON = NOW + 5 * 60 * 1000;   // reset still ahead
const PAST = NOW - 5 * 60 * 1000;   // window already turned over

test.describe('#138 — isCapBlocked', () => {
  test('blocked: the window is spent and its reset is still ahead', () => {
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: SOON, now: NOW })).toBe(true);
  });

  test('NOT blocked at 99% — a nearly-spent window is still a usable one', () => {
    // clampPct ROUNDS, so a real 99.5%+ already arrives as 100. Anything below is
    // genuinely not exhausted, and nudging it would spend quota that was available.
    expect(u.isCapBlocked({ fiveH: 99, fiveHResetAt: SOON, now: NOW })).toBe(false);
    expect(u.isCapBlocked({ fiveH: 0, fiveHResetAt: SOON, now: NOW })).toBe(false);
  });

  // REVIEW FINDING (the serious one). This case previously asserted that a
  // just-passed reset is NOT blocked — which is precisely what made the feature
  // unreachable: the resume fires at reset+60s, so during that minute the
  // derivation said "not blocked", the poll pushed it, and the worker cancelled the
  // timer it was about to fire. For a metrics-only session (every Codex one) the
  // resume could essentially never happen.
  test('STILL blocked in the minute between the reset and the resume', () => {
    const justPassed = NOW - 30 * 1000; // reset 30s ago; resume due in 30s
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: justPassed, now: NOW, delayMs: 60000 })).toBe(true);
  });

  test('still blocked shortly after the resume was due — poll jitter must not disarm it', () => {
    const fired = NOW - 90 * 1000; // resume was due 30s ago
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: fired, now: NOW, delayMs: 60000 })).toBe(true);
  });

  test('NOT blocked once the window is long gone — a stale reading arms nothing', () => {
    expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: NOW - 3 * 60 * 60 * 1000, now: NOW })).toBe(false);
  });

  test('NOT blocked when the percentage is unknown — refuse to act on silence', () => {
    // #56 rule 3: unknown renders as nothing, never as a number. Here it must also
    // DO nothing: a missed auto-resume costs a manual click, a false one costs quota.
    for (const v of [null, undefined, NaN, 'lots']) {
      expect(u.isCapBlocked({ fiveH: /** @type {any} */ (v), fiveHResetAt: SOON, now: NOW })).toBe(false);
    }
  });

  test('NOT blocked when the reset time is missing or malformed', () => {
    for (const v of [null, undefined, 0, -1, NaN, '3pm']) {
      expect(u.isCapBlocked({ fiveH: 100, fiveHResetAt: /** @type {any} */ (v), now: NOW })).toBe(false);
    }
  });
});

test.describe('#137 — usageLimitState (what the session list publishes)', () => {
  test('a capped, enabled session is waiting AND armed, with a resume time', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
    expect(st.armed).toBe(true);
    expect(st.resetAt).toBe(SOON);
    // The badge counts down to when the resume FIRES, not when the window turns
    // over — those are a minute apart and only one of them is when anything happens.
    expect(st.resumeAt).toBe(SOON + 60000);
  });

  // #227 — `armed` is the WORKER's answer whenever the worker gave one. The badge
  // used to re-derive it from a subset of the worker's gates, so a timer cancelled by
  // a hook left both clients rendering "resumes 21:51" for the 2h23m to that moment,
  // with nothing scheduled. These cases are the whole contract: the boolean wins in BOTH
  // directions, and absent is not false.
  test('#227 — the worker saying NOT armed beats a derivation that says armed', () => {
    const args = {
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
    };
    // The exact shape of the field failure: everything the server can see says a
    // resume is scheduled, and the process holding the timer says it is not.
    expect(u.usageLimitState(args).armed).toBe(true); // the derivation, unaided
    const st = u.usageLimitState({ ...args, armedByWorker: false });
    expect(st.armed).toBe(false);
    // ...and the session is still HELD. Reporting the timer honestly must not erase
    // the block itself, or the row would go blank on a session that is still capped.
    expect(st.waiting).toBe(true);
    expect(st.resumeAt).toBe(SOON + 60000);
  });

  test('#227 — the worker saying ARMED beats a derivation that says not armed', () => {
    // The worker checks `enabled` and the agent's capability itself, so its answer is
    // taken whole rather than re-ANDed with this file's copies of the same gates —
    // re-deriving beside the authority is how the two came apart to begin with.
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
      canArm: false, armedByWorker: true,
    });
    expect(st.armed).toBe(true);
  });

  test('#227 — ABSENT is not false: an older worker falls back to the derivation', () => {
    // A cluster peer merely behind must not have its badge switched off. Both spellings
    // of "said nothing" are tested, because `undefined` is what a missing field yields
    // and `null` is what a JSON round-trip of an absent value can become.
    for (const v of [undefined, null]) {
      const st = u.usageLimitState({
        metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
        armedByWorker: /** @type {any} */ (v),
      });
      expect(st.armed).toBe(true);
    }
  });

  test('capped with NO reset time is waiting but NOT armed — no timer can exist', () => {
    // The cap prompt can be observed before any resets_at is read. Reporting armed
    // here would have the badge promise a resume the worker cannot schedule.
    const st = u.usageLimitState({
      metrics: { fiveH: 100 }, observedBlockAt: NOW - 1000,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
    expect(st.armed).toBe(false);
    expect(st.resumeAt).toBeNull();
  });

  test('an observed cap prompt is blocking even with no percentage at all', () => {
    const st = u.usageLimitState({
      metrics: null, observedBlockAt: NOW - 1000,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
  });

  // #142 — the rollout-recorded Codex cap error is the SAME class of direct
  // observation as observedBlockAt, just carried on `metrics` instead of a separate
  // param (it comes from lib/metrics-codex.js's findUsageCapAt, which already lives
  // inside the metrics object server.js reads off the transcript). No fiveH percentage
  // and no reset time — exactly the shape a Codex cap error arrives in when the
  // preceding token_count is outside whatever tail window was read — and the session
  // must still report held, with nothing armed (canArm:false is the Codex registry
  // declaration; see lib/agents.js).
  test('an observed Codex rollout cap error is waiting but NEVER armed, even with no percentage', () => {
    const st = u.usageLimitState({
      metrics: { capObservedAt: NOW - 1000 }, canArm: false,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);
    expect(st.armed).toBe(false);
    expect(st.capBlocked).toBe(true);
    expect(st.resetAt).toBeNull();
    expect(st.resumeAt).toBeNull();
  });

  test('a Codex rollout cap error that has been superseded (capObservedAt null) reports nothing', () => {
    // findUsageCapAt already returns null once a later turn ran — this just confirms
    // usageLimitState does not independently resurrect it from a stale reading.
    const st = u.usageLimitState({
      metrics: { capObservedAt: null, fiveH: 12 }, canArm: false,
      enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(false);
    expect(st.capBlocked).toBe(false);
  });

  test('an opted-out session still reports waiting — hiding the block would be a lie', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: false, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);   // it IS capped
    expect(st.armed).toBe(false);    // nothing will fire
    expect(st.enabled).toBe(false);
  });

  test('the badge survives to the RESUME moment, not just to the reset', () => {
    // The row said "resumes 14:32" and then reverted to a plain idle row at 14:31,
    // with the action still pending — the badge vanished a minute before the thing
    // it was announcing. waiting now runs to resumeAt.
    const justPassed = NOW - 30 * 1000;
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: justPassed }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(true);    // still shown
    expect(st.capBlocked).toBe(true); // and still armable
    expect(st.resumeAt).toBe(justPassed + 60000);
  });

  test('once the resume has passed the badge clears but arming keeps its grace', () => {
    const fired = NOW - 90 * 1000; // resume was due 30s ago
    const st = u.usageLimitState({
      metrics: { fiveH: 100, fiveHResetAt: fired }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(false);   // nothing left to announce
    expect(st.capBlocked).toBe(true); // but the fire must not be cancelled by a race
  });

  test('an ordinary working session publishes nothing to render', () => {
    const st = u.usageLimitState({
      metrics: { fiveH: 42, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW,
    });
    expect(st.waiting).toBe(false);
    expect(st.armed).toBe(false);
    expect(st.resumeAt).toBeNull();
  });

  test('no metrics at all (a plain shell) is safe, not a crash', () => {
    const st = u.usageLimitState({ metrics: null, enabled: true, delayMs: 60000, now: NOW });
    expect(st.waiting).toBe(false);
    expect(st.resetAt).toBeNull();
  });

  // canArm is the AGENT's capability (Codex is deferred, #142); `enabled` is the
  // user's per-session choice. They must narrow DIFFERENT things — a Codex session
  // really is held, and reporting it as not-waiting would be the lie the badge
  // exists to avoid. Only worker-level coverage existed for this.
  test('canArm:false is waiting but never armed — the Codex deferral (#142)', () => {
    const base = { metrics: { fiveH: 100, fiveHResetAt: SOON }, enabled: true, delayMs: 60000, now: NOW };
    const codex = u.usageLimitState({ ...base, canArm: false });
    expect(codex.capBlocked).toBe(true);
    expect(codex.waiting).toBe(true);
    expect(codex.armed).toBe(false);
    expect(codex.resumeAt).toBe(SOON + 60000); // it still shows WHEN the window reopens
    expect(codex.enabled).toBe(true);          // and it is not the user who turned it off
    // Same session, an agent that CAN arm: the only field that moves is `armed`.
    expect(u.usageLimitState({ ...base, canArm: true }).armed).toBe(true);
    expect(u.usageLimitState(base).armed).toBe(true); // absent defaults to capable
  });
});

// --- #138: the cap PROMPT rule (matchUsageLimitPrompt) -----------------------
// A match here is not a reading, it is a KEYSTROKE written into somebody's live
// terminal — so these cases are about what must NOT match at least as much as what
// must.
test.describe('#138 — matchUsageLimitPrompt', () => {
  const cfg = require('../lib/agents').usageLimitPromptFor('claude');
  const CRLF = '\r\n';
  // The captured render, claude-code 2.1.234, as it looks after stripAnsiForScan.
  const RENDER = [
    '',
    'What do you want to do?',
    '❯ 1. Stop and wait for limit to reset',
    '  2. Upgrade your plan',
    '  3. Upgrade to Team plan',
    '',
    'Enter to confirm · Esc to cancel',
    '',
  ].join(CRLF);

  test('the real selector answers with the option\'s own digit', () => {
    expect(u.matchUsageLimitPrompt(RENDER, cfg)).toBe('1');
  });

  test('a reordered menu picks the row that says wait, not position 1', () => {
    // Answering a hardcoded 1 here would buy a plan upgrade.
    const reordered = ['', '1. Upgrade your plan', '2. Upgrade to Team plan', '3. Stop and wait for limit to reset', ''].join(CRLF);
    expect(u.matchUsageLimitPrompt(reordered, cfg)).toBe('3');
  });

  test('prose about the limit is not a menu', () => {
    expect(u.matchUsageLimitPrompt('I would stop and wait for limit to reset, but...', cfg)).toBeNull();
  });

  // THE REGRESSION THIS RULE EXISTS FOR. lib/agents.js carries the captured render
  // verbatim in a comment and tests/reset-resume.spec.js assembles it, so with the
  // old "match the sentence anywhere" rule a Claude session working in THIS CHECKOUT
  // that cat'd, grepped or diffed either file typed a stray `1` into its composer and
  // recorded a cap block that never happened.
  test("this repo's own source is not a trigger phrase", () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    for (const f of ['lib/agents.js', 'lib/usage-limit.js', 'tests/reset-resume.spec.js',
                     'tests/usage-limit.spec.js', 'docs/FEATURES.md', 'docs/CONFIGURATION.md']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect(u.matchUsageLimitPrompt(text, cfg), `${f} must not look like a menu`).toBeNull();
      // ...and the bare sentence really IS in there, so the test above is proving a
      // rule rather than passing on an absent needle.
      if (f.endsWith('.js')) expect(/Stop and wait for limit to reset/i.test(text)).toBe(true);
    }
  });

  test('an option line quoted or commented is not a rendered option', () => {
    // The two shapes that actually appear in this tree: a `//` comment and a string
    // literal. Both carry a real numbered option; neither starts its line with one.
    expect(u.matchUsageLimitPrompt(['    //     > 1. Stop and wait for limit to reset',
                                    '    //       2. Upgrade your plan'].join(CRLF), cfg)).toBeNull();
    expect(u.matchUsageLimitPrompt(["        '1. Stop and wait for limit to reset',",
                                    "        '2. Upgrade your plan',"].join(CRLF), cfg)).toBeNull();
  });

  test('one lone numbered line is prose, not a choice', () => {
    // A selector always offers alternatives. Without a sibling option this is a
    // sentence that happens to start with a number.
    expect(u.matchUsageLimitPrompt(['', '1. Stop and wait for limit to reset', ''].join(CRLF), cfg)).toBeNull();
  });

  test('an agent with no declared prompt never types', () => {
    expect(u.matchUsageLimitPrompt(RENDER, require('../lib/agents').usageLimitPromptFor('codex'))).toBeNull();
    expect(u.matchUsageLimitPrompt(RENDER, require('../lib/agents').usageLimitPromptFor(null))).toBeNull();
    expect(u.matchUsageLimitPrompt(RENDER, null)).toBeNull();
  });
});

test.describe('the resume delay is shared, not copied', () => {
  test('server and worker read the same constant', () => {
    // Two copies would mean a sidebar counting down to a moment when nothing happens.
    expect(u.AUTO_RESUME_DELAY_MS).toBe(60000);
    expect(u.autoResumeDelayMs({})).toBe(u.AUTO_RESUME_DELAY_MS);
    expect(u.autoResumeDelayMs({ WT_AUTO_RESUME_FAST: '1' })).toBe(u.AUTO_RESUME_DELAY_FAST_MS);
  });

  test('resumeAtFrom rejects a malformed reset rather than inventing one', () => {
    expect(u.resumeAtFrom(SOON, 60000)).toBe(SOON + 60000);
    expect(u.resumeAtFrom(null, 60000)).toBeNull();
    expect(u.resumeAtFrom(0, 60000)).toBeNull();
  });
});

// A rollout line is immutable, so re-reading it forever reported a cap long after it
// lifted — 26 days, in the review's own reproduction. The worker's sighting of Claude's
// prompt does not have this problem because the worker clears it; this channel has to
// expire on its own. Found in review.
test.describe('#142 — an observed cap EXPIRES, and names the right window', () => {
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');
  const CAP_AT = Date.parse('2026-08-02T20:26:58.735Z');
  const state = (metrics, now = NOW) =>
    u.usageLimitState({ metrics, enabled: true, now, canArm: false });

  test('THE REVIEW REPRODUCTION: 26 days after the cap, the row is not still held', () => {
    const r = state({ capObservedAt: CAP_AT, fiveH: 34, fiveHResetAt: NOW + 3600e3 });
    expect(r.waiting).toBe(false);
    expect(r.capBlocked).toBe(false);
  });

  test('a LIVE cap, an hour before the window it is under resets, is held', () => {
    const weeklyReset = NOW + 3600e3;
    const r = state({
      capObservedAt: NOW - 60e3,
      sevenD: 100, sevenDResetAt: weeklyReset,
      fiveH: 34, fiveHResetAt: NOW + 30 * 60e3,
    });
    expect(r.waiting).toBe(true);
    // ...and the resume it announces comes from the WEEKLY window, not the 5h one.
    // Announcing the 5h reset for a weekly cap named a time unrelated to the block.
    expect(r.resumeAt).toBeGreaterThan(weeklyReset);
  });

  test('observedCapReset picks the window that is actually spent', () => {
    const weekly = NOW + 5 * 24 * 3600e3;
    const fiveH = NOW + 3600e3;
    expect(u.observedCapReset({ sevenD: 100, sevenDResetAt: weekly, fiveH: 34, fiveHResetAt: fiveH }))
      .toBe(weekly);
    expect(u.observedCapReset({ sevenD: 40, sevenDResetAt: weekly, fiveH: 100, fiveHResetAt: fiveH }))
      .toBe(fiveH);
    expect(u.observedCapReset({ sevenD: 40, fiveH: 34, fiveHResetAt: fiveH })).toBeNull();
  });

  test('with NO reset known at all, the observation still expires', () => {
    // The backstop: Codex's longest window is 7 days, so an error older than that
    // cannot describe a live block whatever else is true.
    const justInside = NOW - (u.CAP_OBSERVATION_MAX_AGE_MS - 60e3);
    const justOutside = NOW - (u.CAP_OBSERVATION_MAX_AGE_MS + 60e3);
    expect(state({ capObservedAt: justInside }).waiting).toBe(true);
    expect(state({ capObservedAt: justOutside }).waiting).toBe(false);
  });

  test('CLAUDE IS UNTOUCHED: it never supplies capObservedAt', () => {
    // The blast-radius check. usageLimitState is shared, so the new channel must be
    // invisible to a pushed Claude status line, which carries no such field.
    expect(state({ fiveH: 34, fiveHResetAt: NOW + 3600e3 }).waiting).toBe(false);
    expect(state({ fiveH: 100, fiveHResetAt: NOW + 3600e3 }).waiting).toBe(true);
    expect(u.usageLimitState({
      metrics: {}, enabled: true, now: NOW, observedBlockAt: NOW - 1000,
    }).waiting).toBe(true);
  });
});
