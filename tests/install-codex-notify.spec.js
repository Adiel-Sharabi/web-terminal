// @ts-check
// scripts/install-codex-notify.js — writing the three [tui] keys that turn on Codex's
// in-band status channel, without disturbing a config.toml this repo does not own.
const { test, expect } = require('@playwright/test');
const { patch } = require('../scripts/install-codex-notify');

const KEYS = ['notifications = true', 'notification_method = "osc9"', 'notification_condition = "always"'];
const tuiBlockOf = (s) => {
  const lines = s.split('\n');
  const i = lines.findIndex((l) => /^\s*\[tui\]\s*$/.test(l));
  if (i === -1) return null;
  let end = i + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return lines.slice(i, end).join('\n');
};

test('appends a [tui] section when there is none', () => {
  const src = 'model = "gpt-5.5"\n';
  const { text } = patch(src);
  expect(text).toContain('model = "gpt-5.5"');   // original preserved
  for (const k of KEYS) expect(tuiBlockOf(text)).toContain(k);
});

test('does NOT write into [tui.model_availability_nux] — a subtable is a different table', () => {
  // The trap: keys placed under [tui.x] belong to that subtable and Codex silently
  // ignores them, exactly like its camelCase hook keys. The real config on this
  // machine has this subtable and no bare [tui].
  const src = [
    'model = "gpt-5.5"', '',
    '[tui.model_availability_nux]', '"gpt-5.5" = 2', '',
  ].join('\n');
  const { text } = patch(src);

  const sub = text.split('[tui.model_availability_nux]')[1].split(/^\s*\[/m)[0];
  expect(sub).not.toContain('notification_method');
  expect(sub).toContain('"gpt-5.5" = 2');
  for (const k of KEYS) expect(tuiBlockOf(text)).toContain(k);
});

test('fills missing keys into an existing [tui] section without touching its others', () => {
  const src = ['[tui]', 'theme = "dark"', '', '[features]', 'x = true', ''].join('\n');
  const { text } = patch(src);
  const block = tuiBlockOf(text);
  expect(block).toContain('theme = "dark"');
  for (const k of KEYS) expect(block).toContain(k);
  expect(text).toContain('[features]');
  expect(text).toContain('x = true');
});

test('corrects a wrong value rather than duplicating the key', () => {
  // notification_condition defaults to "unfocused"; a PTY has no focus, so a config
  // left on the default emits nothing at all and looks like a broken feature.
  const src = ['[tui]', 'notifications = true', 'notification_method = "bel"',
    'notification_condition = "unfocused"', ''].join('\n');
  const { text, changed } = patch(src);
  const block = tuiBlockOf(text);
  expect(block).toContain('notification_method = "osc9"');
  expect(block).toContain('notification_condition = "always"');
  expect(block).not.toContain('"unfocused"');
  expect(block).not.toContain('"bel"');
  expect(changed.sort()).toEqual(['notification_condition', 'notification_method']);
  expect((block.match(/notification_method/g) || []).length).toBe(1);
});

test('is idempotent — a second run is a no-op', () => {
  const first = patch('model = "gpt-5.5"\n').text;
  const second = patch(first);
  expect(second.text).toBe(first);
  expect(second.added).toEqual([]);
  expect(second.changed).toEqual([]);
});
