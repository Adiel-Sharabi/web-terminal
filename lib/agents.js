'use strict';
// AI coding-agent providers — the SINGLE place that knows anything agent-specific.
//
// A session runs some CLI agent (Claude Code, Codex, …). Everything downstream — the
// backward paginator, /api/sessions/:id/transcript, the sidebar, the companion chat
// view — consumes one typed turn shape and one `agent` id. Adding a new CLI agent
// means adding a parser module and ONE entry in PROVIDERS below. It must never mean
// branching on the agent inside server.js, pty-worker.js or the app.
//
// A provider declares:
//   id                     stable identifier; the value put on the wire and persisted
//                          on the session. Never rename one — sessions.json holds it.
//   label                  human name for the UI
//   color                  accent hex the clients tint a session with
//   detect(command)        does this shell command launch the agent?
//   transcriptDir          path segments under the user's home holding transcripts.
//                          Doubles as the containment root a candidate transcript path
//                          must sit strictly inside before it is ever read.
//   resolveTranscript(s,io) locate this session's transcript. Returns a CANDIDATE path
//                          (never trusted directly — the caller re-validates it against
//                          transcriptDir) or '' when the agent left none.
//   parseLine(line)        one transcript line -> typed turn | null
//   extractResults(line)   one transcript line -> [{id, text}] tool OUTPUT
//   supportsSubagentTrace  whether transcripts carry a sibling subagent directory the
//                          /subagent drill endpoint can index
//   readMetrics(tailText)  OPTIONAL. Recover { ctx, fiveH, sevenD, fiveHResetAt, model,
//                          effort } from the tail of this agent's transcript. Present
//                          only for agents that RECORD their usage (Codex). Claude
//                          instead PUSHES its status line to POST /api/claude-status, so
//                          it has none here and server.js keeps reading that live map
//                          for Claude.
//                          fiveHResetAt (issue #69): ms-epoch int | null — when the
//                          account's 5h usage-limit window resets, if known. Codex
//                          reports it (rate_limits.<300min window>.resets_at, seconds ->
//                          ms — see lib/metrics-codex.js). Claude's status push carries
//                          no such field today; POST /api/claude-status stubs it to null
//                          until a real limit-message parse exists (server.js). This is
//                          the ONE field both sources populate — pty-worker.js's #69
//                          auto-resume timer reads it with no per-agent branch.
//   pushesStatus           OPTIONAL. This agent's CLI PUSHES its usage to the server
//                          rather than recording it. It names the owner of every pushed
//                          report — which is not always the carrying session's agent (see
//                          statusPushAgent below).
//   taskList               OPTIONAL (#73). How this agent's multi-step task list is
//                          recovered. `source` is the whole design decision:
//                            'transcript' the agent writes the WHOLE list on every call
//                                         (Codex `update_plan`), so the newest one in the
//                                         file IS the state — `readPlan(text)` recovers it
//                                         and nothing has to be remembered.
//                            'hooks'      the agent emits DELTAS whose task id exists only
//                                         in the result prose (Claude TaskCreate/TaskUpdate),
//                                         so the list is folded forward from the live hook
//                                         stream — a BACKWARD-paging transcript reader
//                                         cannot reconstruct it.
//                          An agent that declares none simply has no task list, which is
//                          the correct answer for a plain shell. The rules themselves are
//                          pure and live in lib/task-list.js; this field only says which.
//   submit                 how this agent's TUI reads a submitted prompt:
//                            gapMs           delay before the submit CR is written
//                            crBurstsAsPaste the TUI folds every byte of ONE read into a
//                                            paste, so a CR arriving alongside its text is
//                                            content (a newline in the composer), not Enter
//                                            — the CR must arrive in a write of its own.
//
// The `io` handed to resolveTranscript is injected so providers stay free of `fs`:
//   { root, join, listRollouts(), readFirstLine(path), exists(path), findByBasename(name) }
// `findByBasename` returns the first file with that exact basename anywhere under the
// root, or ''. It exists because a conversation id is globally unique while a cwd is not
// an identity — see the claude provider's resolveTranscript.
const claudeParser = require('./transcript');
const codexParser = require('./transcript-codex');
const { findRolloutForCwd, findRolloutById } = require('./codex-sessions');
const { parseMetricsFromTail } = require('./metrics-codex');
const taskListLib = require('./task-list');

