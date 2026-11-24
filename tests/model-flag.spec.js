// #533 - the model for a task: `--model <m>` is added to a started session's command unless the command
// already names one (lib/model-flag.js, the one owner shared with the supervisor dispatcher, #525).
const { test, expect } = require('@playwright/test');
const { parseModel, withModel, modelOf } = require('../lib/model-flag');
const { withModel: dispatcherWithModel } = require('../lib/supervisor-cases');
const { BASE, authCtx } = require('./test-helpers');

test.describe('#533 model-flag rule', () => {
  test('withModel adds the flag, never over a model the command names', () => {
    expect(withModel('claude --dangerously-skip-permissions', 'sonnet')).toBe('claude --dangerously-skip-permissions --model sonnet');
    expect(withModel('claude --model opus', 'sonnet')).toBe('claude --model opus');
    expect(withModel('claude --model=opus', 'sonnet')).toBe('claude --model=opus');
    expect(withModel('claude', null)).toBe('claude');
    expect(withModel('claude --models-x', 'sonnet')).toBe('claude --models-x --model sonnet');
  });
  test('the dispatcher uses the SAME function (one owner)', () => {
    expect(dispatcherWithModel).toBe(withModel);
  });
  test('parseModel accepts names, refuses anything a shell could read', () => {
    for (const ok of ['sonnet', 'opus', 'haiku', 'claude-sonnet-5-5', 'opus[1m]']) expect(parseModel(ok)).toEqual({ model: ok });
    expect(parseModel(undefined)).toEqual({ model: null });
    expect(parseModel('')).toEqual({ model: null });
    for (const bad of ['sonnet; rm -rf /', 'a b', '$(x)', '--x', 'x'.repeat(80), 5, {}]) expect(parseModel(bad).error).toBeTruthy();
  });
  test('modelOf reads both spellings', () => {
    expect(modelOf('claude --model sonnet --x')).toBe('sonnet');
    expect(modelOf('claude --model=opus')).toBe('opus');
    expect(modelOf('claude')).toBeNull();
  });
});

test.describe('#533 POST /api/sessions model', () => {
  async function make(ctx, data) {
    return ctx.post(`${BASE}/api/sessions`, { data: { name: `M533 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...data } });
  }
  test('the response names the model; a malformed one is a 400 and creates nothing', async () => {
    const ctx = await authCtx();
    const ids = [];
    try {
      const ok = await make(ctx, { autoCommand: 'echo hi', model: 'sonnet' });
      expect(ok.status()).toBe(200);
      const body = await ok.json(); ids.push(body.id);
      expect(body.model).toBe('sonnet');
      const own = await make(ctx, { autoCommand: 'echo hi --model opus', model: 'sonnet' });
      const ob = await own.json(); ids.push(ob.id);
      expect(ob.model).toBe('opus'); // the command's own choice wins
      const bad = await make(ctx, { autoCommand: 'echo hi', model: 'sonnet; calc' });
      expect(bad.status()).toBe(400);
    } finally {
      for (const id of ids) { try { await ctx.delete(`${BASE}/api/sessions/${id}`); } catch { /* gone */ } }
      await ctx.dispose();
    }
  });
});
