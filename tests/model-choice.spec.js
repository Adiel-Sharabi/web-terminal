// @ts-check
// #533 - Start work's model picker, server side: lib/model-choice.js (the kinds of work, the model each
// suggests, the request's `kind` / `model`, the brief's model line) and how lib/mc-start.js puts the
// choice into the launch command. Pure, from synthetic fixtures. The routes are pinned in
// mc-routes.spec.js; the flag's placement itself in model-flag.spec.js.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const C = require('../lib/model-choice');
const S = require('../lib/mc-start');
const { modelOf } = require('../lib/model-flag');
const { parseRef } = require('../lib/tracker-meta');
const pj = require('../lib/projects');

const PROJECTS = pj.validateProjects([
  { id: 'widgets', name: 'Widgets', match: { repos: ['acme/widgets'], paths: ['C:\\dev\\widgets'] } },
]).projects;
const base = { project: 'widgets', subjects: ['#42'], server: 'alpha' };
const parse = (extra) => S.parseStart({ ...base, ...extra }, { projects: PROJECTS, parseRef });
const plan = (extra, opts) => S.startPlan(parse(extra).value, opts);
const CLAUDE = 'claude --dangerously-skip-permissions';
const promptOf = (autoCommand) => autoCommand.slice(autoCommand.indexOf('"') + 1, -1);

test.describe('#533 the kinds of work and the model each suggests', () => {
  test('routine work -> sonnet, lookups -> haiku, design-heavy -> the default model (no flag)', () => {
    const model = (id) => C.kindById(id).model;
    expect([model('fix'), model('run'), model('lookup'), model('design')]).toEqual(['sonnet', 'sonnet', 'haiku', null]);
    expect(C.kindById('nope')).toBeNull();
    expect(C.DEFAULT_KIND).toEqual({ subjects: 'fix', hunt: 'design' }); // a hunt is open-ended: the stronger model
  });

  test('the catalogue a client draws the picker from names every kind, model and default', () => {
    const c = C.catalogue();
    expect(c.kinds.map((k) => k.id)).toEqual(['fix', 'run', 'lookup', 'design']);
    expect(c.kinds.find((k) => k.id === 'design')).toMatchObject({ model: null });
    expect(c.models.map((m) => m.id)).toEqual(['default', 'sonnet', 'haiku']);
    expect(c.defaults).toEqual({ subjects: 'fix', hunt: 'design' });
    expect(c.defaultModel).toBe('default');
    // Every default names a kind the list holds, and every suggested model is one the picker offers.
    for (const id of Object.values(c.defaults)) expect(c.kinds.some((k) => k.id === id)).toBe(true);
    for (const k of c.kinds) if (k.model) expect(c.models.some((m) => m.id === k.model)).toBe(true);
  });
});

test.describe('#533 the request: kind and model', () => {
  test('neither: no choice, so the session starts as it did before the picker', () => {
    expect(C.parseChoice({})).toEqual({ choice: null });
    expect(C.parseChoice({ kind: '', model: null })).toEqual({ choice: null });
    expect(parse({}).value.choice).toBeNull();
  });

  test('a kind alone takes its suggested model; a model wins over it; `default` is no flag', () => {
    expect(C.parseChoice({ kind: 'fix' }).choice).toEqual({ kind: 'fix', model: 'sonnet', suggested: 'sonnet' });
    expect(C.parseChoice({ kind: 'lookup' }).choice).toEqual({ kind: 'lookup', model: 'haiku', suggested: 'haiku' });
    expect(C.parseChoice({ kind: 'design' }).choice).toEqual({ kind: 'design', model: null, suggested: null });
    expect(C.parseChoice({ kind: 'fix', model: 'haiku' }).choice).toEqual({ kind: 'fix', model: 'haiku', suggested: 'sonnet' });
    expect(C.parseChoice({ kind: 'fix', model: 'default' }).choice).toEqual({ kind: 'fix', model: null, suggested: 'sonnet' });
    expect(C.parseChoice({ model: 'sonnet' }).choice).toEqual({ kind: null, model: 'sonnet' });
    expect(C.parseChoice({ model: 'default' }).choice).toEqual({ kind: null, model: null });
  });

  test('a kind or model that is not one is refused in words, never guessed (one name check: lib/model-flag.js)', () => {
    expect(C.parseChoice({ kind: 'fixes' }).error).toContain('kind must be one of fix, run, lookup, design');
    expect(C.parseChoice({ kind: 5 }).error).toContain('kind must be one of');
    for (const bad of ['sonnet; calc', 'a b', '--x', 'x'.repeat(80), 5, {}]) expect(C.parseChoice({ model: bad }).error, String(bad)).toContain('model must be default or a model name');
    expect(parse({ kind: 'nope' }).error).toContain('kind must be one of');
    expect(parse({ model: '$(x)' }).error).toContain('model must be');
  });
});

