'use strict';
// #505 - Mission Control's persisted state, on the authority only (docs/mission-control.md
// "Who answers"): each subject's stage history (#505), and the person's to-dos and "later"s
// (#506; their rules are lib/mc-needs.js), the Done records of action cards (#522). #512: the sessions Start work bound to a project
// and subjects, under their own key `bindings` (the rule is lib/mc-binding.js). #523: the
// person's Move-to-line overrides, by subject key, under `lineOverrides` (lib/mc-lines.js reads them).
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
/// #523 - a Move-to-line override is the person's own choice: kept 90 days from when it was made.
const OVERRIDE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/** #523 - the overrides still kept at `t`: younger than OVERRIDE_KEEP_MS, the newest `max`. */
function keptOverrides(entries, t, max) {
  return entries.filter(([, o]) => t - o.at <= OVERRIDE_KEEP_MS).sort((a, b) => b[1].at - a[1].at).slice(0, Math.max(0, max));
}

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
    state = { stages: {}, todos: [], later: {}, actionsDone: {}, bindings: {}, lineOverrides: {} };
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
      // #522 - the Done records of action cards: {cardId: {state, why, at}}.
      if (j.actionsDone && typeof j.actionsDone === 'object' && !Array.isArray(j.actionsDone)) {
        for (const [k, v] of Object.entries(j.actionsDone)) {
          if (v && typeof v.state === 'string' && Number.isFinite(v.at)) state.actionsDone[k] = { state: v.state, why: typeof v.why === 'string' ? v.why : null, at: v.at };
        }
      }
      // #512 - bindings, each validated; a malformed one is dropped, never trusted.
      const bsrc = j && j.bindings && typeof j.bindings === 'object' && !Array.isArray(j.bindings) ? j.bindings : {};
      for (const [id, raw2] of Object.entries(bsrc)) { const b = mcBinding.bindingOf(raw2); if (b) state.bindings[id] = b; }
      // #523 - overrides, each validated like a binding's line.
      const osrc = j && j.lineOverrides && typeof j.lineOverrides === 'object' && !Array.isArray(j.lineOverrides) ? j.lineOverrides : {};
      const loaded = [];
      for (const [k, o] of Object.entries(osrc)) {
        const line = o && mcBinding.lineTarget(o.line);
        if (line && Number.isFinite(o.at)) loaded.push([k, { line, at: o.at }]);
      }
      state.lineOverrides = Object.fromEntries(keptOverrides(loaded, now(), maxKeys));
    } catch (e) {
      const aside = `${file}.corrupt-${now()}`;
      try { fs.renameSync(file, aside); } catch { /* best effort */ }
      log(`[mc] state file unreadable (${e.message}); moved to ${path.basename(aside)}`);
      state = { stages: {}, todos: [], later: {}, actionsDone: {}, bindings: {}, lineOverrides: {} };
    }
    return state;
  }

  /** Write now. true when the state is on disk. */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!state || unreadable) return false;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, stages: state.stages, todos: state.todos, later: state.later, actionsDone: state.actionsDone, bindings: state.bindings, lineOverrides: state.lineOverrides }));
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
    /** #522 - the Done records of action cards, by card id: {state, why, at}. */
    actionsDone: () => ({ ...load().actionsDone }),
    /** #522 - replace them. [now] = true writes at once and returns whether they are on disk
     *  (a Done is recorded BEFORE its message goes out, as a park is); else soon, and true. */
    setActionsDone(rec, { now: writeNow = false } = {}) {
      const st = load();
      if (unreadable) return false;
      st.actionsDone = { ...rec };
      if (writeNow) return flush();
      saveSoon();
      return true;
    },
    /** #512 - every live binding by session id (lib/mc-binding.js prunes the old ones). */
    bindings() {
      const st = load();
      st.bindings = mcBinding.pruneBindings(st.bindings, now());
      return st.bindings;
    },
    /** #512 - the bindings still in use (lib/mc-binding.js applyBindings `used`) are marked
     *  seen now, so a long run keeps its binding; written at most once an hour per binding. */
    touchBindings(ids) {
      const st = load();
      const t = now();
      let write = false;
      for (const id of ids || []) {
        const b = st.bindings[id];
        if (!b) continue;
        if (t - (b.seenAt || 0) > 60 * 60 * 1000) write = true;
        b.seenAt = t;
      }
      if (write) saveSoon();
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
    /** #523 - the Move-to-line overrides by subject key: {line: {id?, name}, at}. */
    lineOverrides() {
      const st = load();
      const t = now();
      const out = {};
      for (const [k, o] of Object.entries(st.lineOverrides)) if (t - o.at <= OVERRIDE_KEEP_MS) out[k] = o;
      return out;
    },
    /** #523 - put subject `key` on a line (`{id?, name}`), or back on its rules (null). Saved
     *  soon; false when the line is not valid or the file cannot be written. */
    setLineOverride(key, line) {
      if (typeof key !== 'string' || !key || key.length > 300) return false;
      const st = load();
      if (unreadable) return false;
      if (line === null) { delete st.lineOverrides[key]; saveSoon(); return true; }
      const v = mcBinding.lineTarget(line);
      if (!v) return false;
      const t = now();
      const kept = keptOverrides(Object.entries(st.lineOverrides).filter(([k]) => k !== key), t, maxKeys - 1);
      st.lineOverrides = Object.fromEntries([[key, { line: v, at: t }], ...kept]);
      saveSoon();
      return true;
    },
    flush,
  };
}

module.exports = { createMcState, KEEP_MS, MAX_KEYS, OVERRIDE_KEEP_MS };
