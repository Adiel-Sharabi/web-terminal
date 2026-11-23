'use strict';
// #505 - Mission Control's persisted state, on the authority only (docs/mission-control.md
// "Who answers"): each subject's stage history (#505), and the person's to-dos and "later"s
// (#506; their rules are lib/mc-needs.js). #512: the sessions Start work bound to a project
// and subjects, under their own key `bindings` (the rule is lib/mc-binding.js).
//
// One JSON file, written atomically (tmp + rename), a few seconds after a change. An
// unreadable file is moved aside (`<file>.corrupt-<ms>`) and logged, never half-read and
// never written over, as the brief store does. A subject not seen for `keepMs` is dropped,
// and at most `maxKeys` are kept (the least recently seen go first).
const fs = require('fs');
const path = require('path');
const mcBinding = require('./mc-binding');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEYS = 2000;

function createMcState({ file, log = console.error, now = Date.now, keepMs = KEEP_MS, maxKeys = MAX_KEYS, saveDelayMs = 2000 }) {
  let state = null;
  let timer = null;
  // A file that exists but cannot be read (locked, no permission) is NOT absent: writing over
  // it would lose every to-do and with them the record that a session was already told
  // (#506). Until it reads, nothing is written and a write says it failed.
  let unreadable = false;
  let lastUnreadable = null;

  function load() {
    if (state) return state;
    state = { stages: {}, todos: [], later: {}, bindings: {} };
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // Read again next time: a lock passes. Said once per cause, not on every read.
        const why = e.code || e.message;
        if (why !== lastUnreadable) log(`[mc] state file unreadable (${why}); nothing is written until it reads`);
        lastUnreadable = why;
        unreadable = true;
        const s = state;
        state = null;
        return s;
      }
    }
    unreadable = false;
    lastUnreadable = null;
    if (raw === null) return state;
    try {
      const j = JSON.parse(raw);
      const src = j && j.stages && typeof j.stages === 'object' && !Array.isArray(j.stages) ? j.stages : {};
      for (const [k, e] of Object.entries(src)) {
        if (!e || typeof e !== 'object' || !Array.isArray(e.history)) continue;
        state.stages[k] = { history: e.history, seenAt: Number.isFinite(e.seenAt) ? e.seenAt : 0 };
      }
      // #506 - a to-do needs an id, its card and a time; anything else is not one of ours.
      if (Array.isArray(j.todos)) {
        state.todos = j.todos.filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && typeof t.cardId === 'string'
          && Number.isFinite(t.createdAt));
      }
      if (j.later && typeof j.later === 'object' && !Array.isArray(j.later)) {
        for (const [k, v] of Object.entries(j.later)) if (v && Number.isFinite(v.until)) state.later[k] = { until: v.until, at: Number.isFinite(v.at) ? v.at : null };
      }
      // #512 - bindings, each validated; a malformed one is dropped, never trusted.
      const bsrc = j && j.bindings && typeof j.bindings === 'object' && !Array.isArray(j.bindings) ? j.bindings : {};
      for (const [id, raw2] of Object.entries(bsrc)) { const b = mcBinding.bindingOf(raw2); if (b) state.bindings[id] = b; }
    } catch (e) {
      const aside = `${file}.corrupt-${now()}`;
      try { fs.renameSync(file, aside); } catch { /* best effort */ }
      log(`[mc] state file unreadable (${e.message}); moved to ${path.basename(aside)}`);
      state = { stages: {}, todos: [], later: {}, bindings: {} };
    }
    return state;
  }

  /** Write now. true when the state is on disk. */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!state || unreadable) return false;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, stages: state.stages, todos: state.todos, later: state.later, bindings: state.bindings }));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) { log(`[mc] state write failed: ${e.message}`); return false; }
  }
  function saveSoon() {
    if (timer) return;
    timer = setTimeout(flush, saveDelayMs);
    if (timer.unref) timer.unref();
  }
  function prune() {
    const s = load().stages;
    const t = now();
    for (const k of Object.keys(s)) if (t - (s[k].seenAt || 0) > keepMs) delete s[k];
    const keys = Object.keys(s);
    if (keys.length <= maxKeys) return;
    keys.sort((a, b) => (s[a].seenAt || 0) - (s[b].seenAt || 0));
    for (const k of keys.slice(0, keys.length - maxKeys)) delete s[k];
  }

  return {
    /** A subject's stored stage history ([] when none). */
    stageHistory: (key) => { const e = load().stages[key]; return e ? e.history : []; },
    /** Record a subject's history (changed or not: `seenAt` keeps it from expiring). Writes
     *  only when the history changed, or when the subject was last marked seen a day ago. */
    setStageHistory(key, history, { changed }) {
      const s = load().stages;
      const prev = s[key];
      const t = now();
      const stale = !prev || t - (prev.seenAt || 0) > 24 * 60 * 60 * 1000;
      s[key] = { history, seenAt: changed || stale ? t : prev.seenAt };
      if (changed || stale) { prune(); saveSoon(); }
    },
    /** #506 - the stored to-dos (every state; lib/mc-needs.js decides what each means). */
    todos: () => load().todos.slice(),
    /** #506 - replace the stored to-dos. [now] = true writes at once and returns whether
     *  they are on disk (a park message is recorded BEFORE it is sent, so a crash never sends
     *  it twice; a failed write sends nothing); else soon, and true. */
    setTodos(todos, { now: writeNow = false } = {}) {
      const st = load();
      if (unreadable) return false;
      st.todos = todos.slice();
      if (writeNow) return flush();
      saveSoon();
      return true;
    },
    /** #506 - the "later"s, by card id: {until, at}. */
    later: () => ({ ...load().later }),
    setLater(later) {
      const st = load();
      if (unreadable) return false;
      st.later = { ...later };
      saveSoon();
      return true;
    },
    /** #512 - every live binding by session id (lib/mc-binding.js prunes the old ones). */
    bindings() {
      const st = load();
      st.bindings = mcBinding.pruneBindings(st.bindings, now());
      return st.bindings;
    },
    /** #512 - record that session `id` was started for a project and subjects. Saved soon. */
    setBinding(id, raw) {
      const b = mcBinding.bindingOf(raw);
      if (typeof id !== 'string' || !id || !b) return false;
      const st = load();
      if (unreadable) return false;
      st.bindings[id] = b;
      st.bindings = mcBinding.pruneBindings(st.bindings, now());
      saveSoon();
      return true;
    },
    flush,
  };
}

module.exports = { createMcState, KEEP_MS, MAX_KEYS };
