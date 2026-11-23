'use strict';
// #502 - Mission Control: a work item's details, read from its tracker and cached.
//
// The ONE owner of "what the tracker says about a ref": the parsers for GitHub's issue and
// timeline answers and Azure DevOps' work-item and pull-request answers, the cache (fresh for
// 10 minutes, then served stale while one refresh runs), and the shape every caller gets
// (docs/mission-control.md "Work-item meta"). No I/O of its own: the server injects the
// fetcher, the tokens and the store, so a spec drives every rule from synthetic fixtures.
//
// FAIL VISIBLY. An unreachable tracker or a rejected token answers the last good copy with
// `error` and `staleSince` set; with no copy at all, `title: null` and `error` set. Never a
// blank, never a guess: a field the tracker did not give is null.
const fs = require('fs');
const path = require('path');
const { globalKey } = require('./session-brief');
const { parseRefParam } = require('./work-items');

const FRESH_MS = 10 * 60 * 1000; // a copy younger than this is served without asking again
const RETRY_MS = 60 * 1000; // after a failed read, how long before the tracker is asked again
const MAX_BATCH = 50; // refs in one batch request
const BATCH_CONCURRENCY = 6; // reads in flight at once for one batch (GitHub's anonymous budget is 60/h)
const MAX_PRS = 10; // linked pull requests resolved per item
const MAX_ENTRIES = 2000; // cache entries kept on disk; the least recently read go first
const CLOSED_STATES = new Set(['closed', 'done', 'removed', 'resolved']);
const REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;

/** A request's ref, as the cache knows it. `repo` ("owner/repo") qualifies a bare `#N`.
 *  Null when it is not a work-item ref at all. A bare `#N` with no repo is returned with
 *  `unqualified: true`: no tracker can be asked about it. */
