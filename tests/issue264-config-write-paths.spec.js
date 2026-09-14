// @ts-check
// #264 — THE OTHER TWO ROUTES THAT READ CONFIG IN ORDER TO WRITE IT.
//
// #257 fixed `PUT /api/config`: an unreadable `config.json` arrived as `{}`, so the merge
// wrote a file holding only the request's own keys — the pre-#242 REPLACE, silently. The
// same read-mutate-write-over-`{}` shape survived on two more routes, and on one of them
// the corruption is what UNLOCKS the route in the first place:
//
//   * `POST /api/setup`  — a config that will not parse throws inside the FIRST branch of
//     the startup load, so the `config.default.json` fallback is never reached and `config`
//     stays `{}`. `PASS` lands on the `'admin'` literal, `needsPasswordChange()` becomes
//     true on an ESTABLISHED server, and this route opens. Writing then replaced the file
//     with `{user, password}` alone.
//   * `POST /api/cluster/register` — the damage runs the other way. `cfg.cluster` is an
//     empty array, so the peer never looks present and the write ALWAYS fires, replacing
//     the file with `{cluster:[…]}` alone. `user` and `password` are gone, and the next
//     restart boots this server on the default credentials.
//
// SAY WHAT `/api/setup` ACTUALLY REQUIRES, because the issue said "unauthenticated" and
// that is one word too strong. The auth middleware exempts `/api/setup` only AFTER a
// session cookie verifies — or a valid API token, since the `Bearer` and `?token=` branches
// beside it also fall through — so the caller must authenticate first. What makes it an exposure
// is that the corruption hands them the credentials to do it: this spec's first server
// boots printing `Auth: admin:***`, and the login below uses exactly that. "Authenticated
// with the default credentials the corruption just created" is the honest description, and
// it is still the most dangerous of the three routes.
//
// WHY THE SETUP TESTS SPAWN THEIR OWN SERVER. The route is gated on
// `needsPasswordChange()`, so it opens only on a server whose PASS is the default — which
// the suite's own server is not, and must not be made into. `WT_CONFIG_FILE` (server.js
// ~:72, and pty-worker.js reads the same variable) points that instance at a config file
// of its own, so a run that dies mid-test cannot leave the suite's `config.test.json`
// corrupt. The register tests need no such thing: they are bearer-authed and reachable on
// the suite's own server, the way `cluster.spec.js` reaches it.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { authCtx, AUTH } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'server.js');
const SUITE_CONFIG = path.join(ROOT, 'config.test.json');

// Truncated mid-array, carrying two keys neither settings dialog renders. The same shape
// as #257's fixture on purpose — this is what a half-written or interrupted write leaves.
const CORRUPT = '{"serverName":"wt264-base","cluster":[{"name":"wt264-peer",'
  + '"url":"http://127.0.0.1:1"}';

// A server refusing to leak its own filesystem layout. Asserted structurally rather than
// against one machine's path, so it holds on a CI runner whose layout is nothing like
// this one. ORDER MATTERS at the call sites: the leak checks run before any wording
// check, because a wording check fires FIRST on a leaked path and the run then goes red
// for the cosmetic reason with the leak assertion never evaluated (#257's lesson).
function expectNoServerPath(body, where) {
  expect(body.error, `${where}: a client-facing error must not carry a server filesystem path`)
    .not.toMatch(/[A-Za-z]:[\\/]|[\\/](?:home|Users|var|opt)[\\/]/);
  expect(body.error, `${where}: and must not echo the parse error, which quotes file CONTENT`)
    .not.toContain('JSON at position');
}

// ============================================================================
// POST /api/setup — on an isolated server, because the route only opens on one
// ============================================================================

/**
 * Spawn `server.js` with a config file, a port, a pipe and a worker data dir all of its
 * own. Returns a handle with the base URL and a `stop()`.
 *
 * The worker is REAL and spawned by this server (`WT_SPAWN_WORKER`), not shared with the
 * suite: `server.js` exits fatally if it cannot reach one, so "just don't start a worker"
 * is not an option. Everything it owns lives under `dir`.
 */
