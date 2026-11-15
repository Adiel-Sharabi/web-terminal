'use strict';
// --- #466 A wait that NAMES what it waits on (docs/SUPERVISOR-DESIGN.md §4) ------------
//
// A reported wait (`wait = {on, what}`, lib/session-brief.js) is free text: the server can
// see THAT a session waits, never on WHAT, so it can never tell the wait is over. A wait
// may now carry a `target` the supervisor can look up, and a `checkBy` (minutes) after
// which it is overdue even while the target still says "pending".
//
//   kind      fields                                   names
//   session   id                                       a session on any machine
//   lead      (none)                                   this session's own spawn.parentId
//   pr        provider, repo, number                   a pull request
//   ci        provider, repo, and pr or runId          a pipeline run
//   workitem  ref (#123, owner/repo#123, ado:12345)    a tracker item
//   time      until (ISO 8601)                         a moment
//   child     ids (1..10 session ids)                  child sessions
//
// Validation only (phase 1 resolves nothing). Every error is written for the AGENT to read
// and fix: scripts/wt-report.js prints it. A malformed target is REFUSED, never dropped or
// guessed at - a target silently lost is a wait nobody can resolve.
//
// Pure: no I/O, no clock. [refKey] (lib/session-brief.js, the owner of what a tracker ref
// means) is passed in by the caller, which keeps this module a leaf.

const TARGET_KINDS = Object.freeze(['session', 'lead', 'pr', 'ci', 'workitem', 'time', 'child']);
const PROVIDERS = Object.freeze(['github', 'ado']);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// github: owner/repo. ado: repo, or project/repo. Characters both hosts allow in a name.
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100})?$/;
const RUN_ID_RE = /^\d{1,20}$/;
// The shapes refKey() normalises a tracker ref to; anything else is not a work item.
const WORKITEM_KEY_RE = /^(?:#\d+|ado:\d+|[\w.-]+\/[\w.-]+#\d+)$/;
const CHILD_IDS_MAX = 10;
/** The longest `checkBy`: a week. A wait expected to last longer has no useful deadline. */
const CHECK_BY_MAX_MIN = 7 * 24 * 60;

const _shape = (k) => {
  switch (k) {
    case 'session': return '{"kind":"session","id":"<session id>"}';
    case 'pr': return '{"kind":"pr","provider":"github","repo":"owner/repo","number":12}';
    case 'ci': return '{"kind":"ci","provider":"github","repo":"owner/repo","pr":12} (or "runId" instead of "pr")';
    case 'workitem': return '{"kind":"workitem","ref":"#123"} (or owner/repo#123, ado:12345)';
    case 'time': return '{"kind":"time","until":"2026-11-15T18:00:00Z"}';
    case 'child': return '{"kind":"child","ids":["<session id>"]}';
    default: return '{"kind":"lead"}';
  }
};
const _err = (kind, why) => ({ error: `wait.target (${kind}): ${why}; the shape is ${_shape(kind)}` });
const _posInt = (v) => Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER;
const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/// Validate `wait.target`. undefined/null -> `{target: null}` (a wait with no target behaves
/// exactly as before). Returns `{target}` (normalised: only the kind's own fields) or `{error}`.
/// @param {{refKey: (ref:string)=>string}} deps
function validateTarget(raw, { refKey } = {}) {
  if (raw === undefined || raw === null) return { target: null };
  if (!_isObj(raw)) return { error: `wait.target must be an object like ${_shape('pr')}` };
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!TARGET_KINDS.includes(kind)) {
    return { error: `wait.target.kind "${String(raw.kind).slice(0, 40)}" is not one of: ${TARGET_KINDS.join(', ')}` };
  }
  switch (kind) {
    case 'lead':
      return { target: { kind } };
    case 'session': {
      if (typeof raw.id !== 'string' || !SESSION_ID_RE.test(raw.id)) return _err(kind, '"id" must be a session id');
      return { target: { kind, id: raw.id.toLowerCase() } };
    }
    case 'pr':
    case 'ci': {
      const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
      if (!PROVIDERS.includes(provider)) return _err(kind, `"provider" must be one of: ${PROVIDERS.join(', ')}`);
      if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo.trim())) return _err(kind, '"repo" must name the repository');
      const repo = raw.repo.trim();
      if (kind === 'pr') {
        if (!_posInt(raw.number)) return _err(kind, '"number" must be a positive whole number');
        return { target: { kind, provider, repo, number: raw.number } };
      }
      const hasPr = raw.pr !== undefined && raw.pr !== null;
      const hasRun = raw.runId !== undefined && raw.runId !== null;
      if (hasPr === hasRun) return _err(kind, 'give exactly one of "pr" or "runId"');
      if (hasPr) {
        if (!_posInt(raw.pr)) return _err(kind, '"pr" must be a positive whole number');
        return { target: { kind, provider, repo, pr: raw.pr } };
      }
      // A run id can pass 2^53 on GitHub: kept as a string of digits, never a lossy number.
      const runId = typeof raw.runId === 'number' && _posInt(raw.runId) ? String(raw.runId) : raw.runId;
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return _err(kind, '"runId" must be the run\'s number');
      return { target: { kind, provider, repo, runId } };
    }
    case 'workitem': {
      const key = typeof raw.ref === 'string' && typeof refKey === 'function' ? refKey(raw.ref) : '';
      if (!WORKITEM_KEY_RE.test(key)) return _err(kind, '"ref" must be a work item');
      return { target: { kind, ref: key } };
    }
    case 'time': {
      // An ISO date with a time, so "when" never depends on the reader's time zone guess.
      const ok = typeof raw.until === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw.until)
        && Number.isFinite(Date.parse(raw.until));
      if (!ok) return _err(kind, '"until" must be an ISO date and time');
      return { target: { kind, until: new Date(Date.parse(raw.until)).toISOString() } };
    }
    case 'child': {
      const ids = raw.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > CHILD_IDS_MAX) {
        return _err(kind, `"ids" must list 1 to ${CHILD_IDS_MAX} session ids`);
      }
      if (!ids.every((x) => typeof x === 'string' && SESSION_ID_RE.test(x))) return _err(kind, 'every "ids" entry must be a session id');
      return { target: { kind, ids: [...new Set(ids.map((x) => x.toLowerCase()))] } };
    }
    default: return { error: 'wait.target: unknown kind' };
  }
}