const DEFAULT_AGENT = 'claude';

// Match an agent as a bare program name: at the start of the command or after a path
// separator, with an optional Windows extension. So `codex`, `C:\bin\codex.exe` and
// `npx codex` match, while `codex-notes`, `my-codex` and `echo codexy` do not.
function programMatcher(name) {
  const re = new RegExp(`(?:^|[\\\\/\\s])${name}(?:\\.exe|\\.cmd)?(?=\\s|$)`, 'i');
  return (cmd) => typeof cmd === 'string' && cmd !== '' && re.test(cmd);
}

const PROVIDERS = Object.freeze({
  // Claude Code stores <claudeHome>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl,
  // so the cwd encodes the directory and the transcript path is a pure derivation.
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    color: '#d97757',
    detect: programMatcher('claude'),
    transcriptDir: ['.claude', 'projects'],
    parseLine: claudeParser.parseTranscriptTurn,
    extractResults: claudeParser.extractToolResults,
    supportsSubagentTrace: true,
    // Claude records no usage in its transcript — its status line PUSHES to
    // POST /api/claude-status. So a pushed report is Claude's account quota no matter which
    // session carries it: a user who types `claude` at a plain shell gets a Claude
    // conversation id pinned onto a session that declares no agent, and the status line is
    // pushed under it all the same (#56).
    pushesStatus: true,
    // The resolved path is STABLE: it is a pure derivation from (cwd, agentSessionId),
    // so it cannot change without one of those changing, and the hook re-stashes it
    // every event anyway. Callers may cache it for the life of the session.
    transcriptPathStable: true,
    // `<projects>/<encoded-cwd>/<conversationId>.jsonl` — the id IS the basename.
    conversationIdFromPath(p) {
      const m = /([^\\/]+)\.jsonl$/i.exec(String(p || ''));
      return m ? m[1] : null;
    },
    // `cwd` is where the SHELL was spawned — which is NOT always where the agent RUNS.
    // A user who cd's before launching, or who resumes a conversation belonging to another
    // project from inside the TUI, leaves the conversation under a DIFFERENT project dir,
    // and the derivation then names a file that does not exist. Observed on XPS
    // 2026-08-12: session cwd C:\dev\AM8_Core, conversation under C--dev-am8-health —
    // a live terminal next to a chat lens returning 404.
    //
    // The conversation id is a UUID and globally unique across every project dir, so when
    // the derivation misses, locating `<id>.jsonl` anywhere under the projects root is an
    // EXACT lookup by identity — not the newest-in-cwd mtime guess #23 warns about. The
    // walk only runs on the miss path, so the common case still costs one path join.
    resolveTranscript(session, io) {
      const cwd = session && session.cwd;
      const sid = session && session.agentSessionId;
      if (!sid) return '';
      if (cwd) {
        const derived = io.join(io.root, claudeParser.claudeProjectDirName(cwd), sid + '.jsonl');
        // An io without `exists` (a fake in a unit test) keeps the pure derivation.
        if (typeof io.exists !== 'function' || io.exists(derived)) return derived;
      }
      return (typeof io.findByBasename === 'function' && io.findByBasename(sid + '.jsonl')) || '';
    },
    // Claude's TUI DOES fold a whole read into a paste — it just takes a big enough
    // read to trip it. Measured against the real TUI, atomic `text\r` in one write:
    //   20 chars submitted | 40 submitted | 60 submitted | 80 NOT | 120 NOT
    // and with the CR split off, every length submitted. Same story for a multi-line
    // bracketed paste (`ESC[200~…ESC[201~\r`): 0/4 atomic, 4/4 split.
    //
    // So a short prompt submitted and a real one (longer) was typed but never sent —
    // the "sometimes Enter works, sometimes it doesn't" bug. Withholding the CR and
    // writing it alone after the gap is deterministic at ANY length, which is why this
    // is `true` rather than a length heuristic. #44 still holds: the WORKER owns the
    // delayed CR (it holds the PTY and queues frames arriving in the gap), so a client
    // that dies mid-gap cannot lose it.
    submit: Object.freeze({ gapMs: 150, crBurstsAsPaste: true }),
    // Esc interrupts a turn — and Claude Code fires NO hook when it happens (there is no
    // interrupt event in its hook set: Stop does not run on a user interrupt). The worker's
    // status is otherwise hook-driven, so an interrupted session sat on "Claude is working"
    // until correctStaleStatus rescued it 5 minutes later (#55 §6). The worker writes the
    // Esc byte itself, so it is the one component that can know — see interruptsOnEscape.
    interrupt: Object.freeze({ onEscape: true }),
    // #147 — the marker that says the TUI's composer exists and a prompt sent now
    // reaches the agent instead of the shell it is still sitting in front of.
    // MEASURED on the rig (scripts/rig/probe-claude-ready.js, claude 2.1.237):
    // the caret appeared at 5.0s on one run and 6.1s on the next, and a prompt
    // sent before it started NO turn and drew "command not found" from bash.
    // The caret, deliberately — NOT the banner (Codex's moved between 0.144.0 and
    // 0.144.6, breaking a probe on a routine auto-update) and NOT "esc to
    // interrupt" (a cold TUI prints it while still booting MCP servers).
    // KNOWN GAP, scoped and measured rather than waved away: this glyph is also
    // the default PS1 of starship, pure and several oh-my-posh themes. Arming
    // the scan only after the launch command is written stops the SHELL'S FIRST
    // prompt from counting, but not a prompt printed straight AFTER a launch
    // that failed (`claude: command not found`) — on such a box the latch would
    // flip within milliseconds and the gate would silently open, without ever
    // reaching the 45s fallback. Measured on this fleet 2026-08-20: Git Bash's
    // PS1 ends in `$` and a failed launch prints `bash: ...: command not found`,
    // so it is NOT live here. Closing it properly means keying on the composer
    // FRAME rather than the bare caret, which needs a fresh rig measurement of
    // what that frame prints — do that before declaring it fixed. Raised in
    // re-review of PR #150.
    readiness: Object.freeze({ composer: /❯/ }),
    // #138 - may a 5h auto-resume actually ARM for this agent?
    //
    // Claude yes: we have a captured cap event (the selector below), so we know what
    // being capped looks like AND how to answer it. Codex declares false for now -
    // it still reads its usage metrics and still shows the wait badge, but nothing
    // is scheduled to type into it, because nobody has yet captured what Codex does
    // at its own cap. Arming off an inferred percentage alone, for an agent whose
    // blocked state we have never seen, is the guesswork this issue exists to stop.
    autoResume: Object.freeze({ arm: true }),
    // #138 — the 5-hour cap does NOT leave Claude sitting idle. It BLOCKS ON A
    // SELECTOR, captured from a real limit event on claude-code 2.1.234:
    //
    //     What do you want to do?
    //     > 1. Stop and wait for limit to reset
    //       2. Upgrade your plan
    //       3. Upgrade to Team plan
    //     Enter to confirm . Esc to cancel
    //
    // That matters twice over. It is the DEFINITIVE cap signal — far stronger than
    // inferring a block from a percentage — and it is a session that cannot even go
    // idle until somebody answers it, so an unattended session hangs on a question
    // no one is there to see.
    //
    // `pattern` deliberately matches the OPTION text, not "What do you want to do?":
    // that header is generic enough to appear in ordinary agent output, while this
    // sentence is not. `answer` names the option by its DIGIT rather than pressing
    // Enter on whatever happens to be highlighted — the cursor sits on option 1 in
    // the captured render, but "confirm the highlighted row" would pick a plan
    // upgrade if that ever changed, and a digit cannot. Per #19's measurements a
    // digit SUBMITS in a compact (preview-less) single-select, so no trailing CR is
    // sent: if that is ever wrong the prompt simply stays up, which is the status quo
    // ante and the right direction to fail in.
    //
    // NOT YET VERIFIED against a live cap (a 5h limit cannot be manufactured on
    // demand). The shape is captured; the keystroke is reasoned from #19. Kept as a
    // registry field precisely so correcting it needs no worker change.
    usageLimitPrompt: Object.freeze({
      // The SENTENCE only. What makes a line an answerable menu option — that it
      // starts the line, that it carries its own number, and that another option sits
      // beside it — is agent-independent and lives once in lib/usage-limit.js
      // (`matchUsageLimitPrompt`), which also reads the digit off the render so a
      // reordered menu still picks "stop and wait" rather than a plan upgrade.
      //
      // The structure is not decoration: this comment block is itself a verbatim copy
      // of the render, so a Claude session that merely READ this file used to match
      // and type a digit into its own composer. `answer` is the fallback for a render
      // that somehow carries no number at all.
      pattern: /Stop and wait for limit to reset/i,
      answer: '1',
    }),
    // Claude can launch a shell command with `run_in_background`, which OUTLIVES the
    // turn that started it: the tool returns as soon as the command is launched, so
    // Stop fires and the session goes idle while a build is still running. Its
    // transcript records both ends (the launch's id, and a `<task-notification>`
    // carrying that id when it finishes), so the running set is derivable — see
    // lib/background-tasks.js. Status is deliberately left alone; this is the
    // separate fact the dot cannot carry.
    backgroundTasksInTranscript: true,
    // #73 — Claude's task list is DELTAS (TaskCreate/TaskUpdate) whose id is only in the
    // result prose, so it is folded from the live hook stream rather than read back.
    taskList: Object.freeze({
      source: 'hooks',
      parseDelta: taskListLib.parseClaudeTaskDelta,
    }),
  }),

  // Codex keys rollouts by date+uuid, never by cwd — the cwd lives only in each file's
  // first `session_meta` line — so resolution is a bounded newest-first search.
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    color: '#10a37f',
    detect: programMatcher('codex'),
    transcriptDir: ['.codex', 'sessions'],
    parseLine: codexParser.parseTranscriptTurn,
    extractResults: codexParser.extractToolResults,
    supportsSubagentTrace: false, // Codex reports a subagent's transcript on its SubagentStop hook
    // The resolved path is NOT stable, and caching it for the life of the session is a
    // real bug (observed on Office 2026-07-21: the chat lens served a 2026-07-14 rollout
    // while seven newer ones for the same cwd sat on disk). Codex writes a NEW rollout
    // every time it starts, and resolution is "newest rollout matching this cwd" — so
    // the answer legitimately changes under a session that never itself changed. Claude
    // survives the same cache because its path is a derivation AND its hooks re-stash it;
    // Codex has neither, so nothing was ever invalidating the stale answer.
    transcriptPathStable: false,
    // `rollout-<iso>-<uuid>.jsonl`. The ISO stamp contains dashes too, so the id is
    // matched as a trailing UUID rather than by splitting on '-'. This is the same
    // value Codex shows as `Session:` in /status, and the rollout's `session_id`.
    conversationIdFromPath(p) {
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
        .exec(String(p || ''));
      return m ? m[1] : null;
    },
    // The process image that IS this agent inside a session's PTY. Used to find the
    // session's own codex among the descendants of its shell, which is what allows two
    // Codex sessions to share one working directory.
    processName: 'codex.exe',
    resolveTranscript(session, io) {
      // BEST: an id reported by the session's own Codex through scripts/codex-notify.js.
      // Exact, and the only thing that survives several Codex sessions in one folder.
      const known = findRolloutById(session && session.conversationId, io);
      if (known) return known;
      const cwd = session && session.cwd;
      if (!cwd) return '';
      // Fallbacks, in order: the rollout created when this session's own codex process
      // started (lib/codex-match.js), else the historical newest-in-cwd. Both are needed
      // — notify only reports once a turn COMPLETES, so a session mid-first-turn has no
      // id yet, and neither does one whose codex predates the notifier being installed.
      return findRolloutForCwd(cwd, io, {
        processStartMs: session.processStartMs,
        // Conversations OTHER sessions have claimed. Without this, a session that has not
        // reported yet (Codex writes no rollout until its first turn STARTS, so a freshly
        // opened one has nothing of its own) is handed the neighbour's by mtime — exactly
        // what a second session in one folder saw.
        claimedIds: session.claimedIds,
      });
    },
    // Codex writes its token usage + rate limits into the rollout on every turn, so
    // the same metrics Claude pushes are recoverable straight from the tail.
    readMetrics: parseMetricsFromTail,
    // Codex's TUI (paste_burst.rs) treats a whole read as pasted content, so `text\r`
    // in one write leaves the prompt sitting unsent in its composer. Measured against
    // codex 0.144.0: a CR split off by <=30ms still never submits, >=60ms does; 120ms
    // is the margin. Bracketed paste does not exempt it — only the gap does.
    // #147 — NO readiness marker is declared here ON PURPOSE, and the omission is
    // a decision rather than an oversight. Codex has an obvious candidate (its
    // composer's model/effort line, `gpt-5.5 high`, which CLAUDE.md already names
    // as the only reliable one) but it has NOT been measured against a real Codex
    // boot the way Claude's caret was, and an unmeasured marker is exactly what
    // #143 shipped: a sequence that looked right, was never device-verified, and
    // failed silently. Undeclared means "ready immediately" — today's behaviour
    // exactly, so Codex is no worse off than before while the gate protects
    // Claude. Run scripts/rig/probe-claude-ready.js against a codex autoCommand to
    // settle it, then declare it here and nowhere else.
    submit: Object.freeze({ gapMs: 120, crBurstsAsPaste: true }),
    // Codex's TUI interrupts on Esc too ("Esc to interrupt").
    interrupt: Object.freeze({ onEscape: true }),
    // Codex reports its own status IN BAND, as OSC 9 in the PTY stream — the channel
    // that replaces hooks here (see lib/osc9-notify.js for why hooks are unusable and
    // what was measured). Requires tui.notifications + notification_method="osc9" +
    // notification_condition="always" in config.toml; scripts/install-codex-notify.js
    // writes them, the way install-statusline.js owns Claude's status line.
    //
    // `approvalPattern` is the ONE agent-specific fact needed to read the stream: an
    // approval body is a fixed form ("Codex wants to edit 0 files", captured live),
    // while a turn-complete body is the agent's arbitrary last message. It is a
    // HEURISTIC and is documented as one — an assistant message opening with the same
    // words would be misread as an approval. Anchored to keep that as narrow as
    // possible, and it errs toward 'waiting', which is the recoverable direction: a
    // spurious waiting is cleared by the next real event or by Esc, whereas a missed
    // one is an unanswered question nobody sees.
    // #138 - metrics LOAD (readMetrics above already recovers fiveH/fiveHResetAt, so
    // the badge and the wait period render), but nothing arms: what a capped Codex
    // session looks like on the wire has not been captured, unlike Claude's. Flip
    // `arm` to true once it has (#142) - that is the whole change, here, with no consumer
    // to touch.
    autoResume: Object.freeze({ arm: false }),
    statusFromOutput: Object.freeze({
      osc9: true,
      approvalPattern: /^\s*Codex wants to\b/i,
    }),
    // #73 — `update_plan` carries the WHOLE plan every time, so the newest one in the
    // rollout is the current state and no fold (and no hook) is needed.
    taskList: Object.freeze({
      source: 'transcript',
      readPlan: taskListLib.parseCodexPlan,
    }),
  }),
});

