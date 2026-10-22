// The one [QuestionDrafts] per session (#383).
//
// The words typed into a question card (an Other answer, a note) and the "it did not
// land" flag belong to the SESSION, not to whichever screen showed the card. The
// session screen and the questions inbox both answer the same question, so each looks
// its drafts up here: a flag set when one of them sends is seen by the other, and a
// blind replay is refused wherever the card is opened next.
//
// The rules for when the drafts are kept and cleared stay with [QuestionDrafts] and
// its callers (`shouldClearQuestionDrafts`, `settleAfterAnswer`); this only decides
// that there is one of them per session.

import 'package:flutter/foundation.dart';

import '../widgets/question_overlay.dart' show QuestionDrafts;

class QuestionDraftStore {
  QuestionDraftStore._();

  static final QuestionDraftStore instance = QuestionDraftStore._();

  final Map<String, QuestionDrafts> _drafts = {};

  /// The drafts of session [sessionId] on the server at [baseUrl], created empty on
  /// first use. Keyed by server as well as id: two servers can each have an `s1`.
  QuestionDrafts of(String baseUrl, String sessionId) =>
      _drafts.putIfAbsent('$baseUrl|$sessionId', QuestionDrafts.new);

  /// The drafts of that session if any were ever made, else null. For a read-only
  /// look ("is it flagged", "what is typed"), which must not leave an empty entry
  /// behind for every session it looked at.
  QuestionDrafts? peek(String baseUrl, String sessionId) => _drafts['$baseUrl|$sessionId'];

  /// Forgets every session's drafts, so one test cannot see another's words.
  @visibleForTesting
  void resetForTest() => _drafts.clear();
}
