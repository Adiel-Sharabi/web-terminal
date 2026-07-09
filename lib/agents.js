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
//   readMetrics(tailText)  OPTIONAL. Recover { ctx, fiveH, sevenD, model, effort } from
//                          the tail of this agent's transcript. Present only for agents
//                          that RECORD their usage (Codex). Claude instead PUSHES its
//                          status line to POST /api/claude-status, so it has none here
//                          and server.js keeps reading that live map for Claude.
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
    resolveTranscript(session, io) {
      const cwd = session && session.cwd;
      const sid = session && session.agentSessionId;
      if (!cwd || !sid) return '';
      return io.join(io.root, claudeParser.claudeProjectDirName(cwd), sid + '.jsonl');
    },
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
    resolveTranscript(session, io) {
      const cwd = session && session.cwd;
      if (!cwd) return '';
      return findRolloutForCwd(cwd, io);
    },
    // Codex writes its token usage + rate limits into the rollout on every turn, so
    // the same metrics Claude pushes are recoverable straight from the tail.
    readMetrics: parseMetricsFromTail,
  }),
});

const AGENT_IDS = Object.freeze(Object.keys(PROVIDERS));

function isKnownAgent(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
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
  DEFAULT_AGENT,
  AGENT_IDS,
};
