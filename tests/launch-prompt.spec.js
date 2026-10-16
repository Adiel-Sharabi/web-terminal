// @ts-check
// Unit tests for lib/launch-prompt.js (#360): finding the PROMPT a launch command
// carries as a positional argument, so a resume does not submit it a second time.

const { test, expect } = require('@playwright/test');
const { withoutLaunchPrompt } = require('../lib/launch-prompt');
const agents = require('../lib/agents');

const grammar = agents.launchGrammar('claude');
const isClaude = (t) => agents.commandLaunches('claude', t);
const strip = (c) => withoutLaunchPrompt(c, grammar, isClaude);

test.describe('withoutLaunchPrompt (#360)', () => {
  test('the reported shape: a quoted prompt after a BARE flag is removed', () => {
    expect(strip('claude --dangerously-skip-permissions "Read C:/temp/bh.md in full, then execute it. Do not stop to ask."'))
      .toBe('claude --dangerously-skip-permissions');
    expect(strip("claude 'do the thing'")).toBe('claude');
    expect(strip('claude hello')).toBe('claude');
    // Escaped quotes inside the prompt do not end it early.
    expect(strip('claude -c "say \\"hi\\" twice" --verbose')).toBe('claude -c --verbose');
  });

  test('a value-taking flag keeps its value, quoted or not', () => {
    expect(strip('claude --model opus "go"')).toBe('claude --model opus');
    expect(strip('claude --append-system-prompt "be terse" --verbose')).toBe('claude --append-system-prompt "be terse" --verbose');
    expect(strip('claude --permission-mode=plan "go"')).toBe('claude --permission-mode=plan');
    expect(strip('claude --resume abc "go"')).toBe('claude --resume abc');
  });

  test('an UNKNOWN flag is assumed to take a value - the safe direction', () => {
    // Guessing "bare" would strip a real value and break the launch; guessing "value"
    // at worst leaves today's behaviour (the prompt resubmitted).
    expect(strip('claude --some-future-flag "x"')).toBe('claude --some-future-flag "x"');
    expect(strip('claude -rf "x"')).toBe('claude -rf "x"');
  });

  test('a variadic flag consumes every following non-flag word, as commander does', () => {
    expect(strip('claude --add-dir C:/a C:/b')).toBe('claude --add-dir C:/a C:/b');
    expect(strip('claude --add-dir C:/a --verbose "go"')).toBe('claude --add-dir C:/a --verbose');
  });

  test('`--` makes everything after it positional', () => {
    expect(strip('claude --verbose -- "--not-a-flag"')).toBe('claude --verbose --');
  });

  test('words outside claude\'s own argv are never touched', () => {
    expect(strip('cd "C:/my dir" && claude "go"')).toBe('cd "C:/my dir" && claude');
    expect(strip('claude "go" && echo done')).toBe('claude && echo done');
    expect(strip('claude "go" > out.log')).toBe('claude > out.log');
    expect(strip('C:/tools/claude.exe "go"')).toBe('C:/tools/claude.exe');
  });

  test('nothing to strip, or nothing safe to parse, returns the command unchanged', () => {
    expect(strip('claude --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions');
    expect(strip('claude "unbalanced')).toBe('claude "unbalanced');
    expect(strip('echo "hi"')).toBe('echo "hi"');
    expect(strip('')).toBe('');
    // No declared grammar: never strip (never apply Claude's grammar to another agent).
    expect(withoutLaunchPrompt('claude "go"', null, isClaude)).toBe('claude "go"');
    expect(agents.launchGrammar('codex')).toBeNull();
    expect(agents.launchGrammar(null)).toBeNull();
  });
});
