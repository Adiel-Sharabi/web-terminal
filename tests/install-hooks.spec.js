// @ts-check
// scripts/install-hooks.js — the repo's ownership of this machine's Claude hook set.
// The rules are pure (patch() takes and returns a settings object) so they are testable
// without touching ~/.claude/settings.json.
const { test, expect } = require('@playwright/test');
const { patch, isWtHook, EVENTS } = require('../scripts/install-hooks');

const wt = (port = 7681) => ({
  type: 'http',
  url: `http://127.0.0.1:${port}/api/hook`,
  headers: { 'X-WT-Session-ID': '$WT_SESSION_ID', 'X-WT-Hook-Token': '$WT_HOOK_TOKEN' },
  allowedEnvVars: ['WT_SESSION_ID', 'WT_HOOK_TOKEN'],
});

test('SessionStart is part of the contract — its absence is the bug this script exists for', () => {
  expect(EVENTS).toContain('SessionStart');
});

test('an empty config gets every event', () => {
  const { settings, added } = patch({});
  expect(added.sort()).toEqual([...EVENTS].sort());
  for (const e of EVENTS) expect(settings.hooks[e][0].hooks[0].url).toMatch(/\/api\/hook$/);
});

// The real fleet state on 2026-08-12: eight events installed by hand, SessionStart absent.
test('a fleet-shaped config gains ONLY SessionStart', () => {
  const hooks = {};
  for (const e of EVENTS.filter((x) => x !== 'SessionStart')) hooks[e] = [{ hooks: [wt()] }];
  const { added, corrected } = patch({ hooks });
  expect(added).toEqual(['SessionStart']);
  expect(corrected).toEqual([]);
});

test('running it twice changes nothing the second time', () => {
  const once = patch({});
  const twice = patch(once.settings);
  expect(twice.added).toEqual([]);
  expect(twice.corrected).toEqual([]);
});

// The user's own hooks are not this repo's to manage — clobbering them would be a far
// worse defect than the one being fixed.
test('a user hook on the same event survives untouched', () => {
  const mine = { type: 'command', command: 'echo hi' };
  const { settings, added } = patch({ hooks: { Stop: [{ hooks: [mine] }] } });
  expect(added).toContain('Stop');
  const all = settings.hooks.Stop.flatMap((g) => g.hooks);
  expect(all).toContainEqual(mine);
  expect(all.filter(isWtHook)).toHaveLength(1);
});

// A moved port must be CORRECTED, not duplicated — a second stale entry would fire into
// the void forever while looking installed.
test('a stale port is corrected in place rather than duplicated', () => {
  const { settings, added, corrected } = patch({ hooks: { Stop: [{ hooks: [wt(9999)] }] } });
  expect(added).not.toContain('Stop');
  expect(corrected).toContain('Stop');
  const all = settings.hooks.Stop.flatMap((g) => g.hooks).filter(isWtHook);
  expect(all).toHaveLength(1);
  expect(all[0].url).toBe('http://127.0.0.1:7681/api/hook');
});

test('patch never mutates the config it was handed', () => {
  const src = { hooks: { Stop: [{ hooks: [wt()] }] }, unrelated: { keep: true } };
  const snapshot = JSON.stringify(src);
  const { settings } = patch(src);
  expect(JSON.stringify(src)).toBe(snapshot);
  expect(settings.unrelated).toEqual({ keep: true });
});
