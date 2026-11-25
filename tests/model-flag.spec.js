// #533 - the model for a task: `--model <m>` goes INSIDE the claude call of a started session's command
// (lib/model-flag.js, the one owner shared with the supervisor dispatcher, #525). Every assertion is on
// the behaviour a caller sees - the placed command, the 400 body, the STORED command - never on a copy
// of the implementation.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { parseModel, applyModel, withModel, modelOf } = require('../lib/model-flag');
const cases = require('../lib/supervisor-cases');
const { BASE, authCtx } = require('./test-helpers');

const placed = (cmd, model) => applyModel(cmd, model).cmd;

test.describe('#533 model-flag rule', () => {
  test('the flag goes right after the claude program word, inside the call', () => {
    expect(placed('claude --dangerously-skip-permissions "go"', 'sonnet')).toBe('claude --model sonnet --dangerously-skip-permissions "go"');
    // The first cut appended to the end of the line: `exit` / `bash` got the flag, claude ran on the default model.
    expect(placed('claude "go"; exit', 'sonnet')).toBe('claude --model sonnet "go"; exit');
    expect(placed('cd X && claude "go" || bash', 'claude-sonnet-5-5')).toBe('cd X && claude --model claude-sonnet-5-5 "go" || bash');
    expect(placed('FOO=1 npx claude -c', 'opus')).toBe('FOO=1 npx claude --model opus -c');
    expect(placed('./claude', 'haiku')).toBe('./claude --model haiku');
    expect(placed('claude --models-dir x', 'sonnet')).toBe('claude --model sonnet --models-dir x'); // only --model itself is a model
  });
  test('a command with no claude call, or one a shell could read differently, is refused with the reason', () => {
    for (const cmd of ['echo hi', 'codex -m gpt-5', 'git -C ~/work/claude pull', '', 'claude "$(x)"', 'claude "go" # note']) {
      const r = applyModel(cmd, 'sonnet');
      expect(r.cmd, cmd).toBeUndefined();
      expect(r.error, cmd).toMatch(/only for claude|plain shell line/);
    }
    expect(applyModel('echo hi', null)).toEqual({ cmd: 'echo hi' }); // no model asked: nothing to refuse
  });
  test('the call\'s own model wins; a --model inside its prompt is not its model', () => {
    expect(placed('claude --model opus "go"', 'sonnet')).toBe('claude --model opus "go"');
    expect(placed('claude --model=opus', 'sonnet')).toBe('claude --model=opus');
    expect(modelOf('claude --model sonnet --x')).toBe('sonnet');
    expect(modelOf('claude --model=opus')).toBe('opus');
    expect(modelOf('claude --model opus --model haiku')).toBe('haiku'); // the last one wins, as in claude
    expect(modelOf('claude "fix it --model haiku"')).toBeNull();
    // A flag with an optional value (--resume, --debug) or an unknown one must not swallow the --model after it:
    // the flag was then added over the user's own, claude ran on the user's model and the answer named ours.
    for (const cmd of ['claude --resume --model opus', 'claude -r --model opus', 'claude --debug --model opus "go"', 'claude --foo --model opus "go"']) {
      expect(modelOf(cmd), cmd).toBe('opus');
      expect(placed(cmd, 'sonnet'), cmd).toBe(cmd); // its own choice wins: nothing is added
    }
    expect(modelOf('claude --model --verbose')).toBeNull(); // a dangling --model names no model
    expect(placed('claude "fix it --model haiku"', 'sonnet')).toBe('claude --model sonnet "fix it --model haiku"');
    expect(modelOf('claude "go"; other --model x')).toBeNull(); // past the operator it is not claude's
    expect(modelOf('echo hi --model opus')).toBeNull();
  });
  test('a name with brackets is quoted in the command (a bash glob otherwise) and still read back', () => {
    expect(placed('claude "go"', 'opus[1m]')).toBe("claude --model 'opus[1m]' \"go\"");
    expect(modelOf(placed('claude "go"', 'opus[1m]'))).toBe('opus[1m]');
  });
  test('withModel is the dispatcher\'s form: placed when it can be, the command as written when not', () => {
    expect(withModel('claude --verbose', 'sonnet')).toBe('claude --model sonnet --verbose');
    expect(withModel('printf x; echo claude', 'sonnet')).toBe('printf x; echo claude');
    expect(withModel('claude', null)).toBe('claude');
    expect(cases.withModel).toBe(withModel);
  });
});

