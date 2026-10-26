// scripts/claude-account.js — switch this machine's Claude login between saved accounts (#389).
//
// The script's whole job is a filesystem effect on two files that also hold things it
// must never touch (mcpOAuth beside the login; ~100 other keys beside oauthAccount), so
// it is driven as a real child process against an isolated HOME and the files are
// compared byte for byte.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, authCtx } = require('./test-helpers');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'claude-account.js');

const ACCOUNT_A = {
  oauth: { accessToken: 'access-A-secret', refreshToken: 'refresh-A-secret', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 20 * 864e5, subscriptionType: 'max' },
  account: { accountUuid: 'uuid-a', emailAddress: 'a@example.com', organizationName: 'A org' },
};
const ACCOUNT_B = {
  oauth: { accessToken: 'access-B-secret', refreshToken: 'refresh-B-secret', expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 3 * 864e5, subscriptionType: 'pro' },
  account: { accountUuid: 'uuid-b', emailAddress: 'b@example.com', organizationName: 'B org' },
};
const MCP = { 'plugin:x|1': { accessToken: 'mcp-secret', expiresAt: 1 } };

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-claude-account-'));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}
const credFile = (home) => path.join(home, '.claude', '.credentials.json');
const configFile = (home) => path.join(home, '.claude.json');

// Written the way Claude Code writes them: credentials compact, .claude.json indented.
function login(home, who) {
  fs.writeFileSync(credFile(home), JSON.stringify({ mcpOAuth: MCP, claudeAiOauth: who.oauth }));
  const config = fs.existsSync(configFile(home)) ? JSON.parse(fs.readFileSync(configFile(home), 'utf8')) : { numStartups: 3, projects: { 'C:/x': { a: 1 } } };
  fs.writeFileSync(configFile(home), JSON.stringify({ ...config, oauthAccount: who.account }, null, 2) + '\n');
}

function run(home, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test.describe('claude-account', () => {
  test('switch writes the saved login and leaves everything else in both files as it was', () => {
    const home = makeHome();
    login(home, ACCOUNT_A);
    expect(run(home, 'save').code).toBe(0);
    login(home, ACCOUNT_B); // what a manual /login to B leaves behind
    const credBefore = JSON.parse(fs.readFileSync(credFile(home), 'utf8'));
    const configBefore = JSON.parse(fs.readFileSync(configFile(home), 'utf8'));

    const r = run(home, 'switch', 'a@example.com');
    expect(r.code, r.out).toBe(0);

    const cred = JSON.parse(fs.readFileSync(credFile(home), 'utf8'));
    const config = JSON.parse(fs.readFileSync(configFile(home), 'utf8'));
    expect(cred).toEqual({ ...credBefore, claudeAiOauth: ACCOUNT_A.oauth });
    expect(config).toEqual({ ...configBefore, oauthAccount: ACCOUNT_A.account });
    expect(JSON.stringify(cred.mcpOAuth)).toBe(JSON.stringify(MCP));
    // The files keep their own layout.
    expect(fs.readFileSync(credFile(home), 'utf8')).not.toContain('\n');
    expect(fs.readFileSync(configFile(home), 'utf8')).toMatch(/^\{\n {2}"numStartups"/);
  });

  test('switch saves the current login first, so switching back restores it', () => {
    const home = makeHome();
    login(home, ACCOUNT_A);
    run(home, 'save');
    login(home, ACCOUNT_B); // B was never saved by hand
    expect(run(home, 'switch', 'a@example.com').code).toBe(0);
    const r = run(home, 'switch', 'b@example.com');
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(credFile(home), 'utf8')).claudeAiOauth).toEqual(ACCOUNT_B.oauth);
    expect(JSON.parse(fs.readFileSync(configFile(home), 'utf8')).oauthAccount).toEqual(ACCOUNT_B.account);
  });

  test('refuses, changing nothing, when a login file is empty, not JSON, or missing', () => {
    for (const bad of ['{}', '{"oauthAccount":', null]) {
      const home = makeHome();
      login(home, ACCOUNT_A);
      run(home, 'save');
      login(home, ACCOUNT_B);
      if (bad === null) fs.unlinkSync(configFile(home)); else fs.writeFileSync(configFile(home), bad);
      const credText = fs.readFileSync(credFile(home), 'utf8');

      const r = run(home, 'switch', 'a@example.com');
      expect(r.code, r.out).toBe(2);
      expect(r.out).toContain('nothing was changed');
      expect(fs.readFileSync(credFile(home), 'utf8')).toBe(credText);
      if (bad === null) expect(fs.existsSync(configFile(home))).toBe(false);
      else expect(fs.readFileSync(configFile(home), 'utf8')).toBe(bad);
    }
  });

  test('a label cannot name a file outside the account store, or a device', () => {
    const home = makeHome();
    login(home, ACCOUNT_A);
    for (const label of ['../evil', 'a/b', 'a\\b', '..', 'NUL', 'con.backup', 'COM1']) {
      const r = run(home, 'save', label);
      expect(r.code, label).toBe(2);
      expect(r.out).toContain('not a usable label');
    }
    expect(fs.existsSync(path.join(home, '.config', 'web-terminal', 'evil.json'))).toBe(false);
  });

  test('never prints a token, and warns when a saved refresh token is about to expire', () => {
    const home = makeHome();
    login(home, ACCOUNT_B);
    run(home, 'save');
    login(home, ACCOUNT_A);
    const outputs = [run(home, 'save'), run(home, 'status'), run(home, 'switch', 'b@example.com'), run(home, 'status')]
      .map((r) => r.out).join('\n');
    expect(outputs).not.toMatch(/secret/);
    expect(run(home, 'status').out).toContain('WARNING: refresh token expires within 7 days');
  });

  test('a switch to an unknown account changes nothing', () => {
    const home = makeHome();
    login(home, ACCOUNT_A);
    const credText = fs.readFileSync(credFile(home), 'utf8');
    const r = run(home, 'switch', 'nobody@example.com');
    expect(r.code).toBe(2);
    expect(r.out).toContain('no saved account');
    expect(fs.readFileSync(credFile(home), 'utf8')).toBe(credText);
  });
});

