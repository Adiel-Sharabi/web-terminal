'use strict';
// --- #70 Phase 1: what is worth SAYING out loud -------------------------------
// The read-aloud feature's whole value is deciding what NOT to speak. Reading a
// Claude turn verbatim is unusable: a 40-line diff, a markdown table, a bare URL
// and a heading rule all become noise the moment they hit a speech synthesiser.
//
// The knowledge layer already exists — lib/transcript.js separates assistant
// prose from tool calls and tool results (documented in-file as "plumbing (not
// conversation)") and ANSI-strips what is left. This module is the LAST mile:
// prose in, a speakable utterance out. It is deliberately PURE (no fs, no net,
// no agent knowledge) so every rule below is exhaustively unit-testable, and so
// the same rules govern Claude and Codex without a single branch — the caller
// hands us `turn.text` whichever provider produced it.
//
// Bias: SILENCE. When a rule is ambiguous, drop the content. An utterance that
// omits a detail is recoverable (the screen is right there); one that reads a
// URL character by character gets the feature switched off permanently.
const { stripAnsi } = require('./transcript');

// Spoken length, not written length. ~700 chars is roughly 45-60 seconds of
// speech — past that the listener has stopped following and should be reading.
// The sentence cap is the primary bound; the char cap is the backstop for prose
// that contains no sentence terminator at all (a single long run-on line).
const DEFAULT_MAX_CHARS = 700;
const DEFAULT_MAX_SENTENCES = 4;

