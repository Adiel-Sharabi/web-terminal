'use strict';
// #179 — a submit that never reached the agent must SAY SO, and give the words back.
//
// ## The bug
//
// The compose bar submits into whatever the TUI happens to be showing. When that is
// not a composer — `/usage`, a permission prompt, a crashed TUI back at bash — the
// bytes are swallowed as navigation and **the user's words are gone with no error
// anywhere**. Switching to the terminal to find out why discards the draft too. It is
// #147's failure class arriving later in the session's life: #147 solved "the agent is
// not up YET", this is "the agent is not at its composer ANY MORE".
//
// ## Why this is a VERIFIER and not a detector — measured, not assumed
//
// #179 proposed alt-screen (`ESC[?1049h`/`l`) as a general "the PTY cannot take a
// prompt" marker, and said in bold to measure it first. Measured it was, twice, on
// claude 2.1.250 via `scripts/rig/probe-altscreen-block.js` and
// `scripts/rig/probe-blocked-markers.js`:
//
// | state | DEC modes emitted on entering | did a submit start a turn? |
// |---|---|---|
// | ordinary turn (control) | none | YES |
// | `/usage` | `?25l ?25h ?25l` (cursor only) | **NO** |
// | slash menu open | `?25l ?25h` | **NO** |
// | Agent View (`←`) | mouse off, `?2004l`, `?1004`, `?2031`, `?9001` | dispatched a NEW session |
//
// **Not one blocking state emitted `ESC[?1049h`.** Alt-screen is not the signal — and
// CLAUDE.md's recorded claim that Agent View is *always* alt-screen does not hold on
// this build either (see #146). Nor does anything else line up: cursor-hide covers
// `/usage` but not the slash menu, and it toggles during ordinary repaints, so keying
// on it would refuse legitimate submits. An unmeasured marker is exactly what #143
// shipped, so no marker is declared here at all.
//
// So the rule is inverted, and it is the one #55 already made law: **submit means a
// turn actually starts.** Do not predict whether the PTY can accept a prompt — write
// it, then check that it landed, and hand the words back when it did not. That covers
// every blocking shape at once, including ones nobody has enumerated, because it
// observes the outcome rather than guessing the cause.
//
// ## What counts as evidence
//
// A hook. Any hook. Claude fires `UserPromptSubmit` the moment it accepts a prompt,
// and a session doing anything at all keeps firing others — while a TUI sitting on
// `/usage` or a slash menu fires nothing, because nothing is happening. Using "any
// hook" rather than `UserPromptSubmit` alone is deliberate: it means this rule does
// not depend on which event a given prompt shape produces, which is precisely the kind
// of assumption this file exists to avoid.
//
// ## Failing closed
//
// Every gate below refuses to arm rather than risk a false alarm, because a spurious
// "that didn't reach the agent" on a prompt that DID land is worse than the silence it
// replaces — it would teach the user to distrust the notice on the one occasion it is
// true. In particular a session that has never delivered a hook is never watched, so a
// box where hooks are not installed behaves exactly as it does today.
//
// ## The one case this answers WRONGLY, and why it is recorded rather than fixed
//
// `session.hookStatus` is set on the first hook and NEVER reset — which is #147's
// recorded Gap 1 ("the latch is one-way and does not reset when the agent EXITS back to
// its shell") arriving here. So after `/exit`, a Ctrl-D or a crashed TUI, a session is
// still marked as hook-bearing while the PTY is really at bash. A compose-bar line sent
// then RUNS, in the shell, and produces no hook — and this rule reports it as never
// having reached the agent. Which is true, literally, and unhelpful.
//
// It is not fixed here because every candidate signal is worse than the symptom: keying
// on a shell prompt reappearing means keying on `❯`, which #147 measured to be the
// default glyph of starship, pure and several oh-my-posh themes; and requiring a RECENT
// hook would refuse the notice on exactly the long-idle session most likely to have
// drifted away from its composer. The honest fix is the same one #147 named for its own
// gap — key on the composer FRAME rather than the caret — and it needs a fresh rig
// measurement of what that frame prints. An unmeasured marker is what #143 shipped.

/**
 * A submit is watched only when EVERY one of these holds. Pure so the gate can be
 * asserted directly, without a PTY.
 *
 * @param {object|null} policy   the provider's `submitConfirm` (lib/agents.js), or null
 * @param {object} s
 * @param {boolean} s.hookStatus  has this session EVER delivered a hook? The same proof
 *   `isClaudeSession()` uses. Without it we cannot tell "no hook came back" from "hooks
 *   do not reach this box", and the second must stay silent.
 * @param {string}  s.status      the session's current status
 * @param {boolean} s.fromClient  did a human's client send this frame? The worker
 *   submits on its own account too (auto-resume's `continue`, the API-error ladder's
 *   `/compact`, `/rename`). Those have their own reporting and no draft to give back.
 * @param {boolean} s.isCommand   did the submitted line start with `/`? A slash command
 *   is a TUI instruction, not a prompt: `/usage` legitimately starts no turn, and
 *   flagging it would fire the notice on exactly the states the user opened deliberately.
 * @param {boolean} s.compacting  is the agent mid-compaction (#65)? Found in review, and
 *   it is the `working` gate's twin: #129 measured that Claude reports IDLE part-way
 *   through a `/compact`, so the status gate cannot see it, and no hook fires between
 *   PreCompact and the resumption — a wait bounded by COMPACTING_MAX_MS, far beyond
 *   this window. The prompt is queued and answered when compaction ends, so reporting it
 *   lost would hand back words that are about to be used.
 */
