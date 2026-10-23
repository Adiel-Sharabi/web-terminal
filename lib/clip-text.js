'use strict';

/// The one owner of "cut a display string at a word and say so" (#383). A leaf: it
/// requires nothing, so any lib module can import it without a cycle.
///
/// Why: three server fields (a question's text, a background agent's `waitingFor`, the
/// brief's `wait.what` / `did`) used to slice mid-word, and the first two with no
/// ellipsis at all, so a reader could not tell "cut" from "complete" and the cut often
/// landed before the actual request.

/// Below this share of [max], a word boundary is too far back to be worth the loss: a
/// long path or URL with no spaces would be gutted to its first few characters.
const MIN_KEEP = 0.6;

/// [s] unchanged when it fits in [max] code units, otherwise the longest whole-word
/// prefix plus an ellipsis, the result never longer than [max]. A string with no usable
/// boundary (one long token) is cut hard rather than emptied. Never leaves half a
/// surrogate pair.
function clipAtWord(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  if (max < 2) return '…';
  let cut = s.slice(0, max - 1);
  // Cut at a word only when the next character really starts a new word, i.e. the cut
  // sits on whitespace or the last kept character is followed by whitespace.
  const atBoundary = /\s/.test(s[max - 1]);
  if (!atBoundary) {
    const m = /\s\S*$/.exec(cut);
    if (m && m.index >= max * MIN_KEEP) cut = cut.slice(0, m.index);
  }
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.replace(/[\s,;:\-–—(]+$/, '');
  return `${cut}…`;
}

module.exports = { clipAtWord };
