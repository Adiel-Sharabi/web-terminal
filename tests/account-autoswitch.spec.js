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
    expect(c).toEqual({ enabled: true, cooldownMs: lib.COOLDOWN_MINUTES_DEFAULT * MIN, ntfy: { server: 'https://n.example', topic: 't' } });
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

  test('spent vs not: 100 counts, 99 does not, a reset already passed does not', () => {
    expect(lib.weeklySpent([readingAt(T)], undefined, T)).toEqual({ resetAt: T + 3 * DAY });
    expect(lib.weeklySpent([readingAt(T, { sevenD: 99 })], undefined, T)).toBeNull();
    expect(lib.weeklySpent([readingAt(T, { resetAt: T - 1 })], undefined, T)).toBeNull();
    expect(lib.weeklySpent([readingAt(T, { resetAt: null })], undefined, T)).toEqual({ resetAt: null });
    expect(lib.weeklySpent([], undefined, T)).toBeNull();
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
    expect(lib.weeklySpent([readingAt(T + 60000, { delta: 2000 })], switchedAt, T + 2 * MIN)).toEqual({ resetAt: T + 3 * DAY });
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
    expect(lib.weeklySpent([next], T, T + 4 * 60 * MIN)).toEqual({ resetAt: T + DAY });
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
});