function parseRef(raw, { repo } = {}) {
  const k = parseRefParam(raw);
  if (!k) return null;
  let origin = null;
  if (repo !== undefined && repo !== null && repo !== '') {
    const m = typeof repo === 'string' ? REPO_RE.exec(repo.trim()) : null;
    if (!m) return null;
    origin = { kind: 'github', owner: m[1], repo: m[2] };
  }
  const key = globalKey(raw, origin);
  let m;
  if ((m = /^ado:(\d+)$/.exec(key))) return { key, ref: raw.trim(), tracker: 'ado', id: Number(m[1]) };
  if ((m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key))) {
    if (/^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null; // a dot segment would walk the API path
    return { key, ref: raw.trim(), tracker: 'github', owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  if ((m = /^#(\d+)$/.exec(key))) return { key, ref: raw.trim(), tracker: 'github', owner: null, repo: null, number: Number(m[1]), unqualified: true };
  return null;
}

/** Every field null: what a caller gets for a ref no tracker has answered for yet. */
function blankMeta(r, { adoOrg } = {}) {
  let url = null;
  if (r.tracker === 'github' && r.owner) url = `https://github.com/${r.owner}/${r.repo}/issues/${r.number}`;
  if (r.tracker === 'ado' && adoOrg) url = `https://dev.azure.com/${encodeURIComponent(adoOrg)}/_workitems/edit/${r.id}`;
  return {
    key: r.key, ref: r.ref, tracker: r.tracker, url,
    title: null, type: null, state: null, closed: null, severity: null, severityText: null, priority: null,
    createdBy: null, createdAt: null, assignee: null, area: null, labels: [], prs: [],
    repo: r.tracker === 'github' && r.owner ? `${r.owner}/${r.repo}` : null, adoProject: null,
    fetchedAt: null, staleSince: null, error: null, warning: null,
  };
}

const str = (v, max = 400) => (typeof v === 'string' && v ? v.slice(0, max) : null);
/** A link a client will open: https only and whole (never cut short), else null. */
const httpsLink = (v) => (typeof v === 'string' && v.length <= 500 && /^https:\/\/\S+$/i.test(v) ? v : null);
const ms = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// ---- GitHub ----------------------------------------------------------------------------

const SEV_WORDS = { critical: 1, blocker: 1, high: 2, major: 2, medium: 3, moderate: 3, normal: 3, low: 4, minor: 4, trivial: 4 };
/** Severity from labels like `severity:2`, `sev1`, `severity/high`: 1 is the highest. */
function ghSeverity(labels) {
  for (const l of labels) {
    const m = /^(?:severity|sev)\s*[:/ _-]?\s*([a-z0-9]+)$/i.exec(l);
    if (!m) continue;
    if (/^\d$/.test(m[1])) return { severity: Number(m[1]), severityText: l };
    const w = SEV_WORDS[m[1].toLowerCase()];
    if (w) return { severity: w, severityText: l };
  }
  return { severity: null, severityText: null };
}
/** Priority from labels like `P1`, `priority:2`, `priority/P0`: the lower, the more urgent. */
function ghPriority(labels) {
  for (const l of labels) {
    const m = /^(?:p|priority\s*[:/ _-]?\s*p?)(\d)$/i.exec(l.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/** The pull requests GitHub's issue timeline cross-references, newest state each. */
function githubPrsFromTimeline(timeline) {
  const out = new Map();
  for (const ev of Array.isArray(timeline) ? timeline : []) {
    if (!ev || ev.event !== 'cross-referenced') continue;
    const iss = ev.source && ev.source.issue;
    if (!iss || !iss.pull_request || !Number.isInteger(iss.number)) continue;
    const repo = (iss.repository && str(iss.repository.full_name, 200)) || null;
    const merged = Boolean(iss.pull_request.merged_at);
    const state = merged ? 'merged' : iss.state === 'open' ? 'open' : iss.state === 'closed' ? 'closed' : null;
    out.set(`${repo}#${iss.number}`, {
      url: httpsLink(iss.html_url), number: iss.number, repo, state, draft: iss.draft === true,
    });
  }
  return [...out.values()].slice(0, MAX_PRS);
}

/** GitHub's `GET /repos/{o}/{r}/issues/{n}` (and its timeline) -> the Meta fields. */
function parseGithubIssue(issue, timeline) {
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name)).filter((l) => typeof l === 'string' && l).map((l) => l.slice(0, 100));
  const isPr = Boolean(issue.pull_request);
  const merged = isPr && Boolean(issue.pull_request.merged_at);
  const type = (issue.type && str(issue.type.name, 60)) || (isPr ? 'Pull request' : 'Issue');
  return {
    url: httpsLink(issue.html_url), title: str(issue.title, 500), type,
    state: merged ? 'merged' : str(issue.state, 40), closed: issue.state === 'closed',
    ...ghSeverity(labels), priority: ghPriority(labels),
    createdBy: (issue.user && str(issue.user.login, 100)) || null, createdAt: ms(issue.created_at),
    assignee: (issue.assignee && str(issue.assignee.login, 100))
      || (Array.isArray(issue.assignees) && issue.assignees[0] && str(issue.assignees[0].login, 100)) || null,
    area: null, labels, prs: githubPrsFromTimeline(timeline),
  };
}

// ---- Azure DevOps ----------------------------------------------------------------------

/** "2 - High" -> 2; 1 -> 1; anything else -> null. */
function leadingNumber(v) {
  if (Number.isFinite(v)) return v;
  const m = typeof v === 'string' ? /^\s*(\d+)/.exec(v) : null;
  return m ? Number(m[1]) : null;
}
const identity = (v) => (v && typeof v === 'object' ? str(v.displayName, 100) || str(v.uniqueName, 100) : str(v, 100));

/** The pull requests an ADO work item links (`ArtifactLink` relations to
 *  `vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}`). */
function adoPrLinks(relations) {
  const out = [];
  for (const rel of Array.isArray(relations) ? relations : []) {
    if (!rel || rel.rel !== 'ArtifactLink' || typeof rel.url !== 'string') continue;
    const m = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(rel.url);
    if (!m) continue;
    const parts = decodeURIComponent(m[1]).split('/');
    if (parts.length !== 3 || !/^\d+$/.test(parts[2]) || !parts[0] || !parts[1]) continue;
    if (!out.some((p) => p.prId === Number(parts[2]) && p.repoId === parts[1])) out.push({ projectId: parts[0], repoId: parts[1], prId: Number(parts[2]) });
  }
  return out.slice(0, MAX_PRS);
}

const ADO_PR_STATES = { active: 'open', completed: 'merged', abandoned: 'closed' };
/** ADO's `GET .../pullrequests/{id}` -> one entry of Meta.prs. */
function parseAdoPr(pr, link) {
  const repo = pr && pr.repository;
  const web = repo && httpsLink(repo.webUrl);
  return {
    url: web ? `${web}/pullrequest/${pr.pullRequestId}` : null,
    number: Number.isInteger(pr && pr.pullRequestId) ? pr.pullRequestId : link.prId,
    repo: (repo && str(repo.name, 200)) || null,
    state: ADO_PR_STATES[String(pr && pr.status).toLowerCase()] || null,
    draft: Boolean(pr && pr.isDraft),
  };
}

/** ADO's `GET _apis/wit/workitems/{id}?$expand=relations` -> the Meta fields. */
function parseAdoWorkItem(wi, prs) {
  const f = (wi && wi.fields) || {};
  const state = str(f['System.State'], 60);
  const sevText = str(f['Microsoft.VSTS.Common.Severity'], 60);
  const html = wi && wi._links && wi._links.html && httpsLink(wi._links.html.href);
  return {
    url: html || null, title: str(f['System.Title'], 500), type: str(f['System.WorkItemType'], 60),
    state, closed: state ? CLOSED_STATES.has(state.toLowerCase()) : null,
    severity: leadingNumber(sevText), severityText: sevText, priority: leadingNumber(f['Microsoft.VSTS.Common.Priority']),
    createdBy: identity(f['System.CreatedBy']), createdAt: ms(f['System.CreatedDate']),
    assignee: identity(f['System.AssignedTo']), area: str(f['System.AreaPath'], 300),
    labels: typeof f['System.Tags'] === 'string' ? f['System.Tags'].split(';').map((t) => t.trim()).filter(Boolean).slice(0, 50) : [],
    prs: prs || [], adoProject: str(f['System.TeamProject'], 200),
  };
}

// ---- Reading a tracker (the fetcher is injected) ---------------------------------------

class TrackerError extends Error {}
function httpError(who, r) {
  if (r.status === 401 || r.status === 203 || (r.status >= 300 && r.status < 400)) return new TrackerError(`${who} rejected the token (HTTP ${r.status})`);
  if (r.status === 404) return new TrackerError(`not found in ${who} (HTTP 404)`);
  const remaining = r.headers && typeof r.headers.get === 'function' ? r.headers.get('x-ratelimit-remaining') : null;
  if ((r.status === 403 || r.status === 429) && remaining === '0') return new TrackerError(`${who} rate limit reached (HTTP ${r.status})`);
  if (r.status === 0) return new TrackerError(`${who} unreachable${r.reason ? `: ${String(r.reason).slice(0, 120)}` : ''}`);
  return new TrackerError(`${who} answered HTTP ${r.status}`);
}

/** Read one GitHub issue (or PR) and its linked PRs. A rejected token is retried without
 *  it - a public repo still answers - and the answer says so in `warning`. */
async function readGithub(r, { fetchJson, apiBase, token }) {
  const url = `${apiBase}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/issues/${r.number}`;
  const base = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  let headers = token ? { ...base, Authorization: `Bearer ${token}` } : base;
  let warning = null;
  let res = await fetchJson(url, headers);
  if (res.status === 401 && token) {
    headers = base;
    warning = 'the GitHub token was rejected (HTTP 401); read anonymously';
    res = await fetchJson(url, headers);
  }
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') throw httpError('GitHub', res);
  const tl = await fetchJson(`${url}/timeline?per_page=100`, headers);
  if (tl.status !== 200) warning = [warning, `linked pull requests could not be read (HTTP ${tl.status})`].filter(Boolean).join('; ');
  return { ...parseGithubIssue(res.json, tl.status === 200 ? tl.json : []), repo: `${r.owner}/${r.repo}`, warning };
}

/** Read one ADO work item and the state of each pull request it links. */
async function readAdo(r, { fetchJson, adoBase, org, pat }) {
  if (!org) throw new TrackerError('no Azure DevOps organization configured (config mc.ado.org or supervisor.ado.org)');
  if (!pat) throw new TrackerError('no Azure DevOps token (ADO_PAT is not set)');
  const headers = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json' };
  const o = encodeURIComponent(org);
  const res = await fetchJson(`${adoBase}/${o}/_apis/wit/workitems/${r.id}?$expand=relations&api-version=7.1`, headers);
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') throw httpError('Azure DevOps', res);
  const links = adoPrLinks(res.json.relations);
  let failed = 0;
  const prs = await Promise.all(links.map(async (l) => {
    const p = await fetchJson(`${adoBase}/${o}/${encodeURIComponent(l.projectId)}/_apis/git/repositories/${encodeURIComponent(l.repoId)}/pullrequests/${l.prId}?api-version=7.1`, headers);
    if (p.status === 200 && p.json && typeof p.json === 'object') return parseAdoPr(p.json, l);
    failed += 1;
    return { url: null, number: l.prId, repo: null, state: null, draft: false };
  }));
  const meta = parseAdoWorkItem(res.json, prs);
  if (!meta.url) meta.url = `https://dev.azure.com/${o}/_workitems/edit/${r.id}`;
  return { ...meta, warning: failed ? `${failed} linked pull request(s) could not be read` : null };
}

// ---- The cache -------------------------------------------------------------------------

/** The persisted cache: key -> { meta, fetchedAt, error, errorAt, readAt }. Atomic writes
 *  (tmp + rename); an unreadable file is moved aside, never overwritten blind. */
function createMetaStore({ file, log = console.error, maxEntries = MAX_ENTRIES, saveDelayMs = 1000 }) {
  let items = null;
  let timer = null;
  function load() {
    if (items) return items;
    items = {};
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: nothing cached yet */ }
    if (raw === null) return items;
    try {
      const j = JSON.parse(raw);
      const src = j && typeof j.items === 'object' && j.items ? j.items : {};
      for (const [k, e] of Object.entries(src)) {
        if (!e || typeof e !== 'object') continue;
        const meta = e.meta && typeof e.meta === 'object' ? e.meta : null;
        items[k] = {
          meta, fetchedAt: Number.isFinite(e.fetchedAt) ? e.fetchedAt : null,
          error: typeof e.error === 'string' ? e.error : null, errorAt: Number.isFinite(e.errorAt) ? e.errorAt : null,
          readAt: Number.isFinite(e.readAt) ? e.readAt : 0,
        };
        if (meta && items[k].fetchedAt === null) items[k].meta = null;
      }
    } catch (e) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* best effort */ }
      log(`tracker cache unreadable (${e.message}); moved to ${path.basename(aside)}`);
      items = {};
    }
    return items;
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!items) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items }));
      fs.renameSync(tmp, file);
    } catch (e) { log(`tracker cache write failed: ${e.message}`); }
  }
  function saveSoon() {
    if (timer) return;
    timer = setTimeout(flush, saveDelayMs);
    if (timer.unref) timer.unref();
  }
  function prune() {
    const keys = Object.keys(items);
    if (keys.length <= maxEntries) return;
    keys.sort((a, b) => (items[a].readAt || 0) - (items[b].readAt || 0));
    for (const k of keys.slice(0, keys.length - maxEntries)) delete items[k];
  }
  return {
    get: (key) => load()[key] || null,
    set(key, entry) { load()[key] = entry; prune(); saveSoon(); },
    flush,
  };
}

