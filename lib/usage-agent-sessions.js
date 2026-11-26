'use strict';
// --- Which web-terminal session ran which Claude session (#529) -------------------------
//
// A transcript is named by the Claude session id; the fleet usage ledger wants to know which
// web-terminal session it belonged to (a child, a hand-off successor, a bug-hunter worker). Claude's
// hooks carry that pairing - server.js sees `(wtId, agentSid)` on every hook - but until now it lived
// in a bounded in-memory map and was lost. This module persists the FIRST sighting of each pair to
// `logs/agent-sessions.jsonl`, with what the session was then called and who started it:
//   { at, wtId, agentSid, name, parentId, spawnedBy, replaces, cwd }
// The same Claude session can be seen under two web-terminal ids only if the id changed, so a
// pair is keyed on both. Pure: the file and the clock are injected.

const KEEP = 20000;

/** @param {{load: () => object[], append: (rec: object) => void, now?: () => number}} io */
function createAgentSessionMap({ load, append, now = Date.now }) {
  const pairs = new Set();            // `${wtId}\0${agentSid}`
  const bySid = new Map();            // agentSid -> the newest entry
  const entries = [];
  function take(e) {
    entries.push(e);
    bySid.set(e.agentSid, e);
    pairs.add(`${e.wtId}\0${e.agentSid}`);
  }
  for (const e of load() || []) {
    if (e && typeof e.wtId === 'string' && typeof e.agentSid === 'string' && !pairs.has(`${e.wtId}\0${e.agentSid}`)) take(e);
  }
  const str = (x, n) => (typeof x === 'string' && x ? x.slice(0, n) : null);
  return {
    /** Note a sighting. [meta] is what is known of the web-terminal session
     *  (`{name, cwd, parentId, spawnedBy, replaces}`); returns true when the pair is new. */
    note(wtId, agentSid, meta) {
      if (typeof wtId !== 'string' || typeof agentSid !== 'string' || !wtId || !agentSid) return false;
      if (pairs.has(`${wtId}\0${agentSid}`)) return false;
      const m = meta || {};
      const e = {
        at: new Date(now()).toISOString(), wtId, agentSid,
        name: str(m.name, 100), parentId: str(m.parentId, 40), spawnedBy: str(m.spawnedBy, 80),
        replaces: Array.isArray(m.replaces) && m.replaces.length ? m.replaces.filter((x) => typeof x === 'string').slice(0, 8) : null,
        cwd: str(m.cwd, 260),
      };
      take(e);
      if (entries.length > KEEP) entries.shift();
      try { append(e); } catch { /* the in-memory pair still holds; logged by the caller's append */ }
      return true;
    },
    bySid: (agentSid) => bySid.get(agentSid) || null,
    all: () => entries.slice(),
  };
}

module.exports = { createAgentSessionMap };
