// @ts-check
// The `inboxDigest` config block reaches the route (#383).
//
// inbox-digest.spec.js proves the library obeys the config it is HANDED; this proves the
// route hands it the right one - `enabled`, `model` and `command` from config.json. That
// needs servers of their own: the suite's server runs with the runner pinned to the fake
// CLI by an environment override that outranks `command`, and its config is not ours to
// vary. Each case below boots an isolated server (own config file, port, pipe and data
// dir, a real worker) and drops the override, so it is the CONFIG that decides.
const { test, expect, request: pwRequest } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { codexSessionsRoot, emptyCwd } = require('./test-helpers');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-digest-cli.js');
const FIXTURE_DIR = path.join(codexSessionsRoot(), '2098', '03', '02');
const created = [];

test.afterAll(() => {
  for (const p of created) { try { fs.unlinkSync(p); } catch { /* best effort */ } }
  try { fs.rmdirSync(FIXTURE_DIR); } catch { /* shared */ }
});

async function startServer(dir, inboxDigest) {
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ inboxDigest }), 'utf8');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'scrollback'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  // 17900-17999: clear of 17681, hot-reload's 17700s and #264's 17800s.
  const port = 17900 + Math.floor(Math.random() * 100);
  const suffix = crypto.randomUUID().slice(0, 8);
  const env = {
    ...process.env, WT_TEST: '1', WT_CONFIG_FILE: cfgFile, WT_PORT: String(port), WT_HOST: '127.0.0.1',
    WT_USER: 'testuser', WT_PASS: 'testpass:colon',
    WT_SPAWN_WORKER: '1', WT_WORKER_DATA_DIR: dataDir, WT_WORKER_QUIET: '1', WT_WORKER_NO_DEFAULT: '1',
    WT_WORKER_PIPE: process.platform === 'win32' ? `\\\\.\\pipe\\wt-383-${suffix}` : `/tmp/wt-383-${suffix}.sock`,
    WT_IPC_TOKEN: crypto.randomBytes(32).toString('base64'),
    FAKE_DIGEST_DIR: dir,
  };
  // THE POINT: with these set, the config would never be consulted.
  delete env.WT_INBOX_DIGEST_COMMAND;
  delete env.WT_INBOX_DIGEST_TIMEOUT_MS;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    // The tree, by the pid this function recorded: the server owns a worker that outlives it.
    try { if (proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    try { proc.kill(); } catch { /* gone */ }
    await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) break;
    try {
      const probe = await pwRequest.newContext({ baseURL: base });
      const r = await probe.get('/login', { timeout: 2000 });
      await probe.dispose();
      if (r.status() < 500) return { base, stop };
    } catch { /* not listening yet */ }
  }
  await stop();
  throw new Error(`isolated server never answered on ${base}:\n${out.slice(0, 2000)}`);
}

async function login(base) {
  const c = await pwRequest.newContext({ baseURL: base });
  const res = await c.post('/login', { form: { user: 'testuser', password: 'testpass:colon' }, maxRedirects: 0 });
  const cookie = res.headers()['set-cookie'].split(';')[0];
  await c.dispose();
  return pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { Cookie: cookie } });
}

/** A session on [ctx] whose Codex rollout holds one prompt and one prose ask. */
async function sessionWithAsk(ctx, label) {
  const cwd = emptyCwd(label);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, `rollout-2098-03-02T00-00-00-${process.pid}-${created.length}.jsonl`);
  const l = (type, payload, n) => JSON.stringify({ timestamp: `2098-03-02T00:00:0${n}.000Z`, type, payload });
  fs.writeFileSync(p, [
    l('session_meta', { id: `cfg-${created.length}`, cwd, cli_version: '0.144.0' }, 0),
    l('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tidy up' }] }, 1),
    l('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Delete build/?' }] }, 2),
  ].join('\n') + '\n', 'utf8');
  created.push(p);
  const r = await ctx.post('/api/sessions', { data: { name: label, cwd, agent: 'codex', autoCommand: '' } });
  return (await r.json()).id;
}

test.describe('config.json `inboxDigest` decides what the route does', () => {
  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cfg-')); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('enabled:false is 503 unavailable/disabled, and no run starts', async () => {
    const srv = await startServer(dir, { enabled: false, command: [process.execPath, FAKE] });
    try {
      const ctx = await login(srv.base);
      const id = await sessionWithAsk(ctx, 'cfg-disabled');
      const res = await ctx.get(`/api/sessions/${id}/digest`);
      expect(res.status()).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable', reason: 'disabled' });
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('run-'))).toHaveLength(0);
      await ctx.dispose();
    } finally { await srv.stop(); }
  });

  test('a command that is not there is 503 unavailable/no-cli', async () => {
    const srv = await startServer(dir, { command: [path.join(dir, 'no-such-dir', 'claude.exe')] });
    try {
      const ctx = await login(srv.base);
      const id = await sessionWithAsk(ctx, 'cfg-nocli');
      const res = await ctx.get(`/api/sessions/${id}/digest`);
      expect(res.status()).toBe(503);
      expect(await res.json()).toEqual({ status: 'unavailable', reason: 'no-cli' });
      await ctx.dispose();
    } finally { await srv.stop(); }
  });

  test('`command` and `model` from the config are what is run', async () => {
    const srv = await startServer(dir, { command: [process.execPath, FAKE], model: 'haiku' });
    try {
      const ctx = await login(srv.base);
      const id = await sessionWithAsk(ctx, 'cfg-run');
      const res = await ctx.get(`/api/sessions/${id}/digest`);
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ready', model: 'haiku' });
      const [run] = fs.readdirSync(dir).filter((f) => f.startsWith('run-')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      expect(run.argv[run.argv.indexOf('--model') + 1]).toBe('haiku');
      await ctx.dispose();
    } finally { await srv.stop(); }
  });

  test('`inboxDigest` is not settable over HTTP: `command` is something this server executes', async () => {
    const srv = await startServer(dir, {});
    try {
      const ctx = await login(srv.base);
      await ctx.put('/api/config', { data: { inboxDigest: { command: ['calc.exe'] } } });
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      expect(JSON.stringify(saved)).not.toContain('calc.exe');
      await ctx.dispose();
    } finally { await srv.stop(); }
  });
});
