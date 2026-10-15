// @ts-check
// #351 - an agent in one session creates helper sessions with POST /api/sessions (often on
// a cluster peer) and never closes them; each machine has a session cap, and an orphan held
// a slot for 21 hours. The owner's rule: close an AGENT-STARTED session once its turn has
// ended and nobody has viewed it for hours.
//
// Who started a session is decided by BEHAVIOUR, never by auth (the companion, the cluster
// proxy and an agent all use Bearer): a session POSTed here is `agent`-started unless an
// ACTIVE viewer attaches within the classify window. The rules are lib/spawn-reaper.js and
// are pinned first, gate by gate; the second half drives the real server, worker and sockets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { BASE, AUTH, readHookToken, claudeProjectsRoot } = require('./test-helpers');
const R = require('../lib/spawn-reaper');
const { negotiateSize, isActiveViewer } = require('../lib/terminal-size');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;

// --- the pure rule ------------------------------------------------------------

/** A session that is entitled to be closed: agent-started, 10 hours old, untouched. */
const cfg = R.reaperConfig(6);
const meta = (o = {}) => ({ by: 'agent', createdAt: NOW - 10 * HOUR, spawnedBy: null, lastViewedAt: null, ...o });
const row = (o = {}) => ({
  status: 'idle', compacting: false, lastActivity: NOW - 10 * HOUR, activeViewers: 0, favorite: false,
  usageLimit: { waiting: false }, backgroundTasks: [], ...o,
});
const decide = (r = row(), m = meta(), c = cfg) => R.shouldClose(r, m, NOW, c);

test.describe('#351 shouldClose - every gate, alone', () => {
  test('the baseline closes: agent-started, idle, unviewed, nothing running', () => {
    expect(decide()).toMatchObject({ close: true, why: 'idle' });
  });

  // Each row below changes ONE thing about the baseline and must flip the answer. A gate
  // whose test is missing is a gate someone can delete with the suite still green.
  const gates = [
    ['an active viewer is attached', { activeViewers: 1 }, 'viewer'],
    ['the row does not say how many viewers (fail closed)', { activeViewers: undefined }, 'viewer'],
    ['its turn is running', { status: 'working' }, 'working'],
    ['it is waiting on a person', { status: 'waiting' }, 'waiting'],
    ['it is compacting', { compacting: true }, 'compacting'],
    ['a background command is running', { backgroundTasks: [{ id: 'b1', description: 'build' }] }, 'background-work'],
    ['whether work is running is unknown (fail closed)', { backgroundTasks: null }, 'work-unknown'],
    ['it is a favorite', { favorite: true }, 'favorite'],
    ['it is sitting out a usage limit', { usageLimit: { waiting: true } }, 'capped'],
    ['the usage-limit read failed (null, fail closed)', { usageLimit: null }, 'usage-unknown'],
    ['it has no usage-limit reading at all (fail closed)', { usageLimit: undefined }, 'usage-unknown'],
    ['it produced output a moment ago', { lastActivity: NOW - 1000 }, 'recent'],
  ];
  for (const [what, patch, why] of gates) {
    test(`not closed while: ${what}`, () => {
      expect(decide(row(patch))).toEqual({ close: false, why });
    });
  }

  test('not closed when the verdict is recent: created a moment ago', () => {
    expect(decide(row({ lastActivity: 0 }), meta({ createdAt: NOW - 1000 }))).toEqual({ close: false, why: 'recent' });
  });

  test('not closed when somebody looked at it a moment ago', () => {
    expect(decide(row(), meta({ lastViewedAt: NOW - 1000 }))).toEqual({ close: false, why: 'recent' });
  });

  test('work is work at ANY age: a task flagged stale (the badge\'s 6h backstop) still holds the session', () => {
    // The idle threshold is also 6 hours. A rule that let an old launch go would be dead
    // exactly when it is asked, so the reaper reads raw lists and nothing is exempt by age.
    expect(decide(row({ backgroundTasks: [{ id: 'p1', description: 'shell command', stale: true }] }))).toEqual({ close: false, why: 'background-work' });
    expect(decide(row({ backgroundTasks: [{ id: 'b1', startedAt: NOW - 30 * HOUR }] }))).toEqual({ close: false, why: 'background-work' });
  });

  test('inside its idle window a session is "recent" whatever a READ said - no read needs consulting at all', () => {
    // A fresh server has no process snapshot yet; that is no reason to name for a session that
    // could not be closed anyway. The turn-state gates still outrank the clock.
    const young = { lastActivity: NOW - 1000 };
    for (const patch of [{ backgroundTasks: null }, { backgroundTasks: [{ id: 'b1' }] }, { usageLimit: null }, { usageLimit: { waiting: true } }, { favorite: true }]) {
      expect(decide(row({ ...young, ...patch })), JSON.stringify(patch)).toEqual({ close: false, why: 'recent' });
    }
    expect(decide(row({ ...young, status: 'working' })).why).toBe('working');
    expect(decide(row({ ...young, status: 'waiting' })).why).toBe('waiting');
    expect(decide(row({ ...young, compacting: true })).why).toBe('compacting');
    expect(decide(row({ ...young, activeViewers: 1 })).why).toBe('viewer');
  });

  test('UNKNOWN work (null) is not NONE ([]): only a known-empty list lets it close', () => {
    expect(decide(row({ backgroundTasks: [] })).close).toBe(true);
    expect(decide(row({ backgroundTasks: null }))).toEqual({ close: false, why: 'work-unknown' });
  });

  test('combineWork: known work wins, any unknown source makes an empty answer unknown', () => {
    const t = { id: 'b1' }, p = { pid: 4 };
    expect(R.combineWork([], [])).toEqual([]);
    expect(R.combineWork([t], [p])).toEqual([t, p]);
    expect(R.combineWork([t], null)).toEqual([t]);
    expect(R.combineWork(null, [p])).toEqual([p]);
    expect(R.combineWork(null, [])).toBeNull();
    expect(R.combineWork([], null)).toBeNull();
    expect(R.combineWork(null, null)).toBeNull();
    expect(R.combineWork(undefined, [])).toBeNull();
  });

  test('the idle clock is the NEWEST of created / last viewed / last output', () => {
    const idle = 6 * HOUR;
    const c = R.reaperConfig(6);
    expect(c.idleMs).toBe(idle);
    // exactly at the threshold closes; one millisecond short does not
    expect(R.shouldClose(row({ lastActivity: NOW - idle }), meta({ createdAt: NOW - 9 * HOUR }), NOW, c).close).toBe(true);
    expect(R.shouldClose(row({ lastActivity: NOW - idle + 1 }), meta({ createdAt: NOW - 9 * HOUR }), NOW, c).close).toBe(false);
    expect(R.shouldClose(row({ lastActivity: NOW - 9 * HOUR }), meta({ lastViewedAt: NOW - idle + 1 }), NOW, c).close).toBe(false);
  });

  test('a session this server did not classify as agent-started is NEVER closed', () => {
    expect(decide(row(), null)).toEqual({ close: false, why: 'unknown' });
    expect(R.shouldClose(row(), undefined, NOW, cfg).close).toBe(false);
    expect(decide(row(), meta({ by: 'human' }))).toEqual({ close: false, why: 'human' });
    expect(decide(row(), meta({ by: 'pending' })).close).toBe(false);
    expect(decide(row(), meta({ by: 'whatever' })).close).toBe(false);
    expect(decide(row(), meta({ createdAt: undefined }))).toEqual({ close: false, why: 'no-data' });
  });

  test('a row that was never read is not closed', () => {
    expect(R.shouldClose(null, meta(), NOW, cfg).close).toBe(false);
    expect(R.shouldClose(row(), meta(), undefined, cfg).close).toBe(false);
  });
});