test.describe('#533 ONE model-name check', () => {
  const NAMES = ['sonnet', 'opus', 'haiku', 'claude-sonnet-5-5', 'opus[1m]', 'sonnet[1m]', 'a.b_c-d',
    '', 'sonnet; calc', 'a b', '$(x)', '--x', 'x'.repeat(80), 'opus[1m', 'opus[]', 'opus[1m]x', 'op us[1m]', '[1m]'];
  test('parseModel and the supervisor dispatcher\'s config accept and refuse the same strings', () => {
    for (const s of NAMES) {
      const viaPost = !!parseModel(s).model;
      const d = cases.dispatcherConfig({ dispatcher: { model: s } });
      const viaConfig = s !== '' && d.modelRefused === null; // '' means "run the command as written", not a name
      if (s === '') { expect(d.model, 'empty: no model').toBeNull(); continue; }
      expect(viaConfig, `dispatcher.model ${JSON.stringify(s)}`).toBe(viaPost);
      expect(d.model, s).toBe(viaPost ? s : 'sonnet');
    }
  });
  test('no second copy of the model-name pattern exists in the server, its libs or the worker', () => {
    const root = path.join(__dirname, '..');
    const files = ['server.js', 'pty-worker.js', 'monitor.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
    const needle = ['/^[A-Za-z0-9][A-Za-z0-9._-]', '{0,63}'].join(''); // the pattern a model-name copy starts with (lib/leases.js's resource names have a prefix)
    const owners = files.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes(needle));
    expect(owners).toEqual(['lib/model-flag.js']);
    const named = ['MODEL', 'RE'].join('_'); // and no second validator under the same name
    const wholeWord = new RegExp(`\\b${named}\\b`);
    expect(files.filter((f) => wholeWord.test(fs.readFileSync(path.join(root, f), 'utf8')))).toEqual(['lib/model-flag.js']);
  });
  test('parseModel refuses what is not a name', () => {
    expect(parseModel(undefined)).toEqual({ model: null });
    expect(parseModel(null)).toEqual({ model: null });
    for (const bad of ['sonnet; rm -rf /', 'a b', '$(x)', '--x', 'x'.repeat(80), 5, {}, []]) expect(parseModel(bad).error, String(bad)).toBeTruthy();
  });
});

