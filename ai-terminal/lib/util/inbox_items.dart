// The pure rules behind the questions inbox (#383). Only [askingInProse] so far; the
// item model and its ordering join it with the inbox screen.

/// Whether an agent's last reply [text] ends by asking the person something in prose,
/// rather than through a question prompt: its LAST paragraph carries a question mark.
///
/// Only the last paragraph counts, because a reply that asked something earlier and
/// then went on to say what it did is a report, not a question. Code never counts: a
/// `?` inside a fenced block or an inline code span is a regex, a ternary or a query
/// string, not a question, and so is one inside a URL. The Arabic question mark
/// (U+061F) and the fullwidth one (U+FF1F) count as well as `?`.
bool askingInProse(String text) {
  final prose = text
      .replaceAll(RegExp(r'```[\s\S]*?(```|$)'), ' ')
      .replaceAll(RegExp(r'`[^`\n]*`'), ' ')
      .replaceAll(RegExp(r'\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+'), ' ');
  final paragraphs = prose
      .split(RegExp(r'\n[ \t]*\n'))
      .map((p) => p.trim())
      .where((p) => p.isNotEmpty)
      .toList();
  if (paragraphs.isEmpty) return false;
  return _questionMark.hasMatch(paragraphs.last);
}

/// `?`, the Arabic question mark (U+061F) and the fullwidth one (U+FF1F). Built from
/// code points so the source stays ASCII.
final RegExp _questionMark = RegExp('[?${String.fromCharCode(0x061F)}${String.fromCharCode(0xFF1F)}]');
