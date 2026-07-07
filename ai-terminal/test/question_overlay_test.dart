// Tests for the interactive-question overlay (issue #19): the pure frame
// builder that drives Claude's TUI selector with ABSOLUTE row digits,
// PendingQuestion parsing, and the overlay's select-then-send interaction.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';

PendingQuestionItem _q(
  List<String> options, {
  bool multi = false,
  String header = 'H',
}) =>
    PendingQuestionItem(
      header: header,
      question: 'Pick',
      multiSelect: multi,
      options: [for (final o in options) QuestionOption(label: o)],
    );

/// The keys of each frame, for terse assertions.
List<String> _keys(List<AnswerFrame> f) => [for (final x in f) x.keys];

void main() {
  group('buildAnswerFrames', () {
    test('single-select, single question: just the row digit (auto-submits)',
        () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(_keys(buildAnswerFrames(qs, [
        {0}
      ])), ['1']);
      expect(_keys(buildAnswerFrames(qs, [
        {2}
      ])), ['3']);
    });

    test('multi-select: a digit per selected row (toggle) then Enter', () {
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      // select A and C -> toggle 1, toggle 3, confirm
      expect(_keys(buildAnswerFrames(qs, [
        {0, 2}
      ])), ['1', '3', '\r']);
    });

    test('multiple questions: a digit per tab, then a final Submit Enter', () {
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'])];
      // Q1 -> B (digit 2, advances); Q2 -> X (digit 1, advances); Submit (Enter)
      expect(_keys(buildAnswerFrames(qs, [
        {1},
        {0}
      ])), ['2', '1', '\r']);
    });

    test('transition frames use a gap so they land in separate PTY reads', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ]);
      expect(frames.single.delayMs, greaterThanOrEqualTo(500));
    });
  });

  group('answerNeedsConfirm (cluster-path Enter re-send gate)', () {
    test('single-select single question needs no confirm (digit auto-submits)',
        () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ]);
      expect(answerNeedsConfirm(frames), isFalse);
    });

    test('multi-select needs a confirm (trailing Enter)', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], multi: true)], [
        {0, 2}
      ]);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('multi-question needs a confirm (Submit-review Enter)', () {
      final frames = buildAnswerFrames([_q(['A', 'B']), _q(['X', 'Y'])], [
        {0},
        {1}
      ]);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('empty frame list needs no confirm', () {
      expect(answerNeedsConfirm(const []), isFalse);
    });
  });

  group('PendingQuestion.fromJson', () {
    test('pending:false -> null', () {
      expect(PendingQuestion.fromJson({'pending': false}), isNull);
      expect(PendingQuestion.fromJson({}), isNull);
    });

    test('parses questions + options', () {
      final pq = PendingQuestion.fromJson({
        'pending': true,
        'question': {
          'toolUseId': 'toolu_1',
          'questions': [
            {
              'header': 'DB',
              'question': 'Which database?',
              'multiSelect': false,
              'options': [
                {'label': 'Postgres', 'description': 'default'},
                {'label': 'MySQL'},
              ],
            },
          ],
        },
      });
      expect(pq, isNotNull);
      expect(pq!.toolUseId, 'toolu_1');
      expect(pq.questions.single.options.map((o) => o.label),
          ['Postgres', 'MySQL']);
    });

    test('empty questions -> null', () {
      expect(
        PendingQuestion.fromJson({
          'pending': true,
          'question': {'toolUseId': 't', 'questions': []},
        }),
        isNull,
      );
    });
  });

  group('lastAssistantText (question context)', () {
    test('returns the most recent non-empty assistant turn', () {
      final turns = [
        const TranscriptTurn(role: 'assistant', text: 'old', toolUses: [], ts: null),
        const TranscriptTurn(role: 'user', text: 'hi', toolUses: [], ts: null),
        const TranscriptTurn(
            role: 'assistant', text: 'the full answer', toolUses: [], ts: null),
        const TranscriptTurn(role: 'user', text: 'ok', toolUses: [], ts: null),
      ];
      expect(lastAssistantText(turns), 'the full answer');
    });

    test('skips empty assistant turns; null when none', () {
      expect(
        lastAssistantText(const [
          TranscriptTurn(role: 'assistant', text: '   ', toolUses: [], ts: null),
          TranscriptTurn(role: 'user', text: 'x', toolUses: [], ts: null),
        ]),
        isNull,
      );
      expect(lastAssistantText(const []), isNull);
    });
  });

  testWidgets('shows Claude\'s preceding message as context when provided',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'tc',
                  questions: [_q(['A', 'B'])],
                ),
                contextText:
                    'Here is the FULL_ANSWER_CONTEXT that led to the question.',
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Claude said'), findsOneWidget);
    expect(find.textContaining('FULL_ANSWER_CONTEXT'), findsOneWidget);
  });

  testWidgets('select an option then Send forwards the built frames',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 't1',
      questions: [_q(['Alpha', 'Beta', 'Gamma'])],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: pq,
                onSend: (s) => sent = s,
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Send is disabled until an option is chosen.
    final sendFinder = find.widgetWithText(FilledButton, 'Pick an option');
    expect(tester.widget<FilledButton>(sendFinder).onPressed, isNull);

    await tester.tap(find.text('Gamma'));
    await tester.pumpAndSettle();

    final ready = find.widgetWithText(FilledButton, 'Send answer');
    expect(tester.widget<FilledButton>(ready).onPressed, isNotNull);
    await tester.tap(ready);
    await tester.pumpAndSettle();

    // Gamma is index 2 -> the absolute row digit "3".
    expect(_keys(sent!), ['3']);
  });

  testWidgets('manual Enter key button forwards a raw CR', (tester) async {
    String? key;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't2',
                  questions: [_q(['A', 'B'])],
                ),
                onSend: (_) {},
                onKey: (s) => key = s,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.widgetWithText(OutlinedButton, 'Enter'));
    await tester.pump();
    expect(key, '\r');
  });
}
