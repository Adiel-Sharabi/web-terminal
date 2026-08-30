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

// ---------------------------------------------------------------------------
// #188 — the table also decides which commands are OFFERED as buttons.
//
// Every assertion here exists to stop a client from growing its own list. The
// failure this guards against is not a crash: it is `app.html` and the companion
// each hard-coding "compact, clear, context, usage", and then disagreeing with
// this file — and with each other — the first time a command is added.
// ---------------------------------------------------------------------------
test.describe('#188 — the quick-command button set', () => {
  test('exactly the measured four are buttons, and nothing else is', () => {
    const quick = commands.quickCommands();
    expect(quick.map(c => c.name)).toEqual(['compact', 'context', 'usage', 'clear']);
  });

  test('order is the table\'s, not alphabetical — the destructive row sorts LAST', () => {
    // On a phone the first button is the one a thumb reaches by accident, so
    // /clear must never lead. Alphabetical order would put it first.
    const names = commands.quickCommands().map(c => c.name);
    expect(names[0]).toBe('compact');
    expect(names[names.length - 1]).toBe('clear');
    expect(names).not.toEqual([...names].sort());
  });

  test('every button carries a label; only the destructive one asks first', () => {
    for (const c of commands.quickCommands()) {
      expect(typeof c.label, c.name).toBe('string');
      expect(c.label.length, c.name).toBeGreaterThan(0);
    }
    const confirming = commands.quickCommands().filter(c => c.confirm);
    expect(confirming.map(c => c.name)).toEqual(['clear']);
    // The wording is server-owned so both clients say the same thing.
    expect(confirming[0].confirm).toMatch(/resume/i);
  });

  test('a button keeps the lens policy it already had — no second opinion', () => {
    // The whole point of hanging the buttons off THIS table: a button-run
    // command lands where a typed one does. If these ever diverge, the client
    // has grown its own notion of where to stand.
    for (const c of commands.quickCommands()) {
      expect(c.lens, c.name).toBe(commands.lensFor('/' + c.name));
    }
    expect(commands.lensFor('/compact')).toBe('chat');
    expect(commands.pinsTerminal('/clear')).toBe(true);
  });

  test('/cost is classified but NOT a button — one panel, one button', () => {
    // /usage and /cost are the same TUI panel; two buttons for it would be the
    // duplication this file exists to prevent.
    expect(commands.COMMANDS.cost.lens).toBe('terminal');
    expect(commands.quickCommands().map(c => c.name)).not.toContain('cost');
  });

  test('the catalogue omits the presentation fields on non-button rows', () => {
    // A client must be able to read `quick == null` as "not a button" without
    // knowing the table.
    const byName = Object.fromEntries(commands.listCommands().map(r => [r.name, r]));
    expect(byName.status.quick).toBeUndefined();
    expect(byName.status.label).toBeUndefined();
    expect(byName.compact.quick).toBe(1);
  });

  test('quickCommands() is stable across calls', () => {
    expect(commands.quickCommands()).toEqual(commands.quickCommands());
  });
});

test.describe('#188 — GET /api/commands publishes the button row', () => {
  test('serves `quick`, ordered, so adding a button needs no client release', async ({ request }) => {
    await request.post('/login', {
      form: { user: 'testuser', password: 'testpass:colon' },
      maxRedirects: 0,
    });
    const res = await request.get('/api/commands');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(Array.isArray(body.quick)).toBeTruthy();
    expect(body.quick.map(c => c.name)).toEqual(['compact', 'context', 'usage', 'clear']);
    for (const c of body.quick) {
      expect(typeof c.label).toBe('string');
      expect(['chat', 'terminal']).toContain(c.lens);
    }
    const clear = body.quick.find(c => c.name === 'clear');
    expect(typeof clear.confirm).toBe('string');
    expect(body.quick.find(c => c.name === 'compact').confirm).toBeUndefined();

    // The full catalogue is still served — nothing that already read it breaks.
    expect(body.commands.length).toBeGreaterThan(body.quick.length);
  });
});
