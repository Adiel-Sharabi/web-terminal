'use strict';
// #523 - Mission Control: lines of work.
//
// A project holds several lines of work running side by side (a bug hunt, health checks, a
// feature, a release cut, a docket of fixes), and the person follows each apart. The tracker's
// Area Path does not follow them, so this module is the ONE owner of "which line is this work
// item on". First match wins:
//   0. the person's Move-to-line override (stored on the authority, lib/mc-state.js);
//   1. the line of the session on it, or of the run that started that session: a line the
//      session reported (`line` on its report), the line Start work bound it to, or - for the
//      sessions above it - a configured session-name rule (an orchestrator's workers inherit);
//   2. the subject's project's configured lines (`projects[].lines[].match`: listed items,
//      tags, title prefixes, the names of the sessions on it), in config order;
//   3. its tracker parent: the nearest Feature/Epic up the chain the tracker details hold, else
//      the direct parent (a configured rule that matches the parent names the line);
//   4. otherwise a line of its own: its run's, else the work item's. Never a catch-all.
// The companion renders this answer (GET /api/mc/lines, Subject.line) and never re-derives it
// (docs/mission-control.md "Lines of work").
//
// Pure (lib/mc-subjects.js buildView passes the subject, its sessions and the tree), but for
// readParents, whose tracker I/O server.js hands in.
const projectsLib = require('./projects');
const { lineName } = require('./session-brief');

/// A tracker parent that IS a line of work.
const LINE_TYPES = /^(?:feature|epic)$/i;
/// How far up a parent chain is followed (server.js reads the tracker that many levels up).
const PARENT_DEPTH = 3;
const KINDS = Object.freeze(['config', 'named', 'parent', 'run', 'item']);

const eqi = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const _globs = new Map(); // pattern -> RegExp: config patterns are few and reused every poll
/** A session-name pattern: the WHOLE name, no case, `*` the only wildcard (a run of `*` is one). */
function globMatch(pattern, text) {
  if (typeof pattern !== 'string' || typeof text !== 'string') return false;
  let re = _globs.get(pattern);
  if (!re) {
    const src = pattern.split(/\*+/).map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    re = new RegExp(`^${src}$`, 'i');
    if (_globs.size >= 500) _globs.clear();
    _globs.set(pattern, re);
  }
  return re.test(text);
}

/** A stable slug for a line name: its letters and digits in any script (a Hebrew name is a
 *  line of its own), lower case, the rest one `-`. A name is at most 80 characters, so is this. */
function slug(name) {
  const s = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return s || 'line';
}

/** The kind of line an id names. */
function kindOfId(id) {
  if (/^parent:/.test(id)) return 'parent';
  if (/^run:/.test(id)) return 'run';
  if (/^item:/.test(id)) return 'item';
  return /\/~/.test(id) ? 'named' : 'config';
}

const configLine = (p, l) => ({ id: `${p.id}/${l.id}`, name: l.name, project: p.id, kind: 'config' });
/** A configured line by its full id (`<project>/<line>`), or null. */
function configLineById(projects, id) {
  const i = typeof id === 'string' ? id.indexOf('/') : -1;
  if (i < 1) return null;
  const p = projects.find((x) => x.id === id.slice(0, i));
  const l = p && (p.lines || []).find((x) => x.id === id.slice(i + 1));
  return l ? configLine(p, l) : null;
}

/** A target `{id?, name}` (a report's line, a binding's, an override) as a line in `project`:
 *  a configured line by id, else by name or id (no case) in that project, else the id as
 *  stored, else a line of that name. */
function resolveTarget(target, { projects, project }) {
  if (target.id) {
    const c = configLineById(projects, target.id);
    if (c) return c;
    const prefix = target.id.includes('/~') ? target.id.slice(0, target.id.indexOf('/~')) : null;
    return { id: target.id, name: target.name || target.id, project: prefix && projects.some((p) => p.id === prefix) ? prefix : project, kind: kindOfId(target.id) };
  }
  const p = projects.find((x) => x.id === project);
  const l = p && (p.lines || []).find((x) => eqi(x.name, target.name) || eqi(x.id, target.name));
  if (l) return configLine(p, l);
  return { id: `${project}/~${slug(target.name)}`, name: target.name, project, kind: 'named' };
}

/** The first configured line of project `p` that matches: a listed item, a tag, a title
 *  prefix, or a session name. */
function ruleMatch(p, { key, labels, title, names }) {
  if (!p) return null;
  const t = typeof title === 'string' ? title.trimStart().toLowerCase() : '';
  for (const l of p.lines || []) {
    const m = l.match;
    if (key && m.items.includes(key)) return configLine(p, l);
    if (Array.isArray(labels) && m.tags.some((tag) => labels.some((x) => eqi(x, tag)))) return configLine(p, l);
    if (t && m.titlePrefixes.some((x) => t.startsWith(x.toLowerCase()))) return configLine(p, l);
    if (Array.isArray(names) && m.sessionNames.some((x) => names.some((nm) => globMatch(x, nm)))) return configLine(p, l);
  }
  return null;
}

