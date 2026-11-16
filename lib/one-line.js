'use strict';
// One line of text for a prompt, a card or a log line (#468, moved here by #469): a leaf, so
// lib/supervisor-cases.js and lib/closeout.js share it without a require cycle, and the
// worker never loads it.

/// One line for a prompt or a card: control characters folded, cut to [n] characters.
function oneLine(s, n) {
  return String(s || '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

module.exports = { oneLine };
