// The PROMPT a launch command carries as a positional argument (#360).
//
// An agent-started session is created with its task on the command line:
//
//     claude --dangerously-skip-permissions "Read C:/temp/x.md, then execute it."
//
// That prompt belongs to the FIRST launch only. Every later launch that puts the
// session back on its conversation - a worker restore (`lib/restore-command.js`), the
// Reopen of a closed session (`lib/session-brief.js`), a hand-off successor
// (`lib/handoff.js`) - used to keep it, so the resumed agent was handed its task again
// on top of the conversation that had already done it. Observed on adiel-home
// 2026-10-16: a cold restart re-prompted "Bug Hunter - follow-up" with its launch task.
//
// Which words are the prompt depends on which flags take a value, and that is the
// AGENT's grammar, declared in the registry (`lib/agents.js` `launch`), never here.
// The walk mirrors commander, which is what parses Claude's argv: a bare flag takes
// nothing, a value flag (required or optional) takes the next non-flag word, a
// variadic flag takes every following non-flag word, `--flag=value` is one word, and
// after `--` everything is positional.
//
// EVERY DOUBT RESOLVES TO "LEAVE IT". A flag the grammar does not list is assumed to
// take a value: guessing "bare" would strip a real value and break the launch, while
// guessing "value" at worst keeps today's behaviour.
//
// AND THE RESULT IS RUN BY A SHELL, so a command this tokenizer cannot read EXACTLY as
// bash does is not touched at all. That is a security rule, not tidiness: review of the
// first cut found that a word-splitter which ignores `#` strips the comment's words and
// thereby UN-comments what followed (`claude "go" # n; echo x > F` became
// `claude; echo x > F`, which runs), and that `$'a\'...'` - one word to bash - was split
// at the escaped quote with the same result. So `tokenize` refuses (returns null) on
// anything whose meaning depends on more than quotes and operators: a comment, `$`
// (variables, `$'...'`, `$(...)`, also inside double quotes, where `$(` carries its own
// quoting), backticks, parentheses and braces, redirections, a backslash-newline, and
// an unbalanced quote. Refusing costs nothing: the command then runs exactly as before.

const OPERATORS = new Set([';', '|', '&', '\n']);
// Unquoted characters whose meaning this tokenizer does not model.
const REFUSE_UNQUOTED = new Set(['$', '`', '(', ')', '{', '}', '<', '>']);
// A word that sets a variable, and commands that run the next word: neither ends the
// search for the program word.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['npx', 'env', 'exec', 'command']);

/// Shell words with their source spans: `{ text, start, end, op }`. `text` is the word
/// with its quoting removed; `op` marks `;`, `|`, `&`, `&&`, `||` and a newline. null
/// when the command holds anything it cannot read exactly as bash does (see above).
function tokenize(cmd) {
  const out = [];
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const ch = cmd[i];
    if (OPERATORS.has(ch)) {
      const j = (ch === '|' || ch === '&') && cmd[i + 1] === ch ? i + 2 : i + 1;
      out.push({ text: cmd.slice(i, j), start: i, end: j, op: true });
      i = j;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (cmd[i] === '#') return null;
    let text = '';
    while (i < n && !/\s/.test(cmd[i]) && !OPERATORS.has(cmd[i])) {
      const c = cmd[i];
      if (REFUSE_UNQUOTED.has(c)) return null;
      if (c === "'") {
        const e = cmd.indexOf("'", i + 1);
        if (e < 0) return null;
        text += cmd.slice(i + 1, e);
        i = e + 1;
      } else if (c === '"') {
        i++;
        while (i < n && cmd[i] !== '"') {
          if (cmd[i] === '$' || cmd[i] === '`') return null;
          if (cmd[i] === '\\' && i + 1 < n && '"\\$`'.includes(cmd[i + 1])) { text += cmd[i + 1]; i += 2; }
          else text += cmd[i++];
        }
        if (i >= n) return null;
        i++;
      } else if (c === '\\' && i + 1 < n) {
        if (cmd[i + 1] === '\n' || cmd[i + 1] === '\r') return null;
        text += cmd[i + 1];
        i += 2;
      } else {
        text += c;
        i++;
      }
    }
    out.push({ text, start, end: i, op: false });
  }
  return out;
}

/// Index of the agent's program word, or -1. Only a word in COMMAND POSITION counts -
/// first in the line or after an operator, past any `NAME=value` and `npx`/`env`/`exec`
/// - because the matcher accepts any word ending in the program name, and a path
/// argument such as `git -C ~/work/claude pull` is not a launch (review of the first
/// cut: it stripped `pull` there and broke the git command).
function programIndex(toks, isProgram) {
  let atStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.op) { atStart = true; continue; }
    if (!atStart) continue;
    if (ASSIGNMENT.test(t.text) || WRAPPERS.has(t.text.toLowerCase())) continue;
    if (isProgram(t.text)) return i;
    atStart = false;
  }
  return -1;
}

/// The positional words of the agent's own argv, as source spans. [] when there are
/// none, the command does not launch the agent, or it cannot be parsed.
function launchPromptSpans(cmd, grammar, isProgram) {
  const toks = tokenize(cmd);
  if (!toks) return [];
  let k = programIndex(toks, isProgram);
  if (k < 0) return [];
  const bare = new Set(grammar.bareFlags || []);
  const variadic = new Set(grammar.variadicFlags || []);
  const spans = [];
  let mode = null; // 'value' | 'variadic' | 'rest'
  for (k++; k < toks.length; k++) {
    const t = toks[k];
    // The agent's argv ends at an operator; nothing past it is ours.
    if (t.op) break;
    if (mode !== 'rest' && t.text.length > 1 && t.text[0] === '-') {
      if (t.text === '--') { mode = 'rest'; continue; }
      const name = t.text.split('=')[0];
      if (t.text.includes('=') || bare.has(name)) mode = null;
      else mode = variadic.has(name) ? 'variadic' : 'value';
      continue;
    }
    if (mode === 'value') { mode = null; continue; }
    if (mode === 'variadic') continue;
    spans.push(t);
  }
  return spans;
}

/// `cmd` without the agent's positional words. `isProgram(word)` says whether a word
/// is the agent's executable. No grammar means no strip: an agent that declares none
/// gives no basis to say which words are safe to remove.
function withoutLaunchPrompt(cmd, grammar, isProgram) {
  if (typeof cmd !== 'string' || !cmd || !grammar) return cmd;
  let out = cmd;
  for (const s of launchPromptSpans(cmd, grammar, isProgram).reverse()) {
    let a = s.start;
    while (a > 0 && (out[a - 1] === ' ' || out[a - 1] === '\t')) a--;
    out = out.slice(0, a) + out.slice(s.end);
  }
  return out;
}

module.exports = { withoutLaunchPrompt, tokenize };
