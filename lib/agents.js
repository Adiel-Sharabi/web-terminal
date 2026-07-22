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
//   submit                 how this agent's TUI reads a submitted prompt:
//                            gapMs           delay before the submit CR is written
//                            crBurstsAsPaste the TUI folds every byte of ONE read into a
//                                            paste, so a CR arriving alongside its text is
//                                            content (a newline in the composer), not Enter
//                                            — the CR must arrive in a write of its own.
//
// The `io` handed to resolveTranscript is injected so providers stay free of `fs`:
//   { root, join, listRollouts(), readFirstLine(path) }
const claudeParser = require('./transcript');
const codexParser = require('./transcript-codex');
const { findRolloutForCwd } = require('./codex-sessions');
const { parseMetricsFromTail } = require('./metrics-codex');

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
    resolveTranscript(session, io) {
      const cwd = session && session.cwd;
      const sid = session && session.agentSessionId;
      if (!cwd || !sid) return '';
      return io.join(io.root, claudeParser.claudeProjectDirName(cwd), sid + '.jsonl');
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
    resolveTranscript(session, io) {
      const cwd = session && session.cwd;
      if (!cwd) return '';
      return findRolloutForCwd(cwd, io);
    },
    // Codex writes its token usage + rate limits into the rollout on every turn, so
    // the same metrics Claude pushes are recoverable straight from the tail.
    readMetrics: parseMetricsFromTail,
    // Codex's TUI (paste_burst.rs) treats a whole read as pasted content, so `text\r`
    // in one write leaves the prompt sitting unsent in its composer. Measured against
    // codex 0.144.0: a CR split off by <=30ms still never submits, >=60ms does; 120ms
    // is the margin. Bracketed paste does not exempt it — only the gap does.
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
    statusFromOutput: Object.freeze({
      osc9: true,
      approvalPattern: /^\s*Codex wants to\b/i,
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
  getAdapter,
  isKnownAgent,
  detectAgentFromCommand,
  commandLaunches,
  resolveTranscriptFor,
  listProviders,
  statusPushAgent,
  submitPolicy,
  interruptsOnEscape,
  readsStatusFromOutput,
  classifyStatusNotification,
  transcriptPathIsStable,
  conversationIdFromPath,
  DEFAULT_AGENT,
  DEFAULT_SUBMIT,
  DEFAULT_INTERRUPT,
  AGENT_IDS,
};
