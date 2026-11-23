# Mission Control wire contract (v1)

The SSOT for every Mission Control shape (epic #501). Every change to a shape is made HERE, in the
PR that changes the code. All routes sit behind the normal auth middleware (cookie or Bearer). All
are ADDITIVE: no existing route or field changes. Every response carries `generatedAt` (ms).
Unknown/missing data is `null`, never guessed. Sections below a milestone that has not landed yet
are the plan, not a description of the server.

Landed: Who answers, Work-item meta (#502), Projects and areas (#503). Both are advertised in
`/api/version` `capabilities`: `work-item-meta` and `mission-control`.

## Who answers (one owner for cluster-wide state)
Mission Control is computed on ONE server per cluster: the same authority the supervisor uses
(`supervisorAuthority()` -> `leasesLib.resolveAuthority`); the rule is `lib/mc-authority.js`
`mcRefusal`. Mode `self` or no authority configured (single machine) -> this server answers from its
cluster view (the cached `GET /api/cluster/sessions` view, `cachedClusterSessions`, which already
merges every peer). Mode `remote` -> every `/api/mc/*` route answers
`409 {role:'peer', authority:{name, url}}`. Mode `invalid` (`leases.authority` names a server this
one does not know) -> `503 {error}` naming the bad value. The companion calls `/api/mc/*` on its
first server and, on that 409, on the server in its own list whose url matches `authority.url`
(else shows "Mission Control is served by <name> - add that server"). Persisted MC state (stage
history, to-dos; from #505/#506 on, not yet created) lives on the authority only (`mc-state.json`,
override `WT_MC_STATE_FILE`, atomic tmp+rename, a corrupt file renamed aside as the brief store does).
`/api/work-items/:ref/meta` is answered by any server (per-server cache).

## Work-item meta (#502) - `lib/tracker-meta.js`
`GET /api/work-items/:ref/meta` (ref URL-encoded: `owner%2Frepo%23123`, `ado%3A12345`) -> `Meta + {generatedAt}`
`GET /api/work-items/meta?refs=<comma-separated, max 50>` -> `{items: {<key>: Meta}, generatedAt}`.
`refs` is one query value: encode each ref (`#` must be `%23`) and join with `,`.

A bare `#123` names no repo. Both routes take `?repo=owner/repo` to qualify it; without it the
single route answers `400` and the batch answers that item with `error` set (never read).
A string that is not a work-item ref, or a bad `repo`, is `400 {error}`; so are an empty `refs`
and more than 50.
```
Meta = { key, ref, tracker: 'github'|'ado', url,
  title, type,            // 'Bug'|'Task'|'Issue'|'Pull request'|... (GH: issue type, else Issue / Pull request)
  state, closed: bool,    // tracker's own state text (a merged GH PR: 'merged'); closed = Closed/Done/Removed/Resolved or GH closed
  severity, priority,     // NUMBERS, 1 = highest (priority 0 = P0). ADO: the leading digit of
                          // Microsoft.VSTS.Common.Severity ('2 - High' -> 2) and Priority. GH: from labels
                          // ('severity:2', 'sev1', 'severity/high' -> 2; 'P1', 'priority:2'). Else null.
  severityText,           // the tracker's own severity text ('2 - High', 'severity:2'), or null
  createdBy, createdAt,   // display name / login; ms
  assignee,
  area,                   // ADO System.AreaPath; GH: null
  labels: [string],       // GH labels; ADO System.Tags split on ';'
  prs: [{url, number, repo, state: 'open'|'merged'|'closed'|null, draft: bool}],  // at most 10
  repo,                   // GH 'owner/repo'; ADO: null
  adoProject,             // ADO System.TeamProject; GH: null
  fetchedAt, staleSince: ms|null, error: string|null,
  warning: string|null }  // the copy IS fresh but partial: a rejected GH token read anonymously,
                          // a linked PR that could not be read
```
Key = `briefLib.globalKey` form (`owner/repo#N`, `ado:N`). Cache per key, fresh for 10 min, then
served stale at once while ONE refresh runs (`staleSince` = when the copy went stale). Persisted
(`mc-tracker-cache.json`, `WT_MC_TRACKER_CACHE_FILE`; at most 2000 keys). An unreachable tracker / bad
token -> the last cached copy + `{error, staleSince}`; no cache -> 200 with `title:null` and `error`
set (never a blank 500). After a failed read the tracker is not asked again for 1 minute. A
failure that is not a tracker answer is shown as "the tracker could not be read" (and logged).
At most 6 tracker reads are in flight per server, cold reads and stale refreshes alike (a
batch of 50 stale refs answers at once from the cache and refreshes 6 at a time behind it).

ADO: the PAT exactly as the supervisor's `adoPat()` reads it; org from config `mc.ado.org`, else
`supervisor.ado.org`; one `_apis/wit/workitems/{id}?$expand=relations` call, then each
`vstfs:///Git/PullRequestId/...` `ArtifactLink` through the Git PR API (`active` -> open,
`completed` -> merged, `abandoned` -> closed). Redirects are not followed: an ADO sign-in redirect
(or 203) is a rejected token; a GitHub redirect is an issue or repo that moved ("moved in GitHub",
ask for its new ref). GitHub: REST with a token from `GITHUB_TOKEN`/`GH_TOKEN`, else
`gh auth token` (execFile, 5 s, cached 10 min), else anonymous; a token GitHub rejects (401) is
retried anonymously and the answer carries `warning`; when anonymous cannot read it either (a
private repo), the error names the token first ("GitHub rejected the token (HTTP 401); without it:
..."). PR links from the issue timeline (`cross-referenced` events whose source is a pull
request), read 100 events a page for up to 5 pages; past that `warning` says the rest was not
read. More than 10 linked PRs keeps the newest 10.

Under `WT_TEST` only: `WT_MC_GITHUB_API` / `WT_MC_ADO_URL` replace the tracker base URLs and
`WT_MC_GITHUB_TOKEN` / `WT_MC_ADO_PAT` are the only tokens read (the suite never reads a real one).

## Projects and areas (#503) - `lib/projects.js`
Config (`config.json`, whitelisted key `projects`, settable with `PUT /api/config`; a malformed
list is refused whole with `400 {error}` naming the field, the file untouched):
```
projects: [{ id,          // [a-z0-9][a-z0-9_-]{0,39}, unique; 'other' is reserved
  name,                   // up to 80 characters
  match: { repos: ['owner/repo'], adoProjects: ['Contoso'], paths: ['C:\\dev\\contoso'] },
  areas: { source: 'ado-area'|'gh-label'|'path'|'none',   // default 'none'
           map: { '<area path prefix | label | path prefix>': '<area name>' } } }]
```
A session's project: the git origin of its cwd (`originForCwd`; this server's own sessions only)
against `repos`/`adoProjects`; a peer's session (its cwd is on another machine) takes the origin
its reported items name (a GitHub item's `owner/repo#N` key, an ADO item's link); then the cwd
against `paths` (a folder boundary, not a string prefix; the deepest folder wins; case-insensitive
on Windows and for any path with a drive letter), else `other`. A subject's project: the ref's
repo / ADO project (`Meta.adoProject`), else the project most of its sessions are in, else `other`.
A subject's area: from Meta per `areas.source` (`ado-area`: the longest matching prefix in `map`
at a `\` boundary, else the last segment of the Area Path, a bare project root being `General`;
`gh-label`: the first label `map` knows, no case; `path`: the session cwd's deepest mapped folder),
else `General`.
`GET /api/mc/projects` -> `{projects: [Project], generatedAt}`: every configured project in config
order, then `other`, last, only when non-empty. A project's areas are its distinct `map` names in
config order, then `General` (a project with `source: 'none'` has `General` only).
```
Project = { id, name, tracker: {kind:'github', repo}|{kind:'ado', project}|null,   // the first repo, else the first ADO project
  areas: [{ id, name, counts: Counts }], counts: Counts }
Counts = { active, needsYou, waitsOnOthers, doneWeek, sessions }
```
Until subjects exist (#504) only `sessions` is counted; `active`, `needsYou`, `waitsOnOthers` and
`doneWeek` are 0. A session counts toward an area only where its area is known from the session
itself: a `path` rule, or a project with `source: 'none'` (all in `General`).

## Stage (#505)
Report items gain optional `stage` (validated in `lib/session-brief.js`): `triage | reproduced |
planned | fixing | pr-open | in-review | merged | tested`. Old reports without it stay valid and
`brief.items[]` keeps every existing field. `lib/mc-stage.js` owns the order and the evidence rule:
effective = max(reported, evidence); evidence: an open PR -> >= pr-open, a PR with reviews ->
>= in-review, a merged PR or a closed/resolved work item -> >= merged. Never moves backwards: the
history keeps the max reached.
```
Stage = { current, reported, evidence, history: [{stage, at, source:'report'|'pr'|'tracker', detail}] }
```

## Subjects (#504) - `lib/mc-subjects.js`
`GET /api/mc/subjects?project=&area=` -> `{subjects: [Subject], runs: [Run], servers: [{name, ok}], generatedAt}`
`GET /api/mc/subjects/:key` -> `{subject: Subject, runs: [Run], generatedAt}` (404 when unknown)
```
Subject = { key, ref, url, title,          // title: meta.title, else the latest reported title
  project, area, meta: Meta|null, stage: Stage,
  sessions: [SessionRef], needsYou: Card|null, waitsOn: 'you'|'self'|'external'|'done'|null,
  runId: string|null, updatedAt }
SessionRef = { server, serverUrl, id, name, parentId, status, closed: bool, closedAt,
  lastReport: { state, stage, note, headline, at } , wait: {on, what}|null }
Run = { id, server, sessionId, name, startedAt, status, subjects: [key], children: [{server, id, name, status}] }
```
Join key = `item.key` (the brief's globalKey) across every server. Tree rule: parent = `spawn.parentId`,
a handed-off parent found through `spawn.replaces` - the server owns this rule for MC (ported from
`ai-terminal/lib/util/session_tree.dart`, which stays the owner for the old screens; MC screens
render the server's `parentId`/runs and never re-derive). A run = a session whose descendants
report >= 2 distinct subjects. Closed sessions stay on a subject for 7 days (`liveClosed`).

## Answer now / My to-do (#506) - `lib/mc-needs.js`
`GET /api/mc/now` -> `{answerNow: [Card], todo: [Todo], moving: {working, idle, total}, projects: [Project], generatedAt}`
```
Card = { id,                     // stable: '<server>|<sessionId>|<waitKey>'
  kind: 'question'|'permission'|'decision'|'wait',
  server, serverUrl, sessionId, sessionName, project, subjectKey, ref, title,
  what,                          // wait.what / question header
  why: { blocks, blockedSessions: [{server, id, name}], severity, ageMin, text },  // text e.g. "blocks 3 sessions"
  rank, askedAt, decision: {...}|null, hasQuestion: bool }
Todo = { id, cardId, subjectKey, ref, title, project, text, server, sessionId, createdAt, doneAt|null }
```
Rank: blocked sessions/subjects desc, then severity (1 highest), then age desc.
`POST /api/mc/todo {cardId, text?}` -> `{todo, parked: {delivered, refused?}}`: records the to-do
and sends the session ONE fixed park message through the existing gated prompt path (never twice
for the same cardId). `POST /api/mc/todo/:id {action: 'done'|'reopen'|'back'}` (`back` = to Answer now).
`POST /api/mc/later {cardId, hours: 1-24}`: hidden until then, back only if still pending.

## Questions context (#510) and Ask (#511) - `lib/mc-analyst.js`
`GET /api/mc/questions/:cardId/context?level=ask|context|everything` -> `{level, text, sections: [{title, body}], sources: [Source], generatedAt}` (built on demand, never on a poll)
`POST /api/mc/ask {question, scope: {kind: 'all'|'project'|'subject'|'session', id}}` -> `{answer, sources: [Source], dataAge: {oldestAt, newestAt}, model, generatedAt}`
`POST /api/mc/questions/:cardId/followup {option, question}` -> same shape as ask
`POST /api/mc/questions/:cardId/suggest` -> `{options: [{label, consequence}], sources, generatedAt}`
```
Source = { kind: 'session'|'report'|'recap'|'pr'|'workitem', label, server, sessionId, at, url }
```
Read-only: tools-off model call (the `lib/inbox-digest.js` CLI path), never types into a session.

## Start work (#512)
`POST /api/mc/start {project, subjects: [ref], hunt: bool, server, name?, brief?}` -> `{server, sessionId}`;
the session is bound (project + subject keys recorded at birth, shown on its subject before any report).
`GET /api/mc/machines` -> `{machines: [{name, url, ok, sessions, working, load}], suggested: name}`.