function shouldWatchSubmit(policy, { hookStatus, status, fromClient, isCommand, compacting }) {
  if (!policy || !(policy.timeoutMs > 0)) return false;   // provider does not declare it
  if (!fromClient) return false;
  if (!hookStatus) return false;
  if (isCommand) return false;
  // Already working: the composer QUEUES a prompt behind the running turn and Claude
  // need not report it until that turn ends, which can be minutes. The submit plainly
  // reached a live composer — there is nothing to verify and a timer would only lie.
  if (status === 'working') return false;
  if (compacting) return false;
  return true;
}

/**
 * Evidence confirms a submit only if it arrived AT OR AFTER the submit went out.
 * A hook still in flight from the previous turn must not vouch for this one.
 */
function confirmsSubmit(armedAt, evidenceAt) {
  if (!(armedAt > 0) || !(evidenceAt > 0)) return false;
  return evidenceAt >= armedAt;
}

// --- what the user was typing, as the PTY saw it ----------------------------
//
// The compose bar streams a live `/`-line to the PTY as you type (#55) so the agent's
// slash menu narrows, which means the submit frame for a slash command can be a BARE
// CR with no text in it. Reading the frame alone would therefore watch `/usage` and
// fire on it. So the line is accumulated from the bytes actually written, exactly as
// the terminal accumulates it.
//
// KNOWN LIMIT, recorded rather than papered over: this tracks appended text only. A
// line edited with backspace or arrow keys before submitting can leave the tracker
// disagreeing with the screen. The consequence is bounded and one-directional — the
// worst case is a watch that should have been skipped (a spurious notice on a slash
// command) or one that was skipped and should not have been (today's silence). It is
// never a wrong submit.

const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

/**
 * Everything OUTSIDE bracketed-paste regions. A PASTE IS NOT TYPING, and its body must
 * never become "the line".
 *
 * Found in review: the images-only submit (#87) pastes the staged image's PATH, so a
 * POSIX `/home/...` read as a slash command while a Windows `C:\\Users\\...` read as
 * ordinary text — the gate answered differently on two platforms for the same action.
 * Dropping the body also makes a multi-line prompt (which travels as one bracketed
 * paste) read as a prompt rather than as whatever its first character happens to be.
 *
 * No cross-chunk state: a client sends a paste whole (#44 — the worker owns submit
 * timing and `buildComposeSubmission` emits ONE frame), so an unterminated opener means
 * the rest of this chunk is paste body.
 */
function _dropPastes(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = s.indexOf(PASTE_OPEN, i);
    if (open < 0) return out + s.slice(i);
    out += s.slice(i, open);
    const close = s.indexOf(PASTE_CLOSE, open);
    if (close < 0) return out;                  // the paste runs to the end of the chunk
    i = close + PASTE_CLOSE.length;
  }
}
// The escape sequences a client can legitimately send while typing. Stripped so a
// cursor key does not become part of the "line".
const ESC_SEQ_RE = /\x1b(?:\[[0-9;?]*[A-Za-z~]|[OP-Z\\\]^_]|.)?/g;

/** Only the first character decides `isCommand`, so the line is bounded cheaply. */
const LINE_CAP = 4096;

/**
 * Accumulates what has been typed since the last submit, and answers the one question
 * the gate needs: did this line start with `/`?
 */
function createSubmitLineTracker() {
  let line = '';
  return {
    /** Feed every chunk written to the PTY, in order. */
    push(data) {
      const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
      if (!s) return;
      let t = _dropPastes(s);
      t = t.replace(ESC_SEQ_RE, '');
      // A CR/LF ends the line. Anything after the last one starts the next.
      const cut = Math.max(t.lastIndexOf('\r'), t.lastIndexOf('\n'));
      if (cut >= 0) { line = t.slice(cut + 1); return; }
      // Bounded by keeping the HEAD, not the tail. Found in review: slicing the last
      // 4096 characters threw the leading `/` away, so `/compact <5000 chars>` reported
      // as a PROMPT and got watched — the noisy direction this file's header
      // forbids — while a long prompt whose 4096th-from-last character happened to be
      // `/` reported as a command and was silently skipped. Only the first character
      // decides the answer, so once the cap is reached there is nothing left to learn.
      if (line.length < LINE_CAP) line = (line + t).slice(0, LINE_CAP);
    },
    /** True if the pending line is a TUI slash command rather than a prompt. */
    get isCommand() { return /^\s*\//.test(line); },
    /** Test/introspection only. */
    get line() { return line; },
  };
}

module.exports = {
  shouldWatchSubmit,
  confirmsSubmit,
  createSubmitLineTracker,
};
