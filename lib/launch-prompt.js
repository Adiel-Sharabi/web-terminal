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
// guessing "value" at worst keeps today's behaviour. A command that will not tokenize
// (an unbalanced quote) is returned unchanged.

const OPERATORS = new Set([';', '|', '&', '\n']);

/// Shell words with their source spans: `{ text, start, end, op }`. `text` is the word
/// with its quoting removed; `op` marks `;`, `|`, `&`, `&&`, `||` and a newline. null
/// when a quote is never closed.
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
    let text = '';
    while (i < n && !/\s/.test(cmd[i]) && !OPERATORS.has(cmd[i])) {
      const c = cmd[i];
      if (c === "'") {
        const e = cmd.indexOf("'", i + 1);
        if (e < 0) return null;
        text += cmd.slice(i + 1, e);
        i = e + 1;
      } else if (c === '"') {
        i++;
        while (i < n && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < n && '"\\$`'.includes(cmd[i + 1])) { text += cmd[i + 1]; i += 2; }
          else text += cmd[i++];
        }
        if (i >= n) return null;
        i++;
      } else if (c === '\\' && i + 1 < n) {
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

/// The positional words of the agent's own argv, as source spans. [] when there are
/// none, the command does not launch the agent, or it cannot be parsed.
function launchPromptSpans(cmd, grammar, isProgram) {
  const toks = tokenize(cmd);
  if (!toks) return [];
  let k = toks.findIndex((t) => !t.op && isProgram(t.text));
  if (k < 0) return [];
  const bare = new Set(grammar.bareFlags || []);
  const variadic = new Set(grammar.variadicFlags || []);
  const spans = [];
  let mode = null; // 'value' | 'variadic' | 'rest'
  for (k++; k < toks.length; k++) {
    const t = toks[k];
    // The agent's argv ends at an operator or a redirection; nothing past it is ours.
    if (t.op || /^\d*[<>]/.test(cmd.slice(t.start, t.end))) break;
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
