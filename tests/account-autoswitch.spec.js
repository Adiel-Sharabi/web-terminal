// @ts-check
// #483 - switch this machine's Claude account when the active one has spent its weekly
// window, and say so over ntfy. The rules are pure (lib/account-autoswitch.js) and tested
// directly; the last describe drives a real isolated server + worker end to end: a status
// line at 100% weekly switches the login on disk, posts the notice, and resumes a session
// parked on the cap through the worker's own auto-resume.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const lib = require('../lib/account-autoswitch');
const usageLimit = require('../lib/usage-limit');
const { startServer, bearer, until } = require('./supervisor-rig');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T = Date.UTC(2026, 10, 21, 12, 0, 0); // a fixed "now"

/** Two reports of one session: a baseline, then one that grew the API counter by `delta`. */
function readingAt(at, { delta = 2000, sevenD = 100, resetAt = T + 3 * DAY } = {}) {
  const base = lib.noteReading(null, { apiMs: 10000, sevenD: 40, at: at - 30000 });
  return lib.noteReading(base, { apiMs: 10000 + delta, sevenD, sevenDResetAt: resetAt, at });
}

test.describe('account auto-switch rules (#483)', () => {
  test('config is OFF unless enabled is exactly true, and carries its own ntfy target', () => {
    expect(lib.autoSwitchConfig(undefined).enabled).toBe(false);
    expect(lib.autoSwitchConfig({ enabled: 'yes' }).enabled).toBe(false);
    const c = lib.autoSwitchConfig({ enabled: true, ntfy: { topic: 't', server: 'https://n.example/' } });
    expect(c).toEqual({ enabled: true, cooldownMs: lib.COOLDOWN_MINUTES_DEFAULT * MIN, atPct: 95, ntfy: { server: 'https://n.example', topic: 't' } });
    expect(lib.autoSwitchConfig({ enabled: true }).ntfy).toBeNull();
    expect(lib.autoSwitchConfig({ enabled: true, cooldownMinutes: 1 }).cooldownMs).toBe(lib.COOLDOWN_MINUTES_MIN * MIN);
    expect(lib.autoSwitchConfig({ enabled: true, cooldownMinutes: 1e9 }).cooldownMs).toBe(lib.COOLDOWN_MINUTES_MAX * MIN);
  });

  test('a report counts only when the API counter grew: the first report and a re-render do not', () => {
    const first = lib.noteReading(null, { apiMs: 5000, sevenD: 100, sevenDResetAt: T + DAY, at: T });
    expect(first.fresh).toBeNull();
    const grown = lib.noteReading(first, { apiMs: 7000, sevenD: 100, sevenDResetAt: T + DAY, at: T + 1000 });
    expect(grown.fresh).toEqual({ at: T + 1000, prevAt: T, delta: 2000, sevenD: 100, sevenDResetAt: T + DAY });
    // A redraw with no new response keeps the evidence it had (a capped session makes no calls).
    const redraw = lib.noteReading(grown, { apiMs: 7000, sevenD: 12, at: T + 5000 });
    expect(redraw.fresh).toEqual(grown.fresh);
    // A counter that went down is a new conversation: a baseline, not evidence.
    const reset = lib.noteReading(lib.noteReading(null, { apiMs: 9000, at: T }), { apiMs: 100, sevenD: 100, at: T + 1 });
    expect(reset.fresh).toBeNull();
  });

  test('spent vs not: at the switch point counts, below it does not, a reset already passed does not', () => {
    const at100 = { atPct: 100 };
    expect(lib.weeklySpent([readingAt(T)], undefined, T, at100)).toEqual({ resetAt: T + 3 * DAY, pct: 100 });
    expect(lib.weeklySpent([readingAt(T, { sevenD: 99 })], undefined, T, at100)).toBeNull();
    expect(lib.weeklySpent([readingAt(T, { resetAt: T - 1 })], undefined, T, at100)).toBeNull();
    expect(lib.weeklySpent([readingAt(T, { resetAt: null })], undefined, T, at100)).toEqual({ resetAt: null, pct: 100 });
    expect(lib.weeklySpent([], undefined, T, at100)).toBeNull();
  });

  test('#490: the switch point is switchAtPct, default 95, clamped to 50..100', () => {
    expect(lib.autoSwitchConfig({ enabled: true }).atPct).toBe(95);
    expect(lib.autoSwitchConfig({ enabled: true, switchAtPct: 90 }).atPct).toBe(90);
    expect(lib.autoSwitchConfig({ enabled: true, switchAtPct: 10 }).atPct).toBe(lib.SWITCH_AT_PCT_MIN);
    expect(lib.autoSwitchConfig({ enabled: true, switchAtPct: 150 }).atPct).toBe(lib.SWITCH_AT_PCT_MAX);
    expect(lib.autoSwitchConfig({ enabled: true, switchAtPct: '80' }).atPct).toBe(95);
    // The overnight of 2026-11-23: every stopped session's last pushed reading was 98 or 99,
    // because Claude does not re-render its status line on the weekly refusal. At 95 it switches.
    const { atPct } = lib.autoSwitchConfig({ enabled: true });
    expect(lib.weeklySpent([readingAt(T, { sevenD: 99 })], undefined, T, { atPct })).toEqual({ resetAt: T + 3 * DAY, pct: 99 });
    expect(lib.weeklySpent([readingAt(T, { sevenD: 95 })], undefined, T, { atPct })).toEqual({ resetAt: T + 3 * DAY, pct: 95 });
    expect(lib.weeklySpent([readingAt(T, { sevenD: 94 })], undefined, T, { atPct })).toBeNull();
    // No opts at all is the default switch point too, never 100.
    expect(lib.weeklySpent([readingAt(T, { sevenD: 99 })], undefined, T)).not.toBeNull();
  });

  test('#490: after a switch, a counted reading that names the OLD account\'s window never counts', () => {
    const windowA = T + 1 * DAY;
    const windowB = T + 6 * DAY;
    const switchedAt = T;
    // Before the switch, account A's sessions reported its window: those are proven A's.
    const before = [readingAt(T - 10 * MIN, { sevenD: 80, resetAt: windowA }), readingAt(T - 5 * MIN, { sevenD: 99, resetAt: windowA })];
    const oldWindows = lib.windowsOf(before, T - DAY, switchedAt);
    expect(oldWindows).toEqual([windowA]);
    // Seconds later a response that began after the switch (the counter proves it) still
    // carries A's rate limits. Without the window check it reads as B spent: the flip back.
    const lagging = readingAt(T + 2 * MIN, { sevenD: 100, resetAt: windowA });
    expect(lib.weeklySpent([lagging], switchedAt, T + 3 * MIN, { atPct: 95 })).not.toBeNull();
    expect(lib.weeklySpent([lagging], switchedAt, T + 3 * MIN, { atPct: 95, oldWindows })).toBeNull();
    expect(lib.pendingReadings([['s1', lagging]], switchedAt, T + 3 * MIN, { atPct: 95, oldWindows })).toEqual({});
    // B's own window at the switch point still counts.
    const real = readingAt(T + 2 * MIN, { sevenD: 96, resetAt: windowB });
    expect(lib.weeklySpent([lagging, real], switchedAt, T + 3 * MIN, { atPct: 95, oldWindows })).toEqual({ resetAt: windowB, pct: 96 });
  });

  test('#490: windowsOf takes only counted readings with a future reset, once each; a restored list is checked', () => {
    const w1 = T + DAY;
    const w2 = T + 2 * DAY;
    const since = T - DAY;
    const readings = [
      readingAt(T - MIN, { resetAt: w2 }),
      readingAt(T - 2 * MIN, { resetAt: w1 }),
      readingAt(T - 3 * MIN, { resetAt: w1 }), // the same window twice
      readingAt(T - 4 * MIN, { resetAt: T - 1 }), // already turned over
      readingAt(T - 5 * MIN, { resetAt: null }), // names no window
      readingAt(since - MIN, { resetAt: T + 3 * DAY }), // from before the previous switch: not this account's
      lib.noteReading(null, { apiMs: 1, sevenD: 50, sevenDResetAt: T + 4 * DAY, at: T }), // a first report proves nothing
    ];
    expect(lib.windowsOf(readings, since, T)).toEqual([w1, w2]);
    expect(lib.windowsOf(undefined, since, T)).toEqual([]);
    expect(lib.isOldWindow(w1, [w1])).toBe(true);
    expect(lib.isOldWindow(w1, [String(w1), null, {}])).toBe(false);
    expect(lib.isOldWindow(null, [null])).toBe(false);
    expect(lib.isOldWindow(w1, 'junk')).toBe(false);
    // One window, reported a few seconds apart, is still one window; an hour apart is not.
    expect(lib.isOldWindow(w1 + 30 * 1000, [w1])).toBe(true);
    expect(lib.isOldWindow(w1 + 60 * MIN, [w1])).toBe(false);
  });

  test('#490: a switch BACK never files the account\'s own window as old (A to B to A)', () => {
    const wA = T + 1 * DAY;
    const wB = T + 6 * DAY;
    // A to B by hand: A's counted readings make A's window old.
    const firstSwitch = T;
    const oldAfterFirst = lib.windowsOf([readingAt(T - 5 * MIN, { sevenD: 80, resetAt: wA })], T - DAY, firstSwitch);
    expect(oldAfterFirst).toEqual([wA]);
    // On B: a late reading of A's still counts by the API counter, and B's own reading.
    const lateA = readingAt(T + 2 * MIN, { sevenD: 100, resetAt: wA });
    const ownB = readingAt(T + 3 * MIN, { sevenD: 96, resetAt: wB });
    // B to A: only B's window is old. Without `previous`, A's own window would be filed too,
    // and A could never switch again until its week reset.
    expect(lib.windowsOf([lateA, ownB], firstSwitch, T + 4 * MIN)).toEqual([wA, wB]);
    const oldAfterBack = lib.windowsOf([lateA, ownB], firstSwitch, T + 4 * MIN, oldAfterFirst);
    expect(oldAfterBack).toEqual([wB]);
    const aAgain = readingAt(T + 10 * MIN, { sevenD: 97, resetAt: wA });
    expect(lib.weeklySpent([aAgain], T + 4 * MIN, T + 11 * MIN, { atPct: 95, oldWindows: oldAfterBack })).toEqual({ resetAt: wA, pct: 97 });
  });

  test('a reading from before the last switch, or from a response that began before it, is stale', () => {
    const switchedAt = T;
    // Received before the switch.
    expect(lib.weeklySpent([readingAt(T - 1000)], switchedAt, T + MIN)).toBeNull();
    // Received after the switch, but its response took 30 s: it began before the switch.
    expect(lib.weeklySpent([readingAt(T + 20000, { delta: 30000 })], switchedAt, T + MIN)).toBeNull();
    // Within the report margin of the switch.
    expect(lib.weeklySpent([readingAt(T + 3000, { delta: 1000 })], switchedAt, T + MIN)).toBeNull();
    // A response that began after the switch, plus the margin: it is the new account's.
    expect(lib.weeklySpent([readingAt(T + 60000, { delta: 2000 })], switchedAt, T + 2 * MIN)).toEqual({ resetAt: T + 3 * DAY, pct: 100 });
  });

  test('a push lost before the switch: the bound is the PREVIOUS report, not this one', () => {
    // The last report before the switch was at T - 1 min; a response then ended just before
    // the switch (its push lost), and hours later a redraw shows it. Receipt time minus the
    // delta is far after the switch, but the response may have begun before it.
    const before = lib.noteReading(null, { apiMs: 10000, sevenD: 90, at: T - MIN });
    const late = lib.noteReading(before, { apiMs: 12000, sevenD: 100, sevenDResetAt: T + DAY, at: T + 3 * 60 * MIN });
    expect(lib.weeklySpent([late], T, T + 3 * 60 * MIN)).toBeNull();
    // The next response after that one is provably the new login's.
    const next = lib.noteReading(late, { apiMs: 13000, sevenD: 100, sevenDResetAt: T + DAY, at: T + 3 * 60 * MIN + 10000 });
    expect(lib.weeklySpent([next], T, T + 4 * 60 * MIN)).toEqual({ resetAt: T + DAY, pct: 100 });
  });

  test('each failure in a row doubles the wait before the next attempt, up to a day', () => {
    const cfg = lib.autoSwitchConfig({ enabled: true, cooldownMinutes: 30 });
    expect(lib.cooldownAfter(cfg, {})).toBe(30 * MIN);
    expect(lib.cooldownAfter(cfg, { failures: 2 })).toBe(120 * MIN);
    expect(lib.cooldownAfter(cfg, { failures: 99 })).toBe(lib.COOLDOWN_MINUTES_MAX * MIN);
    expect(lib.blockedBy({ cfg, state: { attemptAt: T - 100 * MIN, failures: 2 }, now: T, holdActive: false })).toBe('cooldown');
    expect(lib.blockedBy({ cfg, state: { attemptAt: T - 121 * MIN, failures: 2 }, now: T, holdActive: false })).toBeNull();
  });

  test('the cooldown, the restart hold and the off switch each block; nothing else does', () => {
    const cfg = lib.autoSwitchConfig({ enabled: true, cooldownMinutes: 30 });
    expect(lib.blockedBy({ cfg, state: {}, now: T, holdActive: false })).toBeNull();
    expect(lib.blockedBy({ cfg: lib.autoSwitchConfig({}), state: {}, now: T, holdActive: false })).toBe('disabled');
    expect(lib.blockedBy({ cfg, state: {}, now: T, holdActive: true })).toBe('restart-hold');
    expect(lib.blockedBy({ cfg, state: { attemptAt: T - 29 * MIN }, now: T, holdActive: false })).toBe('cooldown');
    expect(lib.blockedBy({ cfg, state: { attemptAt: T - 31 * MIN }, now: T, holdActive: false })).toBeNull();
  });

  const saved = (label, extra = {}) => ({ label, refreshExpiresAt: T + 20 * DAY, active: false, ...extra });
  test('picks the next saved account in label order after the active one, wrapping round', () => {
    const list = [saved('c'), saved('a', { active: true }), saved('b')];
    expect(lib.pickNext({ saved: list, activeLabel: 'a', capped: {}, now: T }).next).toBe('b');
    expect(lib.pickNext({ saved: [saved('a'), saved('b'), saved('c', { active: true })], activeLabel: 'c', capped: {}, now: T }).next).toBe('a');
    // The active account is never its own successor, even unsaved (label null).
    expect(lib.pickNext({ saved: [saved('a', { active: true })], activeLabel: 'a', capped: {}, now: T }).next).toBeNull();
    expect(lib.pickNext({ saved: [saved('b')], activeLabel: null, capped: {}, now: T }).next).toBe('b');
  });

  test('skips an expired saved login, a broken one and a known-capped one', () => {
    const list = [saved('a', { active: true }), saved('b', { refreshExpiresAt: T - 1 }), { label: 'c', broken: true }, saved('d'), saved('e')];
    expect(lib.pickNext({ saved: list, activeLabel: 'a', capped: { d: T + DAY }, now: T }).next).toBe('e');
    // A capped mark whose reset has passed no longer counts.
    expect(lib.pickNext({ saved: list, activeLabel: 'a', capped: { d: T - 1 }, now: T }).next).toBe('d');
    // An unknown refresh expiry is not an expired one.
    expect(lib.pickNext({ saved: [saved('a', { active: true }), saved('b', { refreshExpiresAt: null })], activeLabel: 'a', capped: {}, now: T }).next).toBe('b');
  });

  test('all capped: no account, and the earliest reset to name', () => {
    const list = [saved('a', { active: true }), saved('b'), saved('c')];
    const r = lib.pickNext({ saved: list, activeLabel: 'a', capped: { a: T + 5 * DAY, b: T + 2 * DAY, c: T + DAY }, now: T });
    expect(r).toEqual({ next: null, earliest: { label: 'c', resetAt: T + DAY } });
    expect(lib.pruneCapped({ a: T + 1, b: T - 1, c: 'x' }, T)).toEqual({ a: T + 1 });
  });

  test('a capped session resumes on the switch only while its own reading is older than the switch', () => {
    const from = T;
    expect(lib.resumeResetAt({ resumeFrom: from, readingAt: T - MIN, resetAt: T + 3 * 60 * MIN })).toBe(from);
    expect(lib.resumeResetAt({ resumeFrom: from, readingAt: undefined, resetAt: null })).toBe(from);
    // A reading after the switch is the new account's and speaks for itself.
    expect(lib.resumeResetAt({ resumeFrom: from, readingAt: T + 1, resetAt: T + 3 * 60 * MIN })).toBe(T + 3 * 60 * MIN);
    // A window that reset before the switch was already handled by its own resume.
    expect(lib.resumeResetAt({ resumeFrom: from, readingAt: T - MIN, resetAt: T - 2 * MIN })).toBe(T - 2 * MIN);
    // No automatic switch, no change.
    expect(lib.resumeResetAt({ resumeFrom: undefined, readingAt: T, resetAt: 5 })).toBe(5);
    // And it ends once the old account's week has reset.
    expect(lib.resumeResetAt({ resumeFrom: from, resumeUntil: T + DAY, readingAt: T - MIN, resetAt: null, now: T + 2 * DAY })).toBeNull();
    expect(lib.resumeResetAt({ resumeFrom: from, resumeUntil: T + DAY, readingAt: T - MIN, resetAt: null, now: T + MIN })).toBe(from);
  });

  test('the notices name both accounts and the reset, and no other shape', () => {
    const sw = lib.notice('switched', { server: 'Box', from: 'a@example.com', to: 'b@example.com', resetAt: T + DAY });
    expect(sw.title).toBe('Claude account switched on Box');
    expect(sw.message).toContain('a@example.com hit its weekly limit');
    expect(sw.message).toContain('Now using b@example.com.');
    expect(sw.message).toContain(lib.clock(T + DAY));
    const all = lib.notice('all-capped', { server: 'Box', from: 'a', resetAt: T + DAY, earliest: { label: 'c', resetAt: T + 2 * DAY } });
    expect(all.message).toContain(`c resets first, ${lib.clock(T + 2 * DAY)}`);
    const failed = lib.notice('failed', { server: 'Box', from: 'a', to: 'b', error: 'cannot read', retryAt: T });
    expect(failed.title).toBe('Claude account switch failed on Box');
    expect(failed.message).toContain('switching to b failed: cannot read');
    // #490: a switch before the limit says how far the week got.
    const early = lib.notice('switched', { server: 'Box', from: 'a', to: 'b', resetAt: T + DAY, pct: 96 });
    expect(early.message).toContain('a reached 96% of its weekly limit');
    expect(lib.notice('switched', { server: 'Box', from: 'a', to: 'b', resetAt: T + DAY, pct: 100 }).message).toContain('a hit its weekly limit');
  });

  test('the readings a pending switch rests on (kept across a restart) are the spent ones that count', () => {
    const switchedAt = T - 60000;
    const spent = readingAt(T);
    const p = lib.pendingReadings([
      ['s1', spent],
      ['s2', readingAt(T, { sevenD: 50 })], // not spent
      ['s3', readingAt(T - 30000)], // its response began before the switch
      ['s4', readingAt(T, { resetAt: T - 1 })], // its week already turned over
    ], switchedAt, T);
    expect(Object.keys(p)).toEqual(['s1']);
    expect(p.s1).toBe(spent);
    expect(lib.pendingReadings(undefined, switchedAt, T)).toEqual({});
  });

  test('a session waiting on the switch is weekly-blocked by its own reading, 5-hour window or not', () => {
    const from = T;
    const now = T + MIN;
    const delayMs = 60000;
    const at = (args) => lib.weeklyBlockedAtSwitch({ resumeFrom: from, now, delayMs, ...args });
    expect(at({ sevenD: 100, resumeFrom: undefined })).toBe(false);
    expect(at({ sevenD: 100 })).toBe(true);
    expect(at({ sevenD: 99 })).toBe(false);
    // Metrics aged out (sevenD blank): the session's reading from before the switch speaks.
    expect(at({ sevenD: null, reading: readingAt(T - 1000) })).toBe(true);
    // A reading after the switch is the new account's, not the block.
    expect(at({ sevenD: null, reading: readingAt(T + 1000) })).toBe(false);
    expect(at({ sevenD: null, reading: readingAt(T - 1000, { sevenD: 80 }) })).toBe(false);
    // Bounded as the 5-hour block is: the settle delay plus the grace, then no longer.
    const deadline = from + delayMs + usageLimit.CAP_BLOCK_GRACE_MS;
    expect(at({ sevenD: 100, now: deadline - 1 })).toBe(true);
    expect(at({ sevenD: 100, now: deadline })).toBe(false);
  });

  test('a reading restored from the state file is checked, not trusted', () => {
    const good = readingAt(T);
    expect(lib.pendingReadings([['s', good]], T - 60000, T)).toHaveProperty('s');
    for (const bad of [{ at: undefined }, { at: 'x' }, { prevAt: undefined }, { delta: '2000' }, { delta: 0 }]) {
      const r = { ...good, fresh: { ...good.fresh, ...bad } };
      expect(lib.pendingReadings([['s', r]], T - 60000, T)).toEqual({});
    }
  });

  test('a switch that ended with a warning holds further automatic switches, and the notice says so', () => {
    const cfg = lib.autoSwitchConfig({ enabled: true });
    expect(lib.heldBy(undefined, T)).toBeNull();
    const held = lib.heldBy('the login was refreshed right after the switch', T);
    expect(held).toEqual({ warning: 'the login was refreshed right after the switch', at: T });
    expect(lib.blockedBy({ cfg, state: { held }, now: T + 99 * DAY, holdActive: false })).toBe('warning-hold');
    expect(lib.blockedBy({ cfg, state: { held: null }, now: T, holdActive: false })).toBeNull();
    const warned = lib.notice('switched', { server: 'Box', from: 'a', to: 'b', resetAt: T, warning: held.warning });
    expect(warned.message).toContain('Now using b. WARNING: the login was refreshed right after the switch.');
    expect(warned.message).toContain('paused until the account is switched by hand');
    expect(warned.tags).toEqual(['warning']);
    expect(lib.notice('switched', { server: 'Box', from: 'a', to: 'b', resetAt: T }).message).not.toContain('WARNING');
  });
});

