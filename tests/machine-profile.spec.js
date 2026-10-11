// @ts-check
// #331 - the dashboard's Machines section: lib/machine-profile.js's pure rules, its
// on-demand cache, and GET /api/machine against a real server. As in
// resources-api.spec.js, the API half asserts the CONTRACT, never a number: a reading is
// honest or explicitly unknown (null), and never a fabricated 0.
const { test, expect } = require('@playwright/test');
const { authCtx, noAuthCtx } = require('./test-helpers');
const M = require('../lib/machine-profile');

const GB = 1024 * 1024 * 1024;

test.describe('machine profile rules (#331)', () => {
  test('parses commit (KILOBYTES) and fixed drives (bytes); a bad line is dropped, not zeroed', () => {
    const out = [
      'OS|71595604|20440268',
      `DISK|E:|${2000 * GB}|${1300 * GB}|NTFS`,
      `DISK|C:|${931 * GB}|${169 * GB}|NTFS`,
      'DISK|C:|||NTFS',                         // unread size: dropped
      `DISK|\\\\srv\\share|${GB}|${GB}|NTFS`,   // not a drive letter: never reaches a client
      `DISK|D:|${GB}|${2 * GB}|NTFS`,           // more free than the drive holds: impossible
      `DISK|G:|${931 * GB}|${160 * GB}|FAT32`,  // a cloud mount (Google Drive): not a disk
      'garbage',
    ].join('\r\n');
    const p = M.parseProfileOutput(out);
    expect(p.commit).toEqual({ totalBytes: 71595604 * 1024, availBytes: 20440268 * 1024 });
    expect(p.disks.map((d) => d.root)).toEqual(['C:', 'E:']);
    expect(p.disks[0]).toEqual({ root: 'C:', totalBytes: 931 * GB, freeBytes: 169 * GB });
  });

  test('a missing or impossible commit line is null, never 0', () => {
    expect(M.parseProfileOutput('').commit).toBeNull();
    expect(M.parseProfileOutput('OS||').commit).toBeNull();
    expect(M.parseProfileOutput('OS|100|200').commit).toBeNull();
  });

  test('no drive line at all is UNKNOWN (null), not "no drives"', () => {
    expect(M.parseProfileOutput('OS|100|50').disks).toBeNull();
    // a drive line that was read but filtered out still means the list WAS read
    expect(M.parseProfileOutput(`DISK|G:|${GB}|${GB}|FAT32`).disks).toEqual([]);
  });

  test('levels: low free space is hot/warn; unknown is null; a full session limit is hot', () => {
    expect(M.freeLevel(1 * GB, M.THRESHOLDS.disk)).toBe('hot');
    expect(M.freeLevel(20 * GB, M.THRESHOLDS.disk)).toBe('warn');
    expect(M.freeLevel(500 * GB, M.THRESHOLDS.disk)).toBe('ok');
    expect(M.freeLevel(null, M.THRESHOLDS.disk)).toBeNull();
    expect(M.freeLevel(NaN, M.THRESHOLDS.disk)).toBeNull();
    expect(M.cpuLevel(95)).toBe('hot');
    expect(M.cpuLevel(75)).toBe('warn');
    expect(M.cpuLevel(5)).toBe('ok');
    expect(M.cpuLevel(null)).toBeNull();
    expect(M.sessionsLevel(10, 10)).toBe('hot');
    expect(M.sessionsLevel(9, 10)).toBe('warn');
    expect(M.sessionsLevel(3, 10)).toBe('ok');
    expect(M.sessionsLevel(0, 1)).toBe('ok');   // a limit of one: an empty box is not a warning
  });

  test('shapeProfile: what could not be read is null, and every reading carries its level', () => {
    const full = M.shapeProfile({
      name: 'Home',
      resources: { cpuPct: 12, memory: { availBytes: 3 * GB, totalBytes: 64 * GB } },
      os: { commit: { totalBytes: 68 * GB, availBytes: 1 * GB }, disks: [{ root: 'C:', totalBytes: 931 * GB, freeBytes: 169 * GB }] },
      cpuCount: 16,
      uptimeSec: 3600.4,
      sessions: [{ status: 'working' }, { status: 'waiting' }, { status: 'idle' }],
      maxSessions: 10,
      ts: 1,
    });
    expect(full.cpu).toEqual({ pct: 12, cores: 16, level: 'ok' });
    expect(full.memory.level).toBe('warn');
    expect(full.commit.level).toBe('hot');
    expect(full.disks[0].level).toBe('ok');
    expect(full.sessions).toEqual({ count: 3, working: 1, waiting: 1, max: 10, level: 'ok' });
    expect(full.uptimeSec).toBe(3600);

    const bare = M.shapeProfile({ name: 'X', resources: { cpuPct: null, memory: null }, os: null, cpuCount: 4, uptimeSec: 1, sessions: null, maxSessions: 10, ts: 1 });
    expect(bare.cpu.pct).toBeNull();
    expect(bare.cpu.level).toBeNull();
    expect(bare.memory).toBeNull();
    expect(bare.commit).toBeNull();
    expect(bare.disks).toBeNull();      // unknown, which is not "no drives" ([])
    expect(bare.sessions).toBeNull();
  });

  test('the query runs once per TTL and is shared by concurrent callers; a failure is unknown', async () => {
    let calls = 0;
    M._setQueryForTests(async () => { calls++; return { commit: null, disks: [{ root: 'C:', totalBytes: 2, freeBytes: 1 }] }; });
    try {
      const [a, b] = await Promise.all([M.readOsPart(), M.readOsPart()]);
      expect(calls).toBe(1);
      expect(a).toEqual(b);
      await M.readOsPart();
      expect(calls).toBe(1);
      // a fresh query that fails reports null (unknown), and that is cached for the TTL too
      M._setQueryForTests(async () => { calls++; throw new Error('hung'); });
      expect(await M.readOsPart()).toBeNull();
      expect(await M.readOsPart(Date.now() + 1000)).toBeNull();
      expect(calls).toBe(2);
    } finally {
      M._setQueryForTests(null);
    }
  });

  test('a HUNG query gives up the slot after INFLIGHT_MAX_MS, and its late answer overwrites nothing', async () => {
    let release;
    let calls = 0;
    const hung = new Promise((r) => { release = r; });
    M._setQueryForTests(() => { calls++; return calls === 1 ? hung : Promise.resolve({ commit: null, disks: [{ root: 'C:', totalBytes: 2, freeBytes: 2 }] }); });
    try {
      const t0 = Date.now();
      const first = M.readOsPart(t0);
      // still inside the window: the hung query is shared, not duplicated
      M.readOsPart(t0 + 1000);
      await new Promise((r) => setImmediate(r));
      expect(calls).toBe(1);
      // past it: a second query starts and its answer is served
      const second = await M.readOsPart(t0 + M.INFLIGHT_MAX_MS + 1);
      expect(calls).toBe(2);
      expect(second.disks[0].freeBytes).toBe(2);
      // the first one answering LATE must not replace the newer reading
      release({ commit: null, disks: [{ root: 'C:', totalBytes: 2, freeBytes: 1 }] });
      await first;
      expect((await M.readOsPart()).disks[0].freeBytes).toBe(2);
      expect(calls).toBe(2);
    } finally {
      M._setQueryForTests(null);
    }
  });
});

