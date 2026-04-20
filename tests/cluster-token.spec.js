// @ts-check
// Unit tests for lib/cluster-token.js (issue #20 direct terminal mode).
const { test, expect } = require('@playwright/test');
const path = require('path');
const crypto = require('crypto');

const { mintDirectToken, verifyDirectToken, DEFAULT_TTL_MS } = require(path.join(__dirname, '..', 'lib', 'cluster-token.js'));

test.describe('cluster-token: mint', () => {
  test('mint produces a dot-separated token with two base64url parts', () => {
    const tok = mintDirectToken('secret', { sid: 'abc', user: 'alice' });
    expect(typeof tok).toBe('string');
    const parts = tok.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    // base64url: no +, /, =
    expect(tok).not.toMatch(/[+/=]/);
  });

  test('mint rejects empty secret', () => {
    expect(() => mintDirectToken('', { sid: 'a', user: 'b' })).toThrow();
  });

  test('mint rejects missing sid/user', () => {
    // @ts-ignore — intentionally bad input
    expect(() => mintDirectToken('secret', { user: 'alice' })).toThrow();
    // @ts-ignore
    expect(() => mintDirectToken('secret', { sid: 'abc' })).toThrow();
  });

  test('mint applies default TTL of 60 seconds', () => {
    const before = Date.now();
    const tok = mintDirectToken('secret', { sid: 'a', user: 'b' });
    const after = Date.now();
    const payload = JSON.parse(Buffer.from(tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    expect(payload.exp).toBeGreaterThanOrEqual(before + DEFAULT_TTL_MS - 5);
    expect(payload.exp).toBeLessThanOrEqual(after + DEFAULT_TTL_MS + 5);
  });

  test('mint honors custom ttlMs', () => {
    const now = 1_000_000;
    const tok = mintDirectToken('secret', { sid: 'a', user: 'b', ttlMs: 5000, now });
    const payload = JSON.parse(Buffer.from(tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    expect(payload.exp).toBe(now + 5000);
  });
});

test.describe('cluster-token: verify', () => {
  test('verify round-trip with correct key returns valid', () => {
    const tok = mintDirectToken('peer-bearer', { sid: 'sess-1', user: 'alice' });
    const r = verifyDirectToken(tok, ['peer-bearer']);
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.payload.sid).toBe('sess-1');
    expect(r.payload.user).toBe('alice');
  });

  test('verify succeeds when correct key is among many candidates', () => {
    const tok = mintDirectToken('key-3', { sid: 's', user: 'u' });
    const r = verifyDirectToken(tok, ['key-1', 'key-2', 'key-3', 'key-4']);
    expect(r.valid).toBe(true);
  });

  test('verify fails for wrong key', () => {
    const tok = mintDirectToken('right-key', { sid: 's', user: 'u' });
    const r = verifyDirectToken(tok, ['wrong-key', 'also-wrong']);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  test('verify fails for empty candidate list', () => {
    const tok = mintDirectToken('k', { sid: 's', user: 'u' });
    const r = verifyDirectToken(tok, []);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no-keys');
  });

  test('verify fails for tampered payload (sid swap)', () => {
    const tok = mintDirectToken('key', { sid: 'original', user: 'alice' });
    // Forge: swap sid in payload but keep old signature
    const [, sig] = tok.split('.');
    const newPayload = Buffer.from(JSON.stringify({ sid: 'attacker', user: 'alice', exp: Date.now() + 60_000 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${newPayload}.${sig}`;
    const r = verifyDirectToken(forged, ['key']);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  test('verify fails for expired token', () => {
    // Mint with exp already in the past
    const tok = mintDirectToken('k', { sid: 's', user: 'u', ttlMs: -1000 });
    const r = verifyDirectToken(tok, ['k']);
    expect(r.valid).toBe(false);
    expect(r.expired).toBe(true);
    expect(r.reason).toBe('expired');
  });

  test('verify respects custom "now" for testing expiry', () => {
    const t0 = 1_000_000;
    const tok = mintDirectToken('k', { sid: 's', user: 'u', ttlMs: 60_000, now: t0 });
    // At t0 + 59.999s, still valid
    expect(verifyDirectToken(tok, ['k'], { now: t0 + 59_999 }).valid).toBe(true);
    // At t0 + 60s exactly, expired (exp <= now)
    expect(verifyDirectToken(tok, ['k'], { now: t0 + 60_000 }).valid).toBe(false);
    expect(verifyDirectToken(tok, ['k'], { now: t0 + 60_000 }).expired).toBe(true);
  });

  test('verify rejects malformed tokens', () => {
    expect(verifyDirectToken('', ['k']).reason).toBe('missing-token');
    expect(verifyDirectToken('nodotsatall', ['k']).reason).toBe('malformed');
    expect(verifyDirectToken('.trailingonly', ['k']).reason).toBe('malformed');
    expect(verifyDirectToken('leadingonly.', ['k']).reason).toBe('malformed');
    expect(verifyDirectToken('bad!chars.bad!chars', ['k']).valid).toBe(false);
  });

  test('verify rejects payload missing required fields', () => {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payloadB64 = enc({ sid: 'only-sid' }); // no user, no exp
    const sig = crypto.createHmac('sha256', 'k').update(payloadB64).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = verifyDirectToken(`${payloadB64}.${sig}`, ['k']);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  test('verify ignores empty-string candidate secrets', () => {
    const tok = mintDirectToken('real', { sid: 's', user: 'u' });
    // Empty strings should be skipped, not match anything
    const r = verifyDirectToken(tok, ['', null, undefined, 'real']);
    expect(r.valid).toBe(true);
  });
});
