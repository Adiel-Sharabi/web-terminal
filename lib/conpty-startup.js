'use strict';
// --- ConPTY's startup terminal query: answer it, or every spawn waits ~3 s -------
//
// node-pty ships its own conpty.dll/OpenConsole.exe (`useConptyDll: true`); both the
// ConPTY 1.23 in node-pty 1.1.0 and the 1.25 in 1.2.0-beta.18 behave alike here.
// That ConPTY asks the attached terminal for its Primary Device Attributes (DA1,
// `ESC [ c`) the moment it starts, and HOLDS THE CHILD until the answer arrives or
// its own timeout passes. A session is spawned with no terminal attached - the
// companion connects later - so nothing ever answered, and every shell sat there:
//
//   38 ms   ESC[1t ESC[c ESC[?1004h ESC[?9001h    (ConPTY's preamble)
//   3260 ms the bash prompt                       (measured on Home, 2026-11-03)
//
// Answered at once, the same prompt arrives at ~240 ms. This was ~3 s of EVERY
// session start and every restore since the 2026-07-30 node-pty upgrade.
//
// The reply is what xterm.js (app.html) answers to DA1 - "VT100 with Advanced
// Video Option" - so ConPTY learns nothing a real attached viewer would not have
// told it. It is written ONCE per spawn and ONLY while the PTY has printed nothing
// but escape sequences: that is ConPTY's own preamble, before the shell exists.
// The moment anything printable arrives, the window is closed for good, so a
// program that sends DA1 later (vim, an agent's TUI) never gets a worker-written
// answer typed into its input.
//
// And only while ConPTY can still be WAITING. Once its own timeout has passed it
// hands the reply to the shell as typed input: bash echoed `1;2c` and the restore
// ran `1;2cclaude --resume <id>` (reproduced in review, with the worker's event
// loop blocked 4 s after a spawn - the preamble and the prompt then arrive as ONE
// chunk). So: no answer if anything printable FOLLOWS the query either (ConPTY
// already let the shell run), and none once [ANSWER_WINDOW_MS] has passed since the
// spawn (a late preamble on its own). Both fail toward silence - that only costs
// the ~3 s this exists to save.
//
// REQUIRES node-pty >= 1.2.0-beta.13 (#418). Shipped first on 1.1.0 (#416) and
// withdrawn: the worker then died natively under create/kill churn. The fault was
// node-pty 1.1.0's conpty.node, not the reply - each session's exit-watcher thread
// erases from a global handle vector with no lock (conpty.cc:106) while the main
// thread creates and kills; a faster start only made more exits overlap. Upstream
// fixed it in microsoft/node-pty#922 (fa83ecfc, first in 1.2.0-beta.13). package.json
// pins 1.2.0-beta.18 exactly; tests/conpty-startup.spec.js fails on an older pin.

const { stripAnsi } = require('./ansi');

// ESC is never a raw byte in source (lib/ansi.js; tests/control-bytes.spec.js).
const ESC = String.fromCodePoint(0x1b);

/// DA1 request: `ESC [ c` or `ESC [ 0 c`. Not DA2 (`ESC [ > c`), not a reply
/// (`ESC [ ? ... c`) - the parameter must be empty or 0, directly after the `[`.
const DA1_QUERY_RE = new RegExp(ESC + '\\[0?c');

/// The answer: `ESC [ ? 1 ; 2 c`.
const DA1_REPLY = ESC + '[?1;2c';

/// An escape sequence cut off at the end of a chunk (`ESC`, `ESC [`, `ESC [ ?1`):
/// not text, just the rest of a sequence still in flight.
const TRAILING_PARTIAL_RE = new RegExp(ESC + '(?:\\[[0-?]*[ -/]*)?$');

/// Anything a viewer would see: not a C0 control, space or DEL.
const PRINTABLE_RE = /[^\x00-\x20\x7f]/;

/// ConPTY waits ~3.2 s (measured). Answer only well inside that, so the reply is
/// in its hands before it stops listening; the preamble normally arrives at ~40 ms
/// (~360 ms for the eighth session of a cold-restart restore).
const ANSWER_WINDOW_MS = 1500;

/// The preamble is a few dozen bytes. Past this, whatever is talking is not
/// ConPTY's startup and the window closes.
const PREAMBLE_CAP = 4096;

/// A responder for ONE spawn. `feed(chunk)` returns the reply to write, or null.
/// After it has answered once, or seen printable output, or passed the cap or the
/// answer window, it returns null forever (`done`). [spawnedAt] and [now] are
/// injectable for tests.
function createConptyStartupResponder({ spawnedAt = Date.now(), now = Date.now } = {}) {
  let preamble = '';
  let done = false;
  return {
    get done() { return done; },
    feed(chunk) {
      if (done) return null;
      if (now() - spawnedAt > ANSWER_WINDOW_MS) { done = true; return null; }
      preamble += typeof chunk === 'string' ? chunk : String(chunk || '');
      const m = DA1_QUERY_RE.exec(preamble);
      const before = m ? preamble.slice(0, m.index) : preamble;
      if (PRINTABLE_RE.test(stripAnsi(before.replace(TRAILING_PARTIAL_RE, '')))) {
        done = true;
        return null;
      }
      if (m) {
        done = true;
        const after = preamble.slice(m.index + m[0].length).replace(TRAILING_PARTIAL_RE, '');
        return PRINTABLE_RE.test(stripAnsi(after)) ? null : DA1_REPLY;
      }
      if (preamble.length > PREAMBLE_CAP) done = true;
      return null;
    },
  };
}

module.exports = { createConptyStartupResponder, DA1_REPLY, DA1_QUERY_RE, ANSWER_WINDOW_MS };
