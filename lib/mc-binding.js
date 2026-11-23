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

/** How long a binding is kept: a day longer than a closed session stays on a subject. */
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
  return { project, subjects, hunt: raw.hunt === true, server: str(raw.server, 100), at: raw.at };
}

/** The binding that reaches `node`: its own, a predecessor's, else its nearest bound ancestor's. */
function bindingFor(node, bindings, tree) {
  const seen = new Set();
  for (let n = node; n && !seen.has(n); n = tree.parentOf(n)) {
    seen.add(n);
    const own = bindings[n.id];
    if (own) return own;
    for (const old of n.replaces || []) if (bindings[old]) return bindings[old];
  }
  return null;
}

/** `nodes` (lib/mc-subjects.js sessionNodes) with each bound session's binding applied:
 *  `boundProject` set, and - while it has reported no items - its subjects as items marked
 *  `bound: true` (`boundAt` = when the session was created, else when it was bound). New
 *  objects: the input is not changed. */
function applyBindings(nodes, bindings) {
  const list = Array.isArray(nodes) ? nodes : [];
  const b = bindings && typeof bindings === 'object' ? bindings : {};
  if (!Object.keys(b).length) return list;
  const tree = buildTree(list);
  return list.map((n) => {
    const bound = bindingFor(n, b, tree);
    if (!bound) return n;
    const out = { ...n, boundProject: bound.project };
    if (!(n.items && n.items.length) && bound.subjects.length) {
      const at = Number.isFinite(n.createdAt) ? n.createdAt : bound.at;
      out.items = bound.subjects.map((s) => ({ key: s.key, ref: s.ref, title: null, state: null, stage: null, note: null, url: null, bound: true, boundAt: at }));
    }
    return out;
  });
}

/** The stored bindings worth keeping: younger than `keepMs`, at most `max` (newest kept). */
function pruneBindings(bindings, now, { keepMs = BINDING_KEEP_MS, max = MAX_BINDINGS } = {}) {
  const entries = Object.entries(bindings || {}).filter(([, v]) => v && now - v.at <= keepMs);
  entries.sort((x, y) => y[1].at - x[1].at);
  return Object.fromEntries(entries.slice(0, max));
}

module.exports = { BINDING_KEEP_MS, MAX_BINDINGS, MAX_SUBJECTS, bindingOf, bindingFor, applyBindings, pruneBindings };
