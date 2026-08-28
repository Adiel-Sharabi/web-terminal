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

  test('a session mid-COMPACTION is never watched', () => {
    // The `working` gate's twin, and invisible to it: #129 measured that Claude reports
    // IDLE part-way through a /compact, and no hook fires between PreCompact and the
    // resumption. The prompt is queued and answered when compaction ends, so reporting
    // it lost would hand back words that are about to be used. Found in review.
    expect(shouldWatchSubmit(POLICY, { ...OK, status: 'idle', compacting: true })).toBe(false);
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

  test('A PASTE IS NOT TYPING: its body never becomes the line', () => {
    // Found in review, and it made the gate PLATFORM-DEPENDENT. The images-only submit
    // (#87) pastes the staged image's PATH, so a POSIX '/home/...' read as a slash
    // command while a Windows 'C:\\Users\\...' read as ordinary text — the same action,
    // two answers. A multi-line prompt travels as one paste too, and must read as a
    // prompt rather than as whatever its first character happens to be.
    const posix = createSubmitLineTracker();
    posix.push('\x1b[200~/home/u/shot.png\x1b[201~');
    expect(posix.isCommand).toBe(false);

    const win = createSubmitLineTracker();
    win.push('\x1b[200~C:\\Users\\u\\shot.png\x1b[201~');
    expect(win.isCommand).toBe(false);
    expect(win.isCommand).toBe(posix.isCommand);   // the platform must not decide this

    const multiline = createSubmitLineTracker();
    multiline.push('\x1b[200~/etc is where it lives\rand a second line\x1b[201~');
    expect(multiline.isCommand).toBe(false);
  });

  test('an unterminated paste does not leak its body into the next line', () => {
    const t = createSubmitLineTracker();
    t.push('\x1b[200~/some/path/that/never/closes');
    expect(t.isCommand).toBe(false);
  });

  test('typing AROUND a paste is still tracked', () => {
    const t = createSubmitLineTracker();
    t.push('/read \x1b[200~/home/u/notes.txt\x1b[201~ please');
    expect(t.isCommand).toBe(true);   // the `/read` the user typed, not the pasted path
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

  test('THE CAP KEEPS THE HEAD: a long slash command is still a command', () => {
    // Found in review. The first cut kept the last 4096 characters, which threw the
    // leading `/` away — so `/compact <5000 chars>` reported as a PROMPT and got
    // watched, firing the notice on a view the user opened deliberately. Only the first
    // character decides the answer.
    const t = createSubmitLineTracker();
    t.push('/compact ' + 'x'.repeat(5000));
    expect(t.isCommand).toBe(true);
    expect(t.line.length).toBeLessThanOrEqual(4096);
  });

  test('...and the mirror: a long PROMPT is not turned into a command by its tail', () => {
    const t = createSubmitLineTracker();
    t.push('x'.repeat(5000) + '/tail');
    expect(t.isCommand).toBe(false);
  });

  test('the cap holds across many small pushes, as a live line arrives', () => {
    const t = createSubmitLineTracker();
    t.push('/');
    for (let i = 0; i < 500; i++) t.push('abcdefghij');
    expect(t.isCommand).toBe(true);
    expect(t.line.length).toBeLessThanOrEqual(4096);
  });
});
