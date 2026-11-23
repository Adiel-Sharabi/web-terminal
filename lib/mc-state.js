'use strict';
// #505 - Mission Control's persisted state, on the authority only (docs/mission-control.md
// "Who answers"): each subject's stage history. (#506 adds its to-dos here.)
//
// One JSON file, written atomically (tmp + rename), a few seconds after a change. An
// unreadable file is moved aside (`<file>.corrupt-<ms>`) and logged, never half-read and
// never written over, as the brief store does. A subject not seen for `keepMs` is dropped,
// and at most `maxKeys` are kept (the least recently seen go first).
const fs = require('fs');
const path = require('path');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEYS = 2000;

function createMcState({ file, log = console.error, now = Date.now, keepMs = KEEP_MS, maxKeys = MAX_KEYS, saveDelayMs = 2000 }) {
  let state = null;
  let timer = null;

  function load() {
    if (state) return state;
    state = { stages: {} };
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: nothing recorded yet */ }
    if (raw === null) return state;
    try {
      const j = JSON.parse(raw);
      const src = j && j.stages && typeof j.stages === 'object' && !Array.isArray(j.stages) ? j.stages : {};
      for (const [k, e] of Object.entries(src)) {
        if (!e || typeof e !== 'object' || !Array.isArray(e.history)) continue;
        state.stages[k] = { history: e.history, seenAt: Number.isFinite(e.seenAt) ? e.seenAt : 0 };
      }
    } catch (e) {
      const aside = `${file}.corrupt-${now()}`;
      try { fs.renameSync(file, aside); } catch { /* best effort */ }
      log(`[mc] state file unreadable (${e.message}); moved to ${path.basename(aside)}`);
      state = { stages: {} };
    }
    return state;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!state) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, stages: state.stages }));
      fs.renameSync(tmp, file);
    } catch (e) { log(`[mc] state write failed: ${e.message}`); }
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
    flush,
  };
}

module.exports = { createMcState, KEEP_MS, MAX_KEYS };