test.describe('GET /api/machine (#331)', () => {
  test('requires auth', async () => {
    const ctx = await noAuthCtx();
    const res = await ctx.get('/api/machine');
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await ctx.dispose();
  });

  test('answers the whole profile, every reading honest or null; the capability is advertised', async () => {
    const ctx = await authCtx();
    const ver = await (await ctx.get('/api/version')).json();
    expect(ver.capabilities).toContain('machine-profile');

    const res = await ctx.get('/api/machine');
    expect(res.ok()).toBeTruthy();
    const b = await res.json();
    expect(typeof b.name).toBe('string');
    expect(b.cpu.cores).toBeGreaterThan(0);
    expect(b.cpu.pct === null || (b.cpu.pct >= 0 && b.cpu.pct <= 100)).toBe(true);
    expect(b.memory.totalBytes).toBeGreaterThan(0);
    expect(['ok', 'warn', 'hot']).toContain(b.memory.level);
    expect(b.sessions.max).toBeGreaterThan(0);
    expect(b.sessions.count).toBeGreaterThanOrEqual(0);
    expect(b.uptimeSec).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      // The CIM half is the point of the endpoint; on the platform that has it, it must work.
      expect(b.commit && b.commit.totalBytes).toBeGreaterThan(0);
      expect(Array.isArray(b.disks) && b.disks.length).toBeGreaterThan(0);
      for (const d of b.disks) {
        expect(d.root).toMatch(/^[A-Z]:$/);
        expect(d.freeBytes).toBeLessThanOrEqual(d.totalBytes);
        expect(['ok', 'warn', 'hot']).toContain(d.level);
      }
    }
    await ctx.dispose();
  });
});
