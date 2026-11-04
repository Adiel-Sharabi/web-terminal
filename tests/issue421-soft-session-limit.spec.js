// @ts-check
// #421 - the session limit is SOFT: nothing refuses a session for the count; config
// `maxSessions` only colours it (lib/machine-profile.js sessionsLevel). POST
// /api/sessions past the limit is covered in api.spec.js; this file holds the rest.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { authCtx } = require('./test-helpers');

// A body of one top-level server.js function, without printing anything of the file
// (its SERVER_VERSION line is ~400 KB).
function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in server.js`);
  const next = src.indexOf('\nasync function ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

test.describe('#421 soft session limit', () => {
  test('a hand-off never fails for the session count (no no-slot refusal in spawnSuccessor)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const body = functionBody(src, 'spawnSuccessor');
    expect(body.length).toBeGreaterThan(200);           // found the real function
    expect(body).toContain('freshLaunchCommand');        // ...and it is the right one
    expect(body).not.toContain("'no-slot'");
    expect(body).not.toContain('SESSIONS_SOFT_LIMIT');
    // Nor does session creation refuse on it.
    expect(src).not.toMatch(/Session limit reached/);
  });

  test('GET /api/machine?part=sessions answers the count and level without the CIM half', async () => {
    const ctx = await authCtx();
    try {
      const res = await ctx.get('/api/machine?part=sessions');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.sessions).toMatchObject({ max: 10 });
      expect(typeof body.sessions.count).toBe('number');
      expect(['ok', 'warn', 'hot']).toContain(body.sessions.level);
      // The skipped half reads as UNKNOWN, never as zero.
      expect(body.commit).toBeNull();
      expect(body.disks).toBeNull();
    } finally {
      await ctx.dispose();
    }
  });
});
