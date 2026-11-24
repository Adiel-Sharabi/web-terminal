// #526 - the backstop for a question the session wrote in its reply but never reported.
//
// A session reports the decisions it waits on the owner for (`asks`, `wait.decision`:
// lib/session-brief.js), and nothing forces it to: a lead once finished with "Three earlier
// questions still need your answer" and reported `done`. At a Stop the server reads the reply
// and, when its END asks the owner for something that is not on the board, shows a card
// "possible unreported question" quoting the sentence. A rule, not a model: it is run on every
// Stop of every session, it has to be free and the same every time, and a wrong guess costs
// the owner one dismissible card ("possible"), never a key typed anywhere.
//
// Where it looks: the TL;DR (every reply ends with one: the sentence that says what is needed
// from the owner), else the last paragraph. A question earlier in the body that the reply goes
// on to answer is not an open one, and the end is where an open one is put. What counts:
//   - a sentence that ends in `?`, or
//   - a sentence that says a decision, an answer or an approval is owed (NEED).
// What does not: an OFFER ("want me to also ...?": the owner may ignore it), and a sentence that
// says nothing is owed ("nothing needs your input").
// The rule's numbers on real replies (hits, misses, false hits) are in the PR for #526; the
// fixtures in tests/unreported-ask.spec.js are SYNTHETIC sentences of the shapes it matched.
const { clipAtWord } = require('./clip-text');
const { extractSummary } = require('./speech');

/// How much of the asking sentence a card quotes.
const QUOTE_MAX = 240;
/// A reply is read only this far from its end (a TL;DR is short; a pasted log is not a reply).
const READ_CHARS = 4000;

/// The summary section of a reply (lib/speech.js extractSummary: the TL;DR the way the read-aloud
/// button finds it), else its last paragraph. Empty when the reply has no text.
function tailOf(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim().slice(-READ_CHARS);
  const summary = extractSummary(t);
  if (summary) return summary.trim();
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.length ? blocks[blocks.length - 1] : '';
}

/// Sentences of [s], code and inline code dropped (a quoted log line is not a question).
function sentencesOf(s) {
  return s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\s+/g, ' ')
    .split(/(?<=[.?!:])\s+(?=[A-Z0-9"'(*`])/).map((x) => x.trim()).filter(Boolean);
}

/// An optional follow-up the owner can ignore: not a decision anything is waiting on.
const OFFER = /\b(?:want me to|shall i also|i can (?:also )?(?:do|run|add|check|start)|if you (?:like|want|'d like|would like) me to|would you like me to)\b/i;
/// A sentence that says nothing is owed ("nothing needs your input", "no open questions").
const NONE = /\b(?:no|nothing|none|zero|without)\b(?: \w+){0,3} (?:decisions?|questions?|input|answers?|needs?|waiting|pending)\b/i;
const COUNT = String.raw`(?:one|two|three|four|five|six|\d+|open|pending)`;
const SOME = String.raw`(?:one|two|three|four|five|six|\d+|a|an|some|several|open|pending)`;
/// A sentence saying a decision, an answer or an approval is owed. Each alternative is a
/// shape that real replies used; none names a person, so it holds for any owner.
const NEED = new RegExp(String.raw`\b(?:${[
  String.raw`need(?:s|ed)? (?:your|you to|a|the|an|someone to|the owner to) ?(?:decision|answer|call|choice|approval|confirmation|go|ok|input|reply|decide|choose|confirm|approve)`,
  String.raw`(?:awaiting|waiting (?:for|on)) (?:your|the owner|an? answer|a decision|you\b)`,
  String.raw`your (?:call|decision|answer|choice|approval|go-ahead)`,
  String.raw`for (?:you|the owner|someone|a person) to (?:decide|choose|confirm|answer|approve)`,
  String.raw`(?:needs?|still needs?) (?:someone|a person|the owner|you) to decide`,
  String.raw`(?:left|sent|put|gave|handed|raised|asked|has|have) (?:\w+ ){0,2}${SOME} (?:open |remaining |earlier |pending )?(?:decision|question)s?\b`,
  String.raw`${COUNT} (?:open |remaining |earlier |pending )?(?:decision|question)s? (?:is|are|still|remains?|for|waiting|wait|need|left)`,
  String.raw`(?:decision|question)s? (?:is |are |stays? |remains? )?(?:with|waiting for|awaiting) \w+`,
  String.raw`until (?:\w+ ){0,2}(?:answers|decides|confirms|replies|responds)`,
  String.raw`(?:decision|question)s? (?:is|are) (?:still )?(?:open|pending|waiting)`,
  String.raw`(?:please|kindly) (?:confirm|choose|decide|answer|approve|reply|pick|tell me|let me know)`,
  String.raw`tell me (?:if|which|whether|what you)`,
  String.raw`let me know (?:if|which|whether|what you)`,
  String.raw`decide (?:whether|if|which)`,
].join('|')})`, 'i');

/// The sentence of [reply]'s end that asks the owner for something, clipped for a card; null when
/// the end asks nothing. Pure.
function findUnreportedAsk(reply) {
  for (const s of sentencesOf(tailOf(reply))) {
    if (OFFER.test(s) || NONE.test(s)) continue;
    if (/\?\s*["')\]*]*$/.test(s) || NEED.test(s)) return clipAtWord(s, QUOTE_MAX);
  }
  return null;
}

/// Words of [s] long enough to say what it is about (lower case), each cut to its first
/// STEM_CHARS letters: the sentence a reply ends on rarely repeats the ask's words letter for
/// letter ("remove" / "removed", "release" / "releases"), and a question asked in another tense
/// is the same question.
const STEM_CHARS = 5;
const tokensOf = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
function wordsOf(s) {
  return new Set(tokensOf(s).map((w) => w.slice(0, STEM_CHARS)));
}

/// The words of English that every sentence has and none is about (#541): "this", "that", "with",
/// "should", "would"... At four letters or more they pass wordsOf's length bar, and two of them in
/// common made a question about a changelog line "about" an item titled "Make this work with the
/// new phone". Whole words, checked before the stem.
const FILLER = new Set(('this that with from have has been were will would should could might shall must what when where which '
  + 'while whom whose your yours their there then than them they these those into onto over under also just some such only '
  + 'very more most much many each every both other another about after before again does done here please same').split(' '));

/// [wordsOf] without the filler: what a sentence is ABOUT. The one rule for "do these two texts
/// share a subject" (lib/mc-needs.js subjectFor).
function significantWordsOf(s) {
  return new Set(tokensOf(s).filter((w) => !FILLER.has(w)).map((w) => w.slice(0, STEM_CHARS)));
}

/// Is [sentence] already on the board: is it about one of the [asks] (question, context, and
/// option labels), or the reported `you` wait's words? The sentence is covered when at least
/// half of its significant words appear in ONE of them.
function coveredBy(sentence, asks, wait) {
  const mine = wordsOf(sentence);
  if (!mine.size) return false;
  const texts = [];
  for (const a of Array.isArray(asks) ? asks : []) {
    texts.push([a.question, a.context, ...(Array.isArray(a.options) ? a.options.map((o) => o && o.label) : [])].join(' '));
  }
  if (wait && wait.on === 'you') texts.push([wait.what, wait.decision && wait.decision.question, wait.decision && wait.decision.context].join(' '));
  return texts.some((t) => {
    const theirs = wordsOf(t);
    let hit = 0;
    for (const w of mine) if (theirs.has(w)) hit++;
    return hit * 2 >= mine.size;
  });
}

module.exports = { findUnreportedAsk, coveredBy, tailOf, wordsOf, significantWordsOf, QUOTE_MAX };
