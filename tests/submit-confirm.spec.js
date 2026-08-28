// @ts-check
// #179 — the pure rules behind "did that submit actually reach the agent?".
//
// The gates matter more than the happy path here. A false "your prompt didn't land" on
// a prompt that DID land is worse than the silence it replaces, because it teaches the
// user to ignore the notice on the one occasion it is true. So most of what is pinned
// below is the refusals.
const { test, expect } = require('@playwright/test');
const {
  shouldWatchSubmit,
  confirmsSubmit,
  createSubmitLineTracker,
} = require('../lib/submit-confirm');

const POLICY = { timeoutMs: 8000 };
/** Every gate satisfied — each test below flips exactly one thing. */
const OK = { hookStatus: true, status: 'idle', fromClient: true, isCommand: false };

test.describe('shouldWatchSubmit — the gates', () => {
  test('watches an ordinary client submit on a hook-reporting session', () => {
    expect(shouldWatchSubmit(POLICY, OK)).toBe(true);
  });

  test('a provider that declares nothing is never watched', () => {
    // Codex and plain shells. Undeclared means today's behaviour, unchanged — the
    // same convention lib/agents.js `readiness` follows.
    expect(shouldWatchSubmit(null, OK)).toBe(false);
    expect(shouldWatchSubmit(undefined, OK)).toBe(false);
    expect(shouldWatchSubmit({}, OK)).toBe(false);
    expect(shouldWatchSubmit({ timeoutMs: 0 }, OK)).toBe(false);
  });

  test('a session that has never delivered a hook is never watched', () => {
    // THE gate that keeps a box without hooks installed silent. Without it, every
    // submit on such a box would report as lost — the feature would be pure noise
    // exactly where it can prove nothing.
    expect(shouldWatchSubmit(POLICY, { ...OK, hookStatus: false })).toBe(false);
  });

  test("the worker's own submits are never watched", () => {
    // auto-resume's `continue`, the API-error ladder's /compact, /rename. Nobody typed
    // them and there is no draft to hand back.
    expect(shouldWatchSubmit(POLICY, { ...OK, fromClient: false })).toBe(false);
  });

  test('a slash command is never watched — it legitimately starts no turn', () => {
    // /usage, /config, /help. Flagging these would fire the notice on exactly the
    // views the user opened on purpose.
    expect(shouldWatchSubmit(POLICY, { ...OK, isCommand: true })).toBe(false);
  });

  test('a session already WORKING is never watched', () => {
    // The composer queues a prompt behind the running turn, and the agent need not
    // report it until that turn ends — which can be minutes. The submit plainly
    // reached a live composer; a timer here could only lie.
    expect(shouldWatchSubmit(POLICY, { ...OK, status: 'working' })).toBe(false);
  });

  test('a session WAITING on the user IS watched', () => {
    // This is the reported bug, not an exception to it: a session sitting on a
    // permission prompt or a question swallows prose typed at it. #112 established
    // that such a session is `waiting`, not `working`.
    expect(shouldWatchSubmit(POLICY, { ...OK, status: 'waiting' })).toBe(true);
  });

  test('an idle agent session is watched — that is the whole point', () => {
    expect(shouldWatchSubmit(POLICY, { ...OK, status: 'idle' })).toBe(true);
  });
});

test.describe('confirmsSubmit', () => {
  test('evidence that arrived after the submit confirms it', () => {
    expect(confirmsSubmit(1000, 1001)).toBe(true);
    expect(confirmsSubmit(1000, 1000)).toBe(true);
  });

  test('evidence from BEFORE the submit vouches for nothing', () => {
    // A hook still in flight from the previous turn must not confirm this one.
    expect(confirmsSubmit(1000, 999)).toBe(false);
  });

  test('missing timestamps confirm nothing', () => {
    expect(confirmsSubmit(0, 1000)).toBe(false);
    expect(confirmsSubmit(1000, 0)).toBe(false);
    expect(confirmsSubmit(null, null)).toBe(false);
  });
});

test.describe('createSubmitLineTracker — prompt or slash command?', () => {
  test('ordinary prose is a prompt', () => {
    const t = createSubmitLineTracker();
    t.push('fix the failing test');
    expect(t.isCommand).toBe(false);
  });

  test('a line beginning with / is a command', () => {
    const t = createSubmitLineTracker();
    t.push('/usage');
    expect(t.isCommand).toBe(true);
  });

  test('THE CASE THE FRAME CANNOT SEE: a live /-line streamed one char at a time', () => {
    // The compose bar streams a `/`-line to the PTY as you type so the agent's slash
    // menu narrows (#55), which leaves the submit frame a BARE CR carrying no text.
    // Reading the frame alone would watch /usage and fire the notice on it.
    const t = createSubmitLineTracker();
    for (const c of '/usage') t.push(c);
    expect(t.isCommand).toBe(true);
  });

  test('a CR ends the line, and what follows starts the next one', () => {
    const t = createSubmitLineTracker();
    t.push('/compact');
    expect(t.isCommand).toBe(true);
    t.push('\r');
    expect(t.isCommand).toBe(false);
    t.push('now a real prompt');
    expect(t.isCommand).toBe(false);
  });

  test('text arriving in the SAME chunk as the CR belongs to the next line', () => {
    const t = createSubmitLineTracker();
    t.push('/usage\rhello');
    expect(t.line).toBe('hello');
    expect(t.isCommand).toBe(false);
  });

  test('bracketed-paste markers are not part of the line', () => {
    // A multi-line prompt is wrapped in ESC[200~ ... ESC[201~ before its CR.
    const t = createSubmitLineTracker();
    t.push('\x1b[200~/not a command, just text starting with a slash\x1b[201~');
    expect(t.line.startsWith('/')).toBe(true);
    // ...and it IS reported as a command. Documented consequence, not an oversight:
    // the rule is textual, and a pasted line that opens with `/` is indistinguishable
    // from a typed one. It errs toward NOT watching, which is the silent direction.
    expect(t.isCommand).toBe(true);
  });

  test('cursor keys and other escapes are not part of the line', () => {
    const t = createSubmitLineTracker();
    t.push('hello');
    t.push('\x1b[D');       // left arrow
    t.push('\x1b[A');       // up arrow
    expect(t.line).toBe('hello');
    expect(t.isCommand).toBe(false);
  });

  test('leading whitespace does not hide a command', () => {
    const t = createSubmitLineTracker();
    t.push('   /usage');
    expect(t.isCommand).toBe(true);
  });

  test('a Buffer is accepted, as the PTY write path supplies', () => {
    const t = createSubmitLineTracker();
    t.push(Buffer.from('/status', 'utf8'));
    expect(t.isCommand).toBe(true);
  });

  test('a runaway line is bounded', () => {
    const t = createSubmitLineTracker();
    t.push('x'.repeat(20000));
    expect(t.line.length).toBeLessThanOrEqual(4096);
  });

  test('reset clears the pending line', () => {
    const t = createSubmitLineTracker();
    t.push('/usage');
    t.reset();
    expect(t.isCommand).toBe(false);
  });
});