// --- end to end: a real isolated server and its worker ---------------------------------

const ACCOUNT = (k, days = 20) => ({
  oauth: { accessToken: `access-${k}-secret`, refreshToken: `refresh-${k}-secret`, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + days * DAY, subscriptionType: 'max' },
  account: { accountUuid: `uuid-${k}`, organizationUuid: `org-${k}`, emailAddress: `${k}@example.com`, organizationName: `${k} org` },
});
const A = ACCOUNT('a');
const B = ACCOUNT('b');
const C = ACCOUNT('c', -1); // its saved refresh token has expired: never picked

function writeLogin(home, who) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ mcpOAuth: { x: 1 }, claudeAiOauth: who.oauth }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 1, oauthAccount: who.account }, null, 2) + '\n');
}
function saveAs(home, who) {
  const store = path.join(home, '.config', 'web-terminal', 'claude-accounts');
  fs.mkdirSync(path.join(store, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(store, `${who.account.emailAddress}.json`), JSON.stringify({ savedAt: new Date().toISOString(), claudeAiOauth: who.oauth, oauthAccount: who.account }));
}
const activeEmail = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).oauthAccount.emailAddress;

/** One status-line push, the raw payload shape Claude hands its status line. */
function statusPayload(sid, apiMs, sevenD, resetSec) {
  return {
    session_id: sid, model: { id: 'claude-x', display_name: 'X' },
    cost: { total_cost_usd: 1, total_api_duration_ms: apiMs },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: resetSec - 3600 }, seven_day: { used_percentage: sevenD, resets_at: resetSec } },
  };
}