test.describe('#533 the session it starts', () => {
  test('a routine fix runs on sonnet: the flag is inside the call, the brief says which model and why', () => {
    const p = plan({ kind: 'fix' }, { titles: { 'acme/widgets#42': 'Scroll jumps' }, command: CLAUDE });
    expect(p.error).toBeUndefined();
    expect(p.autoCommand.startsWith('claude --model sonnet --dangerously-skip-permissions "')).toBe(true);
    expect(promptOf(p.autoCommand)).toBe('Fix acme/widgets#42 (Scroll jumps) in project Widgets. Model: sonnet for a routine fix or small feature (the suggested model for this kind of work).');
    expect(p.model).toBe('sonnet');
    expect(modelOf(p.autoCommand)).toBe(p.model); // the answer names the model of the command that is typed
    expect(p.goal).toBe('Fix acme/widgets#42 (Scroll jumps) in project Widgets.'); // the goal stays the task
  });

  test('a design-heavy start runs on the default model: no flag, and the brief says so', () => {
    const p = plan({ kind: 'design' }, { command: CLAUDE });
    expect(p.autoCommand.startsWith(`${CLAUDE} "`)).toBe(true);
    expect(p.autoCommand).not.toContain('--model');
    expect(promptOf(p.autoCommand)).toContain('Model: the default model for design, ambiguous or security work (the suggested model for this kind of work).');
    expect(p.model).toBeNull();
  });

  test('an override is recorded as one, with the suggestion it replaced', () => {
    const up = plan({ kind: 'fix', model: 'default' }, { command: CLAUDE });
    expect(up.autoCommand).not.toContain('--model');
    expect(promptOf(up.autoCommand)).toContain('Model: the default model for a routine fix or small feature (chosen when it was started; the suggested model for this kind is sonnet).');
    const down = plan({ kind: 'design', model: 'sonnet' }, { command: CLAUDE });
    expect(down.autoCommand.startsWith('claude --model sonnet ')).toBe(true);
    expect(promptOf(down.autoCommand)).toContain('Model: sonnet for design, ambiguous or security work (chosen when it was started; the suggested model for this kind is the default model).');
    const bare = plan({ model: 'haiku' }, { command: CLAUDE });
    expect(promptOf(bare.autoCommand)).toContain('Model: haiku (chosen when it was started).');
  });

  test('the line is the server\'s own words: nothing a shell acts on inside the double quotes', () => {
    for (const extra of [{ kind: 'fix' }, { kind: 'design', model: 'haiku' }, { model: 'claude-sonnet-5-5' }, { kind: 'run', model: 'default' }]) {
      const inside = promptOf(plan(extra, { command: CLAUDE }).autoCommand);
      expect(inside, JSON.stringify(extra)).not.toMatch(/[`$"\\!%^&|<>\r\n]/);
    }
  });

  test('the start command that names its own model wins, and the brief says what RUNS', () => {
    const p = plan({ kind: 'fix' }, { command: 'claude --model opus' });
    expect(p.autoCommand.startsWith('claude --model opus "')).toBe(true);
    expect(p.autoCommand).not.toContain('--model sonnet');
    expect(p.model).toBe('opus');
    expect(promptOf(p.autoCommand)).toContain('Model: opus for a routine fix or small feature (the start command names its own model).');
    // The default model chosen, the command still names one: it is what runs, so it is what is said.
    expect(promptOf(plan({ kind: 'design' }, { command: 'claude --model opus' }).autoCommand)).toContain('Model: opus for design, ambiguous or security work (the start command names its own model).');
  });

  test('a command that cannot take the flag is REFUSED with the reason, never started on another model', () => {
    const p = plan({ kind: 'fix' }, { command: 'echo' });
    expect(p.error).toMatch(/only for claude/);
    expect(p.autoCommand).toBeUndefined();
    // The default model needs no flag: any command starts, as before.
    expect(plan({ kind: 'design' }, { command: 'echo' }).autoCommand).toMatch(/^echo "/);
    expect(plan({}, { command: 'echo' }).autoCommand).toMatch(/^echo "/);
  });

  test('no choice: the launch command and brief are exactly what they were before the picker', () => {
    const p = plan({}, { command: CLAUDE });
    expect(p.autoCommand).toBe(`${CLAUDE} "Fix acme/widgets#42 in project Widgets."`);
    expect(p.model).toBeNull();
  });

  test('the flag and the line count against the brief\'s room: a brief that fits without a choice can be too long with one', () => {
    const brief = 'word '.repeat(70) + 'END';
    expect(plan({ brief }, { command: CLAUDE }).autoCommand.endsWith('END"')).toBe(true);
    const over = plan({ brief, kind: 'fix' }, { command: CLAUDE });
    expect(over.error).toMatch(/^the brief is \d+ characters too long for this start/);
    // And one that fits is delivered whole after the model line, inside the create route's 500.
    const ok = plan({ brief: 'word '.repeat(30) + 'END', kind: 'fix' }, { command: CLAUDE });
    expect(ok.autoCommand.endsWith('END"')).toBe(true);
    expect(ok.autoCommand.length).toBeLessThanOrEqual(500);
    expect(promptOf(ok.autoCommand)).toContain('Model: sonnet');
  });
});

test.describe('#533 one owner', () => {
  test('no second table of kinds in the server or the libs', () => {
    const root = path.join(__dirname, '..');
    const files = ['server.js', 'pty-worker.js', 'monitor.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
    const text = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    // The kinds' ids appear together only where they are defined.
    const kinds = ["id: 'fix'", "id: 'lookup'"];
    expect(files.filter((f) => kinds.every((k) => text(f).includes(k)))).toEqual(['lib/model-choice.js']);
  });
});
