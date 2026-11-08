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
AnswerSettlement _settle(QuestionDrafts d, String key, AnswerVerification v,
        {String? dismissedKey}) =>
    settleAfterAnswer(
      drafts: d,
      answeredKey: key,
      verdict: v,
      dismissedKey: dismissedKey ?? key,
    );

/// The drafts of a question whose answer has just been SENT: the screen marks them
/// before the first key goes out, so everything below starts from that state.
QuestionDrafts _sent(String key, {List<AnswerFrame>? frames}) => QuestionDrafts()
  ..key = key
  ..other = ['typed']
  ..note = [null]
  ..markSent(key, frames ?? _words);

void main() {
  group('settleAfterAnswer (the verdict -> drafts + resurface)', () {
    final key = questionSignature(_q('Pick one'));

    test('marking happens at SEND time: before any poll the question is flagged',
        () {
      final d = _sent(key);
      expect(d.flaggedFor(key), isTrue);
      expect(d.flaggedFor(questionSignature(_q('Pick another'))), isFalse,
          reason: 'another question is not flagged');
    });

    test('still pending on every poll: the flag stays and the question comes back',
        () async {
      final v = await _verify(key, [_q('Pick one', id: 'seen'), _q('Pick one', id: 'seen')]);
      final d = _sent(key);
      final back = _settle(d, key, v);
      expect(back.apply, isTrue);
      expect(back.question, same(v.stillPending));
      expect(back.undismiss, isTrue);
      expect(d.flaggedFor(key), isTrue);
      expect(d.key, key, reason: 'the words stay');
    });

    test('the same question re-reported under ANOTHER id keeps the flag', () async {
      final v = await _verify(key, [_q('Pick one', id: 'hook'), _q('Pick one', id: 'hook')]);
      final d = _sent(key);
      _settle(d, key, v);
      // The id is not part of the flag: a hook-id -> transcript-id re-report is
      // exactly when the selector may have closed.
      expect(d.flaggedFor(questionSignature(_q('Pick one', id: 'transcript'))), isTrue);
    });

    test('flagged although nothing resurfaces: the user already moved on, but the '
        'chip can reopen the card', () async {
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      final d = _sent(key);
      final back = _settle(d, key, v, dismissedKey: 'something-else');
      expect(back.apply, isFalse, reason: 'dismissal moved on: do not resurface');
      expect(d.flaggedFor(key), isTrue);
    });

    test('pending once, then the next poll THROWS: still flagged, nothing '
        'resurfaces', () async {
      final v = await _verify(key, [_q('Pick one'), Exception('link down')]);
      expect(v.stillPending, isNull, reason: 'a failed poll is not "still pending"');
      final d = _sent(key);
      expect(_settle(d, key, v).apply, isFalse);
      expect(d.flaggedFor(key), isTrue);
      expect(d.key, key);
    });

    test('every poll THROWS: nothing was observed, so the flag set at send stays',
        () async {
      final v = await _verify(key, [Exception('a'), Exception('b')]);
      final d = _sent(key);
      expect(_settle(d, key, v).apply, isFalse,
          reason: 'a failed poll proves nothing: the card stays as it is');
      expect(d.flaggedFor(key), isTrue,
          reason: 'a verify that saw nothing must not leave a replayable card');
      expect(d.key, key);
    });

    test('pending, then cleared: the answer landed, drafts and flag are dropped',
        () async {
      final v = await _verify(key, [_q('Pick one'), null]);
      final d = _sent(key);
      final back = _settle(d, key, v);
      expect(d.key, isNull);
      expect(d.notLanded, isFalse);
      expect(d.flaggedFor(key), isFalse);
      expect(d.sentWords, isEmpty);
      // A card reopened from the chip mid-verify must unmount (#383).
      expect(back.apply, isTrue);
      expect(back.question, isNull, reason: 'gone: the stale card is unmounted');
      expect(back.undismiss, isFalse);
    });

    test('replaced by a DIFFERENT question: a positive observation, flag dropped',
        () async {
      final other = _q('Something else entirely', id: 'new');
      final v = await _verify(key, [other]);
      final d = _sent(key);
      final back = _settle(d, key, v);
      expect(d.notLanded, isFalse);
      expect(d.key, isNull);
      // The card becomes the NEW question, with none of the old words carried over.
      expect(back.apply, isTrue);
      expect(back.question, same(other));
      expect(back.undismiss, isTrue);
      expect(d.words, isEmpty);
      expect(d.other, isEmpty);
      expect(d.flaggedFor(questionSignature(other)), isFalse);
    });

    test('a digits-only answer that was replaced still swaps the card', () async {
      final other = _q('Something else entirely', id: 'new');
      final v = await _verify(key, [other]);
      final d = QuestionDrafts(); // nothing typed, nothing flagged
      final back = _settle(d, key, v);
      expect(back.apply, isTrue);
      expect(back.question, same(other));
    });

    test('a digits-only answer is never flagged', () async {
      final d = _sent(key,
          frames: [const AnswerFrame('1', 0), const AnswerFrame('\r', 0)]);
      expect(d.notLanded, isFalse);
      final v = await _verify(key, [_q('Pick one'), _q('Pick one')]);
      _settle(d, key, v);
      expect(d.notLanded, isFalse);
    });
  });

  // #423 - "Chat about this" REJECTS the question (no PostToolUse), so the server
  // reports it until Claude's Stop. Verifying that always looked "stuck": the card came
  // back and a Send typed a digit and an Enter into a working Claude.
  group('a question turned down with "Chat about this" (#423)', () {
    final asked = _q('Pick one');
    final key = questionSignature(asked);

    test('held back from the card AND the "question is waiting" chip while reported', () {
      final shown = questionAfterRejection(asked, key);
      expect(shown, isNull);
      // The user's own dismissal is the key too (the screen sets both at send time).
      expect(questionOverlayVisible(shown, key), isFalse);
      expect(pendingQuestionChipVisible(shown, key), isFalse);
      // Without the hold the poll would hand the same question straight back, and the
      // chip reopens the card.
      expect(pendingQuestionChipVisible(asked, key), isTrue);
    });

    test('the hold outlasts the verify budget: 20 polls of the same question', () {
      String? rejected = key;
      for (var i = 0; i < 20; i++) {
        expect(questionAfterRejection(asked, rejected), isNull, reason: 'poll $i');
        rejected = rejectedKeyAfterPoll(rejected, asked);
      }
      expect(rejected, key);
    });

    test('a poll that sees it GONE ends the hold; a different question is never held', () {
      expect(rejectedKeyAfterPoll(key, null), isNull);
      final other = _q('Pick another');
      expect(questionAfterRejection(other, key), same(other));
      expect(rejectedKeyAfterPoll(key, other), isNull);
      // After it ended, a later question - even this one asked again - shows normally.
      expect(questionAfterRejection(asked, rejectedKeyAfterPoll(key, null)), same(asked));
    });

    test('with no rejection nothing is held and no key appears', () {
      expect(questionAfterRejection(asked, null), same(asked));
      expect(questionAfterRejection(null, key), isNull);
      expect(rejectedKeyAfterPoll(null, asked), isNull);
      expect(rejectedKeyAfterPoll(null, null), isNull);
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
              r'final settled = settleAfterAnswer\(')));
      expect(b, contains('verdict: verdict,'));
      expect(b, contains('drafts: _questionDrafts,'));
      // The result is applied in ONE setState, so a card reopened mid-verify
      // rebuilds with the settled drafts AND the question the verify observed
      // (unmounted when gone, the new one when replaced).
      expect(b, contains('if (!settled.apply) return;'));
      expect(
          b,
          contains(RegExp(r'setState\(\(\) \{\s+if \(settled\.undismiss\) '
              r'_dismissedQuestionKey = null;\s+'
              r'_pendingQuestion = settled\.question;')));
    });

    test('_answerQuestion flags the words BEFORE the first key goes out', () {
      final b = body('Future<void> _answerQuestion(');
      final mark = b.indexOf(
          RegExp(r'_questionDrafts\.markSent\(answeredKey, frames\);'));
      final send = b.indexOf('deliverAnswerFrames(');
      expect(mark, greaterThanOrEqualTo(0));
      expect(send, greaterThanOrEqualTo(0));
      expect(mark, lessThan(send),
          reason: 'a card mounted mid-send must already be flagged');
    });

    test('settleAfterAnswer sets no flag of its own (only clear() drops it)', () {
      final i = src.indexOf('AnswerSettlement settleAfterAnswer(');
      // CRLF-tolerant: a Windows checkout (core.autocrlf) holds \r\n, never a bare \n.
      final end = src.indexOf(RegExp(r'\r?\n\}\r?\n'), i);
      final b = src.substring(i, end);
      expect(b, isNot(contains('markSent')));
      expect(b, isNot(contains('notLanded')));
    });

    test('_answerQuestion holds a rejected question and never verifies it (#423)', () {
      final b = body('Future<void> _answerQuestion(');
      expect(
          b,
          contains('_rejectedQuestionKey = answerIsVerifiable(frames) ? '
              'null : answeredKey;'));
      expect(
          b,
          contains(RegExp(r'if \(answeredKey\.isNotEmpty && answerIsVerifiable\(frames\)\) '
              r'\{\s+await _verifyAnswerLanded\(')));
    });

    test('the 4 s poll reads the raw question for the drafts and the rejected key, '
        'then shows the held one (#423)', () {
      final b = body('Future<void> _pollPendingQuestion()');
      // Anchored at the start of a line: a commented-out copy (`// q = held;`) is not
      // the line this test is looking for.
      int at(String code) =>
          b.indexOf(RegExp('^[ \\t]*${RegExp.escape(code)}', multiLine: true));
      final drafts = at('if (seen.shouldClearDrafts(');
      final held = at('final held = questionAfterRejection(q, _rejectedQuestionKey);');
      final key = at('_rejectedQuestionKey = rejectedKeyAfterPoll(_rejectedQuestionKey, q);');
      final swap = at('q = held;');
      final apply = at('if (q?.toolUseId != _pendingQuestion?.toolUseId)');
      for (final i in [drafts, held, key, swap, apply]) {
        expect(i, greaterThanOrEqualTo(0));
      }
      expect(drafts, lessThan(held));
      expect(held, lessThan(key));
      expect(key, lessThan(swap),
          reason: 'the key must be read off the RAW observation, before q is replaced');
      expect(swap, lessThan(apply));
    });

    test('ONE predicate: neither the screen nor the board re-derives "is Chat"', () {
      final board = File('lib/services/needs_you_actions.dart').readAsStringSync();
      expect(src, contains('answerIsVerifiable(frames)'));
      expect(board, contains('answerIsVerifiable(frames)'));
      expect(src, isNot(contains('.chat')));
      expect(board, isNot(contains('.chat')));
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
