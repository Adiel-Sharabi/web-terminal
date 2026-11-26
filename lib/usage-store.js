'use strict';
// --- The fleet usage ledger's store (#529) ---------------------------------------------
//
// One append-only jsonl file per ORIGIN (a machine's `serverName`): `<dir>/<origin>.jsonl`.
// The file named for this machine holds the records it wrote; every other file is a REPLICA
// of that machine's file, copied record by record (lib/usage-sync.js). Every record has a
// per-origin `seq` that rises by exactly 1, so two holders of one origin's file can only
// differ in how far each has read: a replica is a prefix, never a fork, and `heads()` (the
// highest seq per origin) says who is ahead. Nothing is ever rewritten.
//
// A record: { type, origin, seq, at, key, ...fields }. `type` is 'session' | 'bh-item' |
// 'inventory' | 'classify' | 'settings'. FOLD = the newest record per `key`: a new version of a session
// is just a later record with the same key.
//
// What is stored: ids, names, times, counts and numbers - never a prompt, a tool result or a
// token (the credential kind). Origin names come off the network, so they are checked against
// ORIGIN_RE before they ever reach a file name.

const fs = require('fs');
const path = require('path');

const TYPES = Object.freeze(['session', 'bh-item', 'inventory', 'classify', 'settings']);
const ORIGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_RECORD_BYTES = 64 * 1024;
/** One offset is kept per this many lines, so a feed page starts near its seq without a full read. */
const INDEX_EVERY = 256;

const isOrigin = (s) => typeof s === 'string' && ORIGIN_RE.test(s);

/** A machine's name as a ledger origin: it becomes a file name, so only letters, digits and . _ - (at most 40). */
const originOf = (name) => String(name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40) || 'machine';

/** A record fit to be stored for [origin] at [seq] - or the reason it is not. */
function checkRecord(rec, origin, seq) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'not an object';
  if (rec.origin !== origin) return 'wrong origin';
  if (rec.seq !== seq) return 'wrong seq';
  if (!TYPES.includes(rec.type)) return 'unknown type';
  if (typeof rec.key !== 'string' || !rec.key || rec.key.length > 400) return 'bad key';
  // a record states a fact about its own origin: only an override (a project's class) is cross-origin
  if (rec.type !== 'classify' && !rec.key.startsWith(`${origin}|`)) return 'bad key';
  if (typeof rec.at !== 'string' || !Number.isFinite(Date.parse(rec.at))) return 'bad at';
  return null;
}

/** Is [a] newer than [b]? Same origin: the higher seq. Across origins (a `classify` record's key is
 *  shared): the later `at`, then the higher origin name, so every holder picks the same winner. */
function newer(a, b) {
  if (a.origin === b.origin) return a.seq > b.seq;
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta > tb;
  return a.origin > b.origin;
}

/** @param {{dir: string, origin: string, now?: () => number, readOnly?: boolean}} o
 *  `readOnly` (a script reading a ledger a server may be appending to): never cuts a torn tail, never
 *  writes; the cut a writer makes could hit a line the server is in the middle of. */
