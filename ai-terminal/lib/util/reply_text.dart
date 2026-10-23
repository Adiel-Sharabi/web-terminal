// The pure text rules the questions inbox reads an agent's own words with (#383): where
// a reply's TL;DR is, whether the reply ends by asking the person something, and which
// sentence of a question or a reply is the one that asks.
//
// The owner's report: "sometime it not clear and cut in the middle". The cards used to
// show the HEAD of the text clamped to a few lines, so the question at the end was what
// got dropped, and the clamp cut mid-word. These rules pick the sentence that asks and
// shorten only at sentence boundaries.

/// The ellipsis that marks sentences left out of a snippet.
final String kEllipsis = String.fromCharCode(0x2026);

/// The typographic apostrophe and closing quotes, built from code points so the source
/// stays ASCII: U+2019 (right single quote) and U+201D (right double quote).
final String _rsquo = String.fromCharCode(0x2019);
final String _rdquo = String.fromCharCode(0x201D);
final String _ldquo = String.fromCharCode(0x201C);

/// A sentence longer than this is cut at a word boundary even inside a card. It is the
/// one place a sentence is shortened, and only for a run-on that would otherwise fill
/// the list on its own; the card's expand shows it whole.
const int kSentenceHardCap = 400;

/// How much of a question a card shows before it shortens to the sentence that asks.
const int kSnippetBudget = 240;

/// A reply split around its author-marked TL;DR: [tldr] is the section's body (null
/// when the author wrote none) and [rest] is everything else, in order.
typedef TldrSplit = ({String? tldr, String rest});

/// A TL;DR heading: `## TL;DR`, `**TL;DR**`, `TL;DR:` (any case, `TLDR` too). The
/// inline form keeps the text after the colon as the section's first line.
final RegExp _tldrHeading = RegExp(
    r'^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*TL;?\s?DR\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$',
    caseSensitive: false);
final RegExp _anyHeading = RegExp(r'^\s{0,3}#{1,6}\s');

/// Splits [text] at its TL;DR section: the LAST TL;DR heading (a turn joins several
/// text blocks, and an early progress note can carry its own), and the one paragraph
/// under it, which ends at a blank line or the next heading. A TL;DR is one or two
/// sentences; letting it run to the next heading would swallow a whole reply whose
/// TL;DR comes first. A heading inside a fenced code block is not one.
TldrSplit splitTldr(String text) {
  final lines = text.split('\n');
  var inFence = false;
  int? start;
  for (var i = 0; i < lines.length; i++) {
    final l = lines[i];
    if (l.trimLeft().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && _tldrHeading.hasMatch(l)) start = i;
  }
  if (start == null) return (tldr: null, rest: text.trim());
  final head = _tldrHeading.firstMatch(lines[start])!.group(1)!.trim();
  final body = <String>[if (head.isNotEmpty) head];
  var end = start + 1;
  for (; end < lines.length; end++) {
    final l = lines[end];
    if (_anyHeading.hasMatch(l)) break;
    if (l.trim().isEmpty) {
      if (body.isNotEmpty) break;
      continue;
    }
    body.add(l);
  }
  final tldr = body.join('\n').trim();
  final rest = [...lines.sublist(0, start), ...lines.sublist(end)].join('\n').trim();
  return (tldr: tldr.isEmpty ? null : tldr, rest: rest);
}

/// [text] with its TL;DR section moved to the top, under its own heading, so the
/// focused view leads with the author's own recap. Unchanged when it has none.
String tldrFirst(String text) {
  final s = splitTldr(text);
  if (s.tldr == null) return text.trim();
  return s.rest.isEmpty ? '## TL;DR\n\n${s.tldr}' : '## TL;DR\n\n${s.tldr}\n\n${s.rest}';
}

/// [text] with code, URLs and quotations blanked out: a `?` or a "which" inside a fenced
/// block, a code span or a query string is a regex, a ternary or a parameter, and one
/// inside a quoted title or a link's label is someone else's question, not the
/// agent's. The quotes are blanked, never deleted, so a sentence keeps its own `?`.
String _proseOnly(String text) => text
    .replaceAll(RegExp(r'```[\s\S]*?(```|$)'), ' ')
    .replaceAll(RegExp(r'`[^`\n]*`'), ' ')
    .replaceAll(RegExp(r'\[[^\]\n]*\]\([^)\s]*\)'), ' ')
    .replaceAll(RegExp(r'\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+'), ' ')
    .replaceAll(RegExp('"[^"\\n]{1,200}"|$_ldquo[^$_rdquo\\n]{1,200}$_rdquo'), '""');