/// Validate `wait.checkBy`: whole minutes from the report, 1..CHECK_BY_MAX_MIN, or absent.
function validateCheckBy(raw) {
  if (raw === undefined || raw === null) return { checkBy: null };
  if (!Number.isInteger(raw) || raw < 1 || raw > CHECK_BY_MAX_MIN) {
    return { error: `wait.checkBy must be whole minutes from now, 1 to ${CHECK_BY_MAX_MIN}` };
  }
  return { checkBy: raw };
}

/// The checks only the ROUTE can make, against the reporting session itself: a `lead`
/// target needs a lead, and no session waits on itself. [selfId] is the reporter's id,
/// [parentId] its spawn.parentId (null when it has none). Returns an error string or null.
function targetRefusal(target, { selfId, parentId } = {}) {
  if (!target) return null;
  if (target.kind === 'lead' && !parentId) {
    return 'wait.target (lead): this session has no lead (it was not opened with a parentId); name the session with {"kind":"session","id":"..."}';
  }
  const self = typeof selfId === 'string' ? selfId.toLowerCase() : null;
  if (self && ((target.kind === 'session' && target.id === self) || (target.kind === 'child' && target.ids.includes(self)))) {
    return 'wait.target: a session cannot wait on itself';
  }
  return null;
}

/// When a wait is overdue (epoch ms), or null when it has no `checkBy`. [wait] is a stored
/// wait (`at` is when it was reported).
function dueAt(wait) {
  if (!wait || !Number.isInteger(wait.checkBy) || !Number.isFinite(wait.at)) return null;
  return wait.at + wait.checkBy * 60 * 1000;
}

module.exports = {
  TARGET_KINDS, PROVIDERS, CHECK_BY_MAX_MIN, CHILD_IDS_MAX,
  validateTarget, validateCheckBy, targetRefusal, dueAt,
};
