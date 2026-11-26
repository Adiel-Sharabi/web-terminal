'use strict';
// --- One Claude session's usage, from its transcript (#529) ----------------------------
//
// Pure: lines in, a summary out - no file, no clock, no model. The collector
// (lib/usage-collector.js) streams a transcript's lines into an accumulator and keeps
// the summary. What is kept is numbers, times and counts: NEVER a prompt's text, a tool's
// output or a path beyond the session's own cwd.
//
// The rules mirror claude-memory's usage-monitor.js (the roll-up that has been written
// daily), so the two agree: a message is counted once by `message.id|requestId` (Claude
// writes each content block of a message on its own line; the LAST line carries the final
// usage); `<synthetic>` messages cost nothing; units are lib/usage-weights.js's.
//
// A session's transcript is the main `<sid>.jsonl` plus `<sid>/subagents/agent-*.jsonl`
// (each with a `.meta.json` sidecar naming its type). A main-file line flagged
// `isSidechain` counts with the subagents.

const { unitsOf, cacheWriteUnitsOf, promptClass, opensBugHunter, WAKE_IDLE_MS } = require('./usage-weights');
const { isCorrection } = require('./usage-correction');

const DEFAULT_ACTIVE_GAP_MS = 5 * 60e3;
/** At most this many per-wait durations are kept in a record (the longest, when there are more). */
const MAX_WAITS = 200;

const pad = (n) => String(n).padStart(2, '0');
/** The machine's local calendar day of [t] - the day the roll-up files use. */
function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Cheap pre-filter for a raw transcript line: only these are worth a JSON.parse. */
function wanted(line) {
  return line.indexOf('"usage"') >= 0 || line.indexOf('"type":"user"') >= 0 || line.indexOf('compact_boundary') >= 0;
}

/** The text of a user turn, or null when it is a tool result (not a prompt). */
function promptText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) {
    const b = c.find((x) => x && x.type === 'text');
    return b && typeof b.text === 'string' ? b.text : null;
  }
  return null;
}

const modelName = (m) => String(m).replace(/^claude-/, '');
const blank = () => ({ in: 0, out: 0, cr: 0, cw: 0, cw1h: 0 });

/** @param {{activeGapMs?: number}} [opts]
 *  @returns {{main(o: object): void, sub(o: object, type: string): void, finish(): object|null}} */