List<String> _paragraphs(String text) => text
    .split(RegExp(r'\n[ \t]*\n'))
    .map((p) => p.trim())
    .where((p) => p.isNotEmpty)
    .toList();

/// The part of a reply that decides whether it asks: the whole TL;DR, plus the final
/// paragraph of the reply's own text (the TL;DR taken out), in reading order. A reply
/// that asked something earlier and then went on to report what it did is a report,
/// not a question, which is why nothing above the final paragraph counts.
String askingScope(String text) {
  final s = splitTldr(text);
  final last = _paragraphs(s.rest).lastOrNull;
  return [?last, ?s.tldr].join('\n\n');
}

/// `?`, the Arabic question mark (U+061F) and the fullwidth one (U+FF1F). Built from
/// code points so the source stays ASCII.
final RegExp _questionMark = RegExp('[?${String.fromCharCode(0x061F)}${String.fromCharCode(0xFF1F)}]');

/// A sentence that begins by asking the person for something. Only the START of a
/// sentence counts: "which" or "confirm" in the middle of one is grammar, not a
/// request ("which means", "confirmed the fix").
final RegExp _requestStart = RegExp(
    r"^(?:(?:please|so|now|ok|okay)[,]?\s+)?(?:"
    r"tell me\b|let me know\b|should i\b|shall i\b|do you want\b|would you like\b|"
    r"which (?:one|option|of|do you|would you|should|way|approach|path)\b|"
    r"i'?ll ask you\b|i will ask you\b|i need you to\b|i need your\b|"
    r"(?:can you |could you )?confirm\b)",
    caseSensitive: false);

/// A sentence opening on "which" (with no question mark) asks only when it is put to
/// the person: it names "you", or what "I"/"we" should do. "Which of the two places
/// fired ... is still a guess" is a statement about the code, not an ask.
final RegExp _which = RegExp(r"^(?:(?:please|so|now|ok|okay)[,]?\s+)?which\b", caseSensitive: false);
final RegExp _addressed = RegExp(r"\b(?:you|your|should i|shall i|should we|shall we|do i|do we)\b", caseSensitive: false);

/// "Confirm with the author that ..." sends someone ELSE to confirm: a review finding,
/// not a request of the person reading.
final RegExp _confirmElsewhere =
    RegExp(r"^(?:(?:please|so|now|ok|okay)[,]?\s+)?(?:can you |could you )?confirm\s+with\b", caseSensitive: false);

/// "Let me know if ..." / "Tell me if ..." is an OFFER at the end of a done reply
/// ("Let me know if you want more") unless it lays out a choice.
final RegExp _offer = RegExp(r"^(?:(?:please|so|now)[,]?\s+)?(?:let me know|tell me) if\b", caseSensitive: false);
final RegExp _choice = RegExp(r"\b(?:should i|or|whether)\b", caseSensitive: false);

/// Whether [sentence] asks: a question mark, or a request phrase at its start that is
/// not a courtesy offer. [sentence] must already be free of code ([_proseOnly]).
bool _asks(String sentence) {
  if (_questionMark.hasMatch(sentence)) return true;
  // A typographic apostrophe ("I'll" typed as I-U+2019-ll) reads as a plain one.
  final s = sentence.replaceFirst(RegExp(r'^[\s>*_#\-\d.)]+'), '').replaceAll(_rsquo, "'");
  if (!_requestStart.hasMatch(s)) return false;
  if (_which.hasMatch(s) && !_addressed.hasMatch(s)) return false;
  if (_confirmElsewhere.hasMatch(s)) return false;
  return !_offer.hasMatch(s) || _choice.hasMatch(s);
}

/// Whether an agent's last reply [text] ends by asking the person something, rather
/// than through a question prompt.
///
/// Decided from [askingScope] (the full TL;DR plus the final paragraph): it asks when a
/// sentence there carries a question mark outside code, or starts with a request
/// ("Tell me", "Let me know", "Should I", "Do you want", "Which one", "I'll ask you",
/// "I need you to", "Confirm"). What keeps this from listing every idle session:
///  * only that scope is read, never the body above it;
///  * a phrase counts only at the start of a sentence;
///  * "Let me know if ..." / "Tell me if ..." is an offer, not an ask, unless it lays
///    out a choice ("... if I should push or wait");
///  * code spans, fenced blocks and URLs are blanked first.
bool askingInProse(String text) => sentencesOf(_proseOnly(askingScope(text))).any(_asks);

