'use strict';
// #512 - Mission Control: a session bound to a project and its work items AT BIRTH.
//
// A session started from Mission Control's "Start work" (POST /api/mc/start) is recorded on
// the authority with the project and the subject keys it was started for, so it shows under
// its subject at once - before its agent has reported anything. This module owns what a
// binding is and how it reaches a session; lib/mc-subjects.js reads the result like any
// reported item, so there is one join, not two.
//
// The rule:
//   * a session's binding is its own, else that of a session it was handed off from
//     (`spawn.replaces`), else its parent's (`spawn.parentId`, resolved by lib/mc-tree.js
//     across every server), nearest first. So an orchestrator's children inherit it;
//   * the PROJECT always comes from the binding (lib/projects.js projectOfSession `bound`);
//   * the SUBJECTS stand in for the session's report only until it reports items of its
//     own: what the agent says wins the moment it says it.
//
// Pure: the server passes the stored bindings (lib/mc-state.js) and the nodes.
const { buildTree } = require('./mc-tree');
const { lineName, LIMITS } = require('./session-brief');

/** How long a binding is kept after a session it reaches was last listed (live, or closed
 *  and still on its subject): a day longer than a closed session stays on a subject. */
const BINDING_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_BINDINGS = 2000;
const MAX_SUBJECTS = 10;

const str = (v, max) => (typeof v === 'string' && v && v.length <= max ? v : null);

/** A stored binding, validated (a hand-edited or older file is read, never trusted), or null.
 *  `{project, subjects: [{key, ref}], hunt, server, at}`. */
function bindingOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const project = str(raw.project, 40);
  if (!project || !Number.isFinite(raw.at)) return null;
  const subjects = [];
  for (const s of Array.isArray(raw.subjects) ? raw.subjects : []) {
    const key = s && str(s.key, 200);
    if (!key || subjects.some((x) => x.key === key) || subjects.length >= MAX_SUBJECTS) continue;
    subjects.push({ key, ref: (s && str(s.ref, 200)) || key });
  }
  // #523 - the line of work Start work named: `{id?, name}` (a line the view knew, or a new one).
  const line = lineTarget(raw.line);
  return { project, subjects, hunt: raw.hunt === true, server: str(raw.server, 100), at: raw.at,
    seenAt: Number.isFinite(raw.seenAt) ? raw.seenAt : raw.at, ...(line ? { line } : {}) };
}

/** #523 - a stored line target `{id?, name}` validated, or null. The one reader for a
 *  binding's line and a Move-to-line override (lib/mc-state.js). */
function lineTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // A line with an id is named by what it is (a tracker parent's title can be long), so the
  // name stored beside the id is only its label (the id stands in for one it cannot keep);
  // a new line has no id and its name IS the line.
  const id = str(raw.id, 300);
  const name = id ? (lineName(raw.name, LIMITS.lineLabel) || id) : lineName(raw.name);
  if (!name) return null;
  return id ? { id, name } : { name };
}

/** The binding that reaches `node` as `{id, binding}`: its own, a predecessor's, else its
 *  nearest bound ancestor's; null when none does. */
function bindingFor(node, bindings, tree) {
  const seen = new Set();
  for (let n = node; n && !seen.has(n); n = tree.parentOf(n)) {
    seen.add(n);
    if (bindings[n.id]) return { id: n.id, binding: bindings[n.id] };
    for (const old of n.replaces || []) if (bindings[old]) return { id: old, binding: bindings[old] };
  }
  return null;
}

/** `nodes` (lib/mc-subjects.js sessionNodes) with each bound session's binding applied:
 *  `boundProject` set, and - while it has reported no items - its subjects as items marked
 *  `bound: true` (`boundAt` = when the session was created, else when it was bound). New
 *  objects: the input is not changed. */
function applyBindings(nodes, bindings, used = null) {
  const list = Array.isArray(nodes) ? nodes : [];
  const b = bindings && typeof bindings === 'object' ? bindings : {};
  if (!Object.keys(b).length) return list;
  const tree = buildTree(list);
  return list.map((n) => {
    const hit = bindingFor(n, b, tree);
    if (!hit) return n;
    // `used` collects the ids of the bindings still in use, so the store keeps them alive.
    if (used) used.add(hit.id);
    const bound = hit.binding;
    const out = { ...n, boundProject: bound.project, ...(bound.line ? { boundLine: bound.line } : {}) };
    if (!(n.items && n.items.length) && bound.subjects.length) {
      const at = Number.isFinite(n.createdAt) ? n.createdAt : bound.at;
      out.items = bound.subjects.map((s) => ({ key: s.key, ref: s.ref, title: null, state: null, stage: null, note: null, url: null, bound: true, boundAt: at }));
    }
    return out;
  });
}

/** The stored bindings worth keeping: in use within `keepMs` (`seenAt`), at most `max`
 *  (the most recently in use kept). */
function pruneBindings(bindings, now, { keepMs = BINDING_KEEP_MS, max = MAX_BINDINGS } = {}) {
  const seen = (v) => (Number.isFinite(v.seenAt) ? v.seenAt : v.at);
  const entries = Object.entries(bindings || {}).filter(([, v]) => v && now - seen(v) <= keepMs);
  entries.sort((x, y) => seen(y[1]) - seen(x[1]));
  return Object.fromEntries(entries.slice(0, max));
}

module.exports = { BINDING_KEEP_MS, MAX_BINDINGS, MAX_SUBJECTS, bindingOf, bindingFor, applyBindings, pruneBindings, lineTarget };