// Every agent submits; only the details differ. The default also splits the CR: a
// session with no recorded agent is very often an interactive TUI anyway (the user
// typed `claude` at a bare shell), and both TUIs we know fold a long read into a paste.
// It is safe for a real plain shell too — splitTrailingCr only ever touches a frame
// that is text ENDING in CR (a bulk submit/paste); ordinary char-by-char typing sends a
// LONE CR, which is never split. The cost is `gapMs` before the command runs.
const DEFAULT_SUBMIT = Object.freeze({ gapMs: 150, crBurstsAsPaste: true });

// A plain shell has no turn to interrupt — Esc there belongs to whatever is running (vim,
// less, a menu) and must never be read as "the agent stopped". Only a declared agent opts in.
const DEFAULT_INTERRUPT = Object.freeze({ onEscape: false });

const AGENT_IDS = Object.freeze(Object.keys(PROVIDERS));

function isKnownAgent(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

// The submit policy for a session's agent. `null` (plain shell) and unknown ids fall back to
// DEFAULT_SUBMIT — which also splits, since ordinary char-by-char typing sends a LONE CR and
// is never touched; only a bulk frame ENDING in CR (a submit or a paste) is.
function submitPolicy(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return (p && p.submit) || DEFAULT_SUBMIT;
}

// Does an Esc keypress interrupt this agent's turn? `null` (plain shell) and unknown ids say
// no, so Esc in vim or a pager can never be mistaken for "the agent stopped".
function interruptsOnEscape(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return !!((p && p.interrupt) || DEFAULT_INTERRUPT).onEscape;
}

// The process image name that identifies this agent running inside a PTY, or null when
// the agent has no such notion. Lets the caller find a session's OWN agent process
// without knowing anything agent-specific itself.
function processNameFor(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return (p && p.processName) || null;
}

// The id of the CONVERSATION a transcript path holds, or null when this agent has no
// such notion (a plain shell) or the path doesn't look like one of its transcripts.
//
// Why this exists: a conversation needs an identity ON THE WIRE, and only Claude had
// one (`claudeSessionId`). A Codex session's conversation was anonymous, so nothing
// downstream could tell that the session had moved to a DIFFERENT conversation — the
// server cached a resolved path with nothing to invalidate it (fixed in 1.45.1 with a
// TTL), and the companion cached the turns themselves with nothing to invalidate them
// either, which is the same bug one layer up: a live terminal beside a chat lens
// showing yesterday. Both need the same missing fact, so it is derived once, here.
function conversationIdFromPath(agentId, p) {
  const provider = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  if (!provider || typeof provider.conversationIdFromPath !== 'function' || !p) return null;
  return provider.conversationIdFromPath(p);
}

// May a caller cache this agent's resolved transcript path for the life of the session?
//
// True only when the path is a pure DERIVATION (Claude: cwd + conversation id). An agent
// whose transcript is DISCOVERED — "the newest rollout matching this cwd" — can have a
// different, equally correct answer minutes later, so a cache must be re-checked or the
// chat lens serves whichever transcript happened to be newest the first time it was
// asked. Unknown ids default to STABLE so nothing about existing behaviour changes.
function transcriptPathIsStable(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return !p || p.transcriptPathStable !== false;
}

// Does this agent report its status IN BAND, as OSC 9 in its own PTY output?
//
// A plain shell (null) and every unknown id say NO, and that default is load-bearing:
// OSC 9 is a general terminal notification, so vim, a build script or `printf` can emit
// one. Only an agent that DECLARES the channel has its output read as status — nothing
// else can move a session's dot by printing an escape sequence.
function readsStatusFromOutput(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return !!(p && p.statusFromOutput && p.statusFromOutput.osc9);
}

// #147 — the composer marker proving this agent can receive a prompt, or null.
//
// null means "usable the moment the PTY exists", which is the RIGHT default and not
// merely a safe one: a plain shell (null agent) IS ready at its first prompt, and an
// unknown/future agent we cannot recognise must never be gated behind a marker that
// will never arrive — that would be a session permanently unable to submit. So the
// only sessions that wait are the ones whose provider states, from measurement, what
// waiting looks like.
function readinessMarker(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  const m = p && p.readiness && p.readiness.composer;
  return m instanceof RegExp ? m : null;
}

// May a 5h auto-resume arm for this agent (#138)?
//
// A plain shell (null) and every unknown agent say NO, and that is the correct
// default rather than a cautious one: a shell has no usage cap to be blocked by, so
// there is nothing for a resume to mean.
function armsAutoResume(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return !!(p && p.autoResume && p.autoResume.arm);
}

// The 5h usage-limit prompt this agent blocks on, or null when it has none (#138).
//
// A plain shell (null) and every unknown agent say NO, which is what keeps a logfile
// that happens to contain the phrase from making us type into someone's shell — the
// same default that governs statusFromOutput above.
function usageLimitPromptFor(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return (p && p.usageLimitPrompt) || null;
}

// Does this agent's transcript record background commands that outlive a turn?
//
// A plain shell (null) and every unknown id say NO, and that default is what keeps the
// cost at zero for them: a shell has no transcript to resolve, so nothing is read from
// disk on their behalf. Only an agent that DECLARES the channel is scanned.
function hasBackgroundTasksInTranscript(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return !!(p && p.backgroundTasksInTranscript);
}

// Classify one OSC 9 body for this agent: 'approval' (the user is being asked
// something — the session is WAITING) or 'turnComplete' (the turn ended). Returns null
// when the agent does not read status from its output at all.
function classifyStatusNotification(agentId, body) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  const cfg = p && p.statusFromOutput;
  if (!cfg || !cfg.osc9) return null;
  const re = cfg.approvalPattern;
  return re && re.test(String(body || '')) ? 'approval' : 'turnComplete';
}

