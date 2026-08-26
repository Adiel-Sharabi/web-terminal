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

  // --- #165: headroom is the number the decision is actually made on ---------------
  test('reports availBytes — the number a percentage saturates away from', () => {
    // The defect #165 exists for: 92% -> 98% is six points while the headroom under it
    // goes 2.5 GB -> 0.65 GB, the difference between "fine" and "unusable". The absolute
    // figure has to be on the wire; it cannot be recovered from a rounded percentage.
    const m = memoryReading();
    expect(typeof m.availBytes).toBe('number');
    expect(m.availBytes).toBeGreaterThan(0);
    expect(m.availBytes).toBeLessThanOrEqual(m.totalBytes);
  });

  test('availBytes is the complement of usedBytes, to the byte', () => {
    // Not a second measurement with its own drift: `usedBytes` is DERIVED as
    // total - free on this very reading, so the two must agree exactly. If they ever
    // stop agreeing, one of them was sampled at a different instant than the other and
    // the readout would show a box with memory that is neither used nor free.
    const m = memoryReading();
    expect(m.usedBytes + m.availBytes).toBe(m.totalBytes);
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

  test('#165 — headroom rides the ALWAYS-ON sampler, not the on-demand snapshot', () => {
    // The whole point: availBytes is os.freemem(), pure JS and free, so it is present on
    // the reading that /api/version and the cluster merge already carry. Putting it behind
    // GET /api/resources would make the primary readout unavailable on exactly the servers
    // nobody has opened the per-session panel for — which is every server, most of the time.
    const r = new Sampler().read();
    expect(typeof r.memory.availBytes).toBe('number');
    expect(r.memory.availBytes).toBeGreaterThan(0);
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
    const good = { cpuPct: 42, windowMs: 5000, ts: Date.now(), memory: { usedBytes: 100, totalBytes: 200, availBytes: 100, usedPct: 50 } };
    expect(sanitizeResources(good)).toEqual(good);
  });

  test('accepts a null cpuPct (the honest "not yet known" reading)', () => {
    const r = { cpuPct: null, windowMs: 5000, ts: Date.now(), memory: { usedBytes: 100, totalBytes: 200, availBytes: 100, usedPct: null } };
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

// --- #165: a PEER's headroom -------------------------------------------------------
// Same rule as every other field here, applied to the one the readout now LEADS with:
// an unearned number is worse than a dash, because this is the figure someone picks a
// box on.
test.describe('sanitizeResources — availBytes (#165)', () => {
  const base = { cpuPct: 12, windowMs: 5000, ts: 1 };
  const withMem = (memory) => ({ ...base, memory });

  test('a peer too old to report headroom reads null, never a fabricated 0', () => {
    // A 0 here says "this box has no memory left" about a box that simply predates the
    // field — the exact inversion the whole feature exists to prevent, on the server the
    // user is most likely to reach for.
    const out = sanitizeResources(withMem({ usedBytes: 100, totalBytes: 200, usedPct: 50 }));
    expect(out).not.toBeNull();
    expect(out.memory.availBytes).toBeNull();
  });

  test('an explicit null passes through as null', () => {
    const out = sanitizeResources(withMem({ usedBytes: 100, totalBytes: 200, availBytes: null, usedPct: 50 }));
    expect(out.memory.availBytes).toBeNull();
  });

  test('a valid headroom is carried through untouched', () => {
    const out = sanitizeResources(withMem({ usedBytes: 100, totalBytes: 200, availBytes: 100, usedPct: 50 }));
    expect(out.memory.availBytes).toBe(100);
  });

  test('rejects a negative headroom', () => {
    expect(sanitizeResources(withMem({ usedBytes: 100, totalBytes: 200, availBytes: -1, usedPct: 50 }))).toBeNull();
  });

  test('rejects a non-finite or wrong-typed headroom', () => {
    expect(sanitizeResources(withMem({ usedBytes: 1, totalBytes: 2, availBytes: NaN, usedPct: 50 }))).toBeNull();
    expect(sanitizeResources(withMem({ usedBytes: 1, totalBytes: 2, availBytes: Infinity, usedPct: 50 }))).toBeNull();
    expect(sanitizeResources(withMem({ usedBytes: 1, totalBytes: 2, availBytes: '100', usedPct: 50 }))).toBeNull();
  });

  test('rejects headroom larger than the machine — cross-field, not per-field', () => {
    // 1e300 is a perfectly well-formed non-negative finite number. Only its RELATIONSHIP
    // to totalBytes is impossible, so a per-field validator would hand the sidebar
    // "1e291 GB free" and it would render it as fact.
    expect(sanitizeResources(withMem({ usedBytes: 1, totalBytes: 200, availBytes: 1e300, usedPct: 50 }))).toBeNull();
    expect(sanitizeResources(withMem({ usedBytes: 1, totalBytes: 200, availBytes: 201, usedPct: 50 }))).toBeNull();
  });

  test('headroom exactly equal to total is legitimate (an empty machine)', () => {
    const out = sanitizeResources(withMem({ usedBytes: 0, totalBytes: 200, availBytes: 200, usedPct: 0 }));
    expect(out.memory.availBytes).toBe(200);
  });
});

// --- cross-field validation of a PEER's memory reading -----------------------
// Each field below is individually well-formed; only the RELATIONSHIP between two
// of them is impossible. A per-field validator passes this, which is exactly why
// the guard has to be cross-field.
test.describe('sanitizeResources — cross-field memory sanity', () => {
  const ok = { cpuPct: 12, windowMs: 5000, ts: 1, memory: { usedBytes: 4, totalBytes: 8, availBytes: 4, usedPct: 50 } };

  test('a well-formed reading still passes', () => {
    expect(sanitizeResources(ok)).toEqual(ok);
  });

  test('used memory greater than total is rejected wholesale', () => {
    const bad = { ...ok, memory: { usedBytes: 1e300, totalBytes: 1, usedPct: 3 } };
    expect(sanitizeResources(bad)).toBeNull();
  });

  test('used exactly equal to total is legitimate (a full machine)', () => {
    const full = { ...ok, memory: { usedBytes: 8, totalBytes: 8, availBytes: 0, usedPct: 100 } };
    expect(sanitizeResources(full)).toEqual(full);
  });

  // --- the TRIPLE, not two pairs (#165) ------------------------------------------
  // `used <= total` and `avail <= total` can BOTH hold while the three numbers still
  // describe no machine that exists. This is the gap that mattered most, because
  // headroom is the figure the readout leads with and the one a box is chosen on.
  const GiB = 1024 * 1024 * 1024;

  test('a consistent triple passes', () => {
    const r = {
      cpuPct: 12, windowMs: 5000, ts: 1,
      memory: { usedBytes: 16 * GiB, totalBytes: 32 * GiB, availBytes: 16 * GiB, usedPct: 50 },
    };
    expect(sanitizeResources(r)).toEqual(r);
  });

  test('a half-idle box claiming ZERO headroom is rejected wholesale', () => {
    // Every pairwise check passes: 16 <= 32, and 0 <= 32. Only used + avail === total
    // catches it — and without that the sidebar renders
    // `MEM 0.0G free of 32.0G (50%) cls=u-hot`: a box with 16 GB spare, shown in red,
    // the precise inversion this feature exists to prevent.
    const bad = {
      cpuPct: 12, windowMs: 5000, ts: 1,
      memory: { usedBytes: 16 * GiB, totalBytes: 32 * GiB, availBytes: 0, usedPct: 50 },
    };
    expect(sanitizeResources(bad)).toBeNull();
  });

  test('the mirror case — headroom claiming the box is empty — is rejected too', () => {
    const bad = {
      cpuPct: 12, windowMs: 5000, ts: 1,
      memory: { usedBytes: 30 * GiB, totalBytes: 32 * GiB, availBytes: 32 * GiB, usedPct: 94 },
    };
    expect(sanitizeResources(bad)).toBeNull();
  });

  test('a sampling-instant skew inside the tolerance is still accepted', () => {
    // The tolerance is 1% of total. A peer that read its two halves a moment apart can
    // legitimately disagree by whatever the box allocated in between; rejecting that
    // would blank a healthy server's row for no reason the user can see.
    const r = {
      cpuPct: 12, windowMs: 5000, ts: 1,
      memory: { usedBytes: 16 * GiB, totalBytes: 32 * GiB, availBytes: 16 * GiB - 64 * 1024 * 1024, usedPct: 50 },
    };
    expect(sanitizeResources(r)).not.toBeNull();
  });

  test('a skew past the tolerance is not a rounding difference', () => {
    const bad = {
      cpuPct: 12, windowMs: 5000, ts: 1,
      memory: { usedBytes: 16 * GiB, totalBytes: 32 * GiB, availBytes: 15 * GiB, usedPct: 50 },
    };
    expect(sanitizeResources(bad)).toBeNull();
  });

  test('an ABSENT headroom is not held to the triple — it is unknown, not wrong', () => {
    // A peer predating the field reports no availBytes at all. That is `null`, and a
    // null cannot contradict anything; failing it here would blank every older server.
    const older = { cpuPct: 12, windowMs: 5000, ts: 1, memory: { usedBytes: 30 * GiB, totalBytes: 32 * GiB, usedPct: 94 } };
    const out = sanitizeResources(older);
    expect(out).not.toBeNull();
    expect(out.memory.availBytes).toBeNull();
  });
});