test.describe('#351 the config knob', () => {
  test('default 6 hours; fractions allowed', () => {
    expect(R.reaperConfig(undefined)).toEqual({ enabled: true, idleMs: 6 * HOUR });
    expect(R.reaperConfig(null)).toEqual({ enabled: true, idleMs: 6 * HOUR });
    expect(R.reaperConfig(0.5)).toEqual({ enabled: true, idleMs: 0.5 * HOUR });
    expect(R.reaperConfig(12)).toEqual({ enabled: true, idleMs: 12 * HOUR });
  });

  test('0 disables it - and nothing else does', () => {
    expect(R.reaperConfig(0).enabled).toBe(false);
    expect(decide(row(), meta(), R.reaperConfig(0))).toEqual({ close: false, why: 'disabled' });
    expect(R.shouldClose(row(), meta(), NOW, undefined).close).toBe(false);
  });

  test('ONLY a finite number >= 0 is accepted: anything else is the default 6, never a surprise', () => {
    for (const bad of [true, false, '', '2', '0', 'never', [], [3], {}, -3, NaN, Infinity, -Infinity]) {
      expect(R.reaperConfig(bad), `config value ${JSON.stringify(bad)}`).toEqual({ enabled: true, idleMs: 6 * HOUR });
    }
  });

  test('a test override shortens the threshold but never re-enables a disabled reaper', () => {
    expect(R.reaperConfig(6, 1500)).toEqual({ enabled: true, idleMs: 1500 });
    expect(R.reaperConfig(0, 1500).enabled).toBe(false);
  });
});

test.describe('#351 classifySpawn - behaviour, not credentials', () => {
  const c = 1_700_000_000_000;
  const W = R.CLASSIFY_MS;

  test('the window is 120 seconds - the companion alone can spend ~40 s before it says it is active', () => {
    expect(W).toBe(120_000);
  });

  test('a viewer inside the window makes it a person\'s', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + 5_000, now: c + 5_000 })).toBe('human');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + W - 1, now: c + 10 * W })).toBe('human');
  });

  test('nobody yet: pending until the window closes, then agent-started', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + W - 1 })).toBe('pending');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + W })).toBe('agent');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + 10 * HOUR })).toBe('agent');
  });

  test('a viewer who arrives AFTER the window does not make it a person\'s', () => {
    // judged by when the view happened, not by when somebody asks - a lazy caller (a list,
    // a sweep) must get the answer an eager timer would have
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + W, now: c + W + 1 })).toBe('agent');
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: c + 2 * W, now: c + 3 * W })).toBe('agent');
  });

  test('no creation time is no verdict', () => {
    expect(R.classifySpawn({ createdAt: undefined, now: c })).toBe('unknown');
  });

  test('the window is overridable per call (the suite shortens it)', () => {
    expect(R.classifySpawn({ createdAt: c, firstViewedAt: null, now: c + 4000, classifyMs: 3000 })).toBe('agent');
  });
});

test.describe('#351 ACTIVE viewer - the same notion terminal-size uses', () => {
  test('a background socket is not a viewer; an active one (or one that never said) is', () => {
    expect(R.countActiveViewers([])).toBe(0);
    expect(R.countActiveViewers(null)).toBe(0);
    expect(R.countActiveViewers([{ background: true }, { background: true }])).toBe(0);
    expect(R.countActiveViewers([{ background: true }, { background: false }])).toBe(1);
    expect(R.countActiveViewers([{ background: false }, {}, { background: false }])).toBe(3);
  });

  test('ONE definition: exactly the sockets that have a vote in the PTY size', () => {
    for (const background of [true, false, undefined]) {
      const v = { cols: 80, rows: 24, background };
      expect(isActiveViewer(v)).toBe(negotiateSize([v]) !== null);
    }
    expect(isActiveViewer(null)).toBe(false);
  });
});

test.describe('#351 the spawner\'s label', () => {
  test('plain text, trimmed, capped at 120', () => {
    expect(R.spawnedByLabel('  helper agent  ')).toBe('helper agent');
    expect(R.spawnedByLabel('x'.repeat(300))).toHaveLength(120);
    expect(R.spawnedByLabel('a' + String.fromCharCode(13, 10) + 'b' + String.fromCharCode(7) + 'c' + String.fromCharCode(0x2028, 0x2029) + 'd')).toBe('abcd');
  });
  test('control, BIDI and ZERO-WIDTH characters are stripped - none of them can reorder or hide text', () => {
    const cc = (...cps) => String.fromCodePoint(...cps);
    // bidi embeddings / overrides, isolates, marks; zero-width space/joiners, word joiner, BOM
    const hostile = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x061c, 0x00ad, 0x180e, 0x85];
    expect(R.spawnedByLabel('ni' + cc(...hostile) + 'ghtly')).toBe('nightly');
    for (const cp of hostile) expect(R.spawnedByLabel('a' + cc(cp) + 'b'), `U+${cp.toString(16)}`).toBe('ab');
    // ...but ordinary text in any script, and emoji, survive
    expect(R.spawnedByLabel('agent ' + cc(0x5de5, 0x4f5c) + ' ' + cc(0x1f916))).toBe('agent ' + cc(0x5de5, 0x4f5c) + ' ' + cc(0x1f916));
    expect(R.spawnedByLabel(cc(...hostile))).toBeNull();
  });
  test('the cap is 120 CODE POINTS, so an emoji is never cut in half', () => {
    const emoji = String.fromCodePoint(0x1f916);
    const out = R.spawnedByLabel(emoji.repeat(200));
    expect(Array.from(out)).toHaveLength(120);
    expect(out).toBe(emoji.repeat(120)); // 240 UTF-16 units, no lone surrogate at the end
    expect(R.spawnedByLabel('x'.repeat(119) + emoji + 'tail')).toBe('x'.repeat(119) + emoji);
  });
  test('absent or not a string is no label', () => {
    for (const v of [undefined, null, 7, {}, [], '', '   ', '\n']) expect(R.spawnedByLabel(v)).toBeNull();
  });
  test('the log line is the one the owner asked for', () => {
    expect(R.closeLogLine({ name: 'helper', id: 'abc', spawnedBy: 'nightly', idleMs: 6.04 * HOUR }))
      .toBe('spawn-reaper: closed "helper" (abc) - agent-started, by "nightly", idle 6h');
    expect(R.closeLogLine({ name: 'helper', id: 'abc', spawnedBy: null, idleMs: 7.26 * HOUR }))
      .toBe('spawn-reaper: closed "helper" (abc) - agent-started, idle 7.3h');
  });
});

