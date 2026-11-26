# Fleet usage ledger (#529)

A record of what every Claude session on every cluster machine cost, who started it, what it was for and
how it went, so "where does the week go?" and "does a smaller context give better results?" are answered from
data. **Scripts only: nothing here ever calls a model.** Source: `lib/usage-*.js`; the routes are
`/api/usage/*`; the reports are `scripts/usage-report.js` and `GET /api/usage/report`.

## What is recorded

One **session record** per Claude conversation (a main transcript plus its subagents), from the transcripts
under the Claude home, read by a worker thread so the server never waits on it:

| Field | Meaning |
|---|---|
| `tok`, `units`, `byDay` | Tokens by kind and **weighted units** `in + cacheWrite*1.25 (2 for 1-hour) + cacheRead*0.1 + out*5` (`lib/usage-weights.js`, the same weights as the account's usage meter), per local day |
| `models`, `sub` | Calls and units per model; subagents' count, units and units by agent type |
| `time` | Active time (gaps up to `activeGapMin`), time waiting on a person (a longer gap ending in a human prompt after the agent finished), idle time, and each individual wait (minutes, capped at 200) |
| `wakes` | A **wake-up** is the first main-agent call after more than an hour idle; its cost is the cache re-write it caused |
| `prompts`, `compactions`, `peakCtx` | Human and automatic prompts, compactions, the largest context the session reached |
| `cls`, `project`, `branch` | What the session was (below), the repository it worked in, its branch |
| `wtId`, `name`, `parentWt`, `spawnedBy`, `replaces` | The web-terminal session that ran it and who started it (see "Who started it") |
| `quality` | Counts only: tool calls, tool errors, tools the person refused, the same tool failing twice in a row, human corrections, compactions in the middle of a task |
| `bh` | For the bug hunter: the work item and role (`worker` / `orchestrator`) |

Other record types: `bh-item` (one per bug-hunter work item: outcome, band, attempts, gate and review
verdict counts, measured complexity, the worker sessions), `inventory` (the project names found on a machine)
and `settings` (the context/effort regime in force: auto-compact window, effort, default model, hand-off
thresholds), and `classify` (a work/private override).

**Never stored:** a prompt, a reply, a tool input or output, a hook's text, a folder path (a session record keeps
the repository's name, not where it lives), or a reviewer's free-text verdict. A correction is detected on the
first 120 characters of a human prompt by a local pattern and only **counted**. **What is stored as text:** the
web-terminal session's name as the sessions list shows it (agent-started sessions are named after their task, so
it can carry a short gloss of a work item's title), the repository name and branch, and a bug-hunter item's
**escalation reason** (why the run stopped on it), cut to 120 characters and kept only for escalated items. The
ledger lives in `logs/` (git-ignored) and travels only between the cluster's own machines.

## Classes

`bh-worker` / `bh-orchestrator` (the bug hunter, found by the web-terminal session name and the run's event
log), `pr-review`, `pipeline-check`, `wt-automation`, `slash` (first-prompt classes), `handoff` (a session that
`replaces` another), `child` (a session with a parent), `interactive` (the rest). The *routine* classes
(`pr-review`, `pipeline-check`, `wt-automation`, `child`, `handoff`) are summed in the report as routine work.

## Who started it

The transcripts know nothing of web-terminal. The server therefore remembers each (web-terminal session,
Claude session) pair when the hook first names the Claude session (`logs/agent-sessions.jsonl`, written once
per pair with the name, parent, `spawnedBy` and `replaces` of the session). The collector joins on it. A
session that ran before this was deployed has no pair and is classed from its first prompt alone.

## Replication: every machine holds every machine's ledger

Each machine appends only to its **own** file, `logs/usage/<origin>.jsonl`: records with a `seq` that grows by
exactly 1, so a copy is always a **prefix** of the original and can never fork. A record's `key` names the
fact it states; the newest record per key is the current one (a session is re-recorded as it grows).

Every `syncMin` minutes a machine asks each cluster peer `GET /api/usage/heads` (`{origin: head seq}`) and
pages `GET /api/usage/feed?origin=X&after=N&limit=500` for whatever it is behind on, for **every** origin the
peer holds, so a machine that was down catches up on a third one through any peer, and a machine whose disk
was wiped gets its own history back from the others before it collects again. A peer that answers 404 (an
older server), fails, or sends a record out of order is skipped for that round. A bad line in a file is
copied aside (`<file>.corrupt-<time>`) and the file is cut to the last good record; the missing records are
pulled again. All routes are behind the normal auth; the cluster tokens already in use are what peers send.

**A machine never writes while it is behind on its own history.** Writing a record with a seq a peer already
holds for this machine's origin would fork it. So the collector and a classify wait (`recovering`, HTTP 503 for the
route) in two cases:

