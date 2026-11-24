'use strict';
// #503 - Mission Control: projects and their areas.
//
// The ONE owner of "which project is this session / work item in, and which area". Config
// `projects[]` (validated here, for PUT /api/config and for every read) says what a project
// is: the repos, ADO projects and folders that belong to it, and where its areas come from.
// Anything no project claims lands in a visible "Other", never hidden. The companion renders
// this module's answer (GET /api/mc/projects) and never re-derives it.
//
// Pure: no I/O. The server passes each session's git origin (it owns the git read) and the
// tracker details (lib/tracker-meta.js).

// #505 - the stage order, for counts.stages (a pure leaf).
const { STAGES } = require('./mc-stage');
// #523 - a line's listed work items are keys as subjects carry them (globalKey), and a line's
// name follows the one rule for a line name (lineName, where a session's report first names one).
const { globalKey, lineName } = require('./session-brief');

const OTHER_ID = 'other';
const GENERAL = 'General';
const SOURCES = ['ado-area', 'gh-label', 'path', 'none'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const LIMITS = { projects: 50, list: 50, map: 200, name: 80, key: 260, lines: 50 };
/// #523 - what a configured line of work matches (lib/mc-lines.js applies them).
const LINE_MATCH = ['items', 'tags', 'titlePrefixes', 'sessionNames'];
const TRACKER_KEY_RE = /^(?:ado:\d+|[\w.-]+\/[\w.-]+#\d+)$/;
const CTL_RE = /[\u0000-\u001f\u007f]/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanStr = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max && !CTL_RE.test(v) ? v.trim() : null);

/** Validate config `projects`. `{ok: true, projects}` (normalised) or `{ok: false, error}`;
 *  an invalid list is refused whole, never half-applied. */
function validateProjects(raw) {
  if (raw === undefined || raw === null) return { ok: true, projects: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'projects must be an array' };
  if (raw.length > LIMITS.projects) return { ok: false, error: `at most ${LIMITS.projects} projects` };
  const out = [];
  const ids = new Set();
  for (const [i, p] of raw.entries()) {
    const at = `projects[${i}]`;
    if (!isObj(p)) return { ok: false, error: `${at} must be an object` };
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return { ok: false, error: `${at}.id must be lowercase letters, digits, - or _ (at most 40)` };
    if (p.id === OTHER_ID) return { ok: false, error: `${at}.id "${OTHER_ID}" is reserved for what no project claims` };
    if (ids.has(p.id)) return { ok: false, error: `${at}.id "${p.id}" is used twice` };
    ids.add(p.id);
    const name = cleanStr(p.name, LIMITS.name);
    if (!name) return { ok: false, error: `${at}.name is required (at most ${LIMITS.name} characters)` };
    const match = p.match === undefined ? {} : p.match;
    if (!isObj(match)) return { ok: false, error: `${at}.match must be an object` };
    const lists = {};
    for (const [k, max, re] of [['repos', 200, REPO_RE], ['adoProjects', 200, null], ['paths', LIMITS.key, null]]) {
      const v = match[k] === undefined ? [] : match[k];
      if (!Array.isArray(v) || v.length > LIMITS.list) return { ok: false, error: `${at}.match.${k} must be an array of at most ${LIMITS.list}` };
      lists[k] = [];
      for (const [j, s] of v.entries()) {
        const c = cleanStr(s, max);
        if (!c || (re && !re.test(c))) return { ok: false, error: `${at}.match.${k}[${j}] is not valid${re ? ' (owner/repo)' : ''}` };
        lists[k].push(c);
      }
    }
    const areasIn = p.areas === undefined ? {} : p.areas;
    if (!isObj(areasIn)) return { ok: false, error: `${at}.areas must be an object` };
    const source = areasIn.source === undefined ? 'none' : areasIn.source;
    if (!SOURCES.includes(source)) return { ok: false, error: `${at}.areas.source must be one of: ${SOURCES.join(', ')}` };
    const mapIn = areasIn.map === undefined ? {} : areasIn.map;
    if (!isObj(mapIn) || Object.keys(mapIn).length > LIMITS.map) return { ok: false, error: `${at}.areas.map must be an object of at most ${LIMITS.map} entries` };
    const map = {};
    for (const [k, v] of Object.entries(mapIn)) {
      const ck = cleanStr(k, LIMITS.key);
      const cv = cleanStr(v, LIMITS.name);
      if (!ck || !cv) return { ok: false, error: `${at}.areas.map entry "${String(k).slice(0, 40)}" needs a key and an area name (at most ${LIMITS.name})` };
      map[ck] = cv;
    }
    const lines = validateLines(p.lines, at, lists.repos[0]);
    if (lines.error) return { ok: false, error: lines.error };
    out.push({ id: p.id, name, match: lists, areas: { source, map }, lines: lines.lines });
  }
  return { ok: true, projects: out };
}

/** #523 - a project's `lines` (its lines of work and what puts a work item on each).
 *  `{lines}` normalised, or `{error}` naming the field. `repo`: the project's first repo,
 *  which a bare `#N` in `items` names. */
function validateLines(raw, at, repo) {
  if (raw === undefined || raw === null) return { lines: [] };
  if (!Array.isArray(raw) || raw.length > LIMITS.lines) return { error: `${at}.lines must be an array of at most ${LIMITS.lines}` };
  const out = [];
  for (const [i, l] of raw.entries()) {
    const la = `${at}.lines[${i}]`;
    if (!isObj(l)) return { error: `${la} must be an object` };
    if (typeof l.id !== 'string' || !ID_RE.test(l.id)) return { error: `${la}.id must be lowercase letters, digits, - or _ (at most 40)` };
    if (out.some((x) => x.id === l.id)) return { error: `${la}.id "${l.id}" is used twice` };
    const name = lineName(l.name);
    if (!name) return { error: `${la}.name is required (at most ${LIMITS.name} characters, one line)` };
    const m = l.match === undefined ? {} : l.match;
    if (!isObj(m)) return { error: `${la}.match must be an object` };
    const match = {};
    for (const k of LINE_MATCH) {
      const v = m[k] === undefined ? [] : m[k];
      if (!Array.isArray(v) || v.length > LIMITS.list) return { error: `${la}.match.${k} must be an array of at most ${LIMITS.list}` };
      match[k] = [];
      for (const [j, x] of v.entries()) {
        const c = cleanStr(x, LIMITS.name);
        if (!c) return { error: `${la}.match.${k}[${j}] is not valid (one line of at most ${LIMITS.name} characters)` };
        if (k === 'items') {
          const [owner, repoName] = repo ? repo.split('/') : [];
          const key = globalKey(c, repo ? { kind: 'github', owner, repo: repoName } : null);
          if (/^#\d+$/.test(key)) return { error: `${la}.match.items[${j}] "${c}" names no repo: this project has none, so write owner/repo#N` };
          if (!TRACKER_KEY_RE.test(key)) return { error: `${la}.match.items[${j}] "${c}" is not a work-item ref (#123, owner/repo#123 or ado:123)` };
          if (!match.items.includes(key)) match.items.push(key);
        } else match[k].push(c);
      }
    }
    out.push({ id: l.id, name, match });
  }
  return { lines: out };
}

/** Windows paths compare without case; so does any path with a drive letter, wherever the
 *  server runs (a peer on Windows reports to an authority on Linux). */
function caseless(p, platform) { return platform === 'win32' || /^[a-z]:/i.test(p); }
function normPath(p, platform) {
  if (typeof p !== 'string' || !p) return null;
  let s = p.replace(/\//g, '\\');
  if (s.length > 1 && !/^[a-z]:\\$/i.test(s)) s = s.replace(/\\+$/, '');
  return caseless(p, platform) ? s.toLowerCase() : s;
}
/** Is `child` the folder `prefix` or inside it? A boundary, never a string prefix:
 *  C:\dev\am8 does not hold C:\dev\am8_core. */
function pathUnder(child, prefix, platform) {
  const c = normPath(child, platform);
  const p = normPath(prefix, platform);
  if (!c || !p) return false;
  return c === p || c.startsWith(p.endsWith('\\') ? p : `${p}\\`);
}
/** The longest key of `keys` that holds `cwd`, or null. */
function longestPath(cwd, keys, platform) {
  let best = null;
  for (const k of keys) if (pathUnder(cwd, k, platform) && (!best || normPath(k, platform).length > normPath(best, platform).length)) best = k;
  return best;
}

/** Where a session's work items live when its own git origin is not known (a peer's cwd is
 *  on another machine): a GitHub item's key names its repo, an ADO item's link its project. */
function originFromItems(items) {
  for (const it of Array.isArray(items) ? items : []) {
    const k = it && typeof it.key === 'string' ? it.key : '';
    const m = /^([\w.-]+)\/([\w.-]+)#\d+$/.exec(k);
    if (m) return { kind: 'github', owner: m[1], repo: m[2] };
    const u = it && typeof it.url === 'string' ? /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\//i.exec(it.url) : null;
    if (u) {
      try { return { kind: 'ado', org: decodeURIComponent(u[1]), project: decodeURIComponent(u[2]) }; } catch { /* a malformed link names nothing */ }
    }
  }
  return null;
}

const eqi = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function projectOfOrigin(origin, projects) {
  if (!origin) return null;
  if (origin.kind === 'github') {
    const full = `${origin.owner}/${origin.repo}`;
    const p = projects.find((x) => x.match.repos.some((r) => eqi(r, full)));
    if (p) return p.id;
  }
  if (origin.kind === 'ado') {
    const p = projects.find((x) => x.match.adoProjects.some((r) => eqi(r, origin.project)));
    if (p) return p.id;
  }
  return null;
}

/** A session's project id, first answer wins: the project it was started for (#512 `bound`,
 *  lib/mc-binding.js) while that project is configured; its git origin against `repos` /
 *  `adoProjects`; its cwd against `paths` (the longest folder wins); the origin its items name
 *  (a peer's session, whose origin is not known here, in an unconfigured folder); else `other`.
 *  #524: a session's own folder beats an item it merely mentions - one cross-repo key must not
 *  pull a whole session (and its session-scoped subjects) into another project. */
function projectOfSession({ cwd, origin, items, bound } = {}, projects, { platform = process.platform } = {}) {
  if (typeof bound === 'string' && projects.some((p) => p.id === bound)) return bound;
  const byOrigin = projectOfOrigin(origin, projects);
  if (byOrigin) return byOrigin;
  let best = null;
  for (const p of projects) {
    const hit = longestPath(cwd, p.match.paths, platform);
    if (hit && (!best || normPath(hit, platform).length > best.len)) best = { id: p.id, len: normPath(hit, platform).length };
  }
  if (best) return best.id;
  // Only a session whose origin is not known here: a known repo no project claims is "other",
  // never whatever repo an item it mentions names.
  return (origin ? null : projectOfOrigin(originFromItems(items), projects)) || OTHER_ID;
}

/** A work item's project id: the repo its key names, else its ADO project (from the tracker
 *  details), else the project most of the sessions on it are in, else `other`. */
function projectOfSubject({ key, meta, sessionProjects } = {}, projects) {
  const m = typeof key === 'string' ? /^([\w.-]+)\/([\w.-]+)#\d+$/.exec(key) : null;
  const byRepo = m && projectOfOrigin({ kind: 'github', owner: m[1], repo: m[2] }, projects);
  if (byRepo) return byRepo;
  const byAdo = meta && meta.adoProject && projectOfOrigin({ kind: 'ado', project: meta.adoProject }, projects);
  if (byAdo) return byAdo;
  const tally = new Map();
  for (const id of Array.isArray(sessionProjects) ? sessionProjects : []) if (id && id !== OTHER_ID) tally.set(id, (tally.get(id) || 0) + 1);
  let best = null;
  for (const [id, n] of tally) if (!best || n > best.n) best = { id, n };
  return best ? best.id : OTHER_ID;
}

/** An ADO Area Path's area: the longest configured prefix (at a `\` boundary, no case), else
 *  the path's last segment; a bare project root is `General`. */
function adoArea(areaPath, map) {
  if (typeof areaPath !== 'string' || !areaPath.trim()) return null;
  const a = areaPath.trim();
  let best = null;
  for (const k of Object.keys(map)) {
    const kl = k.toLowerCase().replace(/\\+$/, '');
    const al = a.toLowerCase();
    if ((al === kl || al.startsWith(`${kl}\\`)) && (!best || k.length > best.length)) best = k;
  }
  if (best) return map[best];
  const segs = a.split('\\').filter(Boolean);
  return segs.length > 1 ? segs[segs.length - 1] : null;
}

/** A subject's (or a session's) area name within its project, per `areas.source`; `General`
 *  when the source has nothing to say. */
function areaOf(project, { meta, cwd } = {}, { platform = process.platform } = {}) {
  if (!project || !project.areas) return GENERAL;
  const { source, map } = project.areas;
  let name = null;
  if (source === 'ado-area') name = adoArea(meta && meta.area, map);
  else if (source === 'gh-label') {
    const keys = Object.keys(map);
    for (const l of (meta && Array.isArray(meta.labels) ? meta.labels : [])) {
      const k = keys.find((x) => eqi(x, l));
      if (k) { name = map[k]; break; }
    }
  } else if (source === 'path') {
    const k = longestPath(cwd, Object.keys(map), platform);
    if (k) name = map[k];
  }
  return name || GENERAL;
}

/** A stable id for an area name. */
function areaId(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'area';
}
const zeroCounts = () => ({ active: 0, needsYou: 0, waitsOnOthers: 0, doneWeek: 0, sessions: 0,
  stages: Object.fromEntries(STAGES.map((s) => [s, 0])) });
const COUNTED = ['active', 'needsYou', 'waitsOnOthers', 'doneWeek'];

/** Count one subject: its `buckets` (lib/mc-subjects.js bucketsOf - the one rule, so a
 *  screen's filter matches these numbers) and its current stage. */
function countSubject(counts, subject) {
  for (const b of Array.isArray(subject.buckets) ? subject.buckets : []) if (COUNTED.includes(b)) counts[b] += 1;
  const st = subject.stage && subject.stage.current;
  if (Object.prototype.hasOwnProperty.call(counts.stages, st)) counts.stages[st] += 1;
}

/** GET /api/mc/projects' `projects`. Every configured project (in config order), then
 *  `other` when anything landed there. A session counts toward an area only where the area
 *  is a folder rule; a subject (#504) counts toward its own project and area. */
function projectsView({ projects, sessions, subjects }, { platform = process.platform } = {}) {
  const views = new Map();
  const mk = (id, name, tracker, areaNames) => {
    const areas = [];
    const seen = new Set();
    for (const n of [...areaNames, GENERAL]) {
      if (seen.has(n)) continue;
      seen.add(n);
      let id2 = areaId(n);
      while (areas.some((a) => a.id === id2)) id2 = `${id2}-x`;
      areas.push({ id: id2, name: n, counts: zeroCounts() });
    }
    return { id, name, tracker, areas, counts: zeroCounts() };
  };
  for (const p of projects) {
    const tracker = p.match.repos.length ? { kind: 'github', repo: p.match.repos[0] }
      : p.match.adoProjects.length ? { kind: 'ado', project: p.match.adoProjects[0] } : null;
    views.set(p.id, mk(p.id, p.name, tracker, p.areas.source === 'none' ? [] : [...new Set(Object.values(p.areas.map))]));
  }
  const other = mk(OTHER_ID, 'Other', null, []);
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const id = projectOfSession(s, projects, { platform });
    const v = views.get(id) || other;
    v.counts.sessions += 1;
    const p = projects.find((x) => x.id === id);
    const src = p ? p.areas.source : 'none';
    if (src === 'path' || src === 'none') {
      const name = src === 'path' ? areaOf(p, { cwd: s.cwd }, { platform }) : GENERAL;
      const a = v.areas.find((x) => x.name === name);
      if (a) a.counts.sessions += 1;
    }
  }
  let otherSubjects = 0;
  for (const sub of Array.isArray(subjects) ? subjects : []) {
    const v = views.get(sub.project) || other;
    if (v === other) otherSubjects += 1;
    countSubject(v.counts, sub);
    const name = typeof sub.area === 'string' && sub.area ? sub.area : GENERAL;
    let a = v.areas.find((x) => x.name === name);
    if (!a) {
      // An area the map does not name (an ADO Area Path's last segment): listed before General.
      let id2 = areaId(name);
      while (v.areas.some((x) => x.id === id2)) id2 = `${id2}-x`;
      a = { id: id2, name, counts: zeroCounts() };
      v.areas.splice(v.areas.length - 1, 0, a);
    }
    countSubject(a.counts, sub);
  }
  const out = [...views.values()];
  if (other.counts.sessions > 0 || otherSubjects > 0) out.push(other);
  return out;
}

module.exports = {
  OTHER_ID, GENERAL, SOURCES,
  TRACKER_KEY_RE, validateProjects, zeroCounts, countSubject, projectOfSession, projectOfSubject, areaOf, adoArea, originFromItems,
  pathUnder, projectsView, areaId,
};
