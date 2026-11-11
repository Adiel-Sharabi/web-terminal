'use strict';
// #271 - the SERVER paces an AskUserQuestion answer, not the client.
//
// An answer is a multi-second sequence of PTY writes with deliberate gaps between them
// (the companion's `buildAnswerFrames`): each key must reach the agent in its own read,
// because Claude folds one read into a paste and swallows a CR that shares it. The
// client used to drive that sequence itself over its terminal socket, and a phone
// replaces or drops that socket on every app pause and resume. On 2026-11-11 a phone
// reattached ten times in three minutes and the last keys of a multi-select answer
// (its Other text, the Enter and the submit digit) went nowhere, silently.
//
// So the client POSTs the frames ONCE and this module writes them, with the same gaps,
// from a process that does not vanish with the app. WHAT the keys are stays the
// client's call (the layout rules live with `buildAnswerFrames`); only WHEN moves here.
// The writes go through the same worker input path as a socket's keystrokes, so every
// rule the worker applies (#55 submit gap, #213 bracketing) applies unchanged.
//
// Pure apart from the injected `write` and `sleep`, so it is unit-testable.

/** Most frames one answer may carry: the longest measured shape is well under 40. */
const MAX_FRAMES = 256;
/** Longest gap one frame may ask for, ms. The client's own gaps are 250 and 600. */
const MAX_DELAY_MS = 5000;
/** Longest a whole answer may take to type, ms. */
const MAX_TOTAL_MS = 60000;

/**
 * Validates a POSTed answer body. Returns `{ frames, totalMs }` or `{ error }`.
 * Refuses rather than repairs (CLAUDE.md "refuse and explain"): a malformed frame is
 * never coerced, clamped or dropped, because a partly typed answer is worse than none.
 *
 * @param {any} body the parsed JSON body: `{ frames: [{ keys, delayMs }] }`
 * @param {number} inputMax the per-socket input cap (`WS_INPUT_MAX`), applied to the
 *   frames' total, so this route can never write more than one socket message could
 */
function validateAnswer(body, inputMax) {
  const frames = body && body.frames;
  if (!Array.isArray(frames) || frames.length === 0) return { error: 'frames must be a non-empty array' };
  if (frames.length > MAX_FRAMES) return { error: `at most ${MAX_FRAMES} frames` };
  const out = [];
  let chars = 0;
  let totalMs = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || typeof f !== 'object') return { error: `frame ${i} is not an object` };
    if (typeof f.keys !== 'string' || f.keys.length === 0) return { error: `frame ${i} has no keys` };
    const d = f.delayMs === undefined ? 0 : f.delayMs;
    if (!Number.isInteger(d) || d < 0 || d > MAX_DELAY_MS) {
      return { error: `frame ${i} delayMs must be an integer from 0 to ${MAX_DELAY_MS}` };
    }
    chars += f.keys.length;
    // The last frame's delay is never waited (nothing follows it).
    if (i < frames.length - 1) totalMs += d;
    out.push({ keys: f.keys, delayMs: d });
  }
  if (chars > inputMax) return { error: `frames carry ${chars} characters, over the ${inputMax} cap` };
  if (totalMs > MAX_TOTAL_MS) return { error: `frames take ${totalMs} ms, over the ${MAX_TOTAL_MS} ms cap` };
  return { frames: out, totalMs };
}

/**
 * One answer at a time per session. A second one while the first is being typed would
 * interleave two key sequences in one selector, so it is refused, never queued.
 */
function createPacer() {
  const inFlight = new Set();
  return {
    busy: (id) => inFlight.has(id),
    /**
     * Writes [frames] for session [id], waiting each frame's delay before the next
     * (none after the last). Stops at the first write that reports nothing was
     * written (`write` returns false: the worker link is down), since the keys after
     * a lost one would land in the wrong place. Resolves `{ written, stopped }`.
     *
     * @param {string} id
     * @param {{ keys: string, delayMs: number }[]} frames already validated
     * @param {{ write: (keys: string) => boolean, sleep: (ms: number) => Promise<void> }} io
     */
    async run(id, frames, io) {
      if (inFlight.has(id)) throw new Error('an answer is already being typed into this session');
      inFlight.add(id);
      let written = 0;
      try {
        for (let i = 0; i < frames.length; i++) {
          if (io.write(frames[i].keys) === false) return { written, stopped: true };
          written++;
          if (i < frames.length - 1 && frames[i].delayMs > 0) await io.sleep(frames[i].delayMs);
        }
        return { written, stopped: false };
      } finally {
        inFlight.delete(id);
      }
    },
  };
}

module.exports = { validateAnswer, createPacer, MAX_FRAMES, MAX_DELAY_MS, MAX_TOTAL_MS };
