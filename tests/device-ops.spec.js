// #311 - which device sent each prompt.
//
// Behind `tailscale serve` every caller arrives on a loopback socket with
// `x-forwarded-for: <client tailnet IP>` (measured in #297, lib/local-request.js). That
// IP names the exact device - the phone, the tablet, a desktop - so the server records
// one line per submit (an input frame ending in CR) with that source and no input text,
// and scripts/device-ops-report.js turns the lines into per-device counts.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const fs = require('fs');
const { BASE, AUTH, authCtx, emptyCwd } = require('./test-helpers');
const { clientSource, isSubmitFrame, classOf, summarize } = require('../lib/device-ops');

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test.describe('#311 clientSource', () => {
  test('a request relayed by tailscale serve is the forwarded client', () => {
    expect(clientSource(req('127.0.0.1', { 'x-forwarded-for': '192.0.2.15' }))).toBe('192.0.2.15');
    expect(clientSource(req('::ffff:127.0.0.1', { 'x-forwarded-for': '192.0.2.82, 10.0.0.1' }))).toBe('192.0.2.82');
  });

  test('a direct loopback client is local', () => {
    expect(clientSource(req('127.0.0.1'))).toBe('local');
    expect(clientSource(req('::1'))).toBe('local');
  });

  test('a relayed request without a usable address is unknown, never the raw header', () => {
    expect(clientSource(req('127.0.0.1', { 'tailscale-user-login': 'someone' }))).toBe('unknown');
    expect(clientSource(req('127.0.0.1', { 'x-forwarded-for': '<script>' }))).toBe('unknown');
  });

  test('x-forwarded-for from a non-loopback socket is not trusted', () => {
    expect(clientSource(req('198.51.100.100', { 'x-forwarded-for': '1.2.3.4' }))).toBe('198.51.100.100');
    expect(clientSource(req('::ffff:198.51.100.100'))).toBe('198.51.100.100');
  });
});

test.describe('#311 isSubmitFrame', () => {
  test('a frame ending in CR is a submit', () => {
    expect(isSubmitFrame('fix the build\r')).toBe(true);
    expect(isSubmitFrame('\r')).toBe(true);
    expect(isSubmitFrame('\x1b[200~two\nlines\x1b[201~\r')).toBe(true);
    expect(isSubmitFrame(Buffer.from('yes\r'))).toBe(true);
  });

  test('keystrokes and control frames are not', () => {
    expect(isSubmitFrame('a')).toBe(false);
    expect(isSubmitFrame('line\n')).toBe(false);
    expect(isSubmitFrame('')).toBe(false);
    expect(isSubmitFrame('{"resize":{"cols":80,"rows":24}}')).toBe(false);
  });
});

test.describe('#311 classOf', () => {
  test('mobile OSes are mobile, the rest desktop, and config overrides by host', () => {
    expect(classOf({ host: 'phone-1', os: 'android' }, {})).toBe('mobile');
    expect(classOf({ host: 'pad', os: 'iOS' }, {})).toBe('mobile');
    expect(classOf({ host: 'box', os: 'windows' }, {})).toBe('desktop');
    expect(classOf({ host: 'tab-1', os: 'android' }, { 'tab-1': 'tablet' })).toBe('tablet');
  });
});

test.describe('#311 summarize', () => {
  // Sunday 2026-10-11 is a workday; build local times so the split does not depend on
  // the machine's time zone.
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const resolve = (src) => ({ '100.1.1.1': { host: 'phone-1', os: 'android' }, '100.2.2.2': { host: 'tab-1', os: 'android' } })[src]
    || { host: src, os: 'windows' };

  test('counts operations per device, split into office hours and outside', () => {
    const recs = [
      { t: at(11, 10, 0), src: '100.1.1.1', server: 'office' },
      { t: at(11, 10, 5), src: '100.1.1.1', server: 'office' },
      { t: at(11, 21, 0), src: '100.1.1.1', server: 'home' },
      { t: at(16, 11, 0), src: '100.1.1.1', server: 'home' }, // Friday: outside
      { t: at(11, 12, 0), src: '100.2.2.2', server: 'home' },
      { t: at(11, 9, 30), src: 'local', server: 'office' },
    ];
    const rows = summarize(recs, { resolve, classes: { 'tab-1': 'tablet' } });
    const by = Object.fromEntries(rows.map((r) => [r.device, r]));
    expect(by['phone-1']).toMatchObject({ cls: 'mobile', ops: 4, office: 2, outside: 2 });
    expect(by['tab-1']).toMatchObject({ cls: 'tablet', ops: 1, office: 1, outside: 0 });
    // A direct loopback client is the server's own machine.
    expect(by.office).toMatchObject({ cls: 'desktop', ops: 1, office: 1 });
    // Two prompts 5 minutes apart form one block: 5 min + the 10-min tail.
    expect(by['phone-1'].hours).toBeCloseTo((15 + 10 + 10) / 60, 5);
    expect(rows[0].device).toBe('phone-1'); // most operations first
  });

  test('a local client joins the row of its own machine when the server is named', () => {
    const recs = [
      { t: at(11, 10, 0), src: 'local', server: 'office' },
      { t: at(11, 11, 0), src: '100.3.3.3', server: 'home' },
    ];
    const rows = summarize(recs, {
      resolve: (src) => (src === '100.3.3.3' ? { host: 'office-pc', os: 'windows' } : null),
      serverHost: (name) => (name === 'office' ? 'office-pc' : null),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ device: 'office-pc', cls: 'desktop', ops: 2 });
  });
});

test('#311 a submit over /ws is recorded with the forwarded client and no input text', async () => {
  const file = process.env.WT_DEVICE_OPS_FILE;
  expect(file, 'playwright.config.js must redirect the device-ops log').toBeTruthy();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;

  const ctx = await authCtx();
  const cwd = emptyCwd('device-ops');
  let id;
  try {
    id = (await (await ctx.post('/api/sessions', { data: { name: 'device-ops', cwd } })).json()).id;
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: AUTH.user, password: AUTH.password }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/${id}`, {
      headers: { Cookie: cookie, 'x-forwarded-for': '203.0.113.7' },
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ mode: 'background', browserId: 'dev-ops' }));
    ws.send('dropped-in-background\r');              // refused input: not an operation
    ws.send(JSON.stringify({ mode: 'active', browserId: 'dev-ops' }));
    ws.send(JSON.stringify({ resize: { cols: 80, rows: 24 } }));
    ws.send('echo secret-311');                      // keystrokes: not an operation
    ws.send('\r');                                   // the submit
    ws.send('echo second-311\r');                    // a one-frame submit

    let lines = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(before) : [];
      if (lines.length >= 2) break;
    }
    await new Promise((r) => setTimeout(r, 300)); // nothing else may arrive
    lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(before) : [];
    ws.close();

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(Object.keys(rec).sort()).toEqual(['server', 'src', 't']);
      expect(rec.src).toBe('203.0.113.7');
      expect(typeof rec.server).toBe('string');
      expect(Number.isNaN(Date.parse(rec.t))).toBe(false);
    }
    const all = fs.readFileSync(file, 'utf8');
    expect(all).not.toContain('secret-311');
    expect(all).not.toContain('second-311');
    expect(all).not.toContain('dropped-in-background');
  } finally {
    if (id) { try { await ctx.delete(`/api/sessions/${id}`); } catch {} }
    await ctx.dispose();
  }
});
