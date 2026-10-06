// @ts-check
// #297 — "loopback" is not "this host". tailscale serve reverse-proxies every tailnet
// caller onto 127.0.0.1, so a route that trusted the socket address alone was open to
// the whole tailnet. These specs pin the rule (lib/local-request.js) and every route
// that relies on it: a request relayed by a proxy is NOT local, a direct one still is.
const fs = require('fs');
const path = require('path');
const { test, expect, request: pwRequest } = require('@playwright/test');
const { FORWARDING_HEADERS, isDirectLocalRequest } = require('../lib/local-request');

const BASE = 'http://127.0.0.1:17681';

// Exactly what a tailscale serve mount added to a request from a peer, measured
// 2026-10-06 (values anonymised; only the NAMES matter to the rule).
const TAILSCALE_SERVE_HEADERS = {
  'x-forwarded-for': '203.0.113.7',
  'x-forwarded-host': 'box.example.test',
  'x-forwarded-proto': 'https',
  'tailscale-user-login': 'someone@example.com',
  'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
};

test.describe('isDirectLocalRequest', () => {
  const req = (ip, headers = {}) => ({ ip, headers });

  test('a direct loopback request is local, on every loopback spelling', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isDirectLocalRequest(req(ip))).toBe(true);
    }
  });

  test('a non-loopback address is never local', () => {
    expect(isDirectLocalRequest(req('203.0.113.7'))).toBe(false);
    expect(isDirectLocalRequest(req(''))).toBe(false);
    expect(isDirectLocalRequest({})).toBe(false);
  });

  test('a loopback request relayed by tailscale serve is NOT local', () => {
    expect(isDirectLocalRequest(req('127.0.0.1', TAILSCALE_SERVE_HEADERS))).toBe(false);
  });

  test('ANY single forwarding header is enough to refuse', () => {
    // Mutate one header at a time: a rule that only looked at x-forwarded-for would
    // pass the whole-set test above while letting a proxy that sends only
    // `Forwarded` (RFC 7239) straight through.
    for (const h of FORWARDING_HEADERS) {
      expect(isDirectLocalRequest(req('127.0.0.1', { [h]: 'x' })), h).toBe(false);
    }
  });

  test('falls back to the socket address when req.ip is absent', () => {
    expect(isDirectLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(true);
    expect(isDirectLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: TAILSCALE_SERVE_HEADERS })).toBe(false);
  });
});

test.describe('localhost-only routes refuse a proxied caller (#297)', () => {
  // Every route guarded by isLocalhostReq alone. A proxied caller must get 401; the
  // same request made directly must not — otherwise the test passes vacuously because
  // the route is simply broken.
  const ROUTES = [
    { method: 'get', path: '/api/relay/status' },
    { method: 'get', path: '/api/relay/recv?agent=nobody-297&wait=0' },
    { method: 'post', path: '/api/relay/send', data: { from: 'claude', to: 'codex', message: '' } },
    { method: 'post', path: '/api/claude-status', data: {} },
    { method: 'post', path: '/api/codex-session', data: {} },
    { method: 'post', path: '/api/hook', data: { event: 'UserPromptSubmit' } },
    { method: 'post', path: '/api/session/anything/hook', data: { event: 'UserPromptSubmit' } },
  ];

  for (const r of ROUTES) {
    test(`${r.method.toUpperCase()} ${r.path.split('?')[0]}`, async () => {
      const c = await pwRequest.newContext({ baseURL: BASE });
      const opts = r.data ? { data: r.data } : {};
      const proxied = await c[r.method](r.path, { ...opts, headers: TAILSCALE_SERVE_HEADERS });
      expect(proxied.status()).toBe(401);
      const direct = await c[r.method](r.path, opts);
      expect(direct.status()).not.toBe(401);
      await c.dispose();
    });
  }

  test('a proxied hook still passes WITH the hook token', async () => {
    // The token is the credential a non-local caller must present; #297 must not
    // break it (cross-machine hooks are the H1 design).
    const token = fs.readFileSync(path.join(__dirname, '..', '.hook-token'), 'utf8').trim();
    const c = await pwRequest.newContext({ baseURL: BASE });
    const res = await c.post('/api/hook', {
      data: { event: 'UserPromptSubmit' },
      headers: { ...TAILSCALE_SERVE_HEADERS, 'X-WT-Hook-Token': token, 'X-WT-Session-ID': 'whatever' },
    });
    expect(res.status()).toBe(200);
    await c.dispose();
  });
});