test.describe('account auto-switch end to end (#483)', () => {
  test.setTimeout(120000);

  test('a weekly reading at 100% switches the login, posts one notice, and resumes the capped session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-483-'));
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd);
    writeLogin(home, A);
    saveAs(home, A); saveAs(home, B); saveAs(home, C);
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'rig-483',
      claudeAccountAutoSwitch: { enabled: true, ntfy: { topic: 'wt-483-test-topic' } },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [token]: { label: '483-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    // The server already knows A is the login (an earlier run recorded it): without that
    // record, a first reading is never pinned on whoever is logged in now.
    fs.writeFileSync(path.join(dir, 'autoswitch.json'), JSON.stringify({ activeKey: 'a@example.com|a org', switchedAt: Date.now() - 3600e3 }));
    const port = 17950 + Math.floor(Math.random() * 40);
    const srv = await startServer(dir, port, '483', {
      WT_CLAUDE_ACCOUNT_HOME: home, WT_NTFY_TEST: '1', WT_ACCOUNT_SWITCH_FILE: path.join(dir, 'autoswitch.json'),
      // The worker's own timers, shortened: the resume settle (#69) and the readiness ceiling
      // (#147) - no real Claude runs here, so its composer is never drawn.
      WT_AUTO_RESUME_FAST: '1', WT_AUTO_RESUME_ON_RESET: '1', WT_READY_FALLBACK_MS: '1500',
    });
    const ctx = await bearer(srv.base, token);
    try {
      // A Claude session whose screen shows the cap selector (#138's render, printed by the
      // shell): the real worker answers it and records the sighting, as it would for Claude.
      // Built with String.fromCharCode so the escapes reach bash's printf, not this file's parser.
      const nl = String.fromCharCode(92) + 'n';
      const printSelector = `sleep 2; printf 'What do you want to do?${nl}> 1. Stop and wait for limit to reset${nl}  2. Upgrade your plan${nl}  3. Upgrade to Team plan${nl}'`;
      const created = await ctx.post('/api/sessions', { data: { name: 'capped-483', cwd, agent: 'claude', autoCommand: printSelector } });
      expect(created.status(), await created.text()).toBeLessThan(300);
      const { id } = await created.json();
      const row = async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
      await until(async () => { const r = await row(); return r && r.usageLimit && r.usageLimit.capBlocked; }, 'the cap sighting', 30000);
      const screen = async () => (await ctx.get(`/api/sessions/${id}/scrollback`)).text();
      expect(await screen()).not.toContain('continue');

      const resetSec = Math.floor((Date.now() + 3 * DAY) / 1000);
      const push = (apiMs, sevenD) => ctx.post('/api/claude-status', { data: statusPayload('agent-483', apiMs, sevenD, resetSec) });
      expect((await push(1000, 99)).status()).toBe(200); // a baseline: proves nothing yet
      await push(1200, 100); // a fresh response (the counter grew from the baseline) at 100% weekly
      // The login on disk is B now (C's refresh token has expired), and only the login changed.
      await until(async () => activeEmail(home) === 'b@example.com', 'the switch');
      const cred = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
      expect(cred.claudeAiOauth).toEqual(B.oauth);
      expect(cred.mcpOAuth).toEqual({ x: 1 });

      // One notice, to the switch's own topic, naming both accounts - and no token anywhere.
      const sink = await (await ctx.get('/api/push/ntfy-test-sink')).json();
      const notices = sink.items.filter((i) => String(i.kind).startsWith('account-'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'account-switched', topic: 'wt-483-test-topic', title: 'Claude account switched on rig-483' });
      expect(notices[0].message).toContain('a@example.com hit its weekly limit');
      expect(notices[0].message).toContain('Now using b@example.com');
      expect(JSON.stringify(sink)).not.toMatch(/secret/);

      // The capped session resumes on the new account through the worker's auto-resume:
      // `continue` reaches its terminal (bash answers it, since no Claude is there).
      await until(async () => (await screen()).includes('continue'), 'continue typed into the capped session', 20000);

      // Another report soon after still carries A's 100%: no second switch and no second
      // notice (the rule that it is stale is pinned above; the cooldown holds here as well).
      await push(1300, 100);
      await new Promise((r) => setTimeout(r, 500));
      expect(activeEmail(home)).toBe('b@example.com');
      const after = await (await ctx.get('/api/push/ntfy-test-sink')).json();
      expect(after.items.filter((i) => String(i.kind).startsWith('account-'))).toHaveLength(0);
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'autoswitch.json'), 'utf8'));
      expect(state.capped['a@example.com']).toBe(resetSec * 1000);
      expect(state.switchedAt).toBe(state.attemptAt);
      expect(state.resumeFrom).toBe(state.switchedAt);
      expect(JSON.stringify(state)).not.toMatch(/secret/);
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** An isolated server with A logged in and A, B saved; [state] seeds the state file. */
  function autoSwitchRig(tag, state) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-483${tag}-`));
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(cwd);
    writeLogin(home, A);
    saveAs(home, A); saveAs(home, B);
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      serverName: 'rig-483', claudeAccountAutoSwitch: { enabled: true, ntfy: { topic: 'wt-483-test-topic' } },
    }));
    fs.writeFileSync(path.join(dir, 'api-tokens.json'), JSON.stringify({ [token]: { label: '483-spec', created: Date.now(), expires: Date.now() + 3600e3 } }));
    const stateFile = path.join(dir, 'autoswitch.json');
    fs.writeFileSync(stateFile, JSON.stringify({ activeKey: 'a@example.com|a org', switchedAt: Date.now() - 3600e3, ...state }));
    const boot = async () => {
      const srv = await startServer(dir, 17950 + Math.floor(Math.random() * 40), `483${tag}`, {
        WT_CLAUDE_ACCOUNT_HOME: home, WT_NTFY_TEST: '1', WT_ACCOUNT_SWITCH_FILE: stateFile,
        WT_AUTO_RESUME_FAST: '1', WT_AUTO_RESUME_ON_RESET: '1', WT_READY_FALLBACK_MS: '1500',
      });
      return { srv, ctx: await bearer(srv.base, token) };
    };
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { dir, home, cwd, stateFile, boot, readState };
  }
  const resetSecIn = (ms) => Math.floor((Date.now() + ms) / 1000);
  const accountNotices = async (ctx) => (await (await ctx.get('/api/push/ntfy-test-sink')).json()).items.filter((i) => String(i.kind).startsWith('account-'));

  test('a session stopped by its WEEK alone (5-hour window not spent) resumes on the new account', async () => {
    const rig = autoSwitchRig('w', {});
    const { srv, ctx } = await rig.boot();
    try {
      // No cap selector on screen: a weekly stop is seen only in the status line.
      const created = await ctx.post('/api/sessions', { data: { name: 'weekly-483', cwd: rig.cwd, agent: 'claude', autoCommand: 'echo idle-483' } });
      expect(created.status(), await created.text()).toBeLessThan(300);
      const { id } = await created.json();
      const agentSid = crypto.randomUUID();
      // The conversation is named by the agent's own hook, as a real Stop names it.
      const hook = await ctx.post(`/api/session/${id}/hook`, { data: { hook_event_name: 'Stop', session_id: agentSid } });
      expect(hook.status(), await hook.text()).toBe(200);
      const row = async () => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
      await until(async () => { const r = await row(); return r && r.claudeSessionId === agentSid; }, 'the conversation id');
      const screen = async () => (await ctx.get(`/api/sessions/${id}/scrollback`)).text();

      const resetSec = resetSecIn(3 * DAY);
      const push = (apiMs, sevenD) => ctx.post('/api/claude-status', { data: statusPayload(agentSid, apiMs, sevenD, resetSec) });
      expect((await push(1000, 99)).status()).toBe(200);
      // The 5-hour window (20%) is not spent, so the 5-hour rule alone says "not blocked".
      const before = await row();
      expect(before.usageLimit && before.usageLimit.capBlocked).toBeFalsy();
      await push(1200, 100);
      await until(async () => activeEmail(rig.home) === 'b@example.com', 'the switch');
      await until(async () => (await screen()).includes('continue'), 'continue typed into the weekly-capped session', 20000);
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(rig.dir, { recursive: true, force: true });
    }
  });

  test('a switch held back (the cooldown) keeps its reading across a restart, and makes the switch after it', async () => {
    // Attempted a minute ago: the cooldown blocks the switch the spent reading asks for.
    const rig = autoSwitchRig('r', { attemptAt: Date.now() - 60e3 });
    let { srv, ctx } = await rig.boot();
    const agentSid = 'agent-483-restart';
    const resetSec = resetSecIn(3 * DAY);
    const push = (c, apiMs, sevenD) => c.post('/api/claude-status', { data: statusPayload(agentSid, apiMs, sevenD, resetSec) });
    try {
      expect((await push(ctx, 1000, 99)).status()).toBe(200);
      await push(ctx, 1200, 100);
      await new Promise((r) => setTimeout(r, 500));
      expect(activeEmail(rig.home)).toBe('a@example.com');
      const kept = rig.readState().pending;
      expect(Object.keys(kept)).toEqual([agentSid]);
      expect(kept[agentSid].fresh).toMatchObject({ sevenD: 100, delta: 200 });
      expect(JSON.stringify(rig.readState())).not.toMatch(/secret/);

      // The restart the hold leads to; the cooldown is over by the time it is back.
      await ctx.dispose();
      await srv.stop();
      fs.writeFileSync(rig.stateFile, JSON.stringify({ ...rig.readState(), attemptAt: null }));
      ({ srv, ctx } = await rig.boot());
      // A redraw (the counter did not grow) proves nothing on its own: without the kept
      // reading it would be a first report, a baseline. With it, the switch goes ahead.
      expect((await push(ctx, 1200, 100)).status()).toBe(200);
      await until(async () => activeEmail(rig.home) === 'b@example.com', 'the switch after the restart', 10000);
      expect(rig.readState().pending).toEqual({});
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(rig.dir, { recursive: true, force: true });
    }
  });

  test('after a switch that warned, no automatic switch until one by hand clears the hold', async () => {
    const rig = autoSwitchRig('h', { held: { warning: 'the login was refreshed right after the switch', at: Date.now() - 60e3 } });
    const { srv, ctx } = await rig.boot();
    try {
      const resetSec = resetSecIn(3 * DAY);
      const push = (apiMs, sevenD) => ctx.post('/api/claude-status', { data: statusPayload('agent-483-held', apiMs, sevenD, resetSec) });
      expect((await push(1000, 99)).status()).toBe(200);
      await push(1200, 100);
      await new Promise((r) => setTimeout(r, 800));
      expect(activeEmail(rig.home)).toBe('a@example.com');
      expect(await accountNotices(ctx)).toHaveLength(0);
      expect(srv.log()).toContain('not switching now (warning-hold)');
      // A switch by hand is what the hold waits for.
      const manual = await ctx.post('/api/claude-account/switch', { data: { account: 'b@example.com' } });
      expect(manual.status(), await manual.text()).toBe(200);
      expect(activeEmail(rig.home)).toBe('b@example.com');
      expect(rig.readState().held).toBeNull();
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(rig.dir, { recursive: true, force: true });
    }
  });
  // #490 review - a login changed OUTSIDE this server (a /login, the CLI): the readings so far
  // may be the new account's own, so none of its windows is filed as old, and the new
  // account still switches at its own switch point.
  test('#490: a login changed outside the server files no window as old; the new account still switches', async () => {
    const rig = autoSwitchRig('o');
    const { srv, ctx } = await rig.boot();
    try {
      const windowB = resetSecIn(6 * DAY);
      writeLogin(rig.home, B); // the server recorded A; B is on disk now, written by someone else
      const push = (apiMs, sevenD) => ctx.post('/api/claude-status', { data: statusPayload('agent-490o', apiMs, sevenD, windowB) });
      expect((await push(1000, 90)).status()).toBe(200);
      await push(1200, 96); // B at its switch point: first, the server only learns the login changed
      await until(async () => (rig.readState().activeKey || '').startsWith('b@example.com'), 'the outside change recorded', 10000);
      expect(rig.readState().oldWindows).toEqual([]);
      expect(activeEmail(rig.home)).toBe('b@example.com');
      await new Promise((r) => setTimeout(r, 6000)); // past the report margin
      await push(1200, 96); // a re-render
      await push(1300, 97); // a response that began after the record: B's own, at 97
      await until(async () => activeEmail(rig.home) === 'a@example.com', 'the switch on B\'s own window', 10000);
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(rig.dir, { recursive: true, force: true });
    }
  });

  // #490 - the 2026-11-23 flip, replayed: a switch BY HAND to B, then a response that began
  // after it (the API counter grew) still carrying A's spent window. It must not switch back
  // to A. B's own window at the switch point (95 by default) then does switch, by itself.
  test('#490: a reading naming the old account\'s window never switches back; the new one\'s at 95% does', async () => {
    const rig = autoSwitchRig('w');
    const { srv, ctx } = await rig.boot();
    try {
      const windowA = resetSecIn(1 * DAY);
      const windowB = resetSecIn(6 * DAY);
      const push = (apiMs, sevenD, resetSec) => ctx.post('/api/claude-status', { data: statusPayload('agent-490', apiMs, sevenD, resetSec) });
      // Account A, on the way up: a baseline, then a counted reading below the switch point.
      expect((await push(1000, 70, windowA)).status()).toBe(200);
      await push(1200, 80, windowA);
      const manual = await ctx.post('/api/claude-account/switch', { data: { account: 'b@example.com' } });
      expect(manual.status(), await manual.text()).toBe(200);
      expect(rig.readState().oldWindows).toEqual([windowA * 1000]);
      // Past the report margin, a re-render, then a response that began after the switch -
      // still naming A's window, at 100%.
      await new Promise((r) => setTimeout(r, 6000));
      await push(1200, 100, windowA);
      await push(1250, 100, windowA);
      await new Promise((r) => setTimeout(r, 800));
      expect(activeEmail(rig.home)).toBe('b@example.com');
      expect(await accountNotices(ctx)).toHaveLength(0);
      // B's own window at 96%: at the switch point, so it switches to A, and the notice says how far.
      await push(1400, 96, windowB);
      await until(async () => activeEmail(rig.home) === 'a@example.com', 'the switch on B\'s own window', 10000);
      const notices = await accountNotices(ctx);
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain('b@example.com reached 96% of its weekly limit');
    } catch (e) {
      throw new Error(`${e.message}\n--- isolated server log (tail) ---\n${srv.log().slice(-3000)}`);
    } finally {
      await ctx.dispose();
      await srv.stop();
      fs.rmSync(rig.dir, { recursive: true, force: true });
    }
  });
});