/** The tracker parent that names a subject's line: the nearest Feature/Epic up the chain the
 *  details hold, else the direct parent. `{key, ref, meta, partial}` or null. `partial`: the
 *  chain stopped at a level never read (not yet, or its read failed), so a Feature may lie
 *  above it and the line can still move when that read lands. */
function parentOf(meta, metaByKey, selfKey) {
  const chain = [];
  const seen = new Set([selfKey]);
  let cur = meta && meta.parent;
  let partial = false;
  while (cur && typeof cur.key === 'string' && !seen.has(cur.key) && chain.length < PARENT_DEPTH) {
    seen.add(cur.key);
    const m = metaByKey[cur.key] || null;
    chain.push({ key: cur.key, ref: (typeof cur.ref === 'string' && cur.ref) || cur.key, meta: m });
    if (m && LINE_TYPES.test(m.type || '')) return { ...chain[chain.length - 1], partial: false };
    if (!m || !m.fetchedAt) { partial = true; break; }
    cur = m.parent;
  }
  return chain[0] ? { ...chain[0], partial } : null;
}

/** The I/O the parent rule needs: adds to `metaByKey` (key -> Meta, mutated) each subject's
 *  tracker parents up to PARENT_DEPTH levels. Each level's reads are started and awaited until
 *  one deadline (`waitMs`, shared by every level); a level not read by then is served as the
 *  cache holds it (never read: `fetchedAt` null, so parentOf says `partial`) and lands on a
 *  later poll. A failed read never throws: the cache answers for it. */
async function readParents({ metaByKey, parseRef, getMany, peek, waitMs, now = Date.now, log = () => {} }) {
  const deadline = now() + waitMs;
  let level = Object.values(metaByKey);
  for (let depth = 0; depth < PARENT_DEPTH && level.length; depth++) {
    const up = [...new Set(level.map((m) => m && m.parent && m.parent.key).filter((k) => typeof k === 'string' && !metaByKey[k]))]
      .map((k) => parseRef(k)).filter((r) => r && !r.unqualified);
    if (!up.length) break;
    const reads = Promise.resolve().then(() => getMany(up)).catch((e) => log(e.message));
    const left = deadline - now();
    if (left > 0) {
      await Promise.race([reads, new Promise((r) => { const t = setTimeout(r, left); if (t.unref) t.unref(); })]);
    }
    level = await Promise.all(up.map((r) => peek(r)));
    for (const m of level) if (m && typeof m.key === 'string') metaByKey[m.key] = m;
  }
  return metaByKey;
}

/** A session's own line target: the line it reported, else the one Start work gave it. */
const explicitOf = (n) => (typeof n.line === 'string' && n.line ? { name: n.line } : n.boundLine || null);

/** Subject's line: `{id, name, project, kind, source}`, source = override | session | rule |
 *  parent | own. `sessions`: the subject's session nodes, newest report first; `tree`:
 *  lib/mc-tree.js over every node; `run`: the run it is in, or null; `projectOfNode(node)`: a
 *  session's project id; `override`: lib/mc-state.js lineOverrides()[key], or undefined. */
function lineOfSubject({ subject, sessions = [], tree, run = null, projects = [], metaByKey = {}, override, projectOfNode = () => null }) {
  const project = subject.project;
  const ctx = { projects, project };
  const pcfg = projects.find((p) => p.id === project) || null;
  const as = (line, source) => ({ id: line.id, name: line.name, project: line.project, kind: line.kind, source });

  if (override && override.line) return as(resolveTarget(override.line, ctx), 'override');

  // 1. The session's own line, else the line of the sessions above it (the run that started it).
  for (const node of sessions) {
    const seen = new Set();
    for (let a = node, self = true; a && !seen.has(a); a = tree ? tree.parentOf(a) : null, self = false) {
      seen.add(a);
      const ex = explicitOf(a);
      if (ex) return as(resolveTarget(ex, ctx), 'session');
      if (self) continue;
      const names = [a.name].filter(Boolean);
      const hit = ruleMatch(pcfg, { names }) || ruleMatch(projects.find((p) => p.id === projectOfNode(a)), { names });
      if (hit) return as(hit, 'session');
    }
  }

  // 2. The project's configured lines.
  const meta = subject.meta || null;
  const rule = ruleMatch(pcfg, { key: subject.key, labels: meta && meta.labels, title: subject.title, names: sessions.map((n) => n.name).filter(Boolean) });
  if (rule) return as(rule, 'rule');

  // 3. The tracker parent.
  const par = parentOf(meta, metaByKey, subject.key);
  if (par) {
    const pm = par.meta;
    const hit = ruleMatch(pcfg, { key: par.key, labels: pm && pm.labels, title: pm && pm.title });
    if (hit) return as(hit, 'parent');
    const line = as({ id: `parent:${par.key}`, name: (pm && typeof pm.title === 'string' && pm.title) || par.ref, project, kind: 'parent' }, 'parent');
    return par.partial ? { ...line, partial: true } : line;
  }

  // 4. A line of its own.
  if (run) return as({ id: `run:${run.id}`, name: run.name || 'Run', project, kind: 'run' }, 'own');
  return as({ id: `item:${subject.key}`, name: subject.title || subject.ref || subject.key, project, kind: 'item' }, 'own');
}