function createSessionAccumulator({ activeGapMs = DEFAULT_ACTIVE_GAP_MS } = {}) {
  const msgs = new Map();   // key -> a call: { t, model, main, type, tok, wake }
  const events = [];        // main-transcript events for the time split: [t, kind]
  let minT = Infinity;
  let maxT = -Infinity;
  let cwd = null;
  let branch = null;
  let firstClass = null;
  let startsBugHunter = false;
  let sawPrompt = false;
  let lastKind = 'human';   // what last prompted the session: decides a wake's cause
  let lastT = null;         // the last main assistant message (a new key)
  let boundaries = 0;
  let summaries = 0;
  const prompts = { human: 0, auto: 0 };
  // Quality signals (#529): counts only - no text, no tool input leaves this function.
  const quality = { toolCalls: 0, toolErrors: 0, deniedTools: 0, retriesSameTool: 0, humanCorrections: 0, compactionsMidTask: 0 };
  const toolUses = new Map(); // tool_use id -> '[name, input]' as JSON (to see the same call fail twice in a row)
  const seenUse = new Set();
  let lastResult = null;     // { key, error } of the previous tool result

  const seen = (o) => {
    const t = Date.parse(o.timestamp);
    if (Number.isFinite(t)) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    return t;
  };

  function call(o, { main, type, agent }) {
    const m = o.message;
    if (!m || !m.usage || !m.model || m.model === '<synthetic>') return;
    const t = seen(o);
    if (!Number.isFinite(t)) return;
    const u = m.usage;
    const cc = u.cache_creation || {};
    const key = `${m.id || o.uuid}|${o.requestId || ''}`;
    let wake = null;
    if (main && !msgs.has(key)) {
      wake = lastT != null && t - lastT > WAKE_IDLE_MS ? lastKind : null;
      lastT = t;
    }
    const prev = msgs.get(key);
    msgs.set(key, {
      t, model: modelName(m.model), main, type, agent,
      tok: { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, cw1h: cc.ephemeral_1h_input_tokens || 0 },
      wake: wake || (prev && prev.wake) || null,
    });
  }

  /** The tool calls an assistant line carries (each content block is its own line, so a call is
   *  seen once by its id). */
  function toolUsesOf(message) {
    if (!Array.isArray(message.content)) return;
    for (const b of message.content) {
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || seenUse.has(b.id)) continue;
      seenUse.add(b.id);
      quality.toolCalls++;
      let input = '';
      try { input = JSON.stringify(b.input === undefined ? null : b.input).slice(0, 4000); } catch { /* unkeyable: never a "same call" */ }
      toolUses.set(b.id, JSON.stringify([b.name, input]));
      if (toolUses.size > 4000) toolUses.delete(toolUses.keys().next().value);
    }
  }

  /** The tool results of a user line: errors, refusals by the person, and the same call failing
   *  twice in a row (a retry loop). */
  function toolResults(o) {
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) return;
    const denied = o.toolUseResult === 'User rejected tool use';
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const key = toolUses.get(b.tool_use_id) || null;
      const error = b.is_error === true;
      if (error && (denied || /^The user doesn't want to proceed/.test(typeof b.content === 'string' ? b.content : ''))) quality.deniedTools++;
      else if (error) {
        quality.toolErrors++;
        if (key && lastResult && lastResult.error && lastResult.key === key) quality.retriesSameTool++;
      }
      lastResult = { key, error };
    }
  }

  /** One parsed line of the MAIN transcript. */
  function main(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.cwd === 'string' && o.cwd && !cwd) cwd = o.cwd;
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') branch = o.gitBranch;
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      boundaries++; seen(o);
      if (o.compactMetadata && o.compactMetadata.trigger === 'auto') quality.compactionsMidTask++; // the context filled mid-task; a manual /compact is a choice
      return;
    }
    if (o.type === 'user' && !o.isSidechain && !o.isMeta && o.message) {
      const t = seen(o);
      if (o.isCompactSummary) { summaries++; return; }
      const txt = promptText(o.message);
      if (txt == null) { toolResults(o); if (Number.isFinite(t)) events.push([t, 'u']); return; }
      const k = promptClass(txt);
      if (!k) return;
      lastKind = k === 'human' ? 'human' : 'auto';
      prompts[lastKind]++;
      if (k === 'human' && sawPrompt && isCorrection(txt)) quality.humanCorrections++;
      if (!sawPrompt) { sawPrompt = true; firstClass = k; startsBugHunter = opensBugHunter(txt); }
      if (Number.isFinite(t)) events.push([t, k === 'human' ? 'h' : 'x']);
      return;
    }
    if (o.type === 'assistant' && o.message) {
      if (!o.isSidechain) toolUsesOf(o.message);
      if (o.isSidechain) { call(o, { main: false, type: 'sidechain', agent: 'sidechain' }); return; }
      const t = seen(o);
      if (Number.isFinite(t)) events.push([t, o.message.stop_reason === 'end_turn' ? 'e' : 'a']);
      call(o, { main: true, type: null, agent: null });
    }
  }

  /** One parsed line of a SUBAGENT transcript of [type] (the sidecar's `agentType`);
   *  [agent] names the file, so a type's agents are counted once each. */
  function sub(o, type, agent) {
    if (!o || typeof o !== 'object' || o.type !== 'assistant') return;
    call(o, { main: false, type: type || 'unknown', agent: agent || type || 'unknown' });
  }

  function timeSplit() {
    const ev = events.slice().sort((a, b) => a[0] - b[0]);
    const time = { activeMs: 0, idleMs: 0, waitYouMs: 0, waits: 0, waitsMin: [] };
    for (let i = 1; i < ev.length; i++) {
      const gap = ev[i][0] - ev[i - 1][0];
      if (gap <= 0) continue;
      if (gap <= activeGapMs) time.activeMs += gap;
      else if (ev[i][1] === 'h' && ev[i - 1][1] === 'e') { time.waitYouMs += gap; time.waits++; time.waitsMin.push(Math.max(1, Math.round(gap / 60e3))); }
      else time.idleMs += gap;
    }
    if (time.waitsMin.length > MAX_WAITS) time.waitsMin = time.waitsMin.sort((a, b) => b - a).slice(0, MAX_WAITS);
    return time;
  }

  /** The summary, or null when the session made no model call. */
  function finish() {
    if (!msgs.size) return null;
    const tok = blank();
    const byModel = {};
    const byDay = {};
    const subAgg = { agents: new Set(), units: 0, byType: {} };
    const wakes = { n: 0, units: 0, auto: { n: 0, units: 0 } };
    let units = 0;
    let peakCtx = 0;
    for (const r of msgs.values()) {
      const u = unitsOf(r.tok);
      units += u;
      for (const k of Object.keys(tok)) tok[k] += r.tok[k];
      const mm = byModel[r.model] ??= { calls: 0, units: 0 };
      mm.calls++; mm.units += u;
      const day = localDay(r.t);
      byDay[day] = (byDay[day] || 0) + u;
      if (r.main) {
        peakCtx = Math.max(peakCtx, r.tok.in + r.tok.cr + r.tok.cw);
        if (r.wake) {
          const w = cacheWriteUnitsOf(r.tok);
          wakes.n++; wakes.units += w;
          if (r.wake === 'auto') { wakes.auto.n++; wakes.auto.units += w; }
        }
      } else {
        subAgg.units += u;
        const bt = subAgg.byType[r.type] ??= { agents: new Set(), units: 0 };
        bt.agents.add(r.agent); bt.units += u;
        subAgg.agents.add(`${r.type}|${r.agent}`);
      }
    }
    const R = Math.round;
    const roundAll = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
    return {
      start: new Date(minT).toISOString(), end: new Date(maxT).toISOString(), cwd, branch,
      tok, units: R(units),
      models: roundAll(byModel, (v) => ({ calls: v.calls, units: R(v.units) })),
      sub: { n: subAgg.agents.size, units: R(subAgg.units), byType: roundAll(subAgg.byType, (v) => ({ n: v.agents.size, units: R(v.units) })) },
      prompts: { ...prompts },
      wakes: { n: wakes.n, units: R(wakes.units), auto: { n: wakes.auto.n, units: R(wakes.auto.units) } },
      time: timeSplit(),
      compactions: Math.max(boundaries, summaries),
      quality: { ...quality },
      peakCtx,
      byDay: roundAll(byDay, R),
      facts: { firstClass, startsBugHunter },
    };
  }

  return { main, sub, finish };
}

module.exports = { DEFAULT_ACTIVE_GAP_MS, MAX_WAITS, localDay, wanted, promptText, createSessionAccumulator };
