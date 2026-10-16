// Restore-time command resolution.
//
// When the pty-worker restarts, it restores each persisted session and re-runs
// its command at a fresh shell prompt. For Claude sessions we want the restored
// terminal to reattach to *its own* conversation — but only when we actually
// know which conversation that is.
//
// #23 — "New session in a folder unexpectedly resumes the last Claude session":
// the previous logic appended `--continue` to any claude session whose own
// session id we hadn't recorded yet. `claude --continue` resumes the
// MOST-RECENTLY-MODIFIED conversation in the cwd, so a freshly-created session
// (or one sharing a cwd with older sessions) would hijack a DIFFERENT/last
// conversation and come up "Resumed" without the user asking. Plain `claude`
// never auto-resumes, so dropping the implicit `--continue` makes an
// unknown-id restore start fresh — the correct, non-surprising behavior. We
// still:
//   - resume the exact conversation with `--resume <id>` when we know the id, and
//   - honor an explicit `--continue`/`--resume` the user typed themselves.
//
// #360 - a resume also drops the PROMPT the session was launched with. An
// agent-started session carries its task as a positional argument
// (`claude ... "Read x.md, then execute it."`); kept on the resume line, that task
// was submitted AGAIN into the conversation that had already done it, on every cold
// restart. With no known id the command is left whole: restore then starts fresh,
// and a fresh start of a prompted session is exactly the launch it was created with.
const agents = require('./agents');
const { withoutLaunchPrompt } = require('./launch-prompt');

const isClaudeProgram = (word) => agents.commandLaunches('claude', word);

function resolveRestoreRunCommand(cfg) {
  const original = (cfg && cfg.autoCommand) || '';
  let runCmd = original;
  if (runCmd && /\bclaude\b/i.test(runCmd)) {
    if (cfg.claudeSessionId) {
      // Known conversation: always restore with the canonical `--resume <id>`.
      // Strip any existing --continue / --resume <id?> first so we don't end up
      // with two flags. The user-facing autoCommand in sessions.json is left
      // untouched (persisted separately), so the UI keeps showing what they typed.
      runCmd = withoutLaunchPrompt(runCmd, agents.launchGrammar('claude'), isClaudeProgram)
        .replace(/\s*--resume\s+\S+/g, '')
        .replace(/\s*--continue\b/g, '')
        .trimEnd() + ' --resume ' + cfg.claudeSessionId;
    }
    // else: no known Claude session id for this terminal — DO NOT inject
    // `--continue` (#23). Leave the command exactly as the user wrote it: a
    // plain `claude` starts fresh; an explicit `--continue`/`--resume` they
    // typed themselves is already in runCmd and is preserved verbatim.
  }
  return runCmd;
}

module.exports = { resolveRestoreRunCommand };