// --- the active frame, and who a hand-off successor is --------------------------

test.describe('#351 isActiveModeFrame - exactly the frame that makes a viewer a viewer', () => {
  test('an active mode frame, as a string or a Buffer', () => {
    expect(R.isActiveModeFrame('{"mode":"active","browserId":"abc"}')).toBe(true);
    expect(R.isActiveModeFrame(Buffer.from('{"mode":"active"}'))).toBe(true);
  });
  test('background / keepOpen, other JSON, keystrokes, junk and oversize are NOT views', () => {
    expect(R.isActiveModeFrame('{"mode":"background","browserId":"abc"}')).toBe(false);
    expect(R.isActiveModeFrame('{"mode":"other"}')).toBe(false);
    expect(R.isActiveModeFrame('{"resize":{"cols":80,"rows":24}}')).toBe(false);
    expect(R.isActiveModeFrame('{"heartbeat":1}')).toBe(false);
    expect(R.isActiveModeFrame('{"mode":')).toBe(false);
    expect(R.isActiveModeFrame('ls -la\r')).toBe(false);
    expect(R.isActiveModeFrame('')).toBe(false);
    expect(R.isActiveModeFrame(undefined)).toBe(false);
    expect(R.isActiveModeFrame(null)).toBe(false);
    expect(R.isActiveModeFrame('{"mode":"active","pad":"' + 'x'.repeat(5000) + '"}')).toBe(false);
  });
});

test.describe('#351 successorVerdict - a hand-off successor of an agent-started session is agent-started', () => {
  test('agent in, agent out: spawner carried, clock restarted, never viewed', () => {
    expect(R.successorVerdict(meta({ spawnedBy: 'nightly', lastViewedAt: NOW - 5 }), NOW)).toEqual({
      by: 'agent', createdAt: NOW, spawnedBy: 'nightly', lastViewedAt: null,
    });
  });
  test('a person\'s, a pending, an unknown or a junk predecessor passes nothing on', () => {
    for (const m of [meta({ by: 'human' }), meta({ by: 'pending' }), meta({ by: 'whatever' }), null, undefined]) {
      expect(R.successorVerdict(m, NOW)).toBeNull();
    }
    expect(R.successorVerdict(meta(), undefined)).toBeNull();
  });
});

// --- the process list: what would closing a session kill? -------------------------