/** The cache over a reader. `read(ref)` resolves to Meta fields or throws (a TrackerError's
 *  message is shown as is; anything else is logged and shown as a generic failure). */
function createTrackerMeta({ store, read, now = Date.now, freshMs = FRESH_MS, retryMs = RETRY_MS, adoOrg = () => null, log = console.error }) {
  const inflight = new Map();

  function view(r, e) {
    const out = blankMeta(r, { adoOrg: adoOrg() });
    if (e && e.meta) Object.assign(out, e.meta);
    out.key = r.key; out.ref = r.ref; out.tracker = r.tracker;
    out.fetchedAt = (e && e.meta && e.fetchedAt) || null;
    out.staleSince = out.fetchedAt !== null && now() - out.fetchedAt >= freshMs ? out.fetchedAt + freshMs : null;
    out.error = (e && e.error) || null;
    if (!out.fetchedAt) out.warning = null;
    return out;
  }

  function refresh(r) {
    if (inflight.has(r.key)) return inflight.get(r.key);
    const p = (async () => {
      const prev = store.get(r.key);
      try {
        const fields = await read(r);
        const { fetchedAt: _f, staleSince: _s, error: _e, key: _k, ref: _r, tracker: _t, ...meta } = fields || {};
        store.set(r.key, { meta, fetchedAt: now(), error: null, errorAt: null, readAt: (prev && prev.readAt) || now() });
      } catch (e) {
        const msg = e instanceof TrackerError ? e.message : 'the tracker could not be read';
        if (!(e instanceof TrackerError)) log(`[tracker-meta] ${r.key}: ${e && e.message}`);
        store.set(r.key, { meta: prev ? prev.meta : null, fetchedAt: prev ? prev.fetchedAt : null, error: msg, errorAt: now(), readAt: (prev && prev.readAt) || now() });
      } finally { inflight.delete(r.key); }
    })();
    inflight.set(r.key, p);
    return p;
  }

  /** One ref's Meta. Fresh: from the cache. Stale: from the cache NOW, one refresh behind it.
   *  Never read: waits for the tracker. A failure is not retried for `retryMs`. */
  async function get(r) {
    if (r.unqualified) {
      return { ...view(r, null), error: 'a bare #N names no repo: ask for owner/repo#N (or pass repo=owner/repo)' };
    }
    const e = store.get(r.key);
    const t = now();
    if (e) e.readAt = t;
    const backingOff = e && e.errorAt && t - e.errorAt < retryMs;
    if (e && e.meta) {
      if (t - e.fetchedAt >= freshMs && !backingOff) refresh(r).catch(() => {});
      return view(r, e);
    }
    if (backingOff) return view(r, e);
    await refresh(r);
    return view(r, store.get(r.key));
  }

  /** Several refs, at most BATCH_CONCURRENCY tracker reads at once. */
  async function getMany(refs) {
    const out = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) { const i = next++; out[i] = await get(refs[i]); }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, refs.length) }, worker));
    return out;
  }

  return { get, getMany, refresh };
}

