// #529 - the fleet usage ledger's store and replication, and the collector's scan over a
// fixture ~/.claude tree. Stores run in-process; "peers" are stores answering through the same
// serveHeads/serveFeed the routes use, so a spec exercises the real paging and recovery rules.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsageStore, INDEX_EVERY, isOrigin } = require('../lib/usage-store');
const sync = require('../lib/usage-sync');
const col = require('../lib/usage-collector');
const { createAgentSessionMap } = require('../lib/usage-agent-sessions');

const dirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
test.afterAll(() => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS */ } });

let clock = Date.parse('2026-03-10T10:00:00Z');
const now = () => (clock += 1000);
// a record's key starts with its origin (the store refuses another); the helper adds it so a draft can be written as `k1`
const store = (dir, origin) => {
  const s = createUsageStore({ dir, origin, now });
  const raw = s.append;
  s.append = (ds) => raw(ds.map((d) => (typeof d.key === 'string' && !d.key.includes('|') ? { ...d, key: `${s.origin}|${d.key}` } : d)));
  return s;
};
const draft = (n, extra = {}) => ({ type: 'session', key: `k${n}`, n, ...extra });

/** A peer that answers like the routes do. `down` makes every call reject; `old` answers 404. */
function peerOf(s, name, state = {}) {
  return {
    name, url: `http://${name}`, state,
    getJson: async (_peer, p) => {
      if (state.down) throw new Error('unreachable');
      if (state.old) return { status: 404, json: null };
      const u = new URL(p, 'http://x');
      if (u.pathname === '/api/usage/heads') return { status: 200, json: sync.serveHeads(s, name) };
      if (u.pathname === '/api/usage/feed') { const r = sync.serveFeed(s, Object.fromEntries(u.searchParams)); return { status: r.status, json: r.body }; }
      return { status: 404, json: null };
    },
  };
}
const getJsonOf = (peers) => (peer, p) => peers.find((x) => x.name === peer.name).getJson(peer, p);