// #73 — where this agent's task list comes from: 'hooks' (folded live from deltas),
// 'transcript' (the newest whole-list snapshot), or null when the agent has no task-list
// concept at all. A plain shell (null) and every unknown id answer null, so nothing is
// parsed or remembered on their behalf.
function taskListSource(agentId) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  return (p && p.taskList && p.taskList.source) || null;
}

// One tool call from this agent's hook stream -> a normalised task-list delta, or null
// when the tool is unrelated (which is almost every call). Only agents whose task list
// is hook-sourced parse anything.
//
// `agentId` may be null, and that is the normal case at the hook layer: a hook arrives as
// a bare HTTP post carrying a session id, and asking the worker which agent that session
// runs would cost an RPC on EVERY tool call to answer a question the payload already
// settles — the tool names are themselves agent-specific. So a null id means "try every
// hook-sourced provider", the same discovery `resolveTranscriptFor` does. A KNOWN id is
// still authoritative and consults only that provider.
function parseTaskDelta(agentId, toolName, toolInput, toolResponse) {
  const ids = isKnownAgent(agentId) ? [agentId] : AGENT_IDS;
  for (const id of ids) {
    const cfg = PROVIDERS[id].taskList;
    if (!cfg || cfg.source !== 'hooks' || typeof cfg.parseDelta !== 'function') continue;
    const delta = cfg.parseDelta(toolName, toolInput, toolResponse);
    if (delta) return delta;
  }
  return null;
}

