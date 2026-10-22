// #383 — the answer-landed decision and the call sites that apply it.
//
// `_verifyAnswerLanded` needs a live ApiClient, so the decision lives in the pure
// [verifyAnswerLanded] / [settleAfterAnswer] (poll injected) and is tested
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

/// Runs [settleAfterAnswer] the way the screen does, with its dismissal key set to
/// the answered question's (the optimistic hide), unless [dismissedKey] is given.
PendingQuestion? _settle(QuestionDrafts d, String key, AnswerVerification v,
        {List<AnswerFrame>? frames, String? dismissedKey}) =>
    settleAfterAnswer(
      drafts: d,
      answeredKey: key,
      frames: frames ?? _words,
      verdict: v,
      dismissedKey: dismissedKey ?? key,
    );

QuestionDrafts _drafts(String key) => QuestionDrafts()
  ..key = key
  ..other = ['typed']
  ..note = [null];

void main() {
  group('settleAfterAnswer (the verdict -> drafts + resurface)', () {
    final key = questionSignature(_q('Pick one'));

    test('still pending on every poll: flagged for the question SIGNATURE, and the '
        'question comes back', () async {
      final v = await _verify(key, [_q('Pick one', id: 'seen'), _q('Pick one', id: 'seen')]);
      final d = _drafts(key);
      final back = _settle(d, key, v);
      expect(back, same(v.stillPending));
      expect(d.flaggedFor(key), isTrue);
      expect(d.flaggedFor(questionSignature(_q('Pick another'))), isFalse,
          reason: 'another question is not flagged');
      expect(d.key, key, reason: 'the words stay');
    });

    test('the same question re-reported under ANOTHER id keeps the flag', () async {
      final v = await _verify(key, [_q('Pick one', id: 'hook'), _q('Pick one', id: 'hook')]);
      final d = _drafts(key);
      _settle(d, key, v);
      // The id is not part of the flag: a hook-id -> transcript-id re-report is
      // exactly when the selector may have closed.
      expect(d.flaggedFor(questionSignature(_q('Pick one', id: 'transcript'))), isTrue);
    });

    test('flagged although nothing resurfaces: the user already moved on, but the '
        'chip can reopen the card', () async {
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      final d = _drafts(key);
      final back = _settle(d, key, v, dismissedKey: 'something-else');
      expect(back, isNull, reason: 'dismissal moved on: do not resurface');
      expect(d.flaggedFor(key), isTrue);
    });

    test('pending once, then the next poll THROWS: flagged, nothing resurfaces',
        () async {
      final v = await _verify(key, [_q('Pick one'), Exception('link down')]);
      expect(v.stillPending, isNull, reason: 'a failed poll is not "still pending"');
      final d = _drafts(key);
      expect(_settle(d, key, v), isNull);
      expect(d.flaggedFor(key), isTrue,
          reason: 'the chip can reopen the card later; it must already be flagged');
      expect(d.key, key);
    });

    test('every poll throws: nothing was observed, nothing flagged or cleared',
        () async {
      final v = await _verify(key, [Exception('a'), Exception('b')]);
      final d = _drafts(key);
      expect(_settle(d, key, v), isNull);
      expect(d.notLanded, isFalse);
      expect(d.key, key);
    });

    test('pending, then cleared: the answer landed, drafts are dropped', () async {
      final v = await _verify(key, [_q('Pick one'), null]);
      final d = _drafts(key);
      expect(_settle(d, key, v), isNull);
      expect(d.key, isNull);
      expect(d.notLanded, isFalse);
    });

    test('a digits-only answer is never flagged', () async {
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      final d = _drafts(key);
      _settle(d, key, v,
          frames: [const AnswerFrame('1', 0), const AnswerFrame('\r', 0)]);
      expect(d.notLanded, isFalse);
    });
  });

  group('the screen applies it (source-level; no ApiClient to pump)', () {
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

    test('_verifyAnswerLanded verifies through the recorded polls, then settles '
        'UNCONDITIONALLY and applies the result inside setState', () {
      final b = body('Future<void> _verifyAnswerLanded(');
      // Not a substring of the method's own name (`_verifyAnswerLanded(`).
      expect(b, contains(RegExp(r'(?<![_\w])verifyAnswerLanded\(')));
      // The settle call follows the `mounted` guard directly (comments only in
      // between): any early return added before it, `if (verdict.stillPending ==
      // null) return;` or a dismissal-key test, would skip the flagging for an
      // answer that never resurfaces.
      expect(
          b,
          contains(RegExp(r'if \(!mounted\) return;\s*(?://[^\n]*\s*)*'
              r'final resurface = settleAfterAnswer\(')));
      expect(b, contains('verdict: verdict,'));
      expect(b, contains('drafts: _questionDrafts,'));
      // The result is applied in ONE setState, so a card reopened mid-verify
      // rebuilds with the settled drafts.
      expect(
          b,
          contains(RegExp(r'setState\(\(\) \{\s+if \(resurface != null\) \{\s+'
              r'_dismissedQuestionKey = null;\s+_pendingQuestion = resurface;')));
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
      // The WHOLE assignment: an inversion moved into it (`final partlyTyped =
      // !...`) or a `|| true` appended would otherwise leave the lines around it
      // intact.
      expect(
          b,
          contains(RegExp(r'final partlyTyped =\s*_questionDrafts\.flaggedFor\('
              r'questionSignature\(_pendingQuestion\)\);')));
      expect(b, contains("if (partlyTyped) _setLens('terminal');"));
      expect(b, contains('_dismissedQuestionKey'));
    });
  });
}