/** The reader the server wires: GitHub or ADO by the ref's tracker. */
function createReader({ fetchJson, githubApi = 'https://api.github.com', adoBase = 'https://dev.azure.com', githubToken, adoOrg, adoPat }) {
  return async (r) => (r.tracker === 'github'
    ? readGithub(r, { fetchJson, apiBase: githubApi, token: await githubToken() })
    : readAdo(r, { fetchJson, adoBase, org: adoOrg(), pat: await adoPat() }));
}

/** A `fetchJson` over global fetch: `{status, json, headers}`; a network failure is status 0.
 *  Redirects are not followed (an ADO sign-in redirect is a rejected token, not data). */
function httpFetchJson({ timeoutMs = 15000 } = {}) {
  return async (url, headers) => {
    try {
      const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      let json = null;
      if (r.status === 200) { try { json = await r.json(); } catch { json = null; } }
      return { status: r.status, json, headers: r.headers };
    } catch (e) { return { status: 0, json: null, headers: null, reason: e && (e.cause && e.cause.code || e.name) }; }
  };
}

module.exports = {
  FRESH_MS, RETRY_MS, MAX_BATCH, MAX_PRS, CLOSED_STATES,
  parseRef, blankMeta, parseGithubIssue, githubPrsFromTimeline, ghSeverity, ghPriority,
  parseAdoWorkItem, adoPrLinks, parseAdoPr, readGithub, readAdo, TrackerError,
  createMetaStore, createTrackerMeta, createReader, httpFetchJson,
};
