# Mission Control wire contract (v1)

The SSOT for every Mission Control shape (epic #501). Every change to a shape is made HERE, in the
PR that changes the code. All routes sit behind the normal auth middleware (cookie or Bearer). All
are ADDITIVE: no existing route or field changes. Every response carries `generatedAt` (ms).
Unknown/missing data is `null`, never guessed. Sections below a milestone that has not landed yet
are the plan, not a description of the server.

Landed: Who answers, Work-item meta (#502), Projects and areas (#503), Stage (#505), Subjects
(#504), Answer now / My to-do (#506), Ask (#511), Start work (#512), Questions context (#510), Lines of work (#523), Asks (#526). Advertised in `/api/version`
`capabilities`: `work-item-meta`, `mission-control` (#502/#503), `mc-subjects` (#504/#505: the
subjects routes, `stage` on report items, `counts.stages`), `mc-needs` (#506: `/api/mc/now`,
`/api/mc/todo[/:id]`, `/api/mc/later`), `mc-start` (#512: `POST /api/mc/start`,
`GET /api/mc/machines`) and `mc-lines` (#523: Lines of work below); Ask and the question routes have no
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
  parent: {key, ref}|null, // #523: ADO's System.LinkTypes.Hierarchy-Reverse link; GitHub's sub-issue
                          // parent (parent_issue_url), else a FIRST body line "Part of #N" /
                          // "Part of owner/repo#N" (a mention further down is prose, not a parent)
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
A session's project, first answer wins (#524): its bound project (below); the git origin of its
cwd (`originForCwd`; this server's own sessions only) against `repos`/`adoProjects`; then the cwd
against `paths` (a folder boundary, not a string prefix; the deepest folder wins; case-insensitive
on Windows and for any path with a drive letter); then - for a peer's session (its origin is not
known here) in an unconfigured folder - the origin its reported items name (a GitHub item's
`owner/repo#N` key, an ADO item's link); else `other`. A session's own folder beats an item it
merely mentions. A subject's project: the ref's
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
  runId: string|null, updatedAt,
  line: Line.ref }                         // #523: {id, name, project, kind, source} - see Lines of work
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
  kind: 'question'|'permission'|'decision'|'wait'|'action'|'ask'|'possible-ask',
  blocking: bool,                // false for an `ask` / `possible-ask` (#526): the session is not held up by it
  askId, replyPrefix, maybeAnswered,  // an `ask` (#526): its short name, what an answer typed from the card begins with, may-be-answered
  supervisor: bool,              // the card is the supervisor dispatcher's own (#532); a to-do on it parks nothing
  server, serverUrl, sessionId, sessionName, project, subjectKey, ref, title,
  what,                          // the reason's text / wait.what
  why: { blocks, blockedSessions: [{server, id, name}], subjects: [key], severity, ageMin, text },
                                 // text e.g. "blocks 3 sessions and 2 work items"
  rank, askedAt, decision: {...}|null, hasQuestion: bool,
  questions: [{header: string|null, text: string}]|null,  // #531, kind 'question' only: the card face
  action: {steps: [string], where: string|null}|null,   // #522, kind 'action' only
  done: {state, refused, reason, at}|null }             // #522, an action card only (My to-do and a subject's
                                                        // needsYou, lib/mc-needs.js withDone): its Done record
```
`questions` (#531): what a question card asks, so the card shows the questions and never only "answer a
question". The pending AskUserQuestion read as the Ask below reads it (in-process, or a peer's route with
its stored token), at most 4 questions, each `{header (<= 40 chars, one line)|null, text (<= 400 chars,
one line)}`; `null` when the question cannot be read (then the card shows that, not a guess). Cached 30 s
per card id (8 s after a failed read) and waited for at most 1.5 s, so a slow peer costs `questions: null`
on that card and never a slow Now. A subject's `needsYou` question card carries it too.
```
Todo = { id, cardId, kind, subjectKey, ref, title, project, text, server, sessionId, sessionName, createdAt, doneAt|null,
  park: { state: 'sending'|'delivered'|'refused'|'uncertain'|'none', refused: code|null, reason: words|null, at } }
```
Answer now = every LIVE session whose wait is `you` by the subjects' own rule (`sessionWaitOn`:
its `reason`, or for a peer too old to send one, status `waiting` or a reported `you` wait): a
question or permission prompt on screen, a decision card (#492), a reported `you` wait. One card
per session (plus its asks, below); the card is `lib/mc-subjects.js` `needsYouCard`, the same as a subject's `needsYou`.
Its id names the wait: a reported wait (wait, decision) by its `at` (the agent's next report is a
new card); a prompt on screen by when it came up (`lib/mc-episodes.js`: an episode opens the first
time a view sees the session at a prompt, at its last activity then, holds while every view sees it
at the same kind of prompt in the same turn - redraws and hooks do not move it - and closes the first
time a view sees it anywhere else, so the next prompt is a new card; kept in memory on the
authority, so a restart opens new ones and a parked card comes back once; two prompts with no view
computed between them read as one). `askedAt` = the wait's `at`, or the prompt's episode start.
**The item a card is about (#541)** - `subjectKey`, `ref`, `title` are the subject of the item the card is ABOUT, never the
session's first item (a session works on several; a question about one showed the title of another). ONE rule,
`lib/mc-needs.js` `subjectFor`, for the wait card, every ask and a possible ask: (1) the item the report NAMED - an optional
`"ref"` on the `wait` and on each ask, which `lib/session-brief.js` accepts only when it is one of the session's own items
(any spelling of it: `gh#5` is `#5`; a report of a wait or asks alone is checked against the items already reported; a
wrong one is refused, naming the session's refs) and keeps as the session reported it; a name the session no longer reports
is no subject, not a guess; (2) a `you` wait with no `ref`: the ONE item reported `blocked`; (3) no `ref`: the open item
whose title and note share at least two significant words with the card's own (the question and its context, or the wait's
text; `lib/unreported-ask.js` `wordsOf`) and strictly more than any other item does; (4) else NO subject: `subjectKey`, `ref`,
`title` and `project` are null, and a client shows the question itself with the session's name beneath. `project` is the
subject's; an ask's `why.severity` is the subject's tracker severity (null with no subject; what a WAIT blocks, `why.subjects`
and its severity, is still every item of the sessions it holds up).
What it blocks (`why`): the asking session and every LIVE session above it in the tree
(`lib/mc-tree.js` ancestors: an orchestrator waits on the children it opened), and the work items
those carry (items reported done excluded). `severity` = the highest (lowest number) tracker
severity of those items, null when none. Rank: blocked sessions desc, then blocked work items
desc, then severity (null last), then age desc (unknown last), then id. `rank` is 1-based.
`moving`: live sessions owing nothing to the person: `working` (reason working; status for an old
peer) and `idle` (the rest).

**Asks (#526)** - decisions waiting for the owner that do NOT block the session. A session reports ONE
wait, and one that also waits on a child session reports `external`, or reports `done` when its work is
delivered: the decisions it holds for the person had no place to go, and the person never saw them. A
report may carry `asks` (top level, beside `items` and `wait`; `lib/session-brief.js` owns it): the
session's STANDING list of open decisions, complete across turns, up to 5, each the wait's decision shape
(#492) with the `context` REQUIRED - `{question, context, options: [{label, consequence?}] x2-4,
recommended?, ref?}` (`ref`: the item it is about, #541, above; a missing context, or any other bad shape, is refused with the right one quoted); two
of the same question (case and spacing aside) are one. A report that names `asks` REPLACES the list (an
ask it leaves out is gone), one without it KEEPS it - a `done`, `self` or `external` report, a wait-only
report, all of them - and `"asks": []` clears it; a report of `asks` alone (`{"asks": [...]}`) updates an
earlier report and leaves its wait as it was. Each ask keeps the time it was first asked while its
question stands. `brief.asks` = `[{id, question, context, options, recommended?, ref?, at, maybeAnswered}]`
(`[]` when none or reporting is off; a peer too old to send it has none); `id` is 8 hex of the question
(`askDigest`).
A session that holds open asks is never closed under them: the close-out (R5) neither asks, marks nor
closes it (`openAsks` on the graph node, `open-asks` from the session's own server), and the idle reaper
keeps it. A card answer typed into a session that is still working is queued by Claude; it reaches the
UserPromptSubmit hook when the turn takes it (measured, `docs/findings/chat-lens.md`), and that is when the ask clears.

What ends an ask is the owner's answer FROM ITS CARD, never a guess. The app types the answer behind the
card's `replyPrefix`, `Answer to "<question, 100 chars>" [ask:<id>]: ` (the server words it; the app only
prepends it), so the typed prompt names the decision it answers: `foldHook` reads it back
(`askAnswered`, only at the start of the text) and drops exactly that ask - the other asks and the
reported wait stand. Any OTHER typed prompt (a harness turn does not count) only marks every ask
`maybeAnswered: true` - the person wrote to the session, what they wrote may or may not have settled a
decision - and clears the wait it answered, as before. The session re-reports after reading: a list that
carries an ask makes it open again (the mark is dropped), one that leaves it out ends it. The dashboard
hook note (`instructionText`) teaches the standing list, quotes it back with the marks, and says a
decision the reply raises goes in before the session finishes, whatever its wait.

Each ask of a LIVE session is an Answer-now card (`kind: 'ask'`, `blocking: false`), one per decision:
`what` = the question, `decision` = `{question, context, options, recommended?}`, `askId`, `replyPrefix`,
`maybeAnswered`, `askedAt` = when it was first asked, id `<server>|<session>|ask:<askedAt>.<id>` (a
re-report of an open ask is the same card; another decision of the session is another card), `why` =
`{blocks: 0, blockedSessions: [], subjects: [], severity: its own items', ageMin, text}` with `text`
naming what the session is doing instead ("the session is still working: this does not hold it up";
carries on by itself / waits on something else / is idle / also waits on you; a `maybeAnswered` one says
the person wrote to the session after it asked). A decision the session also reports as its `you` wait is
that wait's card, not a second one. Asks rank after every wait on the person (they block nothing, a wait
blocks at least its own session) and a `maybeAnswered` one after the open ones, then by the ordinary
rule, oldest first. A session that only has asks still counts in `moving`. A to-do on an ask records it
and tells the session nothing (park `none`, refused `not-blocking`: there is no wait to park); a "later"
works as for any card. The companion answers through the reply dialog (the questions inbox lists only
what a session waits on) and the existing reply path (`McPickSender`), which re-reads the session first
and refuses once it no longer holds that decision.

**Possible unreported question (#526)** - the backstop for a session that wrote a question in its reply
and left it off `asks` and `wait`. At a Stop the server reads the newest reply from the transcript (the
same read as the `did` line, once) and `lib/unreported-ask.js` looks at its END - the TL;DR, else the
last paragraph: a sentence that ends in `?`, or says a decision, answer or approval is owed ("still need
your answer", "left one question", "until X answers"), is noted (`entry.possibleAsk = {text, at}`); an
optional offer ("want me to also ...?") and "nothing needs your input" are not. A rule, not a model:
it runs on every Stop, so it is free and the same every time. `brief.possibleAsk = {text, at}|null`:
null when reporting is off, when an `ask` or the `you` wait covers the sentence (half its significant
words in one of them: `coveredBy`), after the owner types a prompt (`foldHook`), and when a later reply
asks nothing (the note is only set from a turn no newer turn has begun). It is an Answer-now card of kind
`possible-ask` (`blocking: false`, id `<server>|<session>|possible:<at>`, `what` = the quoted sentence,
no decision, no reply prefix, `why.text` "its last reply may ask you something it did not report"),
ranked after the real asks; the person answers it in their own words, and a to-do on it tells the
session nothing.

**The supervisor's dispatcher (#532)** is the fleet's supervisor, not one of its sessions: its row
carries `role: 'supervisor'` (the session list's own field, `supervisorRowFields`), and
`mcSubjects.isSupervisor` is the one place that reads it. Subjects, runs, project and area session
counts and `moving` leave it out; what it needs from the person does not: its `you` wait and its asks
are Answer-now cards like any session's (`supervisor: true` on the card, `sessionName` the
dispatcher's). A to-do on such a card tells it nothing (park `none`, refused `supervisor`): its input
is the supervisor's own case line, not a place for "carry on".

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
The prompt carries `clearWait: true` (`lib/safe-prompt.js`): once typed, the session's own server
clears THAT wait (its `at`; never one reported since), because a tagged prompt is a system turn and
nothing else would - the owner-wait push, the inbox and the subject counts would keep it.
Delivered: the card leaves `actions`. Sending or uncertain (it may have landed): the card stays while
the session still blocks, its `done` saying so, with no Done (never sent twice: pressed again it is
`already`, even after the wait ended). Refused (a draft, a turn running...): kept, its `done` says
why, and Done may be pressed again. A new wait of the session is a new card. 404 when the card no
longer waits, 409 for a card that is not an action. Records are kept 7 days (pruned on every read
and every Done). Capability `mc-actions`.

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
Ask = { kind: 'question'|'permission'|'decision'|'wait'|'action'|'ask'|'possible-ask',
  questions: [{text, header, multiSelect, hasPreview}],
  options: [{index, question, label, detail, recommended}],   // FLAT across the questions; index is what a follow-up names
  recommended: index|null,      // a decision's `recommended`; an AskUserQuestion option labelled "(Recommended)"
  context: string|null,         // a decision's context
  canSuggest: bool }            // a decision, an ask or a wait (answered by a reply); an AskUserQuestion with ONE compact
                                // question (its `Other` row; side-by-side has none); never a permission
```
- The ask: a decision card's (or an `ask`'s) own decision; a question card's live AskUserQuestion (the
  `pending-question` route: in-process for this server's session, a peer's over its route with the
  stored token; unreadable -> the card's words); a wait or a permission -> the card's words, no options.
- Levels, each a list of `{title, body}` (plain text) and the sources they read: `ask` = The ask,
  Recommendation. `context` adds The work item (the tracker CACHE, `peek`, never a read), What the
  session did (its reported brief), Why it asks (a decision's context), What each answer does, and
  Summary (inbox digest) - the session's digest ONLY as cached (`?peek=1`: never starts a run).
  `everything` adds Last turns (#531: the session's own last turns, oldest first, `You (<age>): ...` /
  `The agent (<age>): ...`; the recap when its transcript cannot be read) and Links (the work item, its
  PRs, the session). No model runs for any level.
- `followup {option: index|null, question: 1-2000 chars}`: the Analyst's bundle for the asking
  session alone (its brief, its recap, its items' cached details) plus one block holding the card's
  question and options - agent text, so inside the data fence; the person's words sit after the
  fence and name the option by NUMBER only. Answer shape and errors as Ask (`502`/`503`).
  **The waiting session's last turns (#531)** are in that bundle too, as one source (`<session>: last
  turns`) before the card's own block: the session's real transcript turns (`readTranscriptPage`,
  the newest 60 read), real prompts and the agent's text only (a task notification, a slash-command
  echo or a hook's feedback is not a turn), the last 14 at most, each capped at 3000 characters and all
  at 14000, newest kept; a cut says "(Older turns are not shown.)". Without them the Analyst saw a
  280-character recap and could not explain the terms of a question that the agent had defined in its
  earlier text. A session whose transcript cannot be read falls back to the recap.
- `suggest`: the same bundle; the model proposes 2-4 OTHER answers `{label (one line, <= 80),
  consequence (<= 240)}`; control characters are removed, a label the card already offers (no case)
  or given twice is dropped, none left = `502 bad-output`. `canSend` = the ask's `canSuggest`.
- **Answered in place, asked in one tap (#531).** The companion's **Answer** on a card opens an answer
  sheet inside Mission Control (no jump to the old inbox): an AskUserQuestion shows the answer panel
  the session screen uses, whose frames (`buildAnswerFrames`) go through the existing server-typed
  `POST /api/sessions/:id/answer` after the same pre-write re-check; a decision offers its options and
  a box for the person's own words, a reported wait a reply box, a permission only **Open session**.
  A card also carries **Ask about this** (opens the panel with its box for the whole question ready).
  No new route: `GET /api/mc/now` gains `questions`, the Analyst's bundle gains the last turns.
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
#523: the body may also name the line of work: `line` = a line id from `/api/mc/lines` (`lines` or
`configured`), or `lineName` = a new line by name (not both; the rules of `POST /api/mc/lines/move`).
The binding keeps it as `line: {id?, name}`, the answer echoes it as `line` (null when none), and the
session and its children are on that line until the session reports a `line` of its own.

## Lines of work (#523) - `lib/mc-lines.js`
A project runs several lines of work side by side (a bug hunt, health checks, a feature, a release
cut, a docket of fixes); the person follows each apart, and the tracker's Area Path does not follow
them. Lines replace projects at the top of Mission Control; the project is a label on the line.
Config, per project (`projects[].lines`, validated with `projects`; a bad one refuses the list whole):
```
lines: [{ id,              // [a-z0-9][a-z0-9_-]{0,39}, unique in the project; the line's id is '<project>/<id>'
  name,                    // one line, at most 80 characters
  match: { items: ['ado:123', 'owner/repo#4', '#5'],   // a bare #N takes the project's first repo
           tags: ['health'],                           // tracker tags / labels, no case
           titlePrefixes: ['[Health'],                 // the item's title starts with it, no case
           sessionNames: ['BH worker*'] } }]           // a WHOLE session name, no case, * the only wildcard
```
Which line a work item is on - first match wins:
0. the person's **Move to line** (`POST /api/mc/lines/move`), stored on the authority
   (`mc-state.json` `lineOverrides`, kept 90 days from the move, at most 2000);
1. the line of a session on it (newest report first) or of the sessions above it (`lib/mc-tree.js`,
   the run that started it): a `line` the session REPORTED (report field, below), the line Start
   work BOUND it to, or - for a session above it only - a configured `sessionNames` rule of the
   item's project, else of that session's own project. An orchestrator's workers inherit its line;
2. the item's project's configured lines in config order: a listed item, a tag, a title prefix, or
   the name of a session on it;
3. its tracker parent (`Meta.parent`): the nearest Feature/Epic up the chain the tracker details
   hold (read up to 3 levels per poll, `readParents`, within one more short wait shared by every
   level; a level not read by then arrives on a later poll), else the direct parent; a configured
   rule matching the parent (item, tag, title) names the line. When the chain stopped at a level
   never read (not yet, or its read failed) the line says `partial: true`: it may still move;
4. otherwise a line of its own: its run's (`run:<root session id>`, named after the root session),
   else the work item's (`item:<subject key>`, named after its title). Never a catch-all.
A name (a report's, a binding's, a move's) is matched against the project's configured lines by name
or id, no case; else it is a line of that name, id `<project>/~<slug>` (the slug keeps letters and
digits in any script, so two Hebrew names are two lines). A new line's NAME is held to 80; a line
picked by id (a tracker parent's or item's) keeps its name as a label of up to 500, whatever length.
```
Line.ref = { id, name, project, kind: 'config'|'named'|'parent'|'run'|'item',
  source: 'override'|'session'|'rule'|'parent'|'own',         // on each Subject: why it is there
  partial? }                                                  // true: its parent chain is not fully read
Line = { id, name, kind, project, projectName,                // projectName 'Other' for other
  counts: Counts,                                             // as Projects: the same bucket rule; sessions = LIVE ones
  subjects: [key],                                            // newest first
  machines: [server name],                                    // where its live sessions run, sorted
  updatedAt }
```
A configured or named line's project is its own; any other line's is the project most of its items
are in. Lines are ordered: most needing the person, then those with active work, then the newest.
`GET /api/mc/lines?project=` -> `{lines: [Line], configured: [{id, name, project, kind, projectName}], generatedAt}`
(`configured` = every configured line, items or not, for the pickers). `GET /api/mc/now` gains
`lines: [Line]`; `GET /api/mc/subjects?line=<id>` keeps that line's subjects (and their runs).
`POST /api/mc/lines/move {subject, line?, name?}` -> `{subject, line: Line.ref, generatedAt}`:
`subject` = a subject key in any spelling (404 when no session touched it this week); `line` = a
configured line or one `/api/mc/lines` shows now, `null` = back to the rules; `name` = a line of that
name (one line, at most 80). Exactly one of the two, else `400 {error}`.
Report: optional top-level `line` (one line, at most 80; anything else refuses the report with the
reason; a `line` with only a `wait` is refused too, never dropped). A wait-only report keeps it; a full report without it clears it. `brief.line` carries it
(null when none) and a closed record keeps it. The per-prompt note does not teach it (its length
budget); the refusal does.
