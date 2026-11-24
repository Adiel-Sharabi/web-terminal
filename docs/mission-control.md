# Mission Control wire contract (v1)

The SSOT for every Mission Control shape (epic #501). Every change to a shape is made HERE, in the
PR that changes the code. All routes sit behind the normal auth middleware (cookie or Bearer). All
are ADDITIVE: no existing route or field changes. Every response carries `generatedAt` (ms).
Unknown/missing data is `null`, never guessed. Sections below a milestone that has not landed yet
are the plan, not a description of the server.

Landed: Who answers, Work-item meta (#502), Projects and areas (#503), Stage (#505), Subjects
(#504), Answer now / My to-do (#506), Ask (#511), Start work (#512), Questions context (#510). Advertised in `/api/version`
`capabilities`: `work-item-meta`, `mission-control` (#502/#503), `mc-subjects` (#504/#505: the
subjects routes, `stage` on report items, `counts.stages`), `mc-needs` (#506: `/api/mc/now`,
`/api/mc/todo[/:id]`, `/api/mc/later`) and `mc-start` (#512: `POST /api/mc/start`,
`GET /api/mc/machines`); Ask and the question routes have no
capability of their own (a server without them answers a bare 404).

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
kept), the person's to-dos and "later"s (#506), and the Start work bindings under their own key
`bindings` (#512; kept until 8 days after a session it reaches was last listed, at most 2000).
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
  needsYou: Card|null,                     // {id, kind, server, serverUrl, sessionId, sessionName, subjectKey, ref, title,
                                           //   what, askedAt, decision}: the card of #506 without its rank and why
                                           //   (same id); decision = the reported wait's decision (#492), else null
  waitsOn: 'you'|'self'|'external'|'done'|null,
  buckets: ['active'|'doneWeek', 'needsYou'?, 'waitsOnOthers'?],   // the Counts keys it is counted under
  runId: string|null, updatedAt }
SessionRef = { server, serverUrl, id, name, parentId, status, closed: bool, closedAt,
  bound: bool,                             // #512: on this subject only through its Start work binding (no report of its own yet)
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
`GET /api/mc/now` -> `{answerNow: [Card], actions: [Card], todo: [Todo], moving: {working, idle, total}, projects: [Project], generatedAt}`
```
Card = { id,                     // '<server>|<sessionId>|<kind>:<at>' - names the WAIT, not the session (below)
  kind: 'question'|'permission'|'decision'|'wait'|'action',
  server, serverUrl, sessionId, sessionName, project, subjectKey, ref, title,
  what,                          // the reason's text / wait.what
  why: { blocks, blockedSessions: [{server, id, name}], subjects: [key], severity, ageMin, text },
                                 // text e.g. "blocks 3 sessions and 2 work items"
  rank, askedAt, decision: {...}|null, hasQuestion: bool,
  action: {steps: [string], where: string|null}|null,   // #522, kind 'action' only
  done: {state, refused, reason, at}|null }             // #522, on `actions` only: a refused Done
Todo = { id, cardId, kind, subjectKey, ref, title, project, text, server, sessionId, sessionName, createdAt, doneAt|null,
  park: { state: 'sending'|'delivered'|'refused'|'uncertain'|'none', refused: code|null, reason: words|null, at } }
```
Answer now = every LIVE session whose wait is `you` by the subjects' own rule (`sessionWaitOn`:
its `reason`, or for a peer too old to send one, status `waiting` or a reported `you` wait): a
question or permission prompt on screen, a decision card (#492), a reported `you` wait. One card
per session; the card is `lib/mc-subjects.js` `needsYouCard`, the same as a subject's `needsYou`.
Its id names the wait: a reported wait (wait, decision) by its `at` (the agent's next report is a
new card); a prompt on screen by when it came up (`lib/mc-episodes.js`: an episode opens the first
time a view sees the session at a prompt, at its last activity then, holds while every view sees it
at the same kind of prompt in the same turn - redraws and hooks do not move it - and closes the first
time a view sees it anywhere else, so the next prompt is a new card; kept in memory on the
authority, so a restart opens new ones and a parked card comes back once; two prompts with no view
computed between them read as one). `askedAt` = the wait's `at`, or the prompt's episode start. The card's subject is the first item
the session carries that is not done.
What it blocks (`why`): the asking session and every LIVE session above it in the tree
(`lib/mc-tree.js` ancestors: an orchestrator waits on the children it opened), and the work items
those carry (items reported done excluded). `severity` = the highest (lowest number) tracker
severity of those items, null when none. Rank: blocked sessions desc, then blocked work items
desc, then severity (null last), then age desc (unknown last), then id. `rank` is 1-based.
`moving`: live sessions owing nothing to the person: `working` (reason working; status for an old
peer) and `idle` (the rest).

My to-do = what the person moved to their desk. A to-do (open or done) hides its card; a card
whose wait has ended is not pending, so it never comes back; a new wait of the same session is a
new card. To-dos and "later"s live in `mc-state.json` (authority only); a finished to-do (done,
or sent back) is kept 7 days, at most 500 in all.
`POST /api/mc/todo {cardId, text?}` (text: the person's own words, at most 500 characters) ->
`{todo, parked: {delivered, refused?, reason?, uncertain?, already?}, generatedAt}`; 404 when the
card no longer waits. It records the to-do ON DISK (park `sending`; a write that fails answers `500` and sends nothing,
and a state file that exists but cannot be read is never written over), then sends the session ONE
fixed park message through the gated prompt of the session's own server (`gatedPrompt` here, a
peer's `POST /api/sessions/:id/prompt` with the stored token: the supervisor's own path), with the
supervisor tag (a SYSTEM turn) and, for a reported wait, `expectWaitAt` = the wait's `at` (a
session that reported since answers `stale`). The text:
`[Mission Control] The user moved your wait on <ref> to their to-do list and will handle it at the desk. Park it (do not wait for it), carry on with your other work, and report that wait as external.`
The same cardId again (a second press, or after `back`) returns the same to-do with
`already: true` and sends nothing. A refusal (a draft, a turn running, a prompt on screen: the
gated prompt's code, `reason` in plain words) is answered and kept; it is retried ONLY by
`park`. A prompt on screen (question, permission) is never sent one (park `none`, refused
`on-screen`, no retry): text typed there would ANSWER it, and once it is gone nothing says the
message is still about the same wait. The to-do is still recorded; the person answers it at the desk.
`POST /api/mc/todo/:id {action}`: `done` (409 when done), `reopen` (409 unless done), `back` (to
Answer now: the to-do leaves the list, its card shows again while it waits), `park` (resend a
REFUSED message only; 409 when it was delivered or may have landed: `sending`, `uncertain`; or
none may be sent: `none`) ->
`{todo, parked?, generatedAt}`; an unknown id is 404, an unknown action 400.
`POST /api/mc/later {cardId, hours: 1-24 whole}` -> `{cardId, until, generatedAt}`: hidden until
then, back only if still pending (404 when the card no longer waits). Not the supervisor's later.
Capability `mc-needs`.

### Action waits (#522)
A reported `you` wait may say the person must DO something, not answer:
`wait: {"on": "you", "kind": "action", "what": "...", "steps": ["..."], "where": "..."}`
(`lib/session-brief.js` `_validateAction`). `kind` absent (or `"question"`) is today's wait.
`steps` 1-8 strings of at most 160 characters, `where` (a device or a place) at most 40: REFUSED
when longer, never cut; control characters refused; `steps`/`where` only with `kind: "action"`;
an action needs a `what`, rides only on `you`, and never goes with `decision` (each refusal quotes
the shape). The per-prompt hook note says when to use it in one line.
Its card has kind `action` (`needsYouCard`; a prompt on screen still outranks it) and is NEVER in
`answerNow`: it is in `actions`, the top of My to-do, ranked by the same order (1-based within
`actions`). Later hides it like any card; `POST /api/mc/todo` refuses it (409: it is on My to-do).
`POST /api/mc/actions/done {cardId}` -> `{cardId, done: {delivered, refused?, reason?, uncertain?, already?}, generatedAt}`
records the Done ON DISK (`mc-state.json` `actionsDone`, `sending`; 500 and nothing sent when the
write fails), then sends ONE fixed line through the gated prompt of the session's own server (as the
park does: supervisor tag, never onto an unsent draft, #479; `expectWaitAt` = the wait's `at`):
`[Mission Control] Done: <what>. The user did it; carry on.`
Delivered or uncertain (and `sending`): the card leaves `actions` and is never sent again (pressed
again: `already`, even after the wait ended). Refused (a draft, a turn running...): kept, its
`done` says why, and Done may be pressed again. A new wait of the session is a new card. 404 when the
card no longer waits, 409 for a card that is not an action. Records kept 7 days. Capability `mc-actions`.

## Questions context (#510) and Ask (#511) - `lib/mc-analyst.js`, `lib/mc-questions.js`
`GET /api/mc/questions/:cardId/context?level=ask|context|everything` -> `{level, text, sections: [{title, body}], sources: [Source], ask: Ask, cardId, generatedAt}` (built on demand, never on a poll)
`POST /api/mc/ask {question, scope: {kind: 'all'|'project'|'subject'|'session', id}}` -> `{answer, sources: [Source], dataAge: {oldestAt, newestAt}, cut, scope, model, generatedAt}` (landed, #511)
`POST /api/mc/questions/:cardId/followup {option, question}` -> the ask's shape + `option`
`POST /api/mc/questions/:cardId/suggest` -> `{options: [{label, consequence}], sources, canSend, model, generatedAt}`
```
Source = { id, kind: 'session'|'report'|'recap'|'pr'|'workitem', label, server, sessionId, at, url }
```
Read-only: tools-off model call (the `lib/inbox-digest.js` CLI path), never types into a session.

**Questions as built (#510).** `cardId` = an Answer-now card's id (`Card.id`, #506), URL-encoded;
`404 {error}` once that card no longer waits (the same `pendingCards` the Now screen reads), `400`
for an id over 400 characters, a `level` not in the list (absent = `ask`) or a bad follow-up;
`409`/`503` from `mcRefusal` like every `/api/mc/*` route.
```
Ask = { kind: 'question'|'permission'|'decision'|'wait',
  questions: [{text, header, multiSelect, hasPreview}],
  options: [{index, question, label, detail, recommended}],   // FLAT across the questions; index is what a follow-up names
  recommended: index|null,      // a decision's `recommended`; an AskUserQuestion option labelled "(Recommended)"
  context: string|null,         // a decision's context
  canSuggest: bool }            // a decision or a wait (answered by a reply); an AskUserQuestion with ONE compact
                                // question (its `Other` row; side-by-side has none); never a permission
```
- The ask: a decision card's own decision; a question card's live AskUserQuestion (the
  `pending-question` route: in-process for this server's session, a peer's over its route with the
  stored token; unreadable -> the card's words); a wait or a permission -> the card's words, no options.
- Levels, each a list of `{title, body}` (plain text) and the sources they read: `ask` = The ask,
  Recommendation. `context` adds The work item (the tracker CACHE, `peek`, never a read), What the
  session did (its reported brief), Why it asks (a decision's context), What each answer does, and
  Summary (inbox digest) - the session's digest ONLY as cached (`?peek=1`: never starts a run).
  `everything` adds Last turns (the recap: up to 3 prompts, the latest reply, the tools since) and
  Links (the work item, its PRs, the session). No model runs for any level.
- `followup {option: index|null, question: 1-2000 chars}`: the Analyst's bundle for the asking
  session alone (its brief, its recap, its items' cached details) plus one block holding the card's
  question and options - agent text, so inside the data fence; the person's words sit after the
  fence and name the option by NUMBER only. Answer shape and errors as Ask (`502`/`503`).
- `suggest`: the same bundle; the model proposes 2-4 OTHER answers `{label (one line, <= 80),
  consequence (<= 240)}`; control characters are removed, a label the card already offers (no case)
  or given twice is dropped, none left = `502 bad-output`. `canSend` = the ask's `canSuggest`.
- NOTHING here reaches the waiting session. The companion sends only the person's final pick, after
  a confirm, through the existing answer paths: a decision -> the reply `Decision: <label>` (while
  the session still puts THAT decision), a wait -> the reply, a question -> `buildAnswerFrames` with
  the text as `otherText` (one compact question only) through the pre-write re-check.

**Ask as built (#511).** Chosen over a read-only background session: `claude -p` with every tool,
setting and MCP server off, prompt on stdin, the run slots, timeout and child handling of
`lib/model-cli.js` (shared with the inbox digest). Config `mcAnalyst` `{enabled, model ('sonnet'),
command, timeoutMs (120000)}` - not settable through `PUT /api/config` (`command` is executed).
- `question`: 1-2000 characters. `scope` missing = `all`; `id` required otherwise: a project id
  (`other` included), a subject key (`owner/repo#N`, `ado:N` - the brief items' `key`), a session id.
- The bundle: per session in scope (newest activity first) its reported brief - headline, items,
  wait, doing-now, last turn's summary, last prompt, each with its time; recaps only for a
  `session` or `subject` scope, at most 6 (a local one in-process, a peer's over its own recap
  route); per work item those sessions name, the tracker-meta CACHE only (`peek`, never a tracker
  read) and its linked PRs. Every block has a source id (`S1`...) the model cites; `sources` holds
  only ids the bundle offered, in the model's order (an invented id is dropped). Capped at 60000
  characters by whole blocks; `cut: {omitted, total, itemsOmitted, itemsTotal}` when something did
  not fit (the model is told to say so), else null. `dataAge` = oldest/newest `at` of the sources offered.
- Session text sits between two fence lines carrying a random nonce, and the model is told it is
  data; the question sits after the fence. The answer is plain text (the companion renders it as
  text). A double tap of the same question over the same data shares one run.
- Subjects: a `subject` scope id is `lib/mc-subjects.js`'s subject key (`subjectKeyOf`; a tracker ref in
  any spelling is canonicalised first, as `GET /api/mc/subjects/:key` does).
- Errors: `400 {error}` bad body; `404 {error}` unknown session, subject (no session reports it) or
  project; an empty `all`/project scope is answered by the server (`model: null`, no run);
  `503 {status:'unavailable', reason: disabled|no-cli|busy}`; `502 {status:'failed', reason:
  timeout|error|bad-output}`; `409`/`503` from `mcRefusal` like every `/api/mc/*` route.

## Start work (#512) - `lib/mc-start.js`, `lib/mc-binding.js`
`GET /api/mc/machines` -> `{machines: [Machine], suggested: name|null, generatedAt}`
```
Machine = { name, url,        // url null = the authority itself
  ok: bool,                   // reachable, signed in, and its restart hold read and off
  why: string|null,           // 'offline', 'this server is not signed in to it', 'restart hold: <reason>',
                              // 'its restart hold could not be read'
  sessions, working,          // from the authority's cluster view
  load }                      // CPU percent, null when unknown
```
`suggested` = the ok machine with the fewest WORKING sessions, then the fewest sessions, then the
lowest CPU, then list order (this server first); null when none is ok. The hold is each machine's
`GET /api/maintenance/status` (3 s); one that cannot be read is listed, never suggested.

`POST /api/mc/start {project, subjects: [ref], hunt: bool, server, name?, brief?}` ->
`{server, serverUrl, sessionId, name, agent, agentReady, project, subjects: [key], hunt, generatedAt}`.
`project` = a configured project id; `subjects` = up to 10 refs (a bare `#N` takes the project's
first repo; one it cannot qualify is refused); `hunt` = a bug hunt, which needs no subject (without
it, at least one); `server` = a machine name from `/api/mc/machines` (this server, or a peer of its
`cluster` config by name - never a url from the body); `name` <= 100, `brief` <= 500. Every refusal
is `400 {error}` in words meant for a person: an unknown project, one with no `match.paths` ("has no
folder"), a bad ref, an unknown machine, a brief holding a character a shell acts on (named in the
answer) or one too long to share the 500-character launch command with the task (by how much). A
brief is refused, never changed or cut.
The session is created through the ordinary create path: this server's own `POST /api/sessions`
logic, or that route on the peer with the stored cluster token (a peer's 400/404/409 keeps its
and its 503 restart-hold refusal keep their code; anything else, its 401 included, is a 502 naming
the peer, the detail in this server's log). It starts in the project's
`match.paths[0]` (a folder missing on that machine is the create route's own "Folder does not
exist" refusal), named `<project name> <ref>[ +N] <tracker title>` (`<project name> hunt`; the
title is the tracker's: a cold read is waited on for at most 1.5 s, as a poll waits, then the cache
answers), with `goal` = the task and
`autoCommand` = `<command> "<task>[ <brief>]"` (the task, the server's own words, is shortened to fit): the task is `Fix <keys> (<title>) in project <name>.`
or `Bug hunt in project <name>[, starting from <keys>].`; `<command>` is config `mc.startCommand`
(letters, digits, space and `.:/\=_-` only), else `claude --dangerously-skip-permissions`. Text
inside the quotes keeps letters and digits in any script and plain punctuation; every character a
shell acts on inside double quotes (`` ` $ " \ ! % ^ & | < > ``) and every control character is
dropped from the server's words (a tracker title) and refused in the brief. A restart hold on the chosen machine refuses as its create route does (503, here or on a peer).
Binding: recorded at birth on the authority (`mc-state.json` `bindings`, by session id:
`{project, subjects: [{key, ref}], hunt, server, at}`), and the MC caches are dropped, so the next
`/api/mc/subjects` lists the session under each subject (`SessionRef.bound: true`,
`lastReport.state: null`, `lastReport.at` = its creation) before it reports anything. The rule
(`lib/mc-binding.js`): a session's binding is its own, else that of a session it was handed off from
(`spawn.replaces`), else its nearest bound ancestor's (`spawn.parentId`, the tree rule above) - so an
orchestrator's children inherit it. The PROJECT always comes from the binding (it wins over the git
origin and the folder, while that project is configured); the SUBJECTS stand in for a report only
until the session reports items of its own.