// A fenced code block is the single largest source of unspeakable content, and
// it is also the easiest to identify. Matches ``` and ~~~ fences (with or
// without a language tag) INCLUDING an unterminated trailing fence — a turn that
// was cut mid-block by the transcript cap would otherwise leak its whole tail.
const FENCE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n?[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g;

// A markdown table row. Tables carry meaning entirely through column alignment,
// which speech cannot convey — a row read aloud is a stream of disconnected
// fragments. Dropped wholesale rather than flattened.
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$/gm;
// The |---|---| separator, which may lack the trailing pipe.
const TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm;

// A horizontal rule carries no spoken meaning.
const HR_RE = /^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm;

// Bare URLs are never worth speaking; a link's TEXT usually is. Order matters:
// resolve [text](url) to its text BEFORE stripping bare URLs, or the bracket
// form loses its label too.
const MD_IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const BARE_URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

// Emoji and pictographs. Synthesisers handle these inconsistently — some read
// the CLDR name aloud ("grinning face with smiling eyes"), which is worse than
// silence. Variation selectors and ZWJ joiners go too or they leave artefacts.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

// Inline markdown emphasis/code markers. The CONTENT is kept — dropping an
// inline-code span would gut the sentence around it ("the fix is in at line 42")
// — but the marker characters themselves must go or they are read as "asterisk".
const INLINE_MARKERS_RE = /[*`~]/g;
// Underscores are handled SEPARATELY, as a space rather than a deletion. They
// are both an emphasis marker (_word_) and a word character in real identifiers
// (`some_var`), and the two cases are not distinguishable here. Deleting would
// fuse "some_var" into "somevar"; a space yields "some var", which is what a
// listener would say out loud anyway. Emphasis collapses harmlessly.
const UNDERSCORE_RE = /_/g;

// Leading block markers: heading hashes, blockquote carets, list bullets and
// ordered-list numbers, and checkbox boxes. The text after them is real prose
// and is kept; only the marker is removed.
const LEAD_MARKER_RE = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,3}[.)][ \t]+)/gm;

// Sentence boundary: a terminator followed by whitespace. Deliberately naive —
// "v1.41.0" and "e.g." will split wrongly. That is acceptable here because the
// consequence is a slightly early pause, and the alternative (an abbreviation
// dictionary) is a maintenance burden for a feature whose whole point is to be
// cheap enough to delete.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

// --- the summary ladder ------------------------------------------------------
// Capping at the first N sentences is a LENGTH rule, not an importance rule: if
// the answer's point lands in its last paragraph, the listener never hears it.
// The cheapest fix is not a summariser — it is to let the agent, which already
// knows what mattered, mark the summary as it writes. When a turn ends with a
// TL;DR / Summary section we speak THAT and nothing else; otherwise we fall back
// to first-N. Nothing is mandated: an answer without one still reads fine.
//
// Matched on the LAST such heading in the turn, because a summary is a trailer.
const SUMMARY_LABEL = '(?:tl;?\\s?dr|summary|bottom line|in short|read[- ]?aloud)';
// A heading/label alone on its line: "## TL;DR", "**Summary**", "TL;DR:".
const SUMMARY_HEADING_RE = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?\\*{0,2}' + SUMMARY_LABEL + '\\*{0,2}[ \\t]*:?[ \\t]*$', 'i');
// The inline form: "**TL;DR:** the answer is yes."
const SUMMARY_INLINE_RE = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?\\*{0,2}' + SUMMARY_LABEL + '\\*{0,2}[ \\t]*:[ \\t]*(\\S.*)$', 'i');
// Any other heading ends the section.
const ANY_HEADING_RE = /^[ \t]*#{1,6}[ \t]+\S/;

// The body of the turn's last summary section, or null when it has none.
// PURE; operates on RAW markdown so the normal cleaning still runs afterwards.
function extractSummary(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const inline = lines[i].match(SUMMARY_INLINE_RE);
    if (inline) return inline[1];
    if (!SUMMARY_HEADING_RE.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING_RE.test(lines[j])) break; // next section starts
      body.push(lines[j]);
    }
    const joined = body.join('\n').trim();
    if (joined) return joined;
  }
  return null;
}

// Reduce one assistant turn's prose to a speakable utterance. Returns '' when
// nothing survives — the caller MUST treat that as "say nothing", never as an
// error and never as a reason to fall back to raw text.
function toSpeech(text, opts = {}) {
  if (typeof text !== 'string' || !text) return '';
  const maxChars = _posInt(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxSentences = _posInt(opts.maxSentences, DEFAULT_MAX_SENTENCES);

  // Prefer an author-marked summary over the opening sentences. `preferSummary:
  // false` disables the ladder (used to prove the fallback still works).
  let source = text;
  if (opts.preferSummary !== false) {
    const summary = extractSummary(text);
    if (summary) source = summary;
  }

  let s = stripAnsi(source);

  // Block-level removals first: a fence may CONTAIN table rows, list markers and
  // URLs, so stripping it first stops those inner rules from firing on content
  // that is already gone.
  s = s.replace(FENCE_RE, '\n');
  s = s.replace(TABLE_SEP_RE, '');
  s = s.replace(TABLE_ROW_RE, '');
  s = s.replace(HR_RE, '');

  // Links before bare URLs (see MD_LINK_RE).
  s = s.replace(MD_IMAGE_RE, '');
  s = s.replace(MD_LINK_RE, '$1');
  s = s.replace(BARE_URL_RE, '');

  s = s.replace(LEAD_MARKER_RE, '');
  s = s.replace(EMOJI_RE, '');
  s = s.replace(INLINE_MARKERS_RE, '');
  s = _shapeIdentifiers(s);
  s = s.replace(UNDERSCORE_RE, ' ');

  // Collapse all whitespace to single spaces. Paragraph structure is invisible
  // to speech, and a synthesiser given "\n\n\n" may pause oddly.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';

  return _capSentences(s, maxSentences, maxChars);
}

// Take whole sentences up to BOTH bounds. Always yields at least one sentence
// (hard-truncated at maxChars if that single sentence is itself too long), so a
// wall-of-text turn still says something rather than nothing.
function _capSentences(s, maxSentences, maxChars) {
  const parts = s.split(SENTENCE_SPLIT_RE).filter(Boolean);
  const kept = [];
  let len = 0;
  for (const p of parts) {
    if (kept.length >= maxSentences) break;
    // +1 for the joining space. The FIRST sentence is taken regardless of length
    // so the result is never empty; only later ones are budget-checked.
    const add = kept.length === 0 ? p.length : p.length + 1;
    if (kept.length > 0 && len + add > maxChars) break;
    kept.push(p);
    len += add;
  }
  let out = kept.join(' ');
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + '…';
  return out;
}

// --- speaking like a person, not a path --------------------------------------
// Our vocabulary is the worst case for a speech engine: `lib/agents.js` becomes
// "lib slash agents dot J S" and `buildComposeSubmission` an unbroken mumble.
// Three narrow rewrites, each gated so ordinary prose is untouched:
//
//   lib/agents.js            -> "agents"        (basename, extension dropped)
//   pty-worker.js            -> "pty worker"
//   buildComposeSubmission   -> "build Compose Submission"
//
// Dropping the extension and the directory loses precision on purpose. The
// screen still has the exact path; the ear needs the name. A listener who hears
// "the fix is in agents" and wants the full path looks at it.
const CODE_EXT_RE = /\.(?:js|ts|tsx|jsx|dart|kt|kts|java|py|rb|go|rs|c|h|cpp|cs|json|yaml|yml|md|sh|ps1|html|css|xml|toml)$/i;
// A path-ish token: at least one separator, no spaces.
const PATH_TOKEN_RE = /(?:[A-Za-z0-9._@-]+[\\/])+[A-Za-z0-9._-]+/g;
// camelCase with at least one hump, no separators (so real words are safe).
const CAMEL_TOKEN_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g;

function _shapeIdentifiers(s) {
  // Paths first: reduce to the basename, then let the rules below shape it.
  s = s.replace(PATH_TOKEN_RE, (m) => {
    const base = m.split(/[\\/]/).filter(Boolean).pop() || m;
    return base.replace(CODE_EXT_RE, '');
  });
  // A bare filename that survived (no directory part).
  s = s.replace(/\b[A-Za-z0-9._-]+\.(?:js|ts|tsx|jsx|dart|kt|py|rb|go|rs|json|yaml|yml|md|sh|ps1|html|css)\b/gi,
    (m) => m.replace(CODE_EXT_RE, ''));
  // Hyphens inside a code-ish token read better as spaces ("pty worker").
  s = s.replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/gi, (m) => m.replace(/-/g, ' '));
  // Split camelCase humps so each word is pronounced.
  s = s.replace(CAMEL_TOKEN_RE, (m) => m.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  return s;
}

function _posInt(v, dflt) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : dflt;
}

// Pick the newest assistant turn that carries prose from a page of typed turns
// (newest-LAST, as scanTurnsBackward returns them) and reduce it for speech.
// Tool-use-only turns are skipped: they are the plumbing this feature exists to
// suppress. Returns { text, ts } with text '' when the page holds no prose.
// PURE — the caller does the file I/O and hands the turns in.
function speechFromTurns(turns, opts = {}) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!t || t.role !== 'assistant') continue;
    const spoken = toSpeech(t.text, opts);
    if (spoken) return { text: spoken, ts: t.ts || null };
  }
  return { text: '', ts: null };
}

module.exports = {
  toSpeech,
  speechFromTurns,
  extractSummary,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_SENTENCES,
};