async function startIsolatedServer(dir, configBytes) {
  const cfgFile = path.join(dir, 'config.json');
  if (configBytes === null) { try { fs.unlinkSync(cfgFile); } catch (e) {} }
  else fs.writeFileSync(cfgFile, configBytes, 'utf8');

  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  // 17800-17899: clear of the suite's 17681 and of hot-reload.spec.js's 17700-17799.
  const port = 17800 + Math.floor(Math.random() * 100);
  const suffix = crypto.randomUUID().slice(0, 8);
  const env = {
    ...process.env,
    WT_TEST: '1',
    WT_CONFIG_FILE: cfgFile,
    WT_PORT: String(port),
    WT_HOST: '127.0.0.1',
    WT_SPAWN_WORKER: '1',
    WT_WORKER_DATA_DIR: dataDir,
    WT_WORKER_QUIET: '1',
    WT_WORKER_NO_DEFAULT: '1',
    WT_WORKER_PIPE: process.platform === 'win32'
      ? `\\\\.\\pipe\\wt-264-${suffix}`
      : `/tmp/wt-264-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
  };
  // THE POINT OF THE WHOLE FIXTURE: PASS must come from the config, so that a config which
  // will not parse takes it to the `'admin'` literal. An inherited WT_PASS would set it
  // directly and close the route this spec exists to reach — silently, and the tests would
  // go green on a 403 that proves nothing.
  delete env.WT_PASS;
  delete env.WT_USER;

  const proc = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // POSIX: its own process group, so `stop()` can kill the group. On Windows the tree
    // is walked by pid instead (see stop()), and `detached` there would only detach a
    // console this process does not have.
    detached: process.platform !== 'win32',
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const handle = {
    base, cfgFile, proc,
    getOutput: () => out,
    // KILL THE TREE, NOT JUST THE PROCESS — because this server spawns a child that is
    // BUILT to outlive it. With `WT_SPAWN_WORKER` set, `server.js` spawns its own
    // `pty-worker.js`, and that worker is an IPC *server*: its `conn.on('close')` releases
    // the connection's refs and logs "web.js disconnected", it does not exit. Nothing on
    // the server side kills it either — `_spawnedWorker` is assigned once and never
    // touched again, and `gracefulShutdown` does not reach it; on Windows `proc.kill()` is
    // TerminateProcess, which runs no handler and spares descendants. So killing only the
    // parent can leave a worker holding a named pipe and this test's data dir.
    //
    // Raised in review. The direct before/after process count could NOT settle whether it
    // actually leaks here, because a concurrent full-suite run has `hot-reload.spec.js`
    // spawning and reaping workers of its own the whole time — so the number moves for
    // reasons that have nothing to do with this. Rather than tune a measurement, the
    // teardown is simply made unconditionally correct: it costs one call, and "we counted
    // and it looked fine" is not a teardown.
    //
    // `taskkill /T` ON A PID THIS FUNCTION RECORDED ITSELF — never a name, never a
    // command-line substring. That distinction is the one this repo has already paid for
    // once, when a `-match 'playwright|server|7681'` filter killed production and its
    // supervisor. Every process it reaches is one this call created.
    async stop() {
      try {
        if (process.platform === 'win32') {
          if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else if (proc.pid) {
          process.kill(-proc.pid, 'SIGKILL');   // the group created by `detached` above
        }
      } catch (e) { /* already gone */ }
      try { proc.kill(); } catch (e) {}
      await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
    },
  };

  // Wait for it to answer. A generous ceiling rather than a fitted one: what it bounds is
  // how long a server that will NEVER come up takes to surface, and every finite value
  // catches that — being wrong high costs seconds on an already-fatal failure, being wrong
  // low throws away a run (the #253/#254 argument, applied to a startup).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) break;
    try {
      const probe = await pwRequest.newContext({ baseURL: base });
      const r = await probe.get('/login', { timeout: 2000 });
      await probe.dispose();
      if (r.status() < 500) return handle;
    } catch (e) { /* not listening yet */ }
  }
  await handle.stop();
  throw new Error(`isolated server never answered on ${base}. Output:\n${out.slice(0, 2000)}`);
}

/** Log in with the DEFAULT credentials — which is what a corrupt config hands out. */
async function defaultCredCtx(base) {
  const ctx = await pwRequest.newContext({ baseURL: base });
  const res = await ctx.post('/login', {
    form: { user: 'admin', password: 'admin' },
    maxRedirects: 0,
  });
  const setCookie = res.headers()['set-cookie'];
  expect(setCookie, 'a corrupt config drops PASS to the default, so admin/admin must log in')
    .toBeTruthy();
  await ctx.dispose();
  return pwRequest.newContext({
    baseURL: base,
    extraHTTPHeaders: { Cookie: setCookie.split(';')[0] },
  });
}

test.describe('#264: POST /api/setup never replaces a merge base it could not read', () => {
  let dir;

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt264-'));
  });
  test.afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  });

  test('an UNREADABLE config is refused, and the file is left exactly as it was', async () => {
    // The fixture has to actually be unparseable, or the whole test is about nothing.
    let parsed = true;
    try { JSON.parse(CORRUPT); } catch (e) { parsed = false; }
    expect(parsed, 'the CORRUPT fixture must not parse or this test proves nothing').toBe(false);

    const srv = await startIsolatedServer(dir, CORRUPT);
    try {
      // The chain's own precondition, asserted rather than assumed: the corruption is what
      // drops this server to the default password. Without this line a 500 below could
      // equally mean the route was never open.
      expect(srv.getOutput(), 'a corrupt config must drop the server to the default password')
        .toContain('DEFAULT PASSWORD IN USE');

      const ctx = await defaultCredCtx(srv.base);
      const res = await ctx.post('/api/setup', {
        data: { user: 'wt264user', password: 'wt264-password' },
      });

      // THE STATUS. 200 was the old answer, and it was the misleading half.
      expect(res.status(), 'setup with an unreadable merge base must not report success')
        .toBe(500);

      // THE OUTCOME, which is what actually separates the two behaviours: under the old
      // code this file now reads `{"user":"wt264user","password":"$scrypt$…"}` and the
      // cluster is gone. Proven by toggling the guard off: 200, and the file replaced.
      const after = fs.readFileSync(srv.cfgFile, 'utf8');
      expect(after, 'a refused setup must not write the file at all').toBe(CORRUPT);
      expect(after).toContain('wt264-peer');

      const body = await res.json();
      expectNoServerPath(body, 'POST /api/setup');
      expect(body.error, 'the refusal must still say what to do').toMatch(/config(\.test)?\.json/);
      await ctx.dispose();
    } finally {
      await srv.stop();
    }
  });

  test('an ABSENT config still completes setup — the trap in the obvious fix', async () => {
    // Refusing whenever the merge base is EMPTY would refuse this, which is the one state
    // `/api/setup` exists for: a server that has never been configured. ABSENT versus
    // UNREADABLE is the whole distinction, so both directions are pinned.
    const srv = await startIsolatedServer(dir, null);
    try {
      expect(fs.existsSync(srv.cfgFile),
        'the file must really be gone or this test proves nothing').toBe(false);

      const ctx = await defaultCredCtx(srv.base);
      const res = await ctx.post('/api/setup', {
        data: { user: 'wt264user', password: 'wt264-password' },
      });
      expect(res.status(), 'a first run has no config at all and must still be able to set up')
        .toBe(200);

      const written = JSON.parse(fs.readFileSync(srv.cfgFile, 'utf8'));
      expect(written.user).toBe('wt264user');
      expect(String(written.password).startsWith('$scrypt$'),
        'the password must be stored hashed, never in the clear').toBe(true);
      await ctx.dispose();
    } finally {
      await srv.stop();
    }
  });
});

// ============================================================================
// POST /api/cluster/register — reachable on the suite's own server
// ============================================================================
test.describe('#264: POST /api/cluster/register never replaces a merge base it could not read', () => {
  let ctx;
  let token = '';
  let saved = null;          // the suite config's original bytes, or null if it was absent
  let savedCluster;          // and its cluster array, for putting the live cache back
  let savedName;             // …and its serverName, for the same reason

  test.beforeAll(async () => {
    ctx = await authCtx();
    const t = await ctx.post('/api/auth/token', {
      data: { user: AUTH.user, password: AUTH.password, label: 'wt264-register' },
    });
    token = (await t.json()).token;
    expect(token, 'the register route is bearer-authed; without a token nothing is tested')
      .toBeTruthy();
    try { saved = fs.readFileSync(SUITE_CONFIG, 'utf8'); } catch (e) { saved = null; }
    const served = await (await ctx.get('/api/config')).json();
    savedCluster = Array.isArray(served.cluster) ? served.cluster : [];
    savedName = served.serverName;
  });

  test.afterAll(async () => {
    // Put the file back FIRST, then push the same content through PUT /api/config. The
    // second step is not belt-and-braces: `writeConfig` sets the server's live-config
    // CACHE, so a restore that only touches the disk leaves a peer at a dead port in
    // `getClusterConfig()` for up to LIVE_CONFIG_TTL (5s) — long enough for the next
    // spec's /api/cluster/sessions to try to reach it.
    //
    // When the file was ABSENT to begin with, the PUT recreates one. That is deliberate
    // and is #257's precedent: `_refreshLiveConfig` SKIPS a file that is missing, so
    // deleting it would pin the bogus cluster in cache for the rest of the run instead of
    // clearing it. A file carrying the values the run already expects is the lesser evil,
    // which is why the serverName is re-sent rather than left to the merge.
    try {
      if (saved === null) { try { fs.unlinkSync(SUITE_CONFIG); } catch (e) {} }
      else fs.writeFileSync(SUITE_CONFIG, saved, 'utf8');
      await ctx.put('/api/config', { data: { cluster: savedCluster, serverName: savedName } });
    } catch (e) { /* best effort — the next run deletes this file anyway (#240) */ }
    try { await ctx.delete('/api/auth/tokens/' + token); } catch (e) {}
    await ctx.dispose();
  });

  async function register(url) {
    const bearer = await pwRequest.newContext({
      baseURL: 'http://127.0.0.1:17681',
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    const res = await bearer.post('/api/cluster/register', {
      data: { name: 'wt264-registrant', url, token: 'wt264-peer-token' },
    });
    const out = { status: res.status(), body: await res.json().catch(() => ({})) };
    await bearer.dispose();
    return out;
  }

  test('an UNREADABLE config is refused, and the file is left exactly as it was', async () => {
    fs.writeFileSync(SUITE_CONFIG, CORRUPT, 'utf8');

    const res = await register('http://127.0.0.1:2');
    expect(res.status, 'registering over an unreadable merge base must not report success')
      .toBe(500);

    // The outcome. Under the old code this file now reads `{"cluster":[…]}` alone — no
    // `user`, no `password` — and the next restart of this server boots on `admin`.
    const after = fs.readFileSync(SUITE_CONFIG, 'utf8');
    expect(after, 'a refused registration must not write the file at all').toBe(CORRUPT);

    expectNoServerPath(res.body, 'POST /api/cluster/register');
    expect(res.body.error, 'the refusal must still say what to do').toMatch(/config(\.test)?\.json/);
  });

  test('an ABSENT config still accepts a registration — the trap in the obvious fix', async () => {
    try { fs.unlinkSync(SUITE_CONFIG); } catch (e) {}
    expect(fs.existsSync(SUITE_CONFIG),
      'the file must really be gone or this test proves nothing').toBe(false);

    const url = 'http://127.0.0.1:3';
    const res = await register(url);
    expect(res.status, 'a fresh server has no config.json and must still accept a peer')
      .toBe(200);

    const written = JSON.parse(fs.readFileSync(SUITE_CONFIG, 'utf8'));
    expect(written.cluster.some((s) => s.url === url),
      'the first registration must create the file and land the peer').toBe(true);
  });
});

// ============================================================================
// The gate for ROUTE NUMBER FOUR
// ============================================================================
// #257 fixed one route. #264 found the same defect on two more, four weeks later, by
// review rather than by a test — because no behavioural test can see a route that does not
// exist yet. This is the same argument `tests/app-input-path.spec.js` makes for its funnel
// and `tests/legacy-route-redirect.spec.js` makes for its unserved page: the property is
// about the SOURCE, and a route added next year would leave every behavioural test in this
// file green.
//
// STATE THE PREDICATE. The discriminator is structural, not an allowlist: `^app.` at column
// 0 is where a route handler begins, and the startup password auto-hash sits ABOVE the
// first one — it is not reachable from the network at all, and its own condition
// (`!DEFAULT_PASSWORDS.includes(PASS)`) already excludes the unreadable case, because an
// unreadable config leaves PASS on the `'admin'` literal. So "inside a route handler" is
// exactly the set that needs the guard, and nothing is exempted by name.
//
// WHAT IT DOES NOT PROVE, said plainly rather than implied. The guard is detected
// TEXTUALLY: the strings `readConfigResult()` and `base.ok` appearing somewhere in the
// route's span. It therefore constrains an IDIOM, not a dataflow. A future route could
// satisfy it with those words in a comment above an unguarded write, and a correctly
// guarded route that named the variable `r` would go RED for the wrong reason. Both are
// acceptable in that direction: the false red gets read by a human, and the idiom being
// enforced is the one all three real routes already use. What would NOT be acceptable is
// silence, which is why the two positive controls below exist.
test.describe('#264: the rule, not just the three instances', () => {
  test('every writeConfig() inside a route handler is guarded by readConfigResult()', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split(/\r?\n/);
    const routeStart = (i) => {
      for (let k = i; k >= 0; k--) if (/^app\.(get|post|put|patch|delete|all|use)\(/.test(src[k])) return k;
      return -1;
    };

    const calls = [];
    src.forEach((line, i) => {
      if (line.includes('writeConfig(') && !line.includes('function writeConfig')) calls.push(i);
    });

    // A gate that scans nothing is indistinguishable from a gate that passes (#260). If
    // `writeConfig` is ever renamed, this must go red rather than silently approve.
    expect(calls.length, 'no writeConfig() call sites found — has it been renamed?')
      .toBeGreaterThan(2);

    const unguarded = [];
    let inRoute = 0;
    for (const i of calls) {
      const r = routeStart(i);
      if (r < 0) continue;                       // startup code, above every route
      inRoute++;
      const span = src.slice(r, i + 1).join('\n');
      if (!(span.includes('readConfigResult()') && span.includes('base.ok'))) {
        unguarded.push(`server.js:${i + 1} (route at :${r + 1} — ${src[r].trim().slice(0, 60)})`);
      }
    }

    // The positive control. If this ever reads 0, the scan found no route-borne writes and
    // the assertion below would pass for the wrong reason.
    expect(inRoute, 'no writeConfig() call was found inside a route handler')
      .toBeGreaterThan(0);
    expect(unguarded,
      'a route that writes config must first prove it could READ it (#257/#264), or a '
      + 'corrupt file turns the write into a replace that deletes every other setting')
      .toEqual([]);
  });
});