// Recover this agent's CURRENT task list from a slice of its transcript. Returns null
// for "unknown" — which callers must not confuse with "the list is empty", or a long
// turn that pushes the last snapshot out of the read window would blank a live panel.
function readTaskListFromText(agentId, text) {
  const p = isKnownAgent(agentId) ? PROVIDERS[agentId] : null;
  const cfg = p && p.taskList;
  if (!cfg || cfg.source !== 'transcript' || typeof cfg.readPlan !== 'function') return null;
  return cfg.readPlan(text);
}

// Which agent's account quota does a PUSHED status report describe? Exactly one provider
// pushes (Claude); a report that arrives on POST /api/claude-status is that agent's, even
// when the session carrying it declares no agent. Asking the registry keeps the attribution
// declarative — server.js never hardcodes an agent id (#56).
function statusPushAgent() {
  return AGENT_IDS.find((id) => PROVIDERS[id].pushesStatus === true) || null;
}

// Unknown ids fall back to the default rather than throwing: a session persisted
// before this field existed, or written by a newer server, must still render.
function getAdapter(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_AGENT];
}

// The agent catalogue the clients render (picker entries, per-agent colours).
function listProviders() {
  return AGENT_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id: p.id, label: p.label, color: p.color };
  });
}

// Which agent does this shell command launch, or null when it launches none (a plain
// shell). Null is a real answer, not a failure: a `pwsh` session must not be labelled
// — or coloured, or scanned for a Claude conversation id — as though it were Claude.
function detectAgentFromCommand(cmd) {
  for (const id of AGENT_IDS) {
    if (PROVIDERS[id].detect(cmd)) return id;
  }
  return null;
}

