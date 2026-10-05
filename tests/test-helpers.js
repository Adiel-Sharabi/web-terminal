// @ts-check
const { request: pwRequest, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIRS } = require('../scripts/scratch-dirs');

const BASE = 'http://127.0.0.1:17681';
const AUTH = { user: 'testuser', password: 'testpass:colon' };

/** Read per-process hook token (H1) from .hook-token so tests can hit hook endpoints. */
function readHookToken() {
  try { return fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim(); } catch { return ''; }
}

/** Create a request context with cookie auth */
async function authCtx() {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const loginRes = await ctx.post('/login', {
    form: { user: AUTH.user, password: AUTH.password },
    maxRedirects: 0,
  });
  const setCookie = loginRes.headers()['set-cookie'];
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: {
      Cookie: setCookie.split(';')[0],
      'X-WT-Hook-Token': readHookToken(),
    },
  });
}

/** Create a request context without auth */
async function noAuthCtx() {
  return pwRequest.newContext({ baseURL: BASE });
}

/** Login via page (for browser-based tests) */
async function loginPage(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[name="user"]', AUTH.user);
  await page.fill('input[name="password"]', AUTH.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
}

// ---- fixture locations (#177) ------------------------------------------------
//
// Several specs need a Codex rollout to EXIST where the server will find it, and
// the server looks in one real place — `<claudeHome>/.codex/sessions`. So the
// suite writes fixtures into the developer's own Codex tree. That is workable,
// but only while two rules hold, and #177 is what happens when they don't.
//
//   1. A fixture must be SWEEPABLE without touching real rollouts. Hence the
//      reserved years below: a run that dies before its `afterAll` leaves files
//      behind, and `global-setup.js` clears them before the next run rather than
//      trusting the last one to have tidied up.
//   2. A fixture must never declare a cwd that a test SESSION also has. The
//      server matches a rollout to a session by cwd, so a fixture claiming
//      `%TEMP%` — which is `WT_CWD`, the default cwd of every session the suite
//      creates — answers for every "this session has no transcript" assertion in
//      the suite. That is exactly how five specs came to fail together.

/**
 * Years reserved for generated Codex rollout fixtures. Real rollouts are dated
 * now, so a far-future year is unambiguous test data and safe to delete.
 * Declared ONCE: the specs that write fixtures and the sweep that removes them
 * must agree, and they were already five copies apart.
 */
const FIXTURE_YEARS = Object.freeze(['2097', '2098', '2099']);

/**
 * Where the server looks for Codex rollouts — mirrors server.js's
 * detectClaudeHome(), which prefers config.json's `claudeHome`. Was copied
 * verbatim into five specs before #177.
 */
function codexSessionsRoot() {
  let home = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg && cfg.claudeHome) home = String(cfg.claudeHome);
  } catch {}
  if (!home) home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.codex', 'sessions');
}

/** The Claude counterpart of [codexSessionsRoot] — `<claudeHome>/.claude/projects`. */
function claudeProjectsRoot() {
  let home = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg && cfg.claudeHome) home = String(cfg.claudeHome);
  } catch {}
  if (!home) home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'projects');
}

/** True for a path sitting under one of the [FIXTURE_YEARS] — i.e. generated. */
function isFixtureRollout(p) {
  const parts = String(p).split(/[\\/]/);
  return FIXTURE_YEARS.some((y) => parts.includes(y));
}

/**
 * Delete every generated rollout fixture, whoever left it. Called from
 * `global-setup.js` BEFORE the run, not only after: the failure mode this
 * fixes is a run that never reached its cleanup, and only the NEXT run can
 * repair that.
 */
function sweepCodexFixtures() {
  const root = codexSessionsRoot();
  let removed = 0;
  for (const y of FIXTURE_YEARS) {
    const dir = path.join(root, y);
    try {
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
    } catch {}
  }
  return removed;
}

let _cwdSeq = 0;
/**
 * A fresh, empty working directory for a session that must resolve NO
 * transcript — the point being that nothing has ever run an agent here, so
 * neither provider can match it. Unique per call (pid + counter) so two specs,
 * or two runs, can never collide.
 *
 * Use this instead of `%TEMP%`/`os.tmpdir()` for any "no transcript" session:
 * those are shared directories that fixtures legitimately name.
 */