- **Behind.** A peer has reported a head of this machine's own origin above the local one. This is a high-water
  mark: it holds until a pull has caught the file up, and a later round in which that peer is unreachable does not
  clear it.
- **An empty or cut file.** A fresh file, or one that was cut at load, waits until **every** configured peer has
  answered once since the server started (HTTP 200, or 404 from an older server, which holds nothing of ours). One
  peer answering is not enough, because another one may hold the history. A machine with no peers writes at once.

An intact file keeps writing while the peers are unreachable. A retired peer that will never answer again would keep
a fresh machine waiting for good: list its server name (case-insensitive) in `usageLedger.ignorePeers`. Residual
risk: a file restored from an old backup looks intact, so if it writes before any peer has answered it can reuse
seqs a peer already holds; a fork is not repaired automatically (that machine's own file is then the one to delete
and pull again).

Origin names are the machine's server name made file-safe, compared case-insensitively (Windows file names are):
renaming a server keeps writing to the existing file, and the report counts a Claude session once, by its newest
record, even if an older record of it exists under the previous name.

## Work or private

Decided when a report is **read**, never stored in a record, so a correction applies to the whole history.
`classify` overrides win (the newest per project; `auto` withdraws one); otherwise a project is **work** when
the machine named by `usageLedger.workSource` has it in its inventory (the git repositories under its project
roots). With no `workSource`, nothing is work until it is classified. `node scripts/usage-classify.js <project>
work|private|auto` writes an override.

The project of a session is read from its folder's `.git` (a worktree's `.git` file, its common dir, the
`origin` URL's last segment, lower case) **without starting git**; no origin means the folder's name, no
repository `(none)`.

## Reports

```
node scripts/usage-report.js [--days 7] [--work | --private] [--machine <name>] [--json]
                             [--server <url|name>]
```

Reads this machine's copy of the ledger directly (read-only, so it works with the server stopped);
`--server` asks a peer's `GET /api/usage/report` instead. It shows, for the window: units by machine, scope,
class, project (top 10) and model; the cost of **wake-ups** and how many of them there were; routine work;
compactions; where the time goes (active / waiting on you / idle, median and 90th percentile of the waits);
the most expensive sessions; the **bug hunter** (per item: outcome, attempts, gate failures, worker units,
the orchestrator's overhead); and **quality by context**.

### Quality by context

"Does a smaller context give better results?" The ledger records the **settings regime** a machine ran under
(`settings` records, joined to a session or item by time) and, per session, the quality counts above plus the
peak context. The report groups by context band (under 100k, 100-200k, 200-300k, over 300k):

- **Bug-hunter items**, compared **within a complexity band** (small / medium / large, from the measured fix:
  files, lines, layers, GUI, hardware, database; else the run's own band): first-pass yield, review reject
  rate, gate fail rate, escalation rate, attempts.
- **Other sessions**, which are **not** controlled for complexity: corrections per 10 prompts, tool errors per
  100 calls, the share that was handed off.
- Each cell shows **n**; a cell under 5 is marked *too few* and is not a finding.

This is observation, not proof: sessions that grow large are the harder ones. The clean answer is a deliberate
A/B (two regimes on comparable work, switched by time), which the `settings` records make joinable.

## Configuration

`usageLedger` in `config.json` (all optional; see [CONFIGURATION.md](CONFIGURATION.md)): `enabled`,
`collectMin`, `firstRunMin`, `syncMin`, `activeGapMin`, `budgetSec`, `workSource`, `projectRoots`,
`bhRunDirs`. The collector is incremental: a session is re-read only when its size or modified time changed,
a growing one at most every 2 hours, and a final version once it has been quiet an hour; a pass stops at its
time budget (newest sessions first) and the rest wait for the next. A record is written only when the
summary changed.

## Size

Measured on one machine's real transcripts (1,583 sessions, 69 days on disk): an average record is about
**1 KB**, 1.5 MB for the whole history. A session is re-recorded while it grows (at most every 2 hours, plus a
final one), so about two records per session: roughly **20 MB a year per machine**, and every machine keeps
every machine's file, so a five-machine fleet holds about 100 MB a year. Files are append-only and are not
compacted; a record is capped at 64 KB.

## Known limits

- The weights are copied from the account usage meter's rules; a follow-up should make that meter import
  `lib/usage-weights.js` so there is one copy.
- A replay of one machine's transcripts matches that machine's own daily roll-up to within 0.1M units on 36 of
  37 days; the other differs by 0.7% (see the PR).
- A session that ran before the agent-session map existed cannot be tied to its web-terminal session, so it
  is classed by its first prompt.
- A cluster-wide classification needs every machine on this version; an older peer is skipped, not broken.
- A bug-hunter item run twice is two records (one per run); each carries only its own run's events.