test.describe('the store', () => {
  test('own records get consecutive seqs, survive a restart, and a newer version of a key folds over the older', () => {
    const dir = mk('wt-us-');
    const a = store(dir, 'Home');
    const r1 = a.append([draft(1), draft(2, { key: 'k1', v: 2 })]);
    expect(r1.map((r) => r.seq)).toEqual([1, 2]);
    expect(r1[0]).toMatchObject({ origin: 'Home', type: 'session' });
    expect(a.heads()).toEqual({ Home: 2 });
    expect(a.get('Home|k1').v).toBe(2);                  // the later version of k1
    const b = store(dir, 'Home');                        // a restart reads the file
    expect(b.heads()).toEqual({ Home: 2 });
    expect(b.records().length).toBe(1);
    expect(b.append([draft(3)])[0].seq).toBe(3);
  });
  test('a record the store would not trust is refused: bad type, no key, an origin that could escape the folder', () => {
    const a = store(mk('wt-us-'), 'Home');
    expect(() => a.append([{ type: 'nope', key: 'x' }])).toThrow(/unknown type/);
    expect(() => a.append([{ type: 'session' }])).toThrow(/bad key/);
    expect(() => store(mk('wt-us-'), '../evil')).toThrow(/bad origin/);
    expect(isOrigin('Office')).toBe(true);
    expect(isOrigin('a/b')).toBe(false);
    expect(isOrigin('..')).toBe(false);
    expect(a.appendReplica('../x', [{}])).toBe(0);
  });
  test('a torn last line is cut; a bad line in the middle is kept aside and what follows is pulled again', () => {
    const dir = mk('wt-us-');
    const a = store(dir, 'Home');
    a.append([draft(1), draft(2), draft(3)]);
    const f = path.join(dir, 'Home.jsonl');
    fs.appendFileSync(f, '{"type":"session","origin":"Home","seq":4,"at":"2026-03-10T10:00:09.000Z","ke'); // a write cut short
    expect(store(dir, 'Home').heads()).toEqual({ Home: 3 });
    expect(fs.readFileSync(f, 'utf8').endsWith('\n')).toBe(true);
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    lines[1] = '{ not json';
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const c = store(dir, 'Home');
    expect(c.heads()).toEqual({ Home: 1 });
    expect(fs.readdirSync(dir).some((n) => n.startsWith('Home.jsonl.corrupt-'))).toBe(true);
    expect(c.append([draft(9)])[0].seq).toBe(2);
  });
  test('feed pages from any seq across the offset index; replica appends take only the next seq', () => {
    const a = store(mk('wt-us-'), 'Home');
    const total = INDEX_EVERY * 2 + 40;
    a.append(Array.from({ length: total }, (_, i) => draft(i + 1)));
    expect(a.feed('Home', 0, 5).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(a.feed('Home', INDEX_EVERY - 2, 4).map((r) => r.seq)).toEqual([INDEX_EVERY - 1, INDEX_EVERY, INDEX_EVERY + 1, INDEX_EVERY + 2]);
    expect(a.feed('Home', total - 2, 100).map((r) => r.seq)).toEqual([total - 1, total]);
    expect(a.feed('Home', total, 10)).toEqual([]);
    expect(a.feed('Nobody', 0, 10)).toEqual([]);
    const b = store(mk('wt-us-'), 'Office');
    const batch = a.feed('Home', 0, 50);
    expect(b.appendReplica('Home', batch.slice(1))).toBe(0);            // seq 1 is missing: nothing taken
    expect(b.appendReplica('Home', batch)).toBe(50);
    expect(b.appendReplica('Home', batch)).toBe(0);                      // the same again adds nothing
    expect(b.appendReplica('Home', [{ ...batch[0], seq: 60 }])).toBe(0); // a lie about the seq (a gap)
    expect(b.appendReplica('Home', [{ ...a.feed('Home', 50, 1)[0], origin: 'Elsewhere' }])).toBe(0); // a record that names another origin than the file it is for
    expect(b.heads()).toEqual({ Home: 50 });
  });
});

test.describe('the store: names, keys and blank lines', () => {
  test('a key must start with its own origin (only a classify override crosses origins); another machine\'s fact cannot shadow ours', () => {
    const a = store(mk('wt-us-'), 'Home');
    expect(() => a.append([{ type: 'session', key: 'Office|x' }])).toThrow(/bad key/);
    expect(a.append([{ type: 'classify', key: 'classify|alpha' }])[0].seq).toBe(1);
    const b = store(mk('wt-us-'), 'Office');
    const rec = { type: 'session', origin: 'Home', seq: 1, at: '2026-03-10T10:00:00.000Z', key: 'Office|x' };
    expect(b.appendReplica('Home', [rec])).toBe(0);
  });
  test('two spellings of one machine name are one file: the existing spelling is kept and a replica in another case is refused', () => {
    const dir = mk('wt-us-');
    store(dir, 'Foo').append([draft(1), draft(2)]);
    const again = store(dir, 'foo');                       // the server was renamed Foo -> foo
    expect(again.origin).toBe('Foo');
    expect(again.append([draft(3)])[0]).toMatchObject({ origin: 'Foo', seq: 3 });
    expect(again.appendReplica('FOO', [{ type: 'session', origin: 'FOO', seq: 1, at: '2026-03-10T10:00:00.000Z', key: 'FOO|k' }])).toBe(0);
    expect(again.heads()).toEqual({ Foo: 3 });
  });
  test('a blank line in a file holds no seq, so a feed page still starts where it was asked to', () => {
    const dir = mk('wt-us-');
    const a = store(dir, 'Home');
    a.append(Array.from({ length: 30 }, (_, i) => draft(i + 1)));
    const f = path.join(dir, 'Home.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    lines.splice(10, 0, '');                                // a hand edit left an empty line
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const b = store(dir, 'Home');
    expect(b.heads()).toEqual({ Home: 30 });
    expect(b.feed('Home', 19, 3).map((r) => r.seq)).toEqual([20, 21, 22]);
  });
  test('a file cut at load says so (a peer may hold what it lost); an intact one does not', () => {
    const dir = mk('wt-us-');
    store(dir, 'Home').append([draft(1), draft(2), draft(3)]);
    expect(store(dir, 'Home').ownRepaired()).toBe(false);
    const f = path.join(dir, 'Home.jsonl');
    fs.appendFileSync(f, '{"type":"session","ori');
    expect(store(dir, 'Home').ownRepaired()).toBe(true);
  });
});

test.describe('replication', () => {
  test('a machine pulls what a peer is ahead by, in pages, and both end with the same heads', async () => {
    const A = store(mk('wt-us-'), 'Home');
    const B = store(mk('wt-us-'), 'Office');
    A.append(Array.from({ length: 1234 }, (_, i) => draft(i + 1)));
    B.append([draft(1, { key: 'b1' })]);
    const pa = peerOf(A, 'Home');
    const r = await sync.pullRound({ store: B, peers: [pa], getJson: getJsonOf([pa]) });
    expect(r.answered).toBe(1);
    expect(r.pulled).toBe(1234);
    expect(B.heads()).toEqual({ Home: 1234, Office: 1 });
    const pb = peerOf(B, 'Office');
    await sync.pullRound({ store: A, peers: [pb], getJson: getJsonOf([pb]) });
    expect(A.heads()).toEqual(B.heads());
    expect(A.get('Office|b1')).not.toBeNull();
    expect((await sync.pullRound({ store: B, peers: [pa], getJson: getJsonOf([pa]) })).pulled).toBe(0); // converged: nothing to do
  });
  test('a machine catches up on a third one\'s data through a peer while the origin itself is down', async () => {
    const A = store(mk('wt-us-'), 'Home');
    const B = store(mk('wt-us-'), 'Office');
    const C = store(mk('wt-us-'), 'Xps');
    A.append([draft(1), draft(2), draft(3)]);
    const pa = peerOf(A, 'Home');
    await sync.pullRound({ store: B, peers: [pa], getJson: getJsonOf([pa]) });
    pa.state.down = true;                                              // Home is off
    const pb = peerOf(B, 'Office');
    const r = await sync.pullRound({ store: C, peers: [pa, pb], getJson: getJsonOf([pa, pb]) });
    expect(r.peers.map((p) => p.status)).toEqual(['down', 'ok']);
    expect(C.heads()).toEqual({ Home: 3 });
    expect(C.feed('Home', 0, 10).map((x) => x.seq)).toEqual([1, 2, 3]);
  });
  test('a machine whose disk was wiped gets its OWN history back and carries on after it', async () => {
    const dirA = mk('wt-us-');
    const A = store(dirA, 'Home');
    A.append([draft(1), draft(2), draft(3)]);
    const B = store(mk('wt-us-'), 'Office');
    const pa = peerOf(A, 'Home');
    await sync.pullRound({ store: B, peers: [pa], getJson: getJsonOf([pa]) });
    fs.rmSync(dirA, { recursive: true, force: true });                 // Home's disk is gone
    const A2 = store(dirA, 'Home');
    expect(sync.mayCollect({ ownHead: A2.head('Home'), peerCount: 1 })).toBe(false); // must not write seq 1.. again yet
    const pb = peerOf(B, 'Office');
    const r = await sync.pullRound({ store: A2, peers: [pb], getJson: getJsonOf([pb]), only: 'Home' });
    expect(r.answered).toBe(1);
    expect(A2.head('Home')).toBe(3);
    expect(sync.mayCollect({ ownHead: A2.head('Home'), peerCount: 1, allReached: true })).toBe(true);
    expect(A2.append([draft(4)])[0].seq).toBe(4);                      // continues; no fork of what Office holds
    expect(fs.existsSync(path.join(dirA, 'Office.jsonl'))).toBe(false); // the recovery pull was for the own origin only
  });
  test('an old peer (404), a failing peer and a peer that lies are skipped without harm; bad origins are never created', async () => {
    const A = store(mk('wt-us-'), 'Home');
    const old = peerOf(A, 'Old', { old: true });
    const down = peerOf(A, 'Down', { down: true });
    const liar = { name: 'Liar', url: 'http://liar', getJson: async (_p, p) => (p.startsWith('/api/usage/heads')
      ? { status: 200, json: { heads: { '../../etc': 5, Fine: 1, Weird: 'x' } } }
      : { status: 200, json: { records: [{ type: 'session', origin: 'Fine', seq: 1, at: 'not a date', key: 'k' }] } }) };
    const B = store(mk('wt-us-'), 'Office');
    const r = await sync.pullRound({ store: B, peers: [old, down, liar], getJson: (peer, p) => ({ Old: old, Down: down, Liar: liar })[peer.name].getJson(peer, p) });
    expect(r.peers.map((p) => p.status)).toEqual(['old', 'down', 'ok']);
    expect(r.answered).toBe(1);                // only a 200 is an answer: an older server (404) holds nothing of ours
    expect(r.old).toBe(1);
    expect(r.pulled).toBe(0);
    expect(B.heads()).toEqual({});
    // the write gate: an empty or cut file waits for EVERY peer to have answered; an intact one goes on; a peer that holds more of ours blocks all
    expect(sync.mayCollect({ ownHead: 0, peerCount: 0 })).toBe(true);                                         // stand-alone
    expect(sync.mayCollect({ ownHead: 5, peerCount: 3 })).toBe(true);                                         // an intact file goes on while peers are away
    expect(sync.mayCollect({ ownHead: 5, peerCount: 3, repaired: true })).toBe(false);                       // a file that was cut needs every peer
    expect(sync.mayCollect({ ownHead: 5, peerCount: 3, repaired: true, allReached: true })).toBe(true);
    expect(sync.mayCollect({ ownHead: 0, peerCount: 2 })).toBe(false);                                        // nothing held, nobody heard
    expect(sync.mayCollect({ ownHead: 0, peerCount: 2, allReached: true })).toBe(true);                      // every peer answered (200 or older-server 404)
    expect(sync.mayCollect({ ownHead: 9, peerCount: 2, allReached: true, behind: true })).toBe(false);       // a peer holds more of ours than we do
  });
  test('a peer that spells our origin in another case is still read as holding our history', async () => {
    const mine = store(mk('wt-us-'), 'Home');
    const peer = { name: 'P', url: 'http://p', getJson: async () => ({ status: 200, json: { heads: { HOME: 7 } } }) };
    const r = await sync.pullRound({ store: mine, peers: [peer], getJson: (p, q) => peer.getJson(p, q), only: 'Home' });
    expect(r.ownTheirs).toBe(7);
    expect(r.peers[0]).toMatchObject({ status: 'ok', reached: true });
  });
  test('the feed route answers refuse a bad origin, after or limit', () => {
    const A = store(mk('wt-us-'), 'Home');
    A.append([draft(1)]);
    expect(sync.serveFeed(A, { origin: '../x' }).status).toBe(400);
    expect(sync.serveFeed(A, { origin: 'Home', after: '-1' }).status).toBe(400);
    expect(sync.serveFeed(A, { origin: 'Home', limit: '5000' }).status).toBe(400);
    expect(sync.serveFeed(A, { origin: 'Home', after: '0' }).body.records.length).toBe(1);
    expect(sync.serveFeed(A, { origin: 'Nobody' }).body.records).toEqual([]);
  });
});

test.describe('the agent-session map', () => {
  test('a (web-terminal session, Claude session) pair is written once, with who started it, and is read back after a restart', () => {
    const written = [];
    const m = createAgentSessionMap({ load: () => [], append: (e) => written.push(e), now });
    expect(m.note('wt-1', 'sid-1', { name: 'BH worker #7', parentId: 'wt-0', spawnedBy: 'lead', cwd: 'C:\\dev\\x', replaces: [] })).toBe(true);
    expect(m.note('wt-1', 'sid-1', {})).toBe(false);
    expect(m.note('wt-1', 'sid-2', { name: 'again' })).toBe(true);     // the same web-terminal session, a new Claude session
    expect(m.note('', 'sid-3')).toBe(false);
    expect(written.length).toBe(2);
    expect(written[0]).toMatchObject({ wtId: 'wt-1', agentSid: 'sid-1', name: 'BH worker #7', parentId: 'wt-0', replaces: null });
    const again = createAgentSessionMap({ load: () => written, append: () => { throw new Error('must not write'); } });
    expect(again.note('wt-1', 'sid-1', {})).toBe(false);
    expect(again.bySid('sid-2').name).toBe('again');
  });
});

test.describe('the collector scan over a fixture tree', () => {
  const line = (o) => `${JSON.stringify(o)}\n`;
  const asst = (min, id, out, extra = {}) => ({ type: 'assistant', timestamp: new Date(Date.parse('2026-03-10T08:00:00Z') + min * 60e3).toISOString(), requestId: `r${id}`, message: { id, model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }, ...extra });
  const user = (min, text, cwd) => ({ type: 'user', timestamp: new Date(Date.parse('2026-03-10T08:00:00Z') + min * 60e3).toISOString(), cwd, message: { role: 'user', content: text } });

  function tree() {
    const claude = mk('wt-claude-');
    const repo = path.join(claude, 'work', 'example-app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://example.test/org/Example-App.git\n');
    const pdir = path.join(claude, 'projects', 'p1');
    fs.mkdirSync(path.join(pdir, 'sid-a', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'sid-a.jsonl'), line(user(0, 'do the thing', repo)) + line(asst(1, 'm1', 10)) + line(asst(2, 'm2', 20)));
    fs.writeFileSync(path.join(pdir, 'sid-a', 'subagents', 'agent-x1.jsonl'), line(asst(1, 's1', 5, { message: { id: 's1', model: 'claude-haiku-5-5', usage: { output_tokens: 5 } } })));
    fs.writeFileSync(path.join(pdir, 'sid-a', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    fs.writeFileSync(path.join(pdir, 'sid-b.jsonl'), line(user(0, 'only a prompt', repo)));          // no model call: no record
    fs.mkdirSync(path.join(pdir, 'sid-orphan', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'sid-orphan', 'subagents', 'agent-z.jsonl'), line(asst(1, 'z', 1))); // subagents with no main transcript
    return { claude, repo, pdir };
  }

  test('a session is summarised once with its subagent and project; nothing changed means nothing read; growth is throttled', async () => {
    const { claude, repo, pdir } = tree();
    const t0 = Date.now();
    const r1 = await col.scanTranscripts({ claudeDir: claude, known: {}, now: t0 });
    expect(r1.left).toBe(0);
    const a = r1.sessions.find((s) => s.sid === 'sid-a');
    expect(a.summary.project).toBe('example-app');
    expect(a.summary.cwd).toBe(repo);
    expect(a.summary.sub.byType.Explore.n).toBe(1);
    expect(a.summary.models['opus-5-5'].calls).toBe(2);
    expect(r1.sessions.find((s) => s.sid === 'sid-b').empty).toBe(true);
    expect(r1.sessions.find((s) => s.sid === 'sid-orphan')).toBeUndefined();
    const known = { 'sid-a': { sig: a.sig, at: t0 }, 'sid-b': { sig: r1.sessions.find((s) => s.sid === 'sid-b').sig, at: t0 } };
    expect((await col.scanTranscripts({ claudeDir: claude, known, now: t0 + 1000 })).sessions).toEqual([]);
    fs.appendFileSync(path.join(pdir, 'sid-a.jsonl'), line(asst(3, 'm3', 30)));
    // still growing and emitted a minute ago: left alone
    expect((await col.scanTranscripts({ claudeDir: claude, known, now: Date.now() })).sessions).toEqual([]);
    // two hours later it is read again, and the new call is in
    const later = await col.scanTranscripts({ claudeDir: claude, known, now: t0 + 3 * 3600e3 });
    expect(later.sessions.find((s) => s.sid === 'sid-a').summary.models['opus-5-5'].calls).toBe(3);
  });
  test('the pass stops at its time budget and says how many are left', async () => {
    const { claude } = tree();
    let tick = 0;
    const r = await col.scanTranscripts({ claudeDir: claude, known: {}, now: Date.now(), budgetMs: 10, clock: () => (tick += 20) });
    expect(r.sessions.length).toBe(0);
    expect(r.left).toBe(2);
  });
});