/// Abbreviations a sentence does not end at.
final RegExp _abbrev = RegExp(r'(?:^|\s)(?:e\.g|i\.e|vs|cf|etc|approx|incl|no|fig|eq)\.$', caseSensitive: false);

/// A line that starts its own sentence: a list item, a heading, a quote.
final RegExp _blockStart = RegExp(r'^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)');

/// [text] cut into sentences. A paragraph, a list item and a heading each start a new
/// one; inside them a sentence ends at `.`, `!`, `?` (and the Arabic and fullwidth
/// question marks) followed by a space, unless the word before is an abbreviation or a
/// list number. A fenced code block is kept whole, as one sentence.
List<String> sentencesOf(String text) {
  final blocks = <String>[];
  final cur = <String>[];
  var inFence = false;
  void flush() {
    final b = cur.join(inFence ? '\n' : ' ').trim();
    if (b.isNotEmpty) blocks.add(b);
    cur.clear();
  }

  for (final line in text.split('\n')) {
    final fence = line.trimLeft().startsWith('```');
    if (fence && !inFence) {
      flush();
      inFence = true;
      cur.add(line);
      continue;
    }
    if (inFence) {
      cur.add(line);
      if (fence) {
        final b = cur.join('\n').trim();
        cur.clear();
        inFence = false;
        blocks.add('\u0000$b');
      }
      continue;
    }
    if (line.trim().isEmpty || _blockStart.hasMatch(line)) flush();
    if (line.trim().isNotEmpty) cur.add(line.trim());
  }
  flush();

  final out = <String>[];
  final end = RegExp('[.!?${String.fromCharCode(0x061F)}${String.fromCharCode(0xFF1F)}]+["\'$_rdquo$_rsquo)\\]*_]*(?=\\s)');
  for (final b in blocks) {
    if (b.startsWith('\u0000')) {
      out.add(b.substring(1));
      continue;
    }
    var start = 0;
    for (final m in end.allMatches(b)) {
      final piece = b.substring(start, m.end).trim();
      if (_abbrev.hasMatch(piece) || RegExp(r'^\d+\.$').hasMatch(piece) || RegExp(r'^[-*+]\s*\d*\.?$').hasMatch(piece)) {
        continue;
      }
      if (piece.isNotEmpty) out.add(piece);
      start = m.end;
    }
    final tail = b.substring(start).trim();
    if (tail.isNotEmpty) out.add(tail);
  }
  return out;
}

/// [sentence] shortened to [kSentenceHardCap] at a word boundary, with an ellipsis. Only
/// a run-on sentence is ever touched.
String _capSentence(String sentence) {
  if (sentence.length <= kSentenceHardCap) return sentence;
  final cut = sentence.lastIndexOf(RegExp(r'\s'), kSentenceHardCap);
  return '${sentence.substring(0, cut > 0 ? cut : kSentenceHardCap).trimRight()}$kEllipsis';
}

/// The part of [text] a card shows: all of it when it fits [budget], else the sentence
/// that asks (the last one with a question mark, else the last request, else the last
/// sentence) with as many sentences before it as still fit, and an ellipsis wherever
/// sentences were left out. It never cuts inside a sentence, except a single run-on
/// sentence longer than [kSentenceHardCap].
String questionSnippet(String text, {int budget = kSnippetBudget}) {
  final t = text.trim();
  if (t.length <= budget) return t;
  final all = sentencesOf(t);
  if (all.isEmpty) return t;
  final prose = [for (final s in all) _proseOnly(s)];
  var at = -1;
  for (var i = prose.length - 1; i >= 0 && at < 0; i--) {
    if (_questionMark.hasMatch(prose[i])) at = i;
  }
  for (var i = prose.length - 1; i >= 0 && at < 0; i--) {
    if (_asks(prose[i])) at = i;
  }
  if (at < 0) at = all.length - 1;
  var from = at;
  var len = all[at].length;
  while (from > 0 && len + 1 + all[from - 1].length <= budget) {
    from--;
    len += 1 + all[from].length;
  }
  final body = from == at ? _capSentence(all[at]) : all.sublist(from, at + 1).join(' ');
  return [if (from > 0) kEllipsis, body, if (at < all.length - 1) kEllipsis].join(' ');
}

/// The sentence of a reply that asks, for a card: [questionSnippet] over the reply's
/// [askingScope], so a card shows the request at the end rather than the head of the
/// reply.
String askingSnippet(String text, {int budget = kSnippetBudget}) {
  final scope = askingScope(text);
  return questionSnippet(scope.isEmpty ? text : scope, budget: budget);
}
