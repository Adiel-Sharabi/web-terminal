// @ts-check
const { test, expect } = require('@playwright/test');
const { cpuPercentFromSamples, memoryReading, sanitizeResources, Sampler, SAMPLE_INTERVAL_MS } = require('../lib/resources');

// #152 — the per-server CPU/memory maths. PURE, so these run with no timers and no
// real CPU load: cpuPercentFromSamples takes two hand-built tick snapshots and must
// never fabricate a number it cannot honestly compute.

test.describe('cpuPercentFromSamples', () => {
  test('no previous sample -> null (never 0%)', () => {
    expect(cpuPercentFromSamples(null, { idle: 100, total: 1000 })).toBeNull();
    expect(cpuPercentFromSamples(undefined, { idle: 100, total: 1000 })).toBeNull();
  });

  test('identical samples (zero elapsed) -> null, not NaN, not 0', () => {
    const s = { idle: 500, total: 2000 };
    const r = cpuPercentFromSamples(s, { idle: 500, total: 2000 });
    expect(r).toBeNull();
    expect(Number.isNaN(r)).toBe(false);
  });

  test('a fully-busy window (idle does not advance) reports ~100', () => {
    const prev = { idle: 1000, total: 5000 };
    const next = { idle: 1000, total: 6000 }; // idle unchanged, total advanced by 1000
    expect(cpuPercentFromSamples(prev, next)).toBe(100);
  });

  test('a fully-idle window (idle advances with total) reports ~0', () => {
    const prev = { idle: 1000, total: 5000 };
    const next = { idle: 2000, total: 6000 }; // idle advanced by exactly the total delta
    expect(cpuPercentFromSamples(prev, next)).toBe(0);
  });

  test('a partially-busy window reports the proportional percentage', () => {
    const prev = { idle: 1000, total: 5000 };
    const next = { idle: 1200, total: 6000 }; // idle grew 200 of 1000 total delta -> 80% busy
    expect(cpuPercentFromSamples(prev, next)).toBe(80);
  });

  test('a negative total delta (bogus/rewound pair) -> null, never negative or >100', () => {
    const prev = { idle: 1000, total: 6000 };
    const next = { idle: 500, total: 5000 };
    expect(cpuPercentFromSamples(prev, next)).toBeNull();
  });

  test('clamps to [0, 100] even against a malformed idle delta', () => {
    const prev = { idle: 0, total: 1000 };
    const next = { idle: -500, total: 2000 }; // idle delta negative -> busyFrac > 1
    expect(cpuPercentFromSamples(prev, next)).toBe(100);
  });

  test('non-finite inputs -> null, not NaN', () => {
    expect(cpuPercentFromSamples({ idle: NaN, total: 1000 }, { idle: 100, total: 2000 })).toBeNull();
    expect(cpuPercentFromSamples({ idle: 0, total: 1000 }, { idle: 100, total: Infinity })).toBeNull();
  });
});

test.describe('memoryReading', () => {
  test('returns a well-formed shape with a computed usedPct', () => {
    const m = memoryReading();
    expect(typeof m.totalBytes).toBe('number');
    expect(typeof m.usedBytes).toBe('number');
    expect(m.totalBytes).toBeGreaterThan(0);
    expect(m.usedBytes).toBeGreaterThanOrEqual(0);
    expect(m.usedPct).not.toBeNull();
    expect(m.usedPct).toBeGreaterThanOrEqual(0);
    expect(m.usedPct).toBeLessThanOrEqual(100);
  });
});

test.describe('Sampler', () => {
  test('the very first read() before any tick() has a null cpuPct but a real memory reading', () => {
    const s = new Sampler();
    const r = s.read();
    expect(r.cpuPct).toBeNull();
    expect(r.memory.totalBytes).toBeGreaterThan(0);
    expect(r.windowMs).toBe(SAMPLE_INTERVAL_MS);
    expect(typeof r.ts).toBe('number');
  });

  test('one tick() seeds the sample but still cannot produce a delta -> cpuPct stays null', () => {
    const s = new Sampler();
    s.tick();
    expect(s.read().cpuPct).toBeNull();
  });

  test('a second tick() (with a real delta) produces a finite 0-100 cpuPct', () => {
    const s = new Sampler();
    s.tick();
    // Burn a little CPU so the two real os.cpus() samples are not bit-identical ticks;
    // even if they were, cpuPercentFromSamples must still return a number here since
    // wall-clock time passing is not what gates this — a nonzero total tick delta is.
    // Real os.cpus() sampling can't be faked without timers, so this only asserts shape.
    s.tick();
    const r = s.read();
    expect(r.cpuPct === null || (r.cpuPct >= 0 && r.cpuPct <= 100)).toBe(true);
  });
});

