// The per-command lens policy (#131) — the SSOT for "where should the user be
// standing while a slash command runs, and after it finishes".
//
// WHY THIS IS A TABLE AND NOT A RULE. The commands do not divide by anything you
// can compute from their name or their text. They divide by WHAT THEY WRITE, and
// that was MEASURED across the 609 Claude transcripts on this machine (9 distinct
// commands, 129 invocations):
//
//   /issue, /goal, /issue-hunter, /caveman:caveman   -> a real `user` turn plus a
//        full agent turn. The chat lens already renders these completely
//        (parseCommandInvocation, #32). Nothing to fix; stay in Chat.
//
//   /compact  -> a `system` line with subtype "compact_boundary" + compactMetadata,
//        AND a server-published `compacting` flag (#65, #115, #129). Chat has real
//        state and a real indicator. Stay in Chat.
//
//   /status, /usage, /model, /login, /exit  -> a `system` line with subtype
//        "local_command" whose ENTIRE recorded result is the literal string
//        "Settings dialog dismissed". The panel, the bars and the numbers are TUI
//        paint and reach no turn at any quality of client. There is nothing for
//        chat to render, so leaving the user in Chat strands them looking at an
//        invocation with no result — the reported bug. Pin to Terminal.
//
//   /clear  -> a `system` local_command line; the conversation is reset. Terminal,
//        for the same reason: chat has nothing to show for it.
//
// So the split is real, observable, and NOT derivable at typing time — you cannot
// know what a command will write before it writes it. Hence a table.
//
// THE DEFAULT IS 'chat', AND THAT IS A MEASURED CHOICE TOO. The pinned set below
// is the FINITE list of Claude's own built-ins. Everything else a user can type is
// a SKILL, and a skill by construction starts a real agent turn — which is exactly
// what chat renders best. Defaulting the open-ended class to Chat is therefore
// right far more often than defaulting it to Terminal, and a skill's own turn is
// visible the moment it lands.
//
// Published over GET /api/commands, the way lib/agents.js is published over
// /api/agents, so adding or reclassifying a command needs NO client release.
// An `if (command === '/compact')` anywhere else means the change is in the wrong
// file — add a row here instead.

// Where the user should stand for the duration of a command, keyed by the command
// name WITHOUT its leading slash, lower-cased.
//
// `writes` is not consumed by any client — it is the evidence for the `lens` call,
// kept beside it so a future reader can check the classification against real
// transcripts rather than re-deriving the reasoning.
const COMMANDS = {
  // Built-ins whose whole result is TUI paint. The transcript records only that a
  // dialog was dismissed, so Chat would show an invocation and no answer.
  status: { lens: 'terminal', writes: 'tui-only' },
  usage: { lens: 'terminal', writes: 'tui-only' },
  context: { lens: 'terminal', writes: 'tui-only' },
  cost: { lens: 'terminal', writes: 'tui-only' },
  doctor: { lens: 'terminal', writes: 'tui-only' },
  model: { lens: 'terminal', writes: 'tui-only' },
  login: { lens: 'terminal', writes: 'tui-only' },
  logout: { lens: 'terminal', writes: 'tui-only' },
  config: { lens: 'terminal', writes: 'tui-only' },
  help: { lens: 'terminal', writes: 'tui-only' },
  exit: { lens: 'terminal', writes: 'tui-only' },
  quit: { lens: 'terminal', writes: 'tui-only' },
  // Resets the conversation — chat has nothing to show for it either.
  clear: { lens: 'terminal', writes: 'reset' },
  // The exception the table exists to hold without a branch: a built-in that DOES
  // write transcript state, and has a first-class chat indicator (#65).
  compact: { lens: 'chat', writes: 'transcript-state' },
};

// Everything not listed is a skill, and a skill starts a real agent turn.
const DEFAULT_LENS = 'chat';

// Strip the leading slash and any arguments: the policy is a property of the
// COMMAND, not of what was typed after it. Namespaced skills (`/caveman:caveman`,
// seen in the real data) keep their full name — only the slash and args go.
function commandName(text) {
  if (typeof text !== 'string') return '';
  const m = /^\s*\/([^\s]*)/.exec(text);
  return m ? m[1].toLowerCase() : '';
}

// The lens a command should run in. Unknown -> DEFAULT_LENS, never a throw: a
// newer Claude build can add a command at any time, and a slash command the table
// has never heard of must still behave sensibly.
function lensFor(text) {
  const entry = COMMANDS[commandName(text)];
  return entry ? entry.lens : DEFAULT_LENS;
}

// Does the user need to stay in the terminal to see this command's result?
// The one question the client actually asks.
function pinsTerminal(text) {
  return lensFor(text) === 'terminal';
}

// The catalogue the clients consume (mirrors agentsLib.listProviders()).
function listCommands() {
  return Object.keys(COMMANDS)
    .sort()
    .map((name) => ({ name, lens: COMMANDS[name].lens, writes: COMMANDS[name].writes }));
}

module.exports = { COMMANDS, DEFAULT_LENS, commandName, lensFor, pinsTerminal, listCommands };
