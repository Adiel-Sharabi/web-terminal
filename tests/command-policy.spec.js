// @ts-check
// #131 — the per-command lens policy, and the endpoint that publishes it.
//
// The classification is MEASURED, not assumed (#73's lesson). Across the 609
// Claude transcripts on the reporting machine, 9 distinct commands appeared in
// 129 invocations, and they divide by what they WRITE:
//
//   /issue, /goal, /issue-hunter   a real `user` turn + a full agent turn
//   /compact                       system:compact_boundary + the compacting flag
//   /status, /usage, /model, ...   system:local_command whose ENTIRE recorded
//                                  result is the string "Settings dialog dismissed"
//
// The third class is the reported bug: run one from Chat and you are left looking
// at an invocation with no answer, because there is no answer in the transcript
// to render at any quality of client.

const { test, expect } = require('@playwright/test');
const commands = require('../lib/commands');

test.describe('#131 — lib/commands.js, the policy SSOT', () => {
  test('commandName strips the slash and the arguments', () => {
    expect(commands.commandName('/issue fix the thing')).toBe('issue');
    expect(commands.commandName('/STATUS')).toBe('status');
    // A namespaced skill is ONE name — splitting on ':' would misclassify it.
    expect(commands.commandName('/caveman:caveman')).toBe('caveman:caveman');
    expect(commands.commandName('not a command')).toBe('');
    expect(commands.commandName('/')).toBe('');
    expect(commands.commandName(null)).toBe('');
  });

  test('the TUI-only built-ins pin the terminal', () => {
    for (const c of ['/status', '/usage', '/context', '/model', '/login', '/clear']) {
      expect(commands.pinsTerminal(c), c).toBe(true);
    }
  });

  test('/compact stays in chat — it writes transcript state and has an indicator', () => {
    // The exception the table exists to hold WITHOUT a branch. An
    // `if (command === "/compact")` anywhere else is the thing this prevents.
    expect(commands.lensFor('/compact')).toBe('chat');
  });

  test('a skill stays in chat — it starts a real turn, which chat renders fully', () => {
    expect(commands.lensFor('/issue fix it')).toBe('chat');
    expect(commands.lensFor('/goal')).toBe('chat');
    expect(commands.lensFor('/caveman:caveman')).toBe('chat');
  });

  test('an unknown command defaults to chat — the open-ended class is skills', () => {
    // The pinned set is the FINITE list of Claude built-ins; everything else a
    // user can type is a skill, and a skill always starts a turn.
    expect(commands.lensFor('/invented-tomorrow')).toBe('chat');
    expect(commands.lensFor('')).toBe('chat');
  });

  test('the catalogue is complete, sorted and well-shaped', () => {
    const list = commands.listCommands();
    expect(list.length).toBe(Object.keys(commands.COMMANDS).length);
    expect(list.map(r => r.name)).toEqual([...list.map(r => r.name)].sort());
    for (const row of list) {
      expect(['chat', 'terminal']).toContain(row.lens);
      expect(typeof row.writes).toBe('string');
    }
    // The evidence for the split, asserted so a future edit cannot quietly
    // reclassify a command without also restating what it writes.
    const byName = Object.fromEntries(list.map(r => [r.name, r]));
    expect(byName.status.writes).toBe('tui-only');
    expect(byName.compact.writes).toBe('transcript-state');
  });
});

test.describe('#131 — GET /api/commands', () => {
  test('requires auth, like every other API route', async ({ request }) => {
    const res = await request.get('/api/commands');
    expect(res.status()).toBe(401);
  });

  test('serves the catalogue and the default to an authenticated client', async ({ request }) => {
    const login = await request.post('/login', {
      form: { user: 'testuser', password: 'testpass:colon' },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(login.status());

    const res = await request.get('/api/commands');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.default).toBe('chat');
    expect(Array.isArray(body.commands)).toBeTruthy();
    const byName = Object.fromEntries(body.commands.map(r => [r.name, r.lens]));
    expect(byName.status).toBe('terminal');
    expect(byName.usage).toBe('terminal');
    expect(byName.compact).toBe('chat');
  });

  test('the server advertises the command-policy capability', async ({ request }) => {
    await request.post('/login', {
      form: { user: 'testuser', password: 'testpass:colon' },
      maxRedirects: 0,
    });
    const res = await request.get('/api/version');
    const body = await res.json();
    // The client keys its fallback on this: without it, it uses its own table.
    expect(body.capabilities).toContain('command-policy');
  });
});