function createUsageStore({ dir, origin: wanted, now = Date.now, readOnly = false }) {
  let origin = wanted;
  if (!isOrigin(origin)) throw new Error(`usage store: bad origin ${JSON.stringify(origin)}`);
  const heads = new Map();    // origin -> highest seq held
  const offsets = new Map();  // origin -> byte offset of line INDEX_EVERY*i (line 0 = seq 1)
  const sizes = new Map();    // origin -> bytes held
  const folded = new Map();   // key -> newest record
  const canon = new Map();    // lower-cased origin -> the spelling its file has (file names are case-insensitive on Windows)
  const repaired = new Set(); // origins whose file lost a tail or a bad line at load: peers may hold more than we do
  let version = 0;

  const fileOf = (o) => path.join(dir, `${o}.jsonl`);

  function take(rec, bytesBefore, o) {
    const lines = rec.seq - 1;
    if (lines % INDEX_EVERY === 0) {
      const arr = offsets.get(o) || [];
      arr[lines / INDEX_EVERY] = bytesBefore;
      offsets.set(o, arr);
    }
    heads.set(o, rec.seq);
    canon.set(o.toLowerCase(), o);
    const cur = folded.get(rec.key);
    if (!cur || newer(rec, cur)) folded.set(rec.key, rec);
  }

  /** Read every file once: heads, the offset index and the fold. A torn last line (a write cut
   *  short) is ignored, and the file's size is taken as its last whole line so the next append
   *  starts on a fresh line. */
  function load() {
    heads.clear(); offsets.clear(); sizes.clear(); folded.clear(); canon.clear(); repaired.clear();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no ledger yet */ }
    for (const n of names) {
      const m = /^(.+)\.jsonl$/.exec(n);
      if (!m || !isOrigin(m[1])) continue;
      const o = m[1];
      if (canon.has(o.toLowerCase()) && canon.get(o.toLowerCase()) !== o) continue; // two spellings of one name: the first one read is the file
      let buf;
      try { buf = fs.readFileSync(fileOf(o)); } catch { continue; }
      let pos = 0;
      let expect = 1;
      let bad = false;
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break; // no newline: a torn tail
        const text = buf.toString('utf8', pos, nl).trim();
        const start = pos;
        if (!text) { pos = nl + 1; continue; }
        let rec;
        try { rec = JSON.parse(text); } catch { bad = true; break; }
        if (checkRecord(rec, o, expect)) { bad = true; break; } // out of step: what follows cannot be vouched for
        pos = nl + 1;
        take(rec, start, o);
        expect++;
      }
      // Keep only the part of the file that is in step. A torn tail is just cut; a bad line in the
      // MIDDLE is kept aside first (the cut part is pulled again from a peer by the next sync).
      if (pos < buf.length) repaired.add(o);
      if (pos < buf.length && !readOnly) {
        try {
          if (bad) fs.copyFileSync(fileOf(o), `${fileOf(o)}.corrupt-${now()}`);
          fs.truncateSync(fileOf(o), pos);
        } catch { /* read-only disk: the sizes below still match what we hold */ }
      }
      sizes.set(o, pos);
    }
    version++;
  }

  function writeLines(o, recs) {
    fs.mkdirSync(dir, { recursive: true });
    let size = sizes.get(o) || 0;
    const parts = [];
    for (const rec of recs) {
      const line = `${JSON.stringify(rec)}\n`;
      take(rec, size, o);
      size += Buffer.byteLength(line);
      parts.push(line);
    }
    fs.appendFileSync(fileOf(o), parts.join(''), 'utf8');
    sizes.set(o, size);
    version++;
  }

  /** Stamp [drafts] (`{type, key, ...}`) with this origin, the next seqs and `at`, and store them. */
  function append(drafts) {
    if (readOnly) throw new Error('usage store: read-only');
    const out = [];
    let seq = heads.get(origin) || 0;
    const at = new Date(now()).toISOString();
    for (const d of drafts) {
      const rec = { type: d.type, origin, seq: seq + 1, at, key: d.key, ...Object.fromEntries(Object.entries(d).filter(([k]) => !['type', 'key', 'origin', 'seq', 'at'].includes(k))) };
      const bad = checkRecord(rec, origin, seq + 1);
      if (bad) throw new Error(`usage store: refused own record (${bad})`);
      if (Buffer.byteLength(JSON.stringify(rec)) > MAX_RECORD_BYTES) throw new Error('usage store: refused own record (too large)');
      out.push(rec);
      seq++;
    }
    if (out.length) writeLines(origin, out);
    return out;
  }

  /** Store records another machine wrote, in order, each only if it is the NEXT seq we hold for
   *  [o]. Returns how many were taken; the first record that does not fit ends the batch (what
   *  came before it stays). */
  function appendReplica(o, recs) {
    if (readOnly || !isOrigin(o) || !Array.isArray(recs) || !recs.length) return 0;
    const spelled = canon.get(o.toLowerCase());
    if (spelled && spelled !== o) return 0; // the same name in another case would append into the same file
    let seq = heads.get(o) || 0;
    const ok = [];
    for (const rec of recs) {
      if (checkRecord(rec, o, seq + 1)) break;
      if (Buffer.byteLength(JSON.stringify(rec)) > MAX_RECORD_BYTES) break;
      ok.push(rec);
      seq++;
    }
    if (ok.length) writeLines(o, ok);
    return ok.length;
  }

  /** The records of [o] with seq > [after], at most [limit] (1..1000), oldest first. */
  function feed(o, after = 0, limit = 500) {
    if (!isOrigin(o) || !heads.has(o)) return [];
    const from = Math.max(0, Math.floor(after) || 0);
    const max = Math.min(1000, Math.max(1, Math.floor(limit) || 500));
    if (from >= heads.get(o)) return [];
    const arr = offsets.get(o) || [];
    const slot = Math.min(Math.floor(from / INDEX_EVERY), arr.length - 1);
    let pos = arr[slot] || 0;
    let line = slot * INDEX_EVERY; // lines before `pos`
    const out = [];
    let fd;
    try {
      fd = fs.openSync(fileOf(o), 'r');
      const total = sizes.get(o) || 0;
      let carry = Buffer.alloc(0);
      const chunk = Buffer.alloc(256 * 1024);
      while (pos < total && out.length < max) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, total - pos), pos);
        if (n <= 0) break;
        pos += n;
        carry = Buffer.concat([carry, chunk.subarray(0, n)]);
        let at = 0;
        for (;;) {
          const nl = carry.indexOf(0x0a, at);
          if (nl < 0) break;
          const text = carry.toString('utf8', at, nl);
          if (!text.trim()) { at = nl + 1; continue; } // a blank line holds no seq (load() skips it too)
          if (line >= from) { try { out.push(JSON.parse(text)); } catch { /* skipped */ } }
          line++;
          at = nl + 1;
          if (out.length >= max) break;
        }
        carry = carry.subarray(at);
      }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return out;
  }

  load();
  // this machine's own file may already exist under another case of the same name: keep writing to it
  if (canon.has(origin.toLowerCase())) origin = canon.get(origin.toLowerCase());
  return {
    origin, dir,
    /** true when this machine's own file lost a tail or a bad line at load (a peer may hold records it no longer has) */
    ownRepaired: () => repaired.has(origin),
    append, appendReplica, feed, reload: load,
    heads: () => Object.fromEntries([...heads.entries()].sort()),
    head: (o) => heads.get(o) || 0,
    /** The newest record per key, optionally only of [type]. */
    records: (type) => { const r = [...folded.values()]; return type ? r.filter((x) => x.type === type) : r; },
    get: (key) => folded.get(key) || null,
    version: () => version,
  };
}

module.exports = { TYPES, ORIGIN_RE, MAX_RECORD_BYTES, INDEX_EVERY, isOrigin, originOf, checkRecord, newer, createUsageStore };
