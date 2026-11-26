'use strict';
// --- Work or private? (#529) ------------------------------------------------------------
//
// Whether a project is WORK is decided when a report is READ, never baked into a record, so a
// correction applies to the whole history at once.
//   1. an explicit `classify` record (`{project, as: 'work'|'private'|'auto'}`) wins; the newest
//      one per project is the one that counts, and 'auto' withdraws it;
//   2. otherwise a project is WORK when it is in the inventory (the git repos found under the
//      project roots) of the work-source machine (config `usageLedger.workSource`: a machine's origin
//      name; unset = no machine is the source, so nothing is work until it is classified), else PRIVATE.
// `classify` records are written by POST /api/usage/classify on any machine, into its own ledger
// file, so a change made anywhere replicates everywhere.

const { originOf } = require('./usage-store');

const AS = Object.freeze(['work', 'private', 'auto']);
const NO_PROJECT = '(none)';

/** @param {{records: object[], workSource?: string|null}} o  records = the store's folded records */
function createScoper({ records, workSource = null }) {
  const want = workSource ? originOf(workSource).toLowerCase() : null; // an origin is a cleaned-up machine name
  const workProjects = new Set();
  for (const r of records) {
    if (want && r.type === 'inventory' && String(r.origin).toLowerCase() === want && Array.isArray(r.projects)) for (const p of r.projects) workProjects.add(String(p).toLowerCase());
  }
  const override = new Map();
  for (const r of records) if (r.type === 'classify' && typeof r.project === 'string' && AS.includes(r.as)) override.set(r.project.toLowerCase(), r.as);
  return {
    workSource,
    /** 'work' | 'private' for [project]. */
    scopeOf(project) {
      const p = String(project || NO_PROJECT).toLowerCase();
      const o = override.get(p);
      if (o === 'work' || o === 'private') return o;
      return workProjects.has(p) ? 'work' : 'private';
    },
    hasInventory: workProjects.size > 0,
  };
}

/** The draft of a `classify` record, or `{error}`. */
function classifyDraft(project, as) {
  if (typeof project !== 'string' || !project.trim() || project.length > 100) return { error: 'project is required (up to 100 characters)' };
  if (!AS.includes(as)) return { error: `as must be one of ${AS.join(', ')}` };
  const p = project.trim().toLowerCase();
  return { type: 'classify', key: `classify|${p}`, project: p, as };
}

module.exports = { AS, NO_PROJECT, createScoper, classifyDraft };