// Does this command launch that specific agent? Callers that need "is this a Claude
// session" ask here rather than re-implementing the program-name regex.
function commandLaunches(agentId, cmd) {
  return isKnownAgent(agentId) ? PROVIDERS[agentId].detect(cmd) : false;
}

// The agent a session RUNS: the explicit pick made at create time wins, else it is
// inferred from the launch command, else null for a plain shell. Two-line composition,
// but it belongs here because it is the answer every endpoint owes about one session —
// and #119 is what happens when it lives in only one of them: `GET /api/sessions`
// resolved it (via the worker's sessionSummary) while `POST /api/sessions` echoed back
// only the explicit pick, so a session created with the picker on Auto came back
// `agent: null`. The companion's Chat gate reads that field, so the new session opened
// with no chat controls until a re-select re-read it from the list.
function resolveAgent(explicit, cmd) {
  if (isKnownAgent(explicit)) return explicit;
  return detectAgentFromCommand(cmd || '');
}

// Locate a session's transcript.
//
// `opts.discover` (default true) decides whether providers OTHER than `preferred` may
// be consulted when the preferred one finds nothing. Callers pass false when the agent
// was chosen EXPLICITLY: showing a Codex conversation for a session the user declared
// to be Claude is worse than showing none. It stays true for sessions whose agent was
// never recorded (the user typed `codex` at a plain shell prompt), so their transcript
// is still found.
//
// `makeIo(provider)` supplies that provider's rooted io; `validate(path)` re-applies
// the containment gate and returns '' for anything outside the provider's root.
// Returns { path, agent } — path '' when no provider found one.
function resolveTranscriptFor(session, preferred, makeIo, validate, opts = {}) {
  const discover = opts.discover !== false;
  const rest = discover ? AGENT_IDS.filter((id) => id !== preferred) : [];
  const order = [preferred, ...rest].filter(isKnownAgent);
  for (const id of order) {
    const provider = PROVIDERS[id];
    let candidate = '';
    try { candidate = provider.resolveTranscript(session, makeIo(provider)) || ''; } catch { candidate = ''; }
    if (!candidate) continue;
    const safe = validate(candidate);
    if (safe) return { path: safe, agent: id };
  }
  return { path: '', agent: isKnownAgent(preferred) ? preferred : DEFAULT_AGENT };
}

module.exports = {
  usageLimitPromptFor, armsAutoResume,
  getAdapter,
  isKnownAgent,
  detectAgentFromCommand,
  commandLaunches,
  resolveAgent,
  resolveTranscriptFor,
  listProviders,
  statusPushAgent,
  submitPolicy,
  interruptsOnEscape,
  readsStatusFromOutput,
  readinessMarker,
  hasBackgroundTasksInTranscript,
  classifyStatusNotification,
  transcriptPathIsStable,
  conversationIdFromPath,
  processNameFor,
  taskListSource,
  parseTaskDelta,
  readTaskListFromText,
  DEFAULT_AGENT,
  DEFAULT_SUBMIT,
  DEFAULT_INTERRUPT,
  AGENT_IDS,
};