test.describe('#351 liveWorkUnder - running work by ANY age, from the process tree', () => {
  const { liveWorkUnder } = require('../lib/process-tree');
  const p = (pid, ppid, name, startMs = 1) => ({ pid, ppid, name, startMs });

  test('an idle git-bash prompt (bash.exe -> bash.exe) reports nothing', () => {
    expect(liveWorkUnder([p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe')], 10)).toEqual([]);
  });

  test('a command under the prompt reports itself, however old it is', () => {
    const got = liveWorkUnder([p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe'), p(12, 11, 'sleep.exe', 5)], 10);
    expect(got).toEqual([{ pid: 12, name: 'sleep.exe', startMs: 5 }]);
    // "7 hours old" is not an exemption: nothing here looks at age
    expect(liveWorkUnder([p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe'), p(12, 11, 'npm.exe', NOW - 7 * HOUR)], 10)).toHaveLength(1);
  });

  test('a DIFFERENT shell below the prompt is work (it may be running a command with no child)', () => {
    expect(liveWorkUnder([p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe'), p(12, 11, 'powershell.exe')], 10)).toHaveLength(1);
  });

  test('with an agent in the tree it is the badge\'s answer: shells UNDER the agent, not its MCP servers', () => {
    const base = [p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe'), p(12, 11, 'claude.exe'), p(13, 12, 'node.exe'), p(14, 12, 'python.exe')];
    expect(liveWorkUnder(base, 10)).toEqual([]);
    expect(liveWorkUnder([...base, p(15, 12, 'powershell.exe', NOW - 9 * HOUR)], 10)).toEqual([{ pid: 15, name: 'powershell.exe', startMs: NOW - 9 * HOUR }]);
  });

  test('an agent that exited back to the prompt: whatever still hangs below the shell counts', () => {
    expect(liveWorkUnder([p(10, 1, 'bash.exe'), p(11, 10, 'bash.exe'), p(12, 11, 'dotnet.exe')], 10)).toHaveLength(1);
  });

  test('garbage in, nothing out (the caller treats a missing snapshot as UNKNOWN before it gets here)', () => {
    expect(liveWorkUnder(null, 10)).toEqual([]);
    expect(liveWorkUnder([p(10, 1, 'bash.exe')], NaN)).toEqual([]);
    expect(liveWorkUnder([p(10, 1, 'bash.exe')], 99)).toEqual([]);
  });
});

// --- the store: the verdict file, pruning, forgetting, inheriting ------------------

test.describe('#351 spawn-store - persistence', () => {
  const { createSpawnStore } = require('../lib/spawn-store');
  const { emptyCwd } = require('./test-helpers');
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const isId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  const WINDOW = 3000;

  function rig(opts = {}) {
    const file = path.join(emptyCwd('spawn-store'), 'spawned-sessions.json');
    let t = NOW;
    const clock = { now: () => t, adv: (ms) => { t += ms; } };
    const errors = [];
    const make = () => createSpawnStore({ file, classifyMs: WINDOW, isId, now: clock.now, log: (m) => errors.push(m), ...opts });
    const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, clock, errors, make, onDisk, s: make() };
  }

  test('pending in memory only; agent once the window passes unviewed; then (and only then) on disk', () => {
    const { s, clock, file, onDisk } = rig();
    s.created(id(1), '  nightly  ');
    expect(s.metaOf(id(1))).toMatchObject({ by: 'pending', spawnedBy: 'nightly' });
    expect(fs.existsSync(file)).toBe(false);
    clock.adv(WINDOW);
    expect(s.metaOf(id(1))).toMatchObject({ by: 'agent', createdAt: NOW, spawnedBy: 'nightly', lastViewedAt: null });
    expect(onDisk()[id(1)]).toMatchObject({ by: 'agent', createdAt: NOW, spawnedBy: 'nightly' });
    expect(s.field(id(1))).toEqual({ by: 'agent', spawnedBy: 'nightly', createdAt: NOW });
  });

  test('a view inside the window -> human; a view after it -> still agent', () => {
    const a = rig(), b = rig();
    a.s.created(id(1)); a.clock.adv(1000); a.s.noteViewed(id(1)); a.clock.adv(WINDOW);
    expect(a.s.metaOf(id(1)).by).toBe('human');
    b.s.created(id(2)); b.clock.adv(WINDOW + 1); b.s.noteViewed(id(2));
    expect(b.s.metaOf(id(2)).by).toBe('agent');
  });

  test('noteViewed stamps lastViewedAt on an agent-started session (and writes it); a person\'s is not rewritten', () => {
    const { s, clock, onDisk, file } = rig();
    s.created(id(1)); clock.adv(WINDOW); s.metaOf(id(1));
    clock.adv(5000); s.noteViewed(id(1));
    expect(onDisk()[id(1)].lastViewedAt).toBe(NOW + WINDOW + 5000);
    expect(s.metaOf(id(1)).lastViewedAt).toBe(NOW + WINDOW + 5000);

    s.created(id(2)); s.noteViewed(id(2)); clock.adv(WINDOW); expect(s.metaOf(id(2)).by).toBe('human');
    const snapshot = fs.readFileSync(file, 'utf8');
    clock.adv(1000); s.noteViewed(id(2));
    expect(fs.readFileSync(file, 'utf8')).toBe(snapshot);
  });

  test('a restart INSIDE the window leaves the session with no verdict (never closed)', () => {
    const { s, make } = rig();
    s.created(id(1));
    const restarted = make(); // a new process, same file
    expect(restarted.metaOf(id(1))).toBeNull();
    expect(restarted.field(id(1))).toBeNull();
  });

  test('a restart AFTER the verdict keeps it', () => {
    const { s, clock, make } = rig();
    s.created(id(1), 'nightly'); clock.adv(WINDOW); s.metaOf(id(1));
    expect(make().metaOf(id(1))).toMatchObject({ by: 'agent', spawnedBy: 'nightly', createdAt: NOW });
  });

  test('LOAD keeps clean verdicts and drops everything else; a stored label is re-sanitised', () => {
    const { file, make, errors } = rig();
    const hostile = 'ni' + String.fromCharCode(0x202e) + 'ghtly';
    fs.writeFileSync(file, JSON.stringify({
      [id(1)]: { by: 'agent', createdAt: NOW, spawnedBy: hostile, lastViewedAt: NOW + 5 },
      [id(2)]: { by: 'human', createdAt: NOW, spawnedBy: null, lastViewedAt: null },
      [id(3)]: { by: 'pending', createdAt: NOW },
      [id(4)]: { by: 'agent', createdAt: 'yesterday' },
      [id(5)]: null,
      'not-a-uuid': { by: 'agent', createdAt: NOW },
    }));
    const s = make();
    expect(s.metaOf(id(1))).toEqual({ by: 'agent', createdAt: NOW, spawnedBy: 'nightly', lastViewedAt: NOW + 5 });
    expect(s.metaOf(id(2)).by).toBe('human');
    for (const gone of [id(3), id(4), id(5), 'not-a-uuid']) expect(s.metaOf(gone)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('an unreadable file is ignored (no verdicts: nothing closes) and says so', () => {
    const { file, make, errors } = rig();
    fs.writeFileSync(file, '{ this is not json');
    const s = make();
    expect(s.metaOf(id(1))).toBeNull();
    expect(errors.join(' ')).toMatch(/unreadable/);
  });

  test('PRUNE drops verdicts for sessions the worker no longer lists - but only ones made BEFORE the list was read', () => {
    const { s, clock, onDisk } = rig();
    for (const n of [1, 2, 3]) { s.created(id(n)); }
    clock.adv(WINDOW);
    for (const n of [1, 2, 3]) s.metaOf(id(n)); // all three persisted, createdAt = NOW
    clock.adv(10);
    s.created(id(4)); clock.adv(WINDOW); s.metaOf(id(4)); // createdAt = NOW + WINDOW + 10
    const listedAt = NOW + WINDOW; // the list was read before session 4 existed
    s.prune(new Set([id(1)]), listedAt);
    expect(Object.keys(onDisk()).sort()).toEqual([id(1), id(4)]);
  });

  test('SHIFT (the test lever) moves the whole verdict clock back, and keeps a viewer inside the window inside it', () => {
    const a = rig(), b = rig(), c = rig();
    // never viewed: shifted past the window it is an agent's
    a.s.created(id(1)); expect(a.s.metaOf(id(1)).by).toBe('pending');
    expect(a.s.shift(id(1), WINDOW + 1)).toBe(true);
    expect(a.s.metaOf(id(1))).toMatchObject({ by: 'agent', createdAt: NOW - WINDOW - 1 });
    // viewed inside the window: the view moves with the creation, so it stays a person's
    b.s.created(id(2)); b.clock.adv(1000); b.s.noteViewed(id(2));
    expect(b.s.shift(id(2), 10 * WINDOW)).toBe(true);
    expect(b.s.metaOf(id(2)).by).toBe('human');
    // a persisted verdict: creation AND last view move, and the file follows
    c.s.created(id(3)); c.clock.adv(WINDOW); c.s.metaOf(id(3)); c.clock.adv(500); c.s.noteViewed(id(3));
    expect(c.s.shift(id(3), 7000)).toBe(true);
    expect(c.onDisk()[id(3)]).toMatchObject({ createdAt: NOW - 7000, lastViewedAt: NOW + WINDOW + 500 - 7000 });
    // nothing to move, or no number
    expect(c.s.shift(id(99), 1)).toBe(false);
    expect(c.s.shift(id(3), NaN)).toBe(false);
  });

  test('FORGET removes a session\'s verdict from memory and from the file', () => {
    const { s, clock, onDisk } = rig();
    s.created(id(1)); clock.adv(WINDOW); s.metaOf(id(1));
    s.created(id(2)); // still pending
    expect(Object.keys(onDisk())).toEqual([id(1)]);
    s.forget(id(1)); s.forget(id(2));
    expect(onDisk()).toEqual({});
    expect(s.metaOf(id(1))).toBeNull();
    expect(s.metaOf(id(2))).toBeNull();
    s.forget(id(3)); // forgetting nothing is fine
  });

  test('INHERIT: an agent-started session\'s successor is agent-started; nothing else passes a verdict on', () => {
    const { s, clock, onDisk, make } = rig();
    s.created(id(1), 'nightly'); clock.adv(WINDOW + 7);
    const v = s.inherit(id(1), id(10));
    expect(v).toEqual({ by: 'agent', createdAt: NOW + WINDOW + 7, spawnedBy: 'nightly', lastViewedAt: null });
    expect(onDisk()[id(10)]).toMatchObject({ by: 'agent', spawnedBy: 'nightly', createdAt: NOW + WINDOW + 7 });
    expect(make().field(id(10))).toMatchObject({ by: 'agent', spawnedBy: 'nightly' });

    s.created(id(2)); s.noteViewed(id(2)); clock.adv(WINDOW);          // a person's
    expect(s.inherit(id(2), id(11))).toBeNull();
    s.created(id(3));                                                   // still pending
    expect(s.inherit(id(3), id(12))).toBeNull();
    expect(s.inherit(id(99), id(13))).toBeNull();                       // no verdict at all
    for (const n of [11, 12, 13]) expect(s.metaOf(id(n))).toBeNull();
  });

  test('the store module is what server.js builds its state on (one owner of the file format)', () => {
    expect(SERVER_SRC).toContain("require('./lib/spawn-store')");
    expect(SERVER_SRC).toContain('createSpawnStore({');
  });
});

// --- the source gates -----------------------------------------------------------

test.describe('#351 server.js wiring (pinned against the source)', () => {
  const list = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/api/sessions'"));
  const merge = SERVER_SRC.slice(SERVER_SRC.indexOf('async function _computeClusterSessions'));

  test('both session shapers carry `spawn` from the one helper', () => {
    // Fields were each forgotten in one of these two hand-shaped lists before (#298).
    expect(list.slice(0, list.indexOf('res.json(shaped)'))).toContain('spawn: spawnStore.field(s.id)');
    expect(merge.slice(0, merge.indexOf('result.push(...localShaped)'))).toContain('spawn: spawnStore.field(s.id)');
  });

  test('DELETE and the reaper end a session through the same function', () => {
    const del = SERVER_SRC.slice(SERVER_SRC.indexOf("app.delete('/api/sessions/:id'"));
    expect(del.slice(0, del.indexOf('\n});'))).toContain('killLocalSession(req.params.id)');
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    expect(sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'))).toContain('killLocalSession(s.id)');
  });

  test('the sweep is local-only: it never reaches into a peer', () => {
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    const body = sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'));
    for (const peer of ['clusterFetch', 'loadClusterTokens', 'getClusterConfig', '/cluster/']) {
      expect(body).not.toContain(peer);
    }
  });

  test('the test-only env knobs are read in ONE place, and only under WT_TEST', () => {
    const at = SERVER_SRC.indexOf('const SPAWN_TEST = process.env.WT_TEST ?');
    const end = SERVER_SRC.indexOf('const SPAWN_CLASSIFY_MS');
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    const block = SERVER_SRC.slice(at, end);
    // every read of either variable in the whole file sits inside that one block
    // (WT_SPAWN_WORKER is the unrelated, older "spawn the pty-worker" switch)
    const all = SERVER_SRC.match(/process\.env\.WT_SPAWN_(?!WORKER)[A-Z_]+/g) || [];
    const inBlock = block.match(/process\.env\.WT_SPAWN_(?!WORKER)[A-Z_]+/g) || [];
    expect(all.length).toBeGreaterThan(0);
    expect(inBlock).toEqual(all);
    expect(new Set(all)).toEqual(new Set(['process.env.WT_SPAWN_CLASSIFY_MS', 'process.env.WT_SPAWN_IDLE_MS']));
  });

  test('the time lever exists only under WT_TEST', () => {
    const at = SERVER_SRC.indexOf("app.post('/api/test/spawn-age/:id'");
    expect(at).toBeGreaterThan(0);
    const open = SERVER_SRC.lastIndexOf('if (process.env.WT_TEST) {', at);
    const close = SERVER_SRC.slice(at).search(/\n\}\r?\n/);
    expect(open).toBeGreaterThan(0);
    // the route sits inside that one WT_TEST block, not after its closing brace
    expect(SERVER_SRC.slice(open, at + close)).toContain("app.post('/api/test/spawn-age/:id'");
    expect(SERVER_SRC.slice(open, at)).not.toMatch(/\n\}\r?\n/);
  });

  test('the knob is read live, by the documented name, with the library default', () => {
    expect(SERVER_SRC).toContain("liveConfig('spawnedSessionIdleCloseHours', spawnReaper.DEFAULT_IDLE_HOURS)");
  });

  test('an `active` frame is a view when it ARRIVES, before it is queued behind the attach', () => {
    const ws = SERVER_SRC.slice(SERVER_SRC.indexOf("app.ws('/ws/:id'"));
    const handler = ws.slice(ws.indexOf("ws.on('message', (msg) => {"));
    const body = handler.slice(0, handler.indexOf('handleMessage(msg);'));
    expect(body).toContain('spawnReaper.isActiveModeFrame(msg)');
    expect(body.indexOf('spawnStore.noteViewed(id)')).toBeGreaterThan(0);
    expect(body.indexOf('spawnStore.noteViewed(id)')).toBeLessThan(body.indexOf('pendingMessages.push(msg)'));
  });

  test('a socket still attaching counts as a viewer, and stops counting when it is attached or gone', () => {
    const ws = SERVER_SRC.slice(SERVER_SRC.indexOf("app.ws('/ws/:id'"));
    expect(ws).toContain('setAttaching(id, ws, true)');
    expect(ws).toContain('setAttaching(id, ws, false)');
    expect((ws.match(/setAttaching\(id, ws, false\)/g) || []).length).toBe(2); // attached, and closed
    const count = SERVER_SRC.slice(SERVER_SRC.indexOf('function activeViewerCount(id)'));
    expect(count.slice(0, count.indexOf('\n}'))).toContain('attachingSockets');
  });

  test('a session that goes away takes its verdict with it (sessionExited -> forget), and the sweep prunes', () => {
    const exited = SERVER_SRC.slice(SERVER_SRC.indexOf("workerClient.on('sessionExited'"));
    expect(exited.slice(0, exited.indexOf('workerClient.onExit'))).toContain('spawnStore.forget(id)');
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    expect(sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'))).toContain('spawnStore.prune(');
  });

  test('the reaper reads RAW work (never the aged badge helpers) and never awaits a process snapshot (#280)', () => {
    const at = SERVER_SRC.indexOf('async function reaperRunningWork(s)');
    const body = SERVER_SRC.slice(at, SERVER_SRC.indexOf('let _spawnSweepBusy'));
    expect(body).toContain('readBackgroundTasks(s)');
    expect(body).toContain('processTree.snapshotNoWait()');
    expect(body).not.toMatch(/processTree\s*\.\s*snapshot\b\s*\(/);
    expect(body).toContain('processTree.liveWorkUnder(');
    // the badge's helpers age a task out at 6h, mark a shell stale at 6h, swallow errors to [],
    // and turn a missing snapshot into [] - each would make the gate dead or fail-open
    for (const lenient of ['sessionRunningWork', 'sessionBackgroundTasks', 'sessionRunningShells', 'freshBackgroundTasks', 'runningShellsUnder']) {
      expect(body).not.toContain(lenient);
    }
  });

  test('the sweep looks for viewers once more right before the kill, with nothing awaited in between', () => {
    const sweep = SERVER_SRC.slice(SERVER_SRC.indexOf('async function spawnReaperSweep'));
    const body = sweep.slice(0, sweep.indexOf('const _spawnReaperTicker'));
    const check = body.lastIndexOf('activeViewerCount(s.id) > 0');
    const kill = body.indexOf('await killLocalSession(s.id)');
    expect(check).toBeGreaterThan(0);
    expect(kill).toBeGreaterThan(check);
    expect(body.slice(check, kill)).not.toContain('await');
  });

  test('a hand-off successor is registered by the one start path, right after it is created', () => {
    const at = SERVER_SRC.indexOf('async function spawnSuccessor(');
    const body = SERVER_SRC.slice(at, SERVER_SRC.indexOf('async function verifySuccessor'));
    expect(body).toContain('spawnStore.inherit(id, sid)');
    expect(body.indexOf("workerClient.rpc('createSession'")).toBeLessThan(body.indexOf('spawnStore.inherit(id, sid)'));
  });

  test('every active-viewer transition feeds the clock', () => {
    const ws = SERVER_SRC.slice(SERVER_SRC.indexOf("app.ws('/ws/:id'"));
    // becoming active, leaving active (mode change), leaving active (close), legacy attach
    // (the arrival of an active frame is pinned separately below)
    expect((ws.match(/spawnStore\.noteViewed\(id\)/g) || []).length).toBe(5);
  });
});

// --- the real server -------------------------------------------------------------
//
// NO WALL-CLOCK BETS. Measured on Home (2026-10-15): a bare Node process doing nothing but a
// 10 ms timer is stalled for 8-16 s out of every 20 s, in stalls of up to 8 s, with and without
// anything of ours running (`snapshotNoWait` spawning PowerShell makes no difference). Every
// fixed sleep, window and timeout in a spec is a bet against that, so this section makes none:
//   * "inside the classify window" has 60 s of slack (playwright.config.js);
//   * "past the window" and "untouched for hours" are never waited for: POST
//     /api/test/spawn-age/:id and age-session move the clocks, and every sweep is asked at the
//     REAL 6 h threshold;
//   * a state a spec depends on is polled for (a socket attached, output landed), never slept for;
//   * HTTP goes out with `Connection: close`. The server drops an idle keep-alive socket after
//     5 s (Node's default), and a client that is stalled across that instant writes its next
//     request to a socket the server has already closed: ECONNRESET / "socket hang up".
//     Reproduced against this suite server: 5 of 5 stalled requests reset, 0 of 8 with `close`;
//   * the socket helper copes with the server having closed the socket first (a session the
//     sweep closes ends its viewers' sockets before the HTTP answer reaches the spec).

const CLASSIFY_MS = Number(process.env.WT_SPAWN_CLASSIFY_MS) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test.describe('#351 against the real server', () => {
  test.skip(!CLASSIFY_MS, 'needs the suite server\'s classify window (playwright.config.js)');
  test.setTimeout(120000); // a bound for a failure, not a bet: nothing below sleeps for a window

  /** @type {import('@playwright/test').APIRequestContext} */
  let ctx;
  /** @type {string} */
  let cookie;
  /** @type {string[]} */
  let made = [];

  test.beforeAll(async () => { cookie = await rawCookie(); });
  test.beforeEach(async () => {
    ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Cookie: cookie, 'X-WT-Hook-Token': readHookToken(), Connection: 'close' },
    });
    made = [];
  });
  test.afterEach(async () => {
    for (const id of made) await ctx.delete(`/api/sessions/${id}`).catch(() => {});
    await ctx.dispose();
  });

  async function create(name, extra = {}) {
    const r = await ctx.post('/api/sessions', { data: { name: `${name}-${Date.now()}`, ...extra } });
    expect(r.status()).toBe(200);
    const id = (await r.json()).id;
    made.push(id);
    return id;
  }
  const rowOf = async (id) => (await (await ctx.get('/api/sessions')).json()).find((s) => s.id === id);
  const clusterRowOf = async (id) => (await (await ctx.get('/api/cluster/sessions')).json()).sessions.find((s) => s.id === id);
  const exists = async (id) => Boolean(await rowOf(id));
  const until = async (fn, what, ms = 60000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(300);
    }
  };

  // ---- the time levers ----
  const ageSpawn = async (id, ms) => expect((await ctx.post(`/api/test/spawn-age/${id}`, { data: { ms } })).status()).toBe(200);
  const ageActivity = async (id, ms) => expect((await ctx.post(`/api/test/age-session/${id}`, { data: { ageMinutes: ms / 60000, activityOnly: true } })).status()).toBe(200);
  /** The classify window has passed for [id]. */
  const pastWindow = (id) => ageSpawn(id, CLASSIFY_MS + 1000);
  /** [id] has been untouched for 7 hours: created, last viewed and last written to. */
  const untouched = async (id) => { await ageSpawn(id, 7 * HOUR); await ageActivity(id, 7 * HOUR); };

  /** Run the reaper now, at the real threshold. `fail`: reads to make fail ('work', 'metrics'). */
  const sweep = async (fail) => {
    // A sweep that finds another one running (the 5-minute ticker, or a slow earlier call) says so
    // and does nothing; ask again rather than read the empty answer as "kept".
    for (let i = 0; i < 80; i++) {
      const out = await (await ctx.post('/api/test/spawn-reaper-sweep', { data: fail ? { fail } : {} })).json();
      if (!out.skipped) return out;
      await sleep(250);
    }
    throw new Error('the reaper sweep stayed busy');
  };
  /**
   * Make [id] look untouched, ask the reaper, and return its answer - re-establishing the PREMISE
   * until it holds, never retrying the answer under test:
   *  - 'recent' means something touched the session after it was aged (a slow shell's first
   *    prompt landing late): age it again and ask again;
   *  - 'work-unknown' means the process snapshot is not there yet (the first sweep after the
   *    server starts asks for it in the background, #280): ask again once it has landed -
   *    unless the spec injected that failure itself.
   */
  async function sweepUntouched(id, fail, ms = 90000) {
    const end = Date.now() + ms;
    const injected = Array.isArray(fail) && fail.includes('work');
    for (;;) {
      await untouched(id);
      const out = await sweep(fail);
      const why = out.kept[id];
      const premiseMissing = why === 'recent' || (why === 'work-unknown' && !injected);
      if (out.closed.includes(id) || !premiseMissing) return out;
      if (Date.now() > end) throw new Error(`the premise never held for ${id}: kept as ${JSON.stringify(why)}`);
      await sleep(1000);
    }
  }
  /** The reaper closes [id] (once its premise holds). */
  async function reaped(id) {
    const out = await sweepUntouched(id);
    expect(out.closed, JSON.stringify(out.kept[id])).toContain(id);
  }

  /** A viewer socket on /ws/:id: resolves once the SERVER has attached it (the worker counts it). */
  async function attach(id, mode) {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    if (mode) ws.send(JSON.stringify({ mode, browserId: `reaper-${Math.random()}` }));
    await until(async () => ((await rowOf(id)) || {}).clients > 0, 'the socket to be attached');
    return {
      ws,
      // Safe whoever closed first: a session the sweep ends takes its viewers' sockets with it, and a
      // 'close' that has already fired is never emitted again.
      close: () => new Promise((r) => {
        if (ws.readyState === WebSocket.CLOSED) return r();
        ws.once('close', r);
        try { ws.close(); } catch { r(); }
      }),
    };
  }
  /** After a viewer socket is gone, wait until the server has let go of it. */
  const detached = (id) => until(async () => ((await rowOf(id)) || { clients: 0 }).clients === 0, 'the socket to be detached');

  test('no viewer in the window -> agent-started; the sweep closes it only once it is idle long enough', async () => {
    const id = await create('rp-agent', { spawnedBy: `   a helper agent   ${'x'.repeat(200)}` });
    // Inside the window nothing is claimed yet.
    expect((await rowOf(id)).spawn).toMatchObject({ by: 'pending' });
    await pastWindow(id);

    const r = await rowOf(id);
    expect(r.spawn.by).toBe('agent');
    expect(r.spawn.spawnedBy).toHaveLength(120);
    expect(r.spawn.spawnedBy.startsWith('a helper agent')).toBe(true);
    expect(typeof r.spawn.createdAt).toBe('number');
    // ...on the cluster list too (the second shaper)
    expect((await clusterRowOf(id)).spawn).toMatchObject({ by: 'agent' });

    // The real threshold is 6 hours: a brand-new session is kept, and says why - without having
    // consulted any read (a fresh server has no process snapshot, which is no reason to name).
    const kept = await sweep();
    expect(kept.closed).not.toContain(id);
    expect(kept.kept[id]).toBe('recent');
    expect(await exists(id)).toBe(true);

    // Untouched for 7 hours it closes.
    await reaped(id);
    expect(await exists(id)).toBe(false);
    expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(404);
  });

  test('an ACTIVE viewer that stays past the window -> a person\'s session, never closed', async () => {
    const id = await create('rp-human-stays');
    const v = await attach(id, 'active'); // the mode message alone must classify it
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('human');
    await v.close();
    await detached(id);
    await untouched(id);
    const s = await sweep();
    expect(s.closed).not.toContain(id);
    expect(await exists(id)).toBe(true);
  });

  test('an ACTIVE viewer that looks and leaves inside the window -> a person\'s session too', async () => {
    const id = await create('rp-human-leaves');
    const v = await attach(id, 'active');
    await v.close(); // gone again: only the CLASSIFICATION is under test, not the viewer gate
    await detached(id);
    await pastWindow(id);

    expect((await rowOf(id)).spawn.by).toBe('human');
    expect((await clusterRowOf(id)).spawn.by).toBe('human');
    await untouched(id);
    const s = await sweep();
    expect(s.closed).not.toContain(id);
    expect(await exists(id)).toBe(true);
  });

  test('a BACKGROUND socket is not a viewer: it neither classifies a person nor holds the session open', async () => {
    const id = await create('rp-bg');
    const v = await attach(id, 'background');
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('agent');

    await reaped(id);
    expect(await exists(id)).toBe(false);
    await v.close();
  });

  test('a viewer who is attached holds an agent-started session; once they leave, the clock starts from then', async () => {
    const id = await create('rp-watch');
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('agent');

    const v = await attach(id, 'active'); // a person opens it, late
    const held = await sweepUntouched(id);
    expect(held.closed).not.toContain(id);
    expect(held.kept[id]).toBe('viewer');
    expect(await exists(id)).toBe(true);

    await v.close();
    await detached(id);
    // They have only just left: that is the last time it was viewed, so it is "recent" - the
    // session itself has been untouched for 7 hours (aged above) and is no reason.
    const fresh = await sweep();
    expect(fresh.closed).not.toContain(id);
    expect(fresh.kept[id]).toBe('recent');

    await reaped(id); // 7 hours after they left, it closes
  });

  test('a session that is writing output is not closed - the output alone holds it', async () => {
    const id = await create('rp-busy');
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('agent');
    // A background socket's input is dropped by the server, so an ACTIVE one types the command
    // and leaves. `echo` is a builtin: no child process, so the only thing that can hold the
    // session is the output it just wrote.
    const typer = await attach(id, 'active');
    const typedAt = Date.now();
    typer.ws.send('echo output-holds-it\r');
    await until(async () => ((await rowOf(id)) || {}).lastActivity >= typedAt, 'the echo to be written');
    await typer.close();
    await detached(id);
    await ageSpawn(id, 7 * HOUR); // created and last viewed are now 7 hours ago; lastActivity is not

    const s = await sweep();
    expect(s.closed).not.toContain(id);
    expect(s.kept[id]).toBe('recent');
    expect(await exists(id)).toBe(true);

    await reaped(id); // control: the same session, its output now 7 hours old, closes
  });

  // ---- #351 review round: the late view, the persisted verdict, the dead gate, the unknowns ----

  test('an `active` frame is a view when it ARRIVES: it counts even if the socket is gone before the attach finishes', async () => {
    // The companion can spend tens of seconds before it declares itself, and the server used
    // to record the view only once the worker attach it queued behind had completed. Here the
    // frame is sent and the socket closed at once, so the attach is still in flight: the frame
    // is never drained, and only recording it at arrival can make this session a person's.
    const sendAndLeave = async (id, frame) => {
      const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, { headers: { Cookie: cookie } });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify(frame));
      const closed = new Promise((r) => ws.once('close', r));
      ws.close();
      await closed;
    };
    const personal = await create('rp-early-active');
    await sendAndLeave(personal, { mode: 'active', browserId: 'early-1' });
    const bystander = await create('rp-early-background');
    await sendAndLeave(bystander, { mode: 'background', browserId: 'early-2' }); // a keepOpen socket is not a person
    await pastWindow(personal);
    await pastWindow(bystander);
    expect((await rowOf(personal)).spawn.by).toBe('human');
    expect((await rowOf(bystander)).spawn.by).toBe('agent');
  });

  test('the verdict is written once decided and removed when the session goes (sessionExited -> forget)', async () => {
    const file = process.env.WT_SPAWNED_SESSIONS_FILE;
    test.skip(!file, 'needs the suite\'s WT_SPAWNED_SESSIONS_FILE');
    const verdicts = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = await create('rp-file', { spawnedBy: 'file-test' });
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('agent');
    expect(verdicts()[id]).toMatchObject({ by: 'agent', spawnedBy: 'file-test' });
    expect((await ctx.delete(`/api/sessions/${id}`)).status()).toBe(200);
    // sessionExited arrives a moment after the row leaves the list; no sweep runs in between
    await expect.poll(() => Object.prototype.hasOwnProperty.call(verdicts(), id), { timeout: 30000 }).toBe(false);
  });

  const FIXTURE_DIR = path.join(claudeProjectsRoot(), '__wt-spawnreaper-fixture__');
  const launchLine = (toolUseId, description, timestamp) => JSON.stringify({
    timestamp, message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'npm run build', description, run_in_background: true } }] },
  });
  const launchResultLine = (toolUseId, bgId, timestamp) => JSON.stringify({
    timestamp, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Command running in background with ID: ${bgId}. Output is being written to: /tmp/${bgId}.output. You will be notified when it completes.` }] },
  });
  const finishLine = (bgId) => JSON.stringify({
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: `<task-notification>\n<task-id>${bgId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` }] },
  });

  test('a launch the transcript still shows as running holds the session at ANY age - the badge has already let go of it', async () => {
    // The suite server ages a badge task out after 2.5s (WT_BG_TASK_MAX_AGE_MS; 6h in
    // production, which is also the idle threshold). The reaper must not inherit that.
    const fixture = path.join(FIXTURE_DIR, `wt_spawnreaper_${process.pid}.jsonl`);
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    try {
      const when = new Date().toISOString();
      fs.writeFileSync(fixture, [launchLine('toolu_sr', 'Full server suite', when), launchResultLine('toolu_sr', 'bgsr1', when)].join('\n') + '\n', 'utf8');
      const id = await create('rp-bgwork', { agent: 'claude' });
      const hook = async (event, extra = {}) => expect((await ctx.post('/api/hook', {
        headers: { 'X-WT-Session-ID': id }, data: { hook_event_name: event, ...extra },
      })).status()).toBe(200);
      await hook('UserPromptSubmit', { transcript_path: fixture, prompt: 'go' });
      await hook('Stop', {});
      await expect.poll(async () => (await rowOf(id))?.status, { timeout: 30000 }).toBe('idle');
      await pastWindow(id);
      expect((await rowOf(id)).spawn.by).toBe('agent');
      // the badge has aged it out (a real 2.5 s the suite server is configured with) ...
      await expect.poll(async () => (await rowOf(id)).backgroundTasks, { timeout: 30000, intervals: [500] }).toEqual([]);
      // ... and the reaper has not: the ONLY thing holding the session is the running launch
      const held = await sweepUntouched(id);
      expect(held.closed).not.toContain(id);
      expect(held.kept[id]).toBe('background-work');
      expect(await exists(id)).toBe(true);

      // The transcript records the finish: nothing else changed, and now it closes.
      fs.appendFileSync(fixture, finishLine('bgsr1') + '\n', 'utf8');
      await until(async () => {
        const out = await sweepUntouched(id);
        return out.closed.includes(id);
      }, 'the finished launch to release the session');
    } finally {
      try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test('a read that could not tell keeps the session: unknown work, then unknown usage - and it closes once both can be read', async () => {
    const id = await create('rp-unknown');
    await pastWindow(id);
    expect((await rowOf(id)).spawn.by).toBe('agent');

    const noWork = await sweepUntouched(id, ['work']);
    expect(noWork.closed).not.toContain(id);
    expect(noWork.kept[id]).toBe('work-unknown');

    const noUsage = await sweepUntouched(id, ['metrics']);
    expect(noUsage.closed).not.toContain(id);
    expect(noUsage.kept[id]).toBe('usage-unknown');
    expect(await exists(id)).toBe(true);

    await reaped(id);
  });

  // ---- a hand-off successor (#340/#345) ----------------------------------------------------

  const LAUNCH = "printf '\\xe2\\x9d\\xaf\\xc2\\xa0 ready\\n'; echo claude";
  const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, '..', 'handoffs.test');
  const hookToken = readHookToken;
  const agentHook = async (id, event, body = {}) => (await ctx.post('/api/hook', {
    data: { hook_event_name: event, ...body }, headers: { 'X-WT-Hook-Token': hookToken(), 'X-WT-Session-ID': id },
  })).status();
  const allRows = async () => (await ctx.get('/api/sessions')).json();

  /** A Claude-declared session in the state the hand-off board offers: a finished turn, a
   *  report waiting on a third party, 60% of a 1M window. Created through POST (so it has a
   *  spawn verdict); `extra` is the request body (a spawnedBy label). */
  async function handoffCandidate(name, extra = {}, { viewed = false } = {}) {
    const id = await create(name, { agent: 'claude', autoCommand: LAUNCH, ...extra });
    // A person opens it inside the classify window.
    if (viewed) { const v = await attach(id, 'active'); await v.close(); await detached(id); }
    await until(async () => (await rowOf(id))?.agentReady === true, 'the session to be ready');
    const conv = crypto.randomUUID();
    expect(await agentHook(id, 'UserPromptSubmit', { session_id: conv, prompt: 'work' })).toBe(200);
    expect(await agentHook(id, 'Stop', { session_id: conv })).toBe(200);
    const rep = await ctx.post(`/api/session/${id}/report`, {
      data: { items: [{ ref: '#1', title: 'x', state: 'in-progress' }], wait: { on: 'external', what: 'PR review' } },
      headers: { 'X-WT-Hook-Token': hookToken() },
    });
    expect(rep.status()).toBe(200);
    expect((await ctx.post('/api/claude-status', { data: { session_id: conv, context_window: { context_window_size: 1_000_000, used_percentage: 60 } } })).status()).toBe(200);
    await until(async () => (await rowOf(id))?.status === 'idle', 'the session to go idle');
    return id;
  }
  /** Run a hand-off up to the point the successor exists (a "keep" verdict, so nothing is killed). */
  async function handOff(id, name) {
    expect((await ctx.post(`/api/sessions/${id}/handoff`, { data: { force: true } })).status()).toBe(200);
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    fs.writeFileSync(path.join(HANDOFF_DIR, `handoff-${id}.md`), '# brief\nnext: wait for the PR\n');
    const v = await ctx.post(`/api/session/${id}/handoff-report`, { data: { canClose: false, why: 'keep for the test' }, headers: { 'X-WT-Hook-Token': hookToken() } });
    expect(v.status()).toBe(200);
    return until(async () => (await allRows()).find((s) => s.name === `${name} (2)`), 'the successor');
  }
  const dropByPrefix = async (prefix) => {
    for (const s of await allRows()) if (s.name.startsWith(prefix)) await ctx.delete(`/api/sessions/${s.id}`).catch(() => {});
  };

  test('a hand-off successor of an agent-started session is agent-started too, with the spawner carried over', async () => {
    const base = `rp-handoff-agent-${Date.now()}`;
    try {
      const id = await handoffCandidate(base, { name: base, spawnedBy: 'nightly' });
      await pastWindow(id);
      const before = await rowOf(id);
      expect(before.spawn).toMatchObject({ by: 'agent', spawnedBy: 'nightly' });
      const succ = await handOff(id, before.name);
      expect(succ.spawn).toMatchObject({ by: 'agent', spawnedBy: 'nightly' });
      expect(succ.spawn.createdAt).toBeGreaterThan(before.spawn.createdAt); // its own clock
    } finally { await dropByPrefix(base); }
  });

  test('...and a PERSON\'s session gives its successor no verdict, as before', async () => {
    const base = `rp-handoff-human-${Date.now()}`;
    try {
      const id = await handoffCandidate(base, { name: base }, { viewed: true });
      await pastWindow(id);
      const before = await rowOf(id);
      expect(before.spawn.by).toBe('human');
      const succ = await handOff(id, before.name);
      expect(succ.spawn).toBeNull();
    } finally { await dropByPrefix(base); }
  });
});