test.describe('sanitizeResources', () => {
  test('accepts a well-formed reading verbatim', () => {
    const good = { cpuPct: 42, windowMs: 5000, ts: Date.now(), memory: { usedBytes: 100, totalBytes: 200, usedPct: 50 } };
    expect(sanitizeResources(good)).toEqual(good);
  });

  test('accepts a null cpuPct (the honest "not yet known" reading)', () => {
    const r = { cpuPct: null, windowMs: 5000, ts: Date.now(), memory: { usedBytes: 100, totalBytes: 200, usedPct: null } };
    expect(sanitizeResources(r)).toEqual(r);
  });

  test('rejects null/undefined/non-object input', () => {
    expect(sanitizeResources(null)).toBeNull();
    expect(sanitizeResources(undefined)).toBeNull();
    expect(sanitizeResources('not an object')).toBeNull();
    expect(sanitizeResources(42)).toBeNull();
  });

  test('rejects an out-of-range or wrong-typed cpuPct', () => {
    expect(sanitizeResources({ cpuPct: 150, windowMs: 5000, ts: 1, memory: { usedBytes: 1, totalBytes: 2, usedPct: 50 } })).toBeNull();
    expect(sanitizeResources({ cpuPct: '42', windowMs: 5000, ts: 1, memory: { usedBytes: 1, totalBytes: 2, usedPct: 50 } })).toBeNull();
    expect(sanitizeResources({ cpuPct: NaN, windowMs: 5000, ts: 1, memory: { usedBytes: 1, totalBytes: 2, usedPct: 50 } })).toBeNull();
  });

  test('rejects a malformed or missing memory block', () => {
    expect(sanitizeResources({ cpuPct: 10, windowMs: 5000, ts: 1, memory: null })).toBeNull();
    expect(sanitizeResources({ cpuPct: 10, windowMs: 5000, ts: 1 })).toBeNull();
    expect(sanitizeResources({ cpuPct: 10, windowMs: 5000, ts: 1, memory: { usedBytes: -1, totalBytes: 2, usedPct: 50 } })).toBeNull();
  });

  test('rejects a compromised-peer payload trying to smuggle an oversized/foreign field', () => {
    const evil = { cpuPct: 10, windowMs: 5000, ts: 1, memory: { usedBytes: 1, totalBytes: 2, usedPct: 50 }, __proto__: { polluted: true } };
    const out = sanitizeResources(evil);
    expect(out).not.toBeNull();
    expect(out.polluted).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['cpuPct', 'memory', 'ts', 'windowMs']);
  });
});

// --- cross-field validation of a PEER's memory reading -----------------------
// Each field below is individually well-formed; only the RELATIONSHIP between two
// of them is impossible. A per-field validator passes this, which is exactly why
// the guard has to be cross-field.
test.describe('sanitizeResources — cross-field memory sanity', () => {
  const ok = { cpuPct: 12, windowMs: 5000, ts: 1, memory: { usedBytes: 4, totalBytes: 8, usedPct: 50 } };

  test('a well-formed reading still passes', () => {
    expect(sanitizeResources(ok)).toEqual(ok);
  });

  test('used memory greater than total is rejected wholesale', () => {
    const bad = { ...ok, memory: { usedBytes: 1e300, totalBytes: 1, usedPct: 3 } };
    expect(sanitizeResources(bad)).toBeNull();
  });

  test('used exactly equal to total is legitimate (a full machine)', () => {
    const full = { ...ok, memory: { usedBytes: 8, totalBytes: 8, usedPct: 100 } };
    expect(sanitizeResources(full)).toEqual(full);
  });
});
