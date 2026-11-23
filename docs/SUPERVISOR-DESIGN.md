# Supervisor — design (#465)

Status: **draft, revision 3** (2026-11-15). Folds in the owner's answers to two reviews.
No code yet.

**The one principle: bother the owner last.** Every decision goes down this ladder, by day
and by night:

1. **Handle it.** If a fact, a rule or the supervisor itself can settle it, settle it.
2. **Answer for the owner when the decision can be undone.** Log it in the journal with how
   to undo it.
3. **Wait for the owner only when the decision is important or cannot be undone.** These
   go out as one well-formed question in the journal, pushed outside quiet hours, never a
   stream of pings.

## 1. Why

Sessions on every machine still sit stuck for hours, although the #443 check-in exists. The
logs of 2026-11-14/15 show that the check-in **fires**. What is missing is anything that acts
on what it learns:

| What happened | Why nothing moved |
|---|---|
| A child answered "external: waiting on the team lead" 4 times over 12 h. Its lead no longer existed on any machine; two sibling orchestrators named the same vanished parent. | The answer is only recorded (`lib/check-in.js` `noteHook`). Nothing notices a missing parent: `spawn.parentId` is never checked, and `childGraph` ignores a parent it cannot see. |
| Sessions wait on "CI on PR N" or "the lead". | A wait is free text (`lib/session-brief.js`, `wait = {on, what, at}`). The server cannot look the target up, so it can only ask again, and the session, which has learned nothing new, gives the same answer. |
| One session waited on the owner for 19 h; three more for 1-2 h. | There is no repeat reminder and no quiet hours. A reported "you" wait never pushes at all: a push fires only on a tool approval, an API error or an auto-resume (`lib/notify-push.js`). |
| A lead on one machine, its children on another. | Every rule (check-in, reaper, hand-off, child liveness) reads only its own machine's rows. The cluster view is merged only in the client. |
| Sessions that reported "done" stay open. | The #351 reaper closes only sessions an agent created and nobody viewed. |

**In one sentence: web-terminal can see that a session is waiting, but not what it is
waiting on, so it can never tell that the wait is over, and nobody is told when it never
will be.**

## 2. Goals

1. **No wait goes unattended.** Every waiting session is, within a bounded time, either woken
   with the fact that ended its wait, handed to the dispatcher, or put in front of the owner.
2. **Waits on the owner reach the owner.** A push through the companion app, repeated by day
   and held at night, plus one list of everything waiting on them.
3. **Orphans are resolved.** A child whose lead is gone gets a stand-in lead or a decision.
4. **Every session is driven to its goal.**
   - Sessions the owner opened are **never closed** by the supervisor. They are driven to the
     end, cleaned up, and marked *ready to close*, so the owner can close them with one tap.
   - Sessions an agent or the supervisor opened are closed once they have met the goal they
     were opened for.
5. **Quiet hours are working hours for the supervisor.** Nights and Shabbat send no
   reminders. The dispatcher uses that time to push stuck sessions forward (§6a).
6. **Long jobs survive their sessions.** A stuck, dead or orphaned job gets a replacement
   session that carries on from its brief.
7. **One view of the whole cluster,** on the server side, not only in the app. It includes a
   **journal** of every session ever opened: who opened it, for what, what it did, and how
   it ended (§6b).

Measured by: the time each wait spends with no fact, no dispatcher case and no owner push,
computed from the supervisor's own log. Target: never above 60 min (in quiet hours: never
above 60 min with no dispatcher attempt).

**Scope: every machine in the cluster except the MacBook** (Office, Home, XPS, Help and
Office-Tests). Office-Tests must first be brought up to the current server version. A
peer can be excluded by config (`supervisor.exclude`), and the MacBook is.

**Not in v1:** failover of the supervisor host; replacing the agents' own orchestration
(leads still run their children).

## 3. Shape: three layers

```
  every machine                     Office (leases.authority)
  ───────────────                   ─────────────────────────────────────────
  L0 FACTS                          L1 SUPERVISOR (rules, in server.js)
  session rows: status, reason,     polls every peer each minute -> one
  wait + TARGET, spawn/lineage,  -> cluster work graph -> deterministic rules
  backgroundTasks, resources        -> actions through peer APIs -> log
  + safe-prompt route  <---------   |
  + closeout route                  | cases the rules cannot settle
                                    v
                                    L2 DISPATCHER (one Claude Code session)
                                    reads a case, decides, acts through
                                    wt-supervise.js; every action re-checked
                                    by L1's gates
                                    |
                                    v
                                    OWNER: app push (by day) + inbox
```

