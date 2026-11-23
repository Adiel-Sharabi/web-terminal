# Mission Control wire contract (v1)

The SSOT for every Mission Control shape (epic #501). Every change to a shape is made HERE, in the
PR that changes the code. All routes sit behind the normal auth middleware (cookie or Bearer). All
are ADDITIVE: no existing route or field changes. Every response carries `generatedAt` (ms).
Unknown/missing data is `null`, never guessed. Sections below a milestone that has not landed yet
are the plan, not a description of the server.

Landed: Who answers, Work-item meta (#502), Projects and areas (#503), Stage (#505), Subjects
(#504). Advertised in `/api/version` `capabilities`: `work-item-meta`, `mission-control` (#502/#503)
and `mc-subjects` (#504/#505: the subjects routes, `stage` on report items, `counts.stages`).

## Who answers (one owner for cluster-wide state)
Mission Control is computed on ONE server per cluster: the same authority the supervisor uses
(`supervisorAuthority()` -> `leasesLib.resolveAuthority`); the rule is `lib/mc-authority.js`
`mcRefusal`. Mode `self` or no authority configured (single machine) -> this server answers from its
cluster view (the cached `GET /api/cluster/sessions` view, `cachedClusterSessions`, which already
merges every peer). Mode `remote` -> every `/api/mc/*` route answers
`409 {role:'peer', authority:{name, url}}`. Mode `invalid` (`leases.authority` names a server this
one does not know) -> `503 {error}` naming the bad value. The companion calls `/api/mc/*` on its
first server and, on that 409, on the server in its own list whose url matches `authority.url`
(else shows "Mission Control is served by <name> - add that server"). Persisted MC state lives on the
authority only (`lib/mc-state.js`: `mc-state.json`, override `WT_MC_STATE_FILE`, written 2 s after a
change by tmp+rename, a corrupt file renamed aside to `.corrupt-<ms>` and logged, as the brief store
does): each subject's stage history (#505; a subject unseen for 30 days is dropped, at most 2000
kept); the to-dos join it in #506.
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
Counts = { active, needsYou, waitsOnOthers, doneWeek, sessions,
  stages: { triage, reproduced, planned, fixing, 'pr-open', 'in-review', merged, tested } }   // in stage order
```
`sessions` counts live sessions (a session counts toward an area only where its area is known from
the session itself: a `path` rule, or a project with `source: 'none'`, all in `General`). The other
four count SUBJECTS (#504) by their `buckets` (one rule, `lib/mc-subjects.js` `bucketsOf`, so a
screen filtering subjects by bucket gets the server's number), toward the subject's project and area.
`stages` (#505, ordered, every stage present): subjects by `stage.current`; a subject with no stage
is in none. An area a subject landed in that `map` does not name (an ADO Area Path's last segment)
is listed after the mapped ones, before `General`.

## Stage (#505) - `lib/mc-stage.js`
Report items gain optional `stage` (validated in `lib/session-brief.js`): `triage | reproduced |
planned | fixing | pr-open | in-review | merged | tested`. Plausible words map (`repro`, `pr`,
`review`, `verified`, ...; never a `state` word such as `in-progress` or `done`); an unknown word
refuses the report with the list, as `state` does. Old reports without it stay valid; `brief.items[]`
keeps every existing field and gains `stage` (`null` when none; a pinned item shows the agent's,
a pin never carries one). The per-prompt note names the list in one clause. The Stop-hook block
rule is unchanged (a stage is never required).
`lib/mc-stage.js` owns the order, the words and the evidence rule. Evidence (from Meta; a Meta never
read proves nothing): a subject that IS a pull request (`Meta.type` 'Pull request') -> its own
state (merged -> merged, open -> pr-open; closed unmerged proves nothing). Otherwise: a closed work
item (`Meta.closed`) -> merged; else a linked PR still open -> pr-open (in-review with reviews; Meta
carries no review count yet, so today in-review comes only from a report), even beside an earlier
merged one (phase A merged, phase B open); else a merged linked PR -> merged; an abandoned PR
proves nothing. A GitHub link is any cross-reference, so a PR that only mentions the item counts.
current = the furthest of the stored history, the reports and the evidence. A stage reached by a
REPORT never moves back (a stale report cannot lower it). A stage only the tracker proved is
withdrawn when a fresh, complete read (no `error`, no `warning`) no longer proves it (a reopened item, another PR opened),
down to what the reports and the evidence still hold. The history records ADVANCES (at most one
entry per stage, stage order, so its times need not ascend), each `{stage, at, source, detail}`:
`at` is the report's time for a report, the time the server saw it for evidence. Every session's
current stage on the subject is folded in, not only the newest.
```
Stage = { current, reported, evidence, history: [{stage, at, source:'report'|'pr'|'tracker', detail}] }
```
`reported` = the stage of the newest report on the subject that carries one; `evidence` = what the
tracker proves now (null when nothing, or unread). All null for a subject nobody staged.

## Subjects (#504) - `lib/mc-subjects.js`
`GET /api/mc/subjects?project=&area=` -> `{subjects: [Subject], runs: [Run], servers: [{name, ok}], stages: [id], generatedAt}`
`GET /api/mc/subjects/:key` -> `{subject: Subject, runs: [Run], stages: [id], generatedAt}` (404 when unknown)

`project` = a project id; `area` = an area id as `/api/mc/projects` names it, or (when no area has that id) its name, no case;
each at most 80 characters, one value (else `400`). `runs` keeps every run holding at least one of
the returned subjects. `stages` = the stage ids in order. `:key` takes a tracker ref in any spelling
(`Acme/Widgets#42`, `AB#123`, URL-encoded) or a subject key as given. `servers`: this one, then each
peer; `ok` = its sessions AND its closed strip were read this time. An online peer whose strip read
failed keeps its last copy (`ok: false`); an offline or unauthorised peer contributes no closed
records. `generatedAt` = when the view was computed. The `area` filter takes the exact ids
`/api/mc/projects` hands out (including a `-x` suffixed one after an id collision).
```
Subject = { key, ref, url, title,          // title: meta.title, else the newest reported title, else the ref
  project, area, meta: Meta|null, stage: Stage,
  sessions: [SessionRef],                  // newest report first
  needsYou: Card|null,                     // until #506: {id, kind, server, serverUrl, sessionId, sessionName,
                                           //   subjectKey, ref, title, what, askedAt, decision}; kind question|permission|decision|wait;
                                           //   decision = the reported wait's decision (#492) on a decision card, else null
  waitsOn: 'you'|'self'|'external'|'done'|null,
  buckets: ['active'|'doneWeek', 'needsYou'?, 'waitsOnOthers'?],   // the Counts keys it is counted under
  runId: string|null, updatedAt }
SessionRef = { server, serverUrl, id, name, parentId, status, closed: bool, closedAt,
  lastReport: { state, stage, note, headline, at } , wait: {on, what}|null }
Run = { id, server, sessionId, name, startedAt, status, subjects: [key], children: [{server, id, name, status}] }
```
Data: the authority's cluster view (live rows), every server's closed strip (its own brief store;
each peer's `GET /api/dashboard/closed` with the stored token, cached 30 s), the tracker details
(batch; a poll waits at most 1.5 s for reads it started, then serves what the cache holds - the
rest arrives on a later poll; a failed read never fails the view) and the stored stage history.
One compute runs at a time; its answer is reused for 3 s after it arrives.
Join key = `item.key` (the brief's globalKey) across every server. A key no tracker can answer for
(a bare `#12` from a cwd with no GitHub origin, a free-text ref) joins nothing: it is a subject of
that one session, keyed `<key>@<session id>`, with `meta: null`. A session listed twice (live and
closed, or two urls for one box) counts once, live first. Closed sessions stay for 7 days
(`liveClosed`); their records now keep `spawn: {parentId, replaces, createdAt}` (only when they had
a parent or replaced someone), so a finished child still joins its run. On a closed session
`status` is `'closed'` and `lastReport.at` is its `closedAt`.
Tree rule (`lib/mc-tree.js`, ported from `ai-terminal/lib/util/session_tree.dart`, which stays the
owner for the old screens; MC screens render the server's `parentId`/runs and never re-derive):
parent = `spawn.parentId` looked up across every server; a handed-off parent is found through its
successor's `spawn.replaces`; a live session wins an id over a closed record, and a successor (live,
or closed itself, the newest hand-off first) wins its predecessor's id over the predecessor's record. A loop or a self-parent is visited once. `SessionRef.parentId` is the
resolved parent's id, else the raw `spawn.parentId`.
A run = a tree root whose descendants (any depth, any server, closed included) report >= 2
distinct subjects; its `subjects` are those plus the root's own and those of the sessions it was
handed off from; `startedAt` = the root's `spawn.createdAt` (null when unknown). A subject in two
runs takes the newest run's id.
waitsOn, per session on the subject: an item it reported `done` -> done; a closed session ->
nothing; else its `reason` (`lib/session-reason.js`): you/external/self/done as named, working ->
self, menu -> nothing (a peer too old to send `reason`: status `waiting` -> you, `working` -> self,
else its reported wait). The subject takes the first of you, external, self, done that any session
gives. Buckets: `doneWeek` when `meta.closed` or waitsOn is done, else `active`; plus `needsYou`
when waitsOn is you, `waitsOnOthers` when external - the companion's fallback rule exactly.

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