test.describe('#533 POST /api/sessions model', () => {
  const KEY = `M533-${Date.now()}`;
  let n = 0;
  async function setup() {
    const ctx = await authCtx();
    const ids = [];
    const make = async (data) => {
      const r = await ctx.post(`${BASE}/api/sessions`, { data: { name: `${KEY}-${++n}`, ...data } });
      const body = await r.json();
      if (body.id) ids.push(body.id);
      return { status: r.status(), body };
    };
    const rows = async () => (await (await ctx.get(`${BASE}/api/sessions`)).json());
    const stored = async (id) => (await rows()).find((s) => s.id === id).autoCommand; // what the worker holds and typed
    const done = async () => { for (const id of ids) { try { await ctx.delete(`${BASE}/api/sessions/${id}`); } catch { /* gone */ } } await ctx.dispose(); };
    return { make, rows, stored, done };
  }

  test('the flag is inside the claude call, and the answer names the model of the STORED command', async () => {
    const t = await setup();
    try {
      const r = await t.make({ autoCommand: './claude "go"; echo done', model: 'sonnet' });
      expect(r.status).toBe(200);
      const cmd = await t.stored(r.body.id);
      expect(cmd).toBe('./claude --model sonnet "go"; echo done');
      expect(r.body.model).toBe('sonnet');
      expect(modelOf(cmd)).toBe(r.body.model);
      const own = await t.make({ autoCommand: './claude --model opus "go"', model: 'sonnet' });
      expect(await t.stored(own.body.id)).toBe('./claude --model opus "go"'); // its own choice wins
      expect(own.body.model).toBe('opus');
      const prompt = await t.make({ autoCommand: './claude "fix it --model haiku"' }); // no model asked: nothing is added or reported
      expect(await t.stored(prompt.body.id)).toBe('./claude "fix it --model haiku"');
      expect(prompt.body.model).toBeNull();
      const br = await t.make({ autoCommand: './claude "go"', model: 'opus[1m]' });
      expect(br.status).toBe(200);
      expect(await t.stored(br.body.id)).toBe('./claude --model \'opus[1m]\' "go"');
      expect(br.body.model).toBe('opus[1m]');
    } finally { await t.done(); }
  });

  test('a command with no claude call, or an unreadable one, is a 400 naming why; nothing is created', async () => {
    const t = await setup();
    try {
      const before = (await t.rows()).length;
      const a = await t.make({ autoCommand: 'echo hi', model: 'sonnet' });
      expect(a.status).toBe(400);
      expect(a.body.error).toMatch(/only for claude/);
      const b = await t.make({ autoCommand: 'codex -m gpt-5', model: 'sonnet' });
      expect(b.status).toBe(400);
      const c = await t.make({ autoCommand: './claude "$(x)"', model: 'sonnet' });
      expect(c.status).toBe(400);
      expect(c.body.error).toMatch(/plain shell line/);
      expect((await t.rows()).length).toBe(before);
      const plain = await t.make({ autoCommand: 'echo hi' }); // no model asked: any command still starts
      expect(plain.status).toBe(200);
      expect(plain.body.model).toBeNull();
    } finally { await t.done(); }
  });

  test('a flag that would push the command past 500 characters is a 400, never cut; exactly 500 is stored whole', async () => {
    const t = await setup();
    try {
      const model = 'claude-sonnet-5-5';
      const flagLen = ` --model ${model}`.length;
      const withPad = (len) => `./claude "${'x'.repeat(len - './claude ""'.length)}"`;
      const before = (await t.rows()).length;
      const over = await t.make({ autoCommand: withPad(500 - flagLen + 1), model });
      expect(over.status).toBe(400);
      expect(over.body.error).toMatch(/500/);
      const cut = await t.make({ autoCommand: withPad(495), model }); // the reviewed case: stored as `... --mo`
      expect(cut.status).toBe(400);
      expect((await t.rows()).length).toBe(before);
      const fits = await t.make({ autoCommand: withPad(500 - flagLen), model });
      expect(fits.status).toBe(200);
      const cmd = await t.stored(fits.body.id);
      expect(cmd.length).toBe(500);
      expect(cmd.startsWith(`./claude --model ${model} "`) && cmd.endsWith('"')).toBe(true);
      expect(fits.body.model).toBe(model);
      expect(modelOf(cmd)).toBe(fits.body.model);
    } finally { await t.done(); }
  });

  test('a malformed or bracketed name: POST agrees with the dispatcher check, and a refusal creates nothing', async () => {
    const t = await setup();
    try {
      const before = (await t.rows()).length;
      for (const bad of ['sonnet; calc', 'a b', '--x', 'x'.repeat(80), 'opus[1m', 5]) {
        const r = await t.make({ autoCommand: './claude "go"', model: bad });
        expect(r.status, String(bad)).toBe(400);
        expect(r.body.error).toMatch(/model must be a model name/);
        expect(cases.dispatcherConfig({ dispatcher: { model: bad } }).modelRefused, String(bad)).not.toBeNull();
      }
      expect((await t.rows()).length).toBe(before);
      for (const ok of ['sonnet', 'sonnet[1m]']) {
        const r = await t.make({ autoCommand: './claude "go"', model: ok });
        expect(r.status, ok).toBe(200);
        expect(cases.dispatcherConfig({ dispatcher: { model: ok } }).modelRefused, ok).toBeNull();
      }
    } finally { await t.done(); }
  });
});
