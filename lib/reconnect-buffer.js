'use strict';

// #201 — the cluster reconnect buffer's ADMISSION rule, pure so it can be tested
// without a cluster, a socket or a reconnect.
//
// WHY THIS IS A RULE AND NOT AN `if`. The buffer holds what a browser typed while the
// proxy's link to the remote peer was down, and replays it on reconnect. Its polarity is
// deliberate and is stated at the call site: when the buffer is full the NEWEST write is
// refused rather than an older one evicted, so a replay is a PREFIX of what was typed —
// never a hole in the middle of it. Losing the tail of a sentence is recoverable by
// retyping; a sentence with a gap in the middle is worse than losing it outright,
// because it looks like it arrived.
//
// THAT GUARANTEE NEEDS A LATCH, AND THE FIRST CUT OF #201 DID NOT HAVE ONE. The count
// bound is monotone by construction — `buffered.length` only ever grows until the flush
// resets it — so once it is full it stays full and the prefix property holds for free.
// The BYTE bound is not: `bytes + size <= maxBytes` is a per-frame FIT test, so after a
// large frame is refused for bytes, a later SMALLER frame that still fits is admitted.
// That is exactly the middle hole the polarity promises cannot happen, and it is
// constructible entirely from legitimate frames: buffer ~5 near-maximal frames, have a
// 300 KB frame refused, then admit a 100 KB one typed after it. Rare — it needs ~4 MiB
// accumulated inside one reconnect window — but a guarantee that is only usually true is
// not a guarantee, and this one is load-bearing for what the user sees replayed.
//
// So refusal LATCHES: the first write that does not fit closes the buffer until the next
// flush, whatever the reason it did not fit.

/**
 * May this write be admitted to the reconnect buffer?
 *
 * @param {{count: number, bytes: number, latched: boolean}} state  the buffer as it stands
 * @param {number} size  the write's size in bytes
 * @param {{maxEntries: number, maxBytes: number}} limits
 * @returns {boolean} true iff the write may be buffered; a false answer must LATCH the
 *   buffer (see the caller), because everything after it would replay behind a gap.
 */
function admits(state, size, limits) {
  if (state.latched) return false;
  if (state.count >= limits.maxEntries) return false;
  if (state.bytes + size > limits.maxBytes) return false;
  return true;
}

/**
 * The buffer's whole decision for one write: keep it, and — when refusing — is this
 * the refusal the browser is told about?
 *
 * WHY THE NOTICE IS A RULE AND NOT AN `if` AT THE CALL SITE. #193's principle is that
 * input which is dropped must be VISIBLE, and this path was one of the two that never
 * honoured it (#204): the proxy dropped the write and the browser was told nothing,
 * even though the local socket is open the whole time and has somewhere to put the
 * notice. But the obvious repair — report every refusal — is worse than the silence:
 * a latched buffer refuses EVERY subsequent keystroke, so an outage the user types
 * through would answer each character with its own "input dropped" banner. The latch
 * is what makes one notice the right number: everything after the first refusal is
 * refused for the same reason, so the first one says all of it.
 *
 * Reporting therefore derives from the same state the latch does, and lives here with
 * it rather than beside it. A future change that dropped the `!state.latched` guard
 * would turn a notice into a flood, and that is a rule breaking, not a call site
 * drifting.
 *
 * @param {{count: number, bytes: number, latched: boolean}} state
 * @param {number} size  the write's size in bytes
 * @param {{maxEntries: number, maxBytes: number}} limits
 * @returns {{admit: boolean, notify: boolean}} `admit` false must LATCH the buffer;
 *   `notify` true means send exactly one `inputDropped` for this outage.
 */
function decide(state, size, limits) {
  if (admits(state, size, limits)) return { admit: true, notify: false };
  return { admit: false, notify: !state.latched };
}

module.exports = { admits, decide };