// The routes behind the companion's per-machine "Switch account". The test server reads
// the home playwright.config.js puts in WT_CLAUDE_ACCOUNT_HOME, never the real one.
test.describe('/api/claude-account', () => {
  const home = process.env.WT_CLAUDE_ACCOUNT_HOME;
  let ctx;
  test.beforeAll(async () => { ctx = await authCtx(); });
  test.afterAll(async () => { await ctx.dispose(); });
  test.beforeEach(() => {
    expect(home, 'playwright.config.js sets WT_CLAUDE_ACCOUNT_HOME').toBeTruthy();
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  test('is advertised, reads the login, switches it, and never sends a token', async () => {
    const version = await (await ctx.get('/api/version')).json();
    expect(version.capabilities).toContain('claude-account');

    login(home, ACCOUNT_A);
    expect(run(home, 'save').code).toBe(0);
    login(home, ACCOUNT_B);

    const st = await ctx.get('/api/claude-account');
    expect(st.status()).toBe(200);
    const status = await st.json();
    expect(status.active).toMatchObject({ email: 'b@example.com', label: null });
    expect(status.saved.map((s) => s.email)).toEqual(['a@example.com']);

    const sw = await ctx.post('/api/claude-account/switch', { data: { account: 'a@example.com' } });
    expect(sw.status()).toBe(200);
    const body = await sw.text();
    expect(body).not.toMatch(/secret/);
    expect(JSON.parse(body)).toMatchObject({ from: 'b@example.com', to: 'a@example.com', alreadyActive: false });
    expect(JSON.parse(fs.readFileSync(credFile(home), 'utf8')).claudeAiOauth).toEqual(ACCOUNT_A.oauth);
    // B was saved before the switch, so the companion can switch straight back.
    expect(JSON.parse(body).status.saved.map((s) => s.email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  test('a refusal is a 409 with the reason, and the files are untouched', async () => {
    login(home, ACCOUNT_A);
    run(home, 'save');
    login(home, ACCOUNT_B);
    fs.writeFileSync(configFile(home), '{}');
    const credText = fs.readFileSync(credFile(home), 'utf8');
    const r = await ctx.post('/api/claude-account/switch', { data: { account: 'a@example.com' } });
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toContain('nothing was changed');
    expect(fs.readFileSync(credFile(home), 'utf8')).toBe(credText);
    expect(fs.readFileSync(configFile(home), 'utf8')).toBe('{}');
  });

  test('a switch without an account is a 400', async () => {
    const r = await ctx.post('/api/claude-account/switch', { data: {} });
    expect(r.status()).toBe(400);
  });

  test('save keeps the current login', async () => {
    login(home, ACCOUNT_A);
    const r = await ctx.post('/api/claude-account/save', { data: {} });
    expect(r.status()).toBe(200);
    expect((await r.json()).status.active.label).toBe('a@example.com');
  });

  test('every route needs auth', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE });
    for (const [method, url] of [['get', '/api/claude-account'], ['post', '/api/claude-account/switch'], ['post', '/api/claude-account/save']]) {
      const r = await anon[method](url, { data: method === 'post' ? { account: 'a@example.com' } : undefined, maxRedirects: 0 });
      expect([401, 302], `${method} ${url}`).toContain(r.status());
    }
    await anon.dispose();
  });
});
