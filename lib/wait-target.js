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
// Validation (phase 1), and resolution (#467, below the validators): a resolver answers
// `pending`, `resolved`, `gone` or `unknown`, and NEVER guesses - an unreachable server, a
// failed lookup or a missing credential is `unknown`, and `unknown` never acts.
//
// Every validation error is written for the AGENT to read
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

/// A bare `#123` names an issue in the reporting session's OWN repo, which only that
/// session's server knows. The report route qualifies it once, there, with [qualify]
/// (lib/session-brief.js globalKey against the repo's origin), so the supervisor on another
/// machine can look it up. Anything else is returned as it came.
function qualifyTarget(target, qualify) {
  if (!target || target.kind !== 'workitem' || !/^#\d+$/.test(target.ref) || typeof qualify !== 'function') return target;
  const key = qualify(target.ref);
  return typeof key === 'string' && WORKITEM_KEY_RE.test(key) ? { ...target, ref: key } : target;
}

// --- #467 Resolution -----------------------------------------------------------------------
// One answer per target: `{state, fact}`. `fact` is the plain sentence the wake prompt
// carries ("PR o/r#12 was merged"); it is short and names no person.

const STATES = Object.freeze(['pending', 'resolved', 'gone', 'unknown']);
const _short = (id) => (typeof id === 'string' ? id.slice(0, 8) : '?');
const _label = (n, id) => (n && n.name ? `"${String(n.name).slice(0, 60)}"` : _short(id));
const r = (state, fact = '') => ({ state, fact });

/// Resolve the targets the cluster graph can answer alone: session, lead, child and time.
/// Returns null for a kind that needs an outside lookup (pr, ci, workitem).
///   waiter   the waiting session's graph node (its `wait.at`, `leadId`, `parentId`)
///   find     (id) -> the live graph node for a session id (aliases through `replaces`
///            already followed), or null
///   absence  (id) -> 'suspect' | 'gone' | 'unknown' for an id no server lists: the
///            supervisor's two-scan rule (lib/supervisor.js), never a single scan
///   leadVerdict  the waiter's orphan verdict (lib/supervisor.js noteOrphans), or null
function resolveLocal(target, { waiter, find, absence, leadVerdict, now }) {
  if (!target) return null;
  const since = waiter && waiter.wait && Number.isFinite(waiter.wait.at) ? waiter.wait.at : null;
  const ofSession = (id, n) => {
    if (n) {
      const w = n.wait;
      if (w && w.on === 'done') return r('resolved', `session ${_label(n, id)} reported done`);
      if (w && since !== null && Number.isFinite(w.at) && w.at > since) {
        return r('resolved', `session ${_label(n, id)} reported a new wait (${w.on}${w.what ? `: ${String(w.what).slice(0, 60)}` : ''})`);
      }
      return r('pending');
    }
    const a = absence(id);
    if (a === 'gone') return r('gone', `session ${_short(id)} is gone from every machine`);
    return a === 'suspect' ? r('pending') : r('unknown');
  };
  switch (target.kind) {
    case 'time':
      return Number.isFinite(now) && now >= Date.parse(target.until) ? r('resolved', `the time ${target.until} has passed`) : r('pending');
    case 'session':
      return ofSession(target.id, find(target.id));
    case 'lead': {
      const leadId = waiter && (waiter.leadId || waiter.parentId);
      if (!leadId) return r('unknown');
      const n = find(leadId);
      if (n) return ofSession(leadId, n);
      // The lead's absence is the orphan rule's call - one rule, never a second count.
      const v = leadVerdict && leadVerdict.state;
      if (v === 'orphan') return r('gone', `your lead session ${_short(leadId)} is gone from every machine`);
      return v === 'suspect' ? r('pending') : r('unknown');
    }
    case 'child': {
      let done = 0, gone = 0, unknown = 0, pending = 0;
      for (const id of target.ids) {
        const n = find(id);
        const s = ofSession(id, n);
        if (s.state === 'resolved' && n && n.wait && n.wait.on === 'done') done++;
        else if (s.state === 'gone') gone++;
        else if (s.state === 'unknown') unknown++;
        else pending++; // a child that reported a NEW wait is still working on its part
      }
      if (pending) return r('pending');
      if (unknown) return r('unknown');
      return r('resolved', `every child is finished (${done} reported done, ${gone} gone)`);
    }
    default:
      return null;
  }
}

/// The key two waits on the same outside target share, so one lookup answers both.
function lookupKey(t) {
  if (!t) return null;
  if (t.kind === 'pr') return `pr|${t.provider}|${t.repo.toLowerCase()}|${t.number}`;
  if (t.kind === 'ci') return `ci|${t.provider}|${t.repo.toLowerCase()}|${t.pr ? `pr${t.pr}` : `run${t.runId}`}`;
  if (t.kind === 'workitem') return `wi|${t.ref.toLowerCase()}`;
  return null;
}

/// Why a `gh` call failed, from its stderr: 'gone' only when GitHub said the PR or issue
/// does not exist IN A REPO IT COULD READ. A repository it cannot resolve may be one the
/// login cannot see: that, and every other failure, is 'unknown'.
function ghFailure(stderr) {
  const s = String(stderr || '');
  if (/Could not resolve to a Repository/i.test(s)) return 'unknown';
  if (/Could not resolve to an? (PullRequest|Issue)/i.test(s)) return 'gone';
  return 'unknown';
}

/// The outside answer -> a resolution. [kind] names the lookup made:
///   gh-pr     `gh pr view --json state,reviews`
///   gh-checks `gh pr view --json statusCheckRollup`
///   gh-run    `gh run view --json status,conclusion`
///   gh-issue  `gh issue view --json state`
///   ado-pr    GET .../_apis/git/pullrequests/{id}
///   ado-build GET .../_apis/build/builds/{id}
///   ado-builds GET .../_apis/build/builds?branchName=refs/pull/{pr}/merge (value[])
///   ado-wi    GET .../_apis/wit/workitems/{id}
/// [baseline] is the `sig` this wait's first lookup returned ("its state CHANGED" needs a
/// before); [since] is when the wait was reported. Returns `{state, fact, sig}`.
function fromLookup(kind, json, { target, baseline = null, since = null } = {}) {
  const j = _isObj(json) ? json : {};
  const name = target ? (target.kind === 'workitem' ? target.ref : `${target.repo}#${target.number || target.pr || target.runId}`) : '';
  const changed = (sig, fact) => (baseline !== null && sig !== baseline ? { state: 'resolved', fact, sig } : { state: 'pending', fact: '', sig });
  switch (kind) {
    case 'gh-pr': {
      const st = String(j.state || '').toUpperCase();
      if (st === 'MERGED') return { state: 'resolved', fact: `PR ${name} was merged`, sig: st };
      if (st === 'CLOSED') return { state: 'resolved', fact: `PR ${name} was closed without merging`, sig: st };
      if (st !== 'OPEN') return { state: 'unknown', fact: '', sig: null };
      const fresh = (Array.isArray(j.reviews) ? j.reviews : []).filter((x) => _isObj(x) && since !== null && Date.parse(x.submittedAt) > since);
      if (fresh.length) {
        const last = fresh[fresh.length - 1];
        return { state: 'resolved', fact: `PR ${name} got a new review (${String(last.state || 'COMMENTED').toLowerCase()})`, sig: st };
      }
      return { state: 'pending', fact: '', sig: st };
    }
    case 'gh-checks': {
      const runs = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup.filter(_isObj) : null;
      if (!runs) return { state: 'unknown', fact: '', sig: null };
      if (!runs.length) return { state: 'pending', fact: '', sig: 'none' };
      // A CheckRun has `status`; a commit StatusContext has only `state`.
      const isStatus = (x) => x.__typename === 'StatusContext' || (x.status === undefined && x.state !== undefined);
      const doneOf = (x) => (isStatus(x)
        ? !['PENDING', 'EXPECTED'].includes(String(x.state).toUpperCase())
        : String(x.status).toUpperCase() === 'COMPLETED');
      if (!runs.every(doneOf)) return { state: 'pending', fact: '', sig: 'running' };
      const bad = runs.filter((x) => {
        const v = String(x.conclusion || x.state || '').toUpperCase();
        return ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v);
      }).length;
      return { state: 'resolved', fact: `CI on PR ${name} finished: ${runs.length - bad} passed, ${bad} failed`, sig: 'done' };
    }
    case 'gh-run': {
      const st = String(j.status || '').toLowerCase();
      if (!st) return { state: 'unknown', fact: '', sig: null };
      if (st === 'completed') return { state: 'resolved', fact: `run ${name} finished: ${String(j.conclusion || 'unknown').toLowerCase()}`, sig: st };
      return { state: 'pending', fact: '', sig: st };
    }
    case 'gh-issue': {
      const st = String(j.state || '').toUpperCase();
      if (!st) return { state: 'unknown', fact: '', sig: null };
      return changed(st, `${name} is now ${st.toLowerCase()}`);
    }
    case 'ado-pr': {
      const st = String(j.status || '').toLowerCase();
      if (!st) return { state: 'unknown', fact: '', sig: null };
      if (st === 'completed') return { state: 'resolved', fact: `PR ${name} was completed`, sig: st };
      if (st === 'abandoned') return { state: 'resolved', fact: `PR ${name} was abandoned`, sig: st };
      const votes = (Array.isArray(j.reviewers) ? j.reviewers : []).filter(_isObj).map((x) => `${x.id}:${x.vote}`).sort().join(',');
      return changed(`${st}|${votes}`, `PR ${name} got a new vote`);
    }
    case 'ado-build': {
      const st = String(j.status || '').toLowerCase();
      if (!st) return { state: 'unknown', fact: '', sig: null };
      if (st === 'completed') return { state: 'resolved', fact: `run ${name} finished: ${String(j.result || 'unknown').toLowerCase()}`, sig: st };
      return { state: 'pending', fact: '', sig: st };
    }
    case 'ado-builds': {
      const list = Array.isArray(j.value) ? j.value.filter(_isObj) : null;
      if (!list) return { state: 'unknown', fact: '', sig: null };
      // The runs queued since the wait began; none yet means CI has not started.
      const fresh = list.filter((b) => since === null || Date.parse(b.queueTime) >= since - 5 * 60 * 1000);
      if (!fresh.length) return { state: 'pending', fact: '', sig: 'none' };
      if (!fresh.every((b) => String(b.status).toLowerCase() === 'completed')) return { state: 'pending', fact: '', sig: 'running' };
      const bad = fresh.filter((b) => !['succeeded', 'partiallysucceeded'].includes(String(b.result).toLowerCase())).length;
      return { state: 'resolved', fact: `CI on PR ${name} finished: ${fresh.length - bad} passed, ${bad} failed`, sig: 'done' };
    }
    case 'ado-wi': {
      const st = j.fields && typeof j.fields['System.State'] === 'string' ? j.fields['System.State'] : '';
      if (!st) return { state: 'unknown', fact: '', sig: null };
      return changed(st, `${name} is now ${st}`);
    }
    default:
      return { state: 'unknown', fact: '', sig: null };
  }
}

module.exports = {
  TARGET_KINDS, PROVIDERS, CHECK_BY_MAX_MIN, CHILD_IDS_MAX, STATES,
  validateTarget, validateCheckBy, targetRefusal, dueAt, qualifyTarget,
  resolveLocal, lookupKey, ghFailure, fromLookup,
};
