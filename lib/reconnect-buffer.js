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

module.exports = { admits };