- **L0, on every server:** the facts it already publishes, plus a wait *target*
  (§4), a gated prompt route a peer can call (§10), and a close-out answer route (§7).
- **L1, on Office only:** runs where `resolveAuthority` (`lib/leases.js`) says `self`.
  Deterministic, cheap, fails closed, and logs every decision. This is the "rules" half of
  the hybrid.
- **L2, on Office only:** one long-lived Claude Code session that handles only what L1
  cannot settle. **The AI proposes and the rules dispose:** every dispatcher action goes
  through the same gates as an L1 action.

**L1 and L2 together are "the Supervisor", a built-in part of web-terminal,** not one
more session the owner has to keep alive.
- The server starts it, and restarts it when its brain session dies, hands off or hits a
  usage cap.
- The app shows it as **the Supervisor**: its own entry, with what it is doing now, its
  recent decisions and a pause switch. It is not mixed into the session list.
- Its memory survives its own hand-offs: a running notes file (what it decided and why,
  the owner's past answers) that every new brain session reads first.

Why the dispatcher is a session and not `claude -p` (the call `lib/inbox-digest.js`
makes): it needs memory across cases, real tools (transcripts, `gh`, ADO), and the owner
must be able to open it, read its reasoning and steer it. It runs on the machine's
subscription login like every other session, so **no API key is needed**; its tokens count
against the same usage limits. `claude -p` stays available to L1 for cheap one-shot jobs,
such as summarising a dead session for its replacement's brief.

## 4. Waits that name a target (the core change)

`wt-report` gains an optional `target` on the wait. Free text `what` stays, for people.

| `target.kind` | fields | resolved when | gone when |
|---|---|---|---|
| `session` | `id` (any machine; `replaces` aliases followed) | target reported `done`, or its turn ended with a new report | absent from **every** server, on two scans ≥ 5 min apart, with every server answering |
| `lead` | (none: the session's own `spawn.parentId`) | as `session` | as `session` |
| `pr` | `provider` `github`\|`ado`, `repo`, `number` | merged, closed, or a new review or vote | not found |
| `ci` | `provider`, `pr` or `runId` | the run finished (any result) | not found |
| `workitem` | `ref` (`#123`, `ado:12345`) | its state changed | not found |
| `time` | `until` (ISO) | the time passed | (never) |
| `child` | `ids` | every child reported `done` or is gone | (n/a) |

- An optional **`checkBy`** (minutes) says when the session expects the wait to be over.
  Past it, the wait is overdue even if the target says "pending".
- **A resolver never guesses.** It returns `pending`, `resolved`, `gone` or `unknown`. An
  unreachable server, a failed `gh` call or an expired token reads `unknown`, and `unknown`
  never wakes, closes or adopts anything.
- PR and CI resolvers use the credentials Office already has: the `gh` login and `ADO_PAT`
  (read from User scope, never printed).
- **Backward compatible:** a wait with no target behaves exactly as it does today
  (check-in), and its outcome feeds L1 (rule R3).
- The report command (`reportCommand` in `lib/session-brief.js`) teaches the agent the
  shape, the way it teaches `wait` today. Validation goes in `validateReport`.

## 5. The rules (L1)

Every rule fails closed. It never touches a session that:

- has an active viewer who is typing (#443 `typingQuietMin`);
- is in a restart hold (#359);
- has a hand-off in progress (#345);
- is compacting, or is showing a menu or a blocked prompt.

Each session gets a bounded number of actions per hour, and every decision is logged with
its inputs.

| # | Rule | Action |
|---|---|---|
| R1 | **Wake on fact.** A targeted wait resolves or its target is gone. | Type a tagged prompt (<512 bytes): `[web-terminal supervisor] Your wait "<what>" changed: <fact>. Carry on, or report a new wait.` |
| R2 | **Orphan.** `spawn.parentId`, followed through `replaces`, is gone cluster-wide. | Mark the session `orphan`. If it waits on its lead → open a dispatcher case ("stand in for the lead"). Otherwise just tell it. |
| R3 | **No progress.** An untargeted wait gets the same check-in answer twice with no new turn of work in between, or a wait passes `checkBy`. | Open a dispatcher case instead of asking a third time. |
| R4 | **Waiting on the owner.** `reason.kind = you`, or the dispatcher escalated a case. | Owner channel (§6). |
| R5 | **Done.** The session reported `done`, is idle, has no viewer and no live work. | Close-out. Then close it if an agent or the supervisor opened it; mark it *ready to close* if the owner did (§7). |
| R6 | **Hung turn.** `working`, but no hook and no PTY output for N min. | Case. |
| R7 | **Dead agent.** The agent exited to its shell. Needs #373 (the SessionEnd hook). | Case → usually a replacement (§8). |
| R8 | **Capacity.** Before any spawn. | Refuse a machine that is at its slot cap or below its free-commit floor. Office lives near its limit: the floor is per machine, in config. |
| R9 | **Going in circles.** The same failure, test or error comes back across turns, retries pile up, or the session is patching symptoms (a special-case `if`, a swallowed error, the same fix in a second place). | Case. The dispatcher coaches the session (§6a). |

## 6. The owner channel

- **Only the supervisor pushes owner waits.** Today every server pushes for its own
  sessions. One sender means one push per wait, not four. The companion registers its
  device with every configured server (`push_service.dart`), so Office can already reach
  the phone. The existing approval and API-error pushes stay as they are.
- **A new push kind, `owner-wait`,** through the existing `pushNotify` (FCM data-only or
  ntfy). The phone shows it on a new channel, between "approval" and "idle" in importance.
  - It fires when a wait on the owner starts.
  - It repeats every `remindEveryMin` (120) during the day.
  - It is deduplicated per session and per wait: a new report restarts the ladder, and an
    answer stops it.
- **Quiet hours** are nights (`supervisor.quietHours`, default `22:00-08:00` local time),
  **Shabbat and every Yom Tov**, by **Jerusalem** times, with **one hour of margin on each
  side**.
  - The quiet window runs from 1 h before candle-lighting to 1 h after the day ends.
  - Candle-lighting is 40 min before sunset (the Jerusalem custom). The day ends at tzeit
    (sun 8.5° below the horizon).
  - Yom Tov follows the Israeli calendar: Rosh Hashanah (both days), Yom Kippur, the first
    day of Sukkot, Shemini Atzeret, the first and seventh days of Pesach, and Shavuot. Two
    holy days in a row, or one next to Shabbat, make one window.
  - Everything is computed on the server, with no outside service: the Hebrew date comes from
    Node's built-in `Intl` Hebrew calendar, and sunset from the solar formula for Jerusalem's
    coordinates. A unit test pins a year of known times. Location, offsets and margin are
    configurable.
  - Pushes in quiet hours are held, never dropped. When quiet hours end, the owner gets
    **one** push ("5 things wait on you"), not one per session.
  - The existing approval and API-error pushes respect quiet hours too.
- **One list (#492, owner's decision 2026-11-23):** reported "you" waits, questions, blocked and
  ready-for-test items, dispatcher recommendations and escalations all land in the companion's
  questions inbox, the one "Needs you" surface. The journal (§6b) keeps a single "N need you"
  row that opens it, and tapping an owner-wait push opens it on that session's card.

## 6a. Quiet hours: the night shift

While the owner is away, the dispatcher's job is to **drive every session towards its goal**,
not to wait for the morning.

- **A session waiting on the owner** (by day as well; at night there is just no push). The
  dispatcher follows the ladder at the top of this doc:
  1. **The answer follows from the owner's written rules** (CLAUDE.md, the engineering
     standards, the tracker item, the owner's past answers in the Supervisor's notes). It
     answers, and the answer is logged with its source.
  2. **It can be undone.** It answers with its best judgement, and logs the answer with how
     to undo it, e.g. "chose to fix it in the server, not the client; revert commit X".
  3. **The question can be avoided.** It points the session to a path that does not need
     the decision, such as finishing the other items or building the part that holds under
     either answer.
  4. **It is important or cannot be undone.** It waits for the owner, and the session is
     told to park cleanly.

  Always step 4, never answered for the owner:
  - GitHub comments;
  - pushing or merging a PR;
  - deleting data;
  - an install on a host;
  - spending money;
  - anything outward-facing (seen by people outside the owner's machines).
- **A session going in circles (R9).** The dispatcher coaches it:
  - step back and restate the problem;
  - look at it from another angle (another layer, the data, the premise of the issue);
  - get to the root cause instead of a workaround: reproduce it, name the layer, state
    "X happens because Y", then fix it at the owner of the rule.

  The coaching prompt quotes the evidence it saw, such as "the same test failed 4 times
  with the same message".
- **A session stuck on an untargeted wait (R3), or an orphan (R2).** The dispatcher works
  out what it is really waiting for, and either resolves it or gives it a target.
- **Everything the night shift did is in the journal,** and the morning push summarises it:
  answered, coached, unblocked, still needs you.

## 6b. The journal (a new page, not a session)

One page in the companion, served by Office, that traces every session on every machine.
It does not replace a session's own screen. It is the place to see what happened.

- **One entry per session, for its whole life.** Each entry records:
  - machine and folder;
  - who opened it (the owner, an agent, the supervisor) and its **goal**;
  - its parent, children and hand-off chain;
  - a **very short brief** (2-3 lines) of what it did and how it ended (done, closed,
    replaced, died);
  - when it opened and closed.
- **Sections:**
  - **Needs you:** owner waits, recommendations awaiting approval, escalations.
  - **Live:** what each session is doing and waiting on.
  - **Ready to close:** the owner's done sessions, with a one-tap close.
  - **History:** closed sessions, searchable by day, machine or work item.
- **Supervisor actions appear inline** on the session they touched ("woken: PR 819 CI
  green", "coached: same test failed 4 times"), so the journal is also the audit trail.
- **The brief** is written from what the session reported (headline, items, final wait)
  and, when the session closes, one `claude -p` summary of its last turns. Under the
  owner's rule for model-output features, that summary is replayed over 5 or more real
  sessions before merge.
- **Where the data lives:** every server appends lifecycle events (opened, hand-off,
  closed, and why) to its own `sessions-journal.jsonl`. Office merges them, so a session
  that lived for less than a minute between two polls is still recorded.
- **The goal:** `POST /api/sessions` gains an optional `goal`. A hand-off successor inherits
  it. A session without one uses its first typed prompt, shortened.

## 7. Done: clean up, then close

The owner's rule: a done session cleans up after itself before it is closed.

1. **Close-out prompt.** R5 types a tagged prompt asking the session to check, and fix
   where it can:
   - uncommitted and untracked changes;
   - unpushed branches;
   - worktrees;
   - processes and sessions it started;
   - the tracker updated with its result.

   This is the `/dds-can-i-close` audit, but answered rather than printed.
2. **The answer is state, not prose** (the #359 pattern): `wt-closeout.js clean`,
   or `wt-closeout.js blocked "<what is left>"`.
3. `clean`:
   - **The owner opened it → never closed by the supervisor.** It is marked *ready to
     close* in the journal, with its brief, so the owner can close it quickly. If it is
     done but its goal is not met, the dispatcher drives it on first.
   - **An agent or the supervisor opened it → closed once its goal is met**, through
     `DELETE /api/sessions/:id` on its machine. It must be idle for `closeAfterMin`, have no
     viewer, and not be a favourite. The transcript stays on disk, so `claude --resume`
     can bring it back.
4. `blocked`, no answer, or `lost` → "Needs you" in the journal, never a forced close.
5. **Children close before their lead.** A lead with a live child is never closed.

The #351 reaper keeps running until this rule has proved itself. It is then retired into R5.

## 8. Spawning a replacement

**When:**
- the dispatcher decides that an orphaned or stuck job should continue;
- the agent died (R7);
- a hand-off failed and left the job with no live session.

**How:**
- If the old session can still write its own brief, reuse the hand-off path
  (`spawnSuccessor`).
- If it can't, the supervisor writes the brief: its last report and items, its tracker
  references, and a `claude -p` summary of the last turns.
- The replacement resumes the same conversation (`--resume`) when the transcript is sound,
  and starts fresh from the brief otherwise.
- It is linked through `replaces`, so the lead's and the children's links still hold.

**Where:** on the same machine, because a working folder exists only there, and only if R8
allows.

**As built (#470, `lib/replacement.js`):**
- R7's fact is the agent's **process**, not the hook: `SessionEnd` fires on a deliberate exit
  (`/exit`, Ctrl-C twice) and never on a crash (measured; `docs/findings/agents-codex.md`). Gone
  after being seen, with no `SessionEnd` standing, is a death; with one, it is someone's choice
  and is never replaced.
- Three readings, never two: **running** (seen in the newest snapshot), **gone** (absent from a
  snapshot newer than the last sighting under the same shell and than the last hook, with the
  exit hook installed), **unknown** (anything else). Only running is handed off (a wrap-up typed
  into a bare shell is a command), only gone is replaced as dead, and a dead run's old shell is
  closed only while the agent is still gone: one found running there again is kept.
- A session that already has a successor, whose last run ended kept or failed, or whose hand-off
  a person cancelled (until someone types) is refused: one job, one successor.
- The summary of the last turns is the **dispatcher's `--note`** plus the last turns read
  mechanically, not a `claude -p` call: the dispatcher already reads the tail with a model, and a
  second model call would add no fact and an unverified output to the brief.
- A job with no live session left (its session was killed) is not replaced: nothing on the
  machine records its folder and conversation once the session is gone. A failed hand-off leaves
  the old session open, so it is covered.

## 9. The dispatcher (L2)

- **One session on Office**, named `web-terminal supervisor`, in its own working folder. L1
  starts it, and restarts it if it is gone. It hands itself off with the normal auto
  hand-off.
- **Cases are its input.** L1 types a short tagged prompt: the case id and one line. The
  full case (rows, wait history, transcript tail) is read with `wt-supervise.js case <id>`.
  No case means no tokens.
- **Its verbs** go through `wt-supervise.js`, and the server re-checks every one:

  | Verb | What it does |
  |---|---|
  | `sessions` | list the cluster's sessions |
  | `tail <id>` | read the end of a session's transcript |
  | `wake <id> "<text>"` | wake a session with a message |
  | `lead <id> "<text>"` | answer as the stand-in lead |
  | `spawn …` | start a replacement session |
  | `close <id>` | close a session (only after a clean close-out) |
  | `ask-owner <case> "<question>"` | escalate to the owner |
  | `resolve <case> "<what was done>"` | close the case |

- **Guardrails:**
  - It has an action budget per hour.
  - It has no verb for restarts, process kills or config changes.
  - **Anything the owner's own rules reserve for the owner goes to the owner**, not to the
    dispatcher: GitHub comments, pushing a PR, deleting data, a host install.
  - A pause switch (`supervisor.dispatcher.enabled`, live, and a toggle in the app) stops it
    taking new cases.
  - Near the usage cap it takes no new cases, and L1 escalates them straight to the owner.

## 10. New wire and routes

| Where | What |
|---|---|
| every server | `wait.target` and `wait.checkBy` in `POST /api/session/:id/report` |
| every server | `POST /api/sessions/:id/prompt {text, tag}`: a gated prompt a peer may call. It checks idle, ready, not in a menu, not blocked, not typing, and no hand-off or hold, and answers `delivered` or `refused: <why>`. Needed because `/answer` checks none of these, and `typePrompt` is local only. |
| every server | `POST /api/session/:id/closeout` (hook token): the close-out answer (#469: `scripts/wt-closeout.js`, the session's own credential, so not a `wt-supervise.js` verb) |
| every server | `POST /api/sessions/:id/close {closeoutAt}` (#469): the gated close, re-checked by the session's own server before the kill; never the owner's session |
| Office | `GET /api/supervisor/state`: the graph, open cases and the owner queue. The companion reads it beside the session rows. |
| Office | `POST /api/supervisor/cases/:id` (resolve), `POST /api/supervisor/pause` |
| Office | `handoffs/supervisor-log.jsonl` (every decision and its inputs), `supervisor-cases.jsonl` |

Rules live in new pure modules (`lib/supervisor.js` for the graph and rules,
`lib/wait-target.js` for target validation and resolvers), tested like `lib/check-in.js`.
`server.js` owns only the timers, the peer calls and the writes.

## 11. How it fits what exists

- **The check-in (#443):** unchanged on every machine. It remains the fallback when Office is
  down, and the only asker for untargeted waits. Its outcomes now feed R3.
- **The auto hand-off (#345):** unchanged. The supervisor leaves a session in hand-off
  alone, and follows `replaces`.
- **The spawn reaper (#351):** kept until R5 is proven, then retired.
- **The questions inbox (#383):** extended into the one "Needs you" surface (§6, #492).
- **The agent-exit gap (#373):** a prerequisite for R7.
- **Child grouping (#377):** can use the supervisor's graph.
- **If Office is down:** no supervision, and today's per-machine behaviour carries on.
  Failover is a later issue.

## 12. Rollout: recommend first, then act

Silent shadow mode is dropped, because the owner would have nothing to look at. Instead,
every action starts in **recommend mode**. It appears in the "Needs you" inbox (§6) as a card
("Wake *X*: its PR's CI went green", "Stand in for the lead of *Y*: answer *Z*") with
**Approve** and **Dismiss** buttons. Approve performs it. Each card says why it was
proposed.

- Each **class of action** (wake, coach, answer-for-owner, stand-in, close, spawn) moves
  from *recommend* to *act* on its own, when the owner flips it
  (`supervisor.autonomy.<class>`, also a switch in the app).
- The journal shows each class's record: how many cards were approved and how many
  dismissed.
- **What can be undone starts in act mode, from day one and in quiet hours too** (the owner:
  "try not to bother me if you can handle it"):
  - waking with a fact;
  - coaching;
  - answering for the owner on a decision that can be undone;
  - standing in for a lead;
  - spawning a replacement;
  - closing a session an agent opened (its transcript can be resumed).
- **Recommend mode is only for what cannot be undone or is important.**
- A card pending at night waits for the morning, except under the night-shift rules above,
  once that class is in act mode.

Phases (each a child issue of #465):

1. **Facts and the journal:** `wait.target`, `goal`, lifecycle events, the gated prompt
   route, the cluster graph and orphan detection on Office, and the journal page.
   Office-Tests updated.
2. **Wake and reach the owner:** R1, R2's "tell", R4 with push, and quiet hours (nights and
   Shabbat).
3. **The dispatcher and the night shift:** cases (R2, R3, R6, R9), the `wt-supervise.js`
   verbs, recommendation cards and the §6a rules.
4. **Close-out and close:** R5, and the *ready to close* mark.
5. **Replacements:** §8 and R7 (after #373).

## 13. Decisions

| Question | Owner's answer (2026-11-15) |
|---|---|
| Autonomy | Wake, close, spawn, and stand in for a lost lead, all allowed. Done sessions clean up before they close. Claude may make decisions. |
| Owner contact | App push. Never at night. |
| Brain | Hybrid: rules plus a dispatcher. |
| Closing | Never the owner's sessions: drive them to their end so the owner closes them fast. Sessions opened by an agent or the supervisor close once their goal is met. |
| Quiet hours | Nights **and Shabbat**: no reminders. Use the time to drive sessions: answer them, make them step back and see the problem from another angle, root causes over workarounds. |
| Scope | Every machine. |
| Shadow mode | Replaced by recommend mode, with cards in the journal (§12). |
| Dispatcher as lead | Yes. It starts by recommending (§12). |
| A general page | The journal (§6b): every session opened and closed, with a very short brief. The questions page proved less useful than hoped. |

| Shabbat and Yom Tov | Jerusalem times. Every Yom Tov is quiet too. No bothering from 1 h before it starts to 1 h after it ends. |
| Bothering the owner | As little as possible: handle it yourself. Answer for the owner when the decision can be undone; wait when it is very important. |
| The questions page | Out of scope here (a separate issue). |
| Office-Tests | In scope. Update it and cold-restart it when phase 1 needs it, after checking it has no live sessions. |
| The MacBook | Out of scope: the supervisor ignores it entirely. |
| What this is | Something that runs inside web-terminal and has a brain, managing all of these operations: the built-in Supervisor (§3). |

## 14. Open questions

None. Next: commit this design to a branch, file the five phase issues under #465, and
start phase 1.