function emptyCwd(label = 'cwd') {
  const dir = path.join(DIRS.tests, `${label}-${process.pid}-${++_cwdSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- opening a session in app.html (#277) -------------------------------------
//
// `#sessionName` filling in is NOT the session being open. It is painted from a
// `/api/sessions` fetch that races the `/ws/<id>` upgrade, so it can settle while
// the page's socket is still CONNECTING. Four specs each carried a pasted copy of
// "goto, wait for the name" and then acted as if attached: pushed a synthetic frame
// into the socket, or switched away expecting `switchSession` to DEMOTE a socket it
// only demotes when it is OPEN (otherwise it closes it, and every later frame sent
// into that route is silently discarded by Playwright). Fast when idle, so it only
// failed under full-suite load, and a different test each time.

/** Ceiling for a wait on a PRECONDITION SIGNAL (#277/#282) - the socket attached, the
 *  sidebar rendered a payload, the page saw a routed request fail. Generous ON PURPOSE, and that
 *  is not a "longer timer": a signal wait passes the instant the thing is true, so an
 *  idle run does not wait at all and a loaded one waits as long as the server needs.
 *  What it replaces is a 5s default spent on the ASSERTION while the server work in
 *  front of it - every route here that reaches the pty-worker - was still in flight. */
const SIGNAL_TIMEOUT_MS = 20000;

/**
 * Open `/app/<id>` and return only once the session is ATTACHED end to end: the
 * header names it, the page's current socket is for it and OPEN, and the PTY's own
 * bytes have arrived over that socket and been painted into the terminal. The last
 * one is the real signal - the server adds a socket to the session's client set
 * only after `attachSession` returns, so no PTY byte can reach a socket that is not
 * attached. A fresh session always produces some (ConPTY paints, the shell prompts).
 *
 * `drawerClosed: true` seeds the phone drawer shut BEFORE load and asserts it stayed
 * shut (#221: at phone width `#sidebar.open` is 100vw and covers the compose bar).
 */
async function openSession(page, id, name, { drawerClosed = false } = {}) {
  if (drawerClosed) {
    await page.addInitScript(() => {
      try { sessionStorage.setItem('sidebarOpen', '0'); } catch { /* private mode */ }
    });
  }
  await page.goto(BASE + '/app/' + id);
  await expect(page.locator('#sessionName')).toContainText(name, { timeout: 10000 });
  try {
    await page.waitForFunction((sid) => {
      // `ws`, `sessionId` and `term` are top-level bindings of app.html's classic script.
      if (sessionId !== sid || !ws || ws.readyState !== 1) return false;
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim()) return true;
      }
      return false;
    }, id, { timeout: SIGNAL_TIMEOUT_MS });
  } catch (e) {
    const state = await page.evaluate(() => ({
      sessionId, readyState: ws ? ws.readyState : null,
    })).catch(() => null);
    throw new Error(`openSession: session ${id} never attached (page state ${JSON.stringify(state)}): ${e.message}`);
  }
  if (drawerClosed) {
    // THE DRAWER MUST EXIST BEFORE ITS ABSENCE MEANS ANYTHING: `toHaveCount(0)` on
    // `#sidebar.open` is also satisfied by there being no `#sidebar` at all.
    await expect(page.locator('#sidebar'),
      'no #sidebar at all - the closed-drawer guard below would pass vacuously').toHaveCount(1);
    await expect(page.locator('#sidebar.open'),
      'the phone-width drawer is 100vw and covers everything a spec clicks (#221)').toHaveCount(0);
  }
}

/**
 * Route every socket the page opens on `pathname` through Playwright with real
 * traffic passed both ways, and push synthetic server frames into it.
 *
 * `send` always targets the NEWEST socket on that path. Holding on to the first
 * route - what the pasted copies did - keeps sending into a socket the page has
 * already closed and replaced, and Playwright discards such a send without an error.
 */
async function routeSocket(page, pathname) {
  const routes = [];
  let opened;
  const firstOpen = new Promise((resolve) => { opened = resolve; });
  await page.routeWebSocket((url) => url.pathname === pathname, (wsRoute) => {
    wsRoute.connectToServer();
    routes.push(wsRoute);
    opened();
  });
  return {
    /** Resolves once the page has opened at least one socket on the path. */
    opened: () => firstOpen,
    send(msg) {
      if (!routes.length) throw new Error(`routeSocket: the page never opened ${pathname}`);
      routes[routes.length - 1].send(msg);
    },
  };
}

module.exports = {
  BASE, AUTH, authCtx, noAuthCtx, loginPage, readHookToken,
  FIXTURE_YEARS, codexSessionsRoot, claudeProjectsRoot, isFixtureRollout,
  sweepCodexFixtures, emptyCwd,
  SIGNAL_TIMEOUT_MS, openSession, routeSocket,
};
