// @ts-check
// lib/peer-fetch-log.js — #272 follow-up: a peer dropping out of the cluster merge
// must be visible in the log, ONCE per transition, never once per poll.
//
// The old `Cluster fetch` line in server.js fired only inside
// `if (r.sessions.length > 0)`, so an offline, unauthorised or empty peer produced
// nothing at all. These specs pin both halves: the drop-out IS reported, and a peer
// that stays down is NOT reported again on every sidebar refresh.
const { test, expect } = require('@playwright/test');
const { PEER_STATES, PEER_REASON_CAP, peerFetchState, notePeerFetch } = require('../lib/peer-fetch-log');

const ok = (n = 2) => ({ server: 'peer', online: true, needsAuth: false,
  sessions: Array.from({ length: n }, (_, i) => ({ id: String(i) })) });
const offline = (reason = 'timeout') => ({ server: 'peer', online: false, sessions: [], reason });
const unauth = () => ({ server: 'peer', online: true, needsAuth: true, sessions: [], reason: 'HTTP 401' });
const empty = () => ({ server: 'peer', online: true, needsAuth: false, sessions: [] });

test.describe('peerFetchState', () => {
  test('names the four outcomes, auth before reachability', () => {
    expect(peerFetchState(ok())).toBe(PEER_STATES.OK);
    expect(peerFetchState(empty())).toBe(PEER_STATES.EMPTY);
    expect(peerFetchState(offline())).toBe(PEER_STATES.OFFLINE);
    expect(peerFetchState(unauth())).toBe(PEER_STATES.NEEDS_AUTH);
    // No stored token: server.js reports online:false AND needsAuth:true. It is a
    // credential problem, not a network one — the #272 conflation, not repeated here.
    expect(peerFetchState({ server: 'peer', online: false, needsAuth: true, sessions: [] }))
      .toBe(PEER_STATES.NEEDS_AUTH);
  });
});

test.describe('notePeerFetch — transitions, not polls', () => {
  test('a peer DROPPING OUT is logged — the case the old line could not show', () => {
    const states = new Map();
    notePeerFetch(states, ok());
    const line = notePeerFetch(states, offline('connect ECONNREFUSED'));
    expect(line).toBe('Cluster fetch: peer ok -> offline (connect ECONNREFUSED)');
  });

  test('a peer that STAYS down is logged once, however often it is polled', () => {
    const states = new Map();
    notePeerFetch(states, ok());
    const lines = [];
    for (let i = 0; i < 50; i++) {
      // The reason varies between polls of one outage; that is not a transition.
      const l = notePeerFetch(states, offline(i % 2 ? 'timeout' : 'socket hang up'));
      if (l) lines.push(l);
    }
    expect(lines).toHaveLength(1);
  });

  test('recovery is logged with the session count', () => {
    const states = new Map();
    notePeerFetch(states, offline());
    expect(notePeerFetch(states, ok(3))).toBe('Cluster fetch: peer offline -> ok (3 sessions)');
    expect(notePeerFetch(states, ok(4))).toBeNull(); // ok -> ok is the summary line's job
  });

  test('a peer first seen DOWN is logged at once; one first seen healthy is not', () => {
    const down = new Map();
    expect(notePeerFetch(down, unauth())).toBe('Cluster fetch: peer unseen -> needs-auth (HTTP 401)');
    const up = new Map();
    expect(notePeerFetch(up, ok())).toBeNull();
  });

  test('an EMPTY peer has dropped out of the merge too', () => {
    const states = new Map();
    notePeerFetch(states, ok());
    expect(notePeerFetch(states, empty())).toBe('Cluster fetch: peer ok -> empty');
  });

  test('peers are tracked independently', () => {
    const states = new Map();
    notePeerFetch(states, { ...ok(), server: 'a' });
    notePeerFetch(states, { ...ok(), server: 'b' });
    expect(notePeerFetch(states, { ...offline(), server: 'a' })).toContain('a ok -> offline');
    expect(notePeerFetch(states, { ...ok(), server: 'b' })).toBeNull();
  });

  test('server.js consults the rule for EVERY peer, not only one with sessions', () => {
    // server.js exports nothing and the log is not observable from a spec, so the
    // wiring is pinned against the source: the call must sit in the per-peer loop
    // AHEAD of the `sessions.length > 0` guard that hid every drop-out before.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const loop = src.indexOf('for (const r of remotes) {');
    expect(loop).toBeGreaterThan(-1);
    const call = src.indexOf('peerFetchLog.notePeerFetch(', loop);
    const guard = src.indexOf('if (r.sessions.length > 0)', loop);
    expect(call).toBeGreaterThan(loop);
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeLessThan(guard);
  });

  test('the reason is external text: collapsed to one line and capped', () => {
    const states = new Map();
    const line = String(notePeerFetch(states, offline('x\n'.repeat(500))));
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(PEER_REASON_CAP + 80);
  });
});
