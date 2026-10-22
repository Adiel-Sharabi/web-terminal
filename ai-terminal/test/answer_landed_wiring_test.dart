// #383 — the answer-landed decision and the call sites that apply it.
//
// `_verifyAnswerLanded` needs a live ApiClient, so the decision lives in the pure
// [verifyAnswerLanded] / [settleDraftsAfterAnswer] (poll injected) and is tested
// here directly. The SECOND half is the wiring: that the screen actually calls
// them, and that "Answer in terminal" opens the terminal after a not-landed answer.
// No behavioural test can see a call deleted from the screen, so those are asserted
// against the SOURCE, as tests/app-input-path.spec.js does for the web client.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';

PendingQuestion _q(String question, {String id = 't'}) => PendingQuestion(
      toolUseId: id,
      questions: [
        PendingQuestionItem(
          header: 'H',
          question: question,
          multiSelect: false,
          hasPreview: false,
          options: [QuestionOption(label: 'Red'), QuestionOption(label: 'Green')],
        ),
      ],
    );

final _words = [
  const AnswerFrame('3', 0),
  const AnswerFrame('typed', 0, text: true, other: true),
  const AnswerFrame('\r', 0),
];

/// Runs the verify with [polls] answered in order; an `Exception` entry throws.
Future<AnswerVerification> _verify(String key, List<Object?> polls) {
  var i = 0;
  return verifyAnswerLanded(
    answeredKey: key,
    resendEnter: false,
    poll: () async {
      final next = polls[i < polls.length ? i++ : polls.length - 1];
      if (next is Exception) throw next;
      return next as PendingQuestion?;
    },
    resend: () {},
    attempts: polls.length,
    every: Duration.zero,
  );
}

QuestionDrafts _drafts(String key) => QuestionDrafts()
  ..key = key
  ..other = ['typed']
  ..note = [null]
  ..selected = [<int>{}];

void main() {
  group('settleDraftsAfterAnswer (what the polls saw -> the drafts)', () {
    final key = questionSignature(_q('Pick one'));

    test('still pending on every poll: flagged (the overlay resurfaces)', () async {
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      expect(v.stillPending, isNotNull);
      final d = _drafts(key);
      settleDraftsAfterAnswer(d, key, _words, v.seen);
      expect(d.partlyTyped, isTrue);
      expect(d.key, key, reason: 'the words stay');
    });

    test('pending once, then the next poll THROWS: still flagged, though nothing '
        'resurfaces', () async {
      final v = await _verify(key, [_q('Pick one'), Exception('link down')]);
      expect(v.stillPending, isNull, reason: 'a failed poll is not "still pending"');
      final d = _drafts(key);
      settleDraftsAfterAnswer(d, key, _words, v.seen);
      expect(d.partlyTyped, isTrue,
          reason: 'the chip can reopen the card later; it must already be flagged');
      expect(d.key, key);
    });

    test('every poll throws: nothing was observed, nothing is flagged or cleared',
        () async {
      final v = await _verify(key, [Exception('a'), Exception('b')]);
      final d = _drafts(key);
      settleDraftsAfterAnswer(d, key, _words, v.seen);
      expect(d.partlyTyped, isFalse);
      expect(d.key, key);
    });

    test('pending, then cleared: the answer landed, drafts are dropped', () async {
      final v = await _verify(key, [_q('Pick one'), null]);
      final d = _drafts(key);
      settleDraftsAfterAnswer(d, key, _words, v.seen);
      expect(d.key, isNull);
      expect(d.partlyTyped, isFalse);
    });

    test('a digits-only answer is never flagged', () async {
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      final d = _drafts(key);
      settleDraftsAfterAnswer(
          d, key, [const AnswerFrame('1', 0), const AnswerFrame('\r', 0)], v.seen);
      expect(d.partlyTyped, isFalse);
    });
  });

  group('the screen applies them (source-level; no ApiClient to pump)', () {
    final src = File('lib/screens/session_screen.dart').readAsStringSync();

    // The text of the member that begins at [signature], up to the next
    // member at the same indent.
    String body(String signature) {
      final start = src.indexOf(signature);
      expect(start, greaterThanOrEqualTo(0), reason: '$signature exists');
      final end = src.indexOf(RegExp(r'\n  (?:Future|void|bool|static|String)\b'),
          start + signature.length);
      return src.substring(start, end < 0 ? src.length : end);
    }

    test('_verifyAnswerLanded verifies through the recorded polls and settles '
        'the drafts', () {
      final b = body('Future<void> _verifyAnswerLanded(');
      // Not a substring of the method's own name (`_verifyAnswerLanded(`).
      expect(b, contains(RegExp(r'(?<![_\w])verifyAnswerLanded\(')));
      expect(b, contains('settleDraftsAfterAnswer('));
      expect(b, contains('_questionDrafts'));
    });

    test('the 4 s poll records what it saw before clearing drafts', () {
      final b = body('Future<void> _pollPendingQuestion()');
      expect(b, contains('seen.record('));
      expect(b, contains('seen.shouldClearDrafts('));
    });

    test('"Answer in terminal" opens the terminal when the answer is partly typed',
        () {
      expect(src, contains('onDismiss: _dismissQuestionOverlay'));
      final b = body('void _dismissQuestionOverlay()');
      expect(b, contains('_questionDrafts.partlyTyped'));
      expect(b, contains("_setLens('terminal')"));
      expect(b, contains('_dismissedQuestionKey'));
    });
  });
}
