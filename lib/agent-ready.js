'use strict';
// #147 — is a freshly spawned agent actually able to RECEIVE a prompt yet?
//
// A new session drops the user straight into the chat lens, but the agent CLI is
// not there yet: the PTY is still sitting at the shell prompt while `claude` (or
// `codex`) boots. A prompt sent in that window is handed to BASH, which either
// runs it as a command or does nothing — either way the text is gone, silently.
//
// MEASURED on the rig against claude 2.1.237 (scripts/rig/probe-claude-ready.js,
// two runs), verdict taken from "did a turn start", never from the screen:
//
//   +3.3s   bash prompt appears
//   +3.7s   the autoCommand (`claude ...`) is typed
//   +5.0s / +6.1s   the composer caret appears        <- the spread is the point
//   submitted BEFORE that marker -> NO turn started, and bash answered
//                                   "command not found" — the bug, reproduced
//   submitted AFTER  that marker -> a turn started
//
// **That 1.1s spread across two runs on one machine is why this is a MARKER and
// never an elapsed-time guess.** A timer tuned to the fast boot eats prompts on
// the slow one, and a timer tuned to the slow boot makes every session feel
// broken. CLAUDE.md already says the same thing about Codex from a different
// direction: readiness keyed on the startup banner broke on a routine
// auto-update, and `esc to interrupt` prints while a cold TUI is still booting
// MCP servers — a false positive that reads as ready.
//
// PURE (bytes in, boolean out) so every branch is unit-testable; pty-worker.js
// owns the one place it meets a real PTY.
//
// KNOWN LIMITATION — the latch is one-way, and does not reset when the agent
// EXITS back to its shell (`/exit`, Ctrl-D, a crashed TUI). Such a session keeps
// reporting ready, so the next chat-lens submit is handed to bash: the original
// #147 bug, arriving later in the session's life instead of at its start. Not
// fixed here because the honest signal is "the shell prompt is back", and the
// shell prompt is exactly what this file already refuses to key on (`❯` is the
// default glyph of starship and friends) — a wrong reset would re-block a live
// agent, which is worse. Raised in review of PR #150; recorded rather than
// guessed at.

// Bytes of the previous chunk kept and re-scanned with the next one. A marker can
// land across a read boundary — the composer caret is 3 UTF-8 bytes (E2 9D AF) and
// a PTY read can split it — and unlike the api-error sniff next door, MISSING it is
// permanent: the phrase does not stay on screen and does not repeat, so a dropped
// match is a session that never becomes ready. Small because a marker is short;
// this is overlap, not a buffer of the stream.
const CARRY_BYTES = 16;

/**
 * A one-way latch that flips the first time `pattern` is seen in the output.
 *
 * @param {RegExp|null} pattern  the provider's composer marker, or null/undefined
 *   for an agent that declares none — a plain shell is usable the moment it
 *   exists, so a detector with no pattern reports ready IMMEDIATELY rather than
 *   never. Getting that backwards would block submit forever on every shell.
 */
function createReadyDetector(pattern) {
  let ready = !pattern;
  let carry = Buffer.alloc(0);

  return {
    get ready() {
      return ready;
    },

    /**
     * Feed one PTY chunk. Returns true ONLY on the transition to ready, so the
     * caller can log/broadcast exactly once and treat it as an edge.
     * @param {Buffer|string} chunk
     */
    push(chunk) {
      if (ready) return false;
      if (chunk == null) return false;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buf.length === 0) return false;

      const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
      // Decoding a chunk that ends mid-character yields a replacement char at the
      // tail; the carry re-decodes those bytes next round WITH their continuation,
      // so no marker is lost to a split. See the UTF-8 chunk-split regression.
      if (pattern.test(hay.toString('utf8'))) {
        ready = true;
        carry = Buffer.alloc(0);
        return true;
      }
      // COPIED, not sliced. `subarray` returns a view that keeps its parent
      // alive, and the parent here can be an entire seeded scrollback — so a
      // session whose marker never arrives would pin megabytes for its whole
      // life on the strength of a 16-byte overlap.
      carry = hay.length > CARRY_BYTES
        ? Buffer.from(hay.subarray(hay.length - CARRY_BYTES))
        : Buffer.from(hay);
      return false;
    },

    /**
     * Declare ready without having seen the marker. The SAFETY NET, and the
     * reason this state can never wedge: an agent that fired a hook, started a
     * turn or reported a status is self-evidently accepting input, whatever the
     * screen did. #147 is explicit that there must be no state where a working
     * session is stuck showing "starting" — a marker that changes in a future
     * CLI release must degrade to "ready late", never to "ready never".
     * Returns true only on the transition, like push().
     */
    force() {
      if (ready) return false;
      ready = true;
      carry = Buffer.alloc(0);
      return true;
    },
  };
}

module.exports = { createReadyDetector, CARRY_BYTES };