const projectName = (projects, id) => (id === projectsLib.OTHER_ID ? 'Other' : ((projects.find((p) => p.id === id) || {}).name || id));

/** GET /api/mc/lines' `lines`: one row per line the subjects are on, with the Counts of
 *  /api/mc/projects (the one bucket rule), the live sessions and machines on it, and its
 *  project as a label (a configured line's own; else the project most of its items are in).
 *  Busiest first: waiting on the person, then with active work, then the newest. */
function linesView({ subjects, projects = [] }) {
  const byId = new Map();
  for (const s of Array.isArray(subjects) ? subjects : []) {
    const l = s.line;
    if (!l || typeof l.id !== 'string') continue;
    let v = byId.get(l.id);
    if (!v) {
      v = { id: l.id, name: l.name, kind: l.kind, project: l.project, projectName: null, counts: projectsLib.zeroCounts(),
        subjects: [], machines: [], updatedAt: null, _projects: new Map(), _sessions: new Set(), _machines: new Set() };
      byId.set(l.id, v);
    }
    v._projects.set(s.project, (v._projects.get(s.project) || 0) + 1);
    projectsLib.countSubject(v.counts, s);
    v.subjects.push(s.key);
    for (const x of Array.isArray(s.sessions) ? s.sessions : []) {
      if (x.closed) continue;
      v._sessions.add(`${x.server || ''}|${x.id}`);
      if (x.server) v._machines.add(x.server);
    }
    if (Number.isFinite(s.updatedAt) && (v.updatedAt === null || s.updatedAt > v.updatedAt)) v.updatedAt = s.updatedAt;
  }
  const out = [];
  for (const v of byId.values()) {
    if (v.kind !== 'config' && v.kind !== 'named') {
      let best = null;
      for (const [id, n] of v._projects) if (!best || n > best.n) best = { id, n };
      if (best) v.project = best.id;
    }
    v.projectName = projectName(projects, v.project);
    v.counts.sessions = v._sessions.size;
    v.machines = [...v._machines].sort();
    delete v._projects; delete v._sessions; delete v._machines;
    out.push(v);
  }
  out.sort((a, b) => (b.counts.needsYou - a.counts.needsYou) || ((b.counts.active > 0) - (a.counts.active > 0))
    || ((b.updatedAt || 0) - (a.updatedAt || 0)) || a.name.localeCompare(b.name));
  return out;
}

/** Every configured line, in config order (the pickers offer them, items or not). */
function configuredLines(projects) {
  const out = [];
  for (const p of Array.isArray(projects) ? projects : []) for (const l of p.lines || []) out.push({ ...configLine(p, l), projectName: p.name });
  return out;
}

/** `?project=` on the lines. */
function filterLines(lines, { project } = {}) {
  return project ? lines.filter((l) => l.project === project) : lines;
}

/** Move to line (and Start work's line): `{line: id}` = a configured line or one the view
 *  shows (`lines`), `{name}` = a line of that name (made when first used), `{line: null}` =
 *  back to the rules. `{ok: true, line: {id?, name} | null}` or `{ok: false, error}`. */
function moveTarget(body, { projects = [], lines = [] } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { ok: false, error: 'body must be a JSON object' };
  const hasLine = b.line !== undefined;
  const hasName = b.name !== undefined && b.name !== null;
  if (hasLine && hasName) return { ok: false, error: 'give a line id or a new line name, not both' };
  if (hasLine) {
    if (b.line === null) return { ok: true, line: null };
    if (typeof b.line !== 'string' || !b.line || b.line.length > 300) return { ok: false, error: 'line must be a line id from /api/mc/lines (or null to go back to the rules)' };
    const c = configLineById(projects, b.line);
    if (c) return { ok: true, line: { id: c.id, name: c.name } };
    const known = (Array.isArray(lines) ? lines : []).find((l) => l && l.id === b.line);
    if (known) return { ok: true, line: { id: known.id, name: known.name } };
    return { ok: false, error: `no line ${JSON.stringify(b.line.slice(0, 60))}: pick one from the list, or give a new line name` };
  }
  if (hasName) {
    const name = lineName(b.name);
    if (!name) return { ok: false, error: 'a line name is one line of text, at most 80 characters' };
    return { ok: true, line: { name } };
  }
  return { ok: false, error: 'a line id (line) or a new line name (name) is required' };
}

module.exports = {
  KINDS, PARENT_DEPTH, globMatch, slug, readParents, kindOfId, configLineById, resolveTarget, ruleMatch, lineOfSubject,
  linesView, configuredLines, filterLines, moveTarget,
};
