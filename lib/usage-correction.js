'use strict';
// --- Is a human prompt a correction? (#529) ------------------------------------------------
//
// One input of the "does a smaller context give better results" measurement: how often the person
// has to correct the agent. A LOCAL heuristic over the opening words of a prompt - never a model, and
// the text is counted and forgotten, never stored. It is deliberately narrow: the first 120 characters,
// matched at the START of the prompt ("no, ...", "wrong file", "that's not what I asked", "stop",
// "again", "undo", "you forgot", "don't ...", and the Hebrew equivalents). A handful of misses or
// false hits per hundred prompts does not matter; a count that rises with context size would.
// The Hebrew words are written as escapes to keep this file ASCII.

const HEBREW = [
  '\\u05dc\\u05d0',                                   // no / not
  '\\u05d8\\u05e2\\u05d5\\u05ea',                     // mistake
  '\\u05e2\\u05e6\\u05d5\\u05e8',                     // stop
  '\\u05e9\\u05d5\\u05d1',                            // again
  '\\u05d6\\u05d4 \\u05dc\\u05d0',                    // this is not
  '\\u05ea\\u05d7\\u05d6\\u05d5\\u05e8',              // go back
].join('|');

const PATTERNS = [
  '^(no|nope|wrong|stop|wait|undo|revert|again|incorrect)\\b',
  "^(that'?s|that is|this is|it'?s|it is) (not|wrong|incorrect)\\b",
  '^not (what|that|like|quite|right)\\b',
  "^(you|u) (didn'?t|did not|forgot|missed|broke|ignored|misunderstood)\\b",
  "^(why did you|i (said|asked|told you|meant)|don'?t|do not)\\b",
  `^(${HEBREW})(?![\\p{L}])`,
];
const CORRECTION_RE = new RegExp(PATTERNS.join('|'), 'iu');

function isCorrection(txt) {
  const t = String(txt).trim()
    .replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '')
    .replace(/^[\s"'([*_>-]+/, '')
    .slice(0, 120);
  return CORRECTION_RE.test(t);
}

module.exports = { isCorrection };
