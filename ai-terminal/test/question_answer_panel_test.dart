// #383 - the answer card extracted from the question overlay, so a screen with no
// terminal beneath it (the questions inbox) can mount it. The overlay's own behaviour
// is pinned by question_overlay_test.dart, which runs unchanged against the wrapper;
// this file pins what the extraction ADDED: the card standing on its own, with no raw
// keys and its own label for "answer elsewhere", the board's one-press predicate, and
// one session's drafts shared by every card that answers it.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/question_draft_store.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/question_answer_panel.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

PendingQuestionItem _item({bool multi = false, bool preview = false, String question = 'Pick one', String header = 'H'}) =>
    PendingQuestionItem(
      header: header,
      question: question,
      multiSelect: multi,
      hasPreview: preview,
      options: [
        QuestionOption(label: 'Red', preview: preview ? 'r' : ''),
        QuestionOption(label: 'Green', preview: preview ? 'g' : ''),
      ],
    );

PendingQuestion _pq(List<PendingQuestionItem> items, {String id = 't1'}) =>
    PendingQuestion(toolUseId: id, questions: items);

void main() {
  group('quickAnswerable (the board\'s one-press option buttons)', () {
    test('one single-select question: one press is the whole answer', () {
      expect(quickAnswerable(_pq([_item()])), isTrue);
      expect(quickAnswerable(_pq([_item(preview: true)])), isTrue,
          reason: 'buildAnswerFrames commits a previewed single-select with its Enter');
    });

    test('multi-select, or several questions, needs the full card', () {
      expect(quickAnswerable(_pq([_item(multi: true)])), isFalse, reason: 'one press toggles a row');
      expect(quickAnswerable(_pq([_item(), _item(question: 'Another')])), isFalse);
    });
  });

  group('QuestionAnswerPanel on its own', () {
    Future<void> mount(WidgetTester tester, Widget panel) async {
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(theme: AppTheme.dark, home: Scaffold(body: panel)));
      await tester.pumpAndSettle();
    }

    testWidgets('with no terminal beneath (onKey null) it offers no raw keys, and names where else to answer',
        (tester) async {
      await mount(
          tester,
          QuestionAnswerPanel(
            question: _pq([_item()]),
            onSend: (_) {},
            onDismiss: () {},
            elsewhereLabel: 'Open session',
          ));
      expect(find.byTooltip('Show raw keys'), findsNothing);
      expect(find.text('Open session'), findsOneWidget);
      expect(find.text('Answer in terminal'), findsNothing);
    });

    testWidgets('with a terminal (onKey set) the raw-key toggle is there and forwards', (tester) async {
      final keys = <String>[];
      await mount(
          tester,
          QuestionAnswerPanel(question: _pq([_item()]), onSend: (_) {}, onDismiss: () {}, onKey: keys.add));
      await tester.tap(find.byTooltip('Show raw keys'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Esc'));
      expect(keys, ['\x1b']);
      expect(find.text('Answer in terminal'), findsOneWidget, reason: 'the default label is the overlay\'s');
    });

    testWidgets('it sends exactly buildAnswerFrames for the picks', (tester) async {
      final q = _pq([_item(preview: true, header: 'Colour'), _item(multi: true, question: 'Which ones?', header: 'More')]);
      List<AnswerFrame>? sent;
      await mount(tester, QuestionAnswerPanel(question: q, onSend: (f) => sent = f, onDismiss: () {}));
      await tester.tap(find.text('Green'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('More')); // the second tab
      await tester.pumpAndSettle();
      await tester.tap(find.text('Red'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send answer'));
      final expected = buildAnswerFrames(q.questions, [
        {1},
        {0},
      ]);
      expect(sent!.map((f) => f.keys), expected.map((f) => f.keys));
    });
  });

  group('one session\'s drafts, shared by every card that answers it (QuestionDraftStore)', () {
    setUp(QuestionDraftStore.instance.resetForTest);

    test('one instance per session, keyed by server as well as id', () {
      final store = QuestionDraftStore.instance;
      expect(identical(store.of('http://a:1', 's1'), store.of('http://a:1', 's1')), isTrue);
      expect(identical(store.of('http://a:1', 's1'), store.of('http://b:1', 's1')), isFalse);
      expect(identical(store.of('http://a:1', 's1'), store.of('http://a:1', 's2')), isFalse);
    });

    testWidgets('words typed on the session screen\'s overlay are on a second card for the same question',
        (tester) async {
      final q = _pq([_item()]);
      const sig = 'sig-A';
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      // The session screen's consumer: the overlay, drafts looked up in the store.
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(children: [
            QuestionOverlay(
              question: q,
              drafts: QuestionDraftStore.instance.of('http://a:1', 's1'),
              draftKey: sig,
              onSend: (_) {},
              onKey: (_) {},
              onDismiss: () {},
            ),
          ]),
        ),
      ));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'a long dictated answer');
      await tester.pumpAndSettle();

      // A second consumer (the inbox's card) looks the same session up.
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: QuestionAnswerPanel(
            question: _pq([_item()], id: 't2'), // the same question under another id
            drafts: QuestionDraftStore.instance.of('http://a:1', 's1'),
            draftKey: sig,
            onSend: (_) {},
            onDismiss: () {},
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'a long dictated answer');

      // And an answer flagged not-landed by one card puts the other into
      // "Send again anyway" mode: the flag is the session's, not the screen's.
      QuestionDraftStore.instance.of('http://a:1', 's1').markSent(sig, buildAnswerFrames(q.questions, [<int>{}],
          otherText: ['a long dictated answer']));
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(children: [
            QuestionOverlay(
              question: q,
              drafts: QuestionDraftStore.instance.of('http://a:1', 's1'),
              draftKey: sig,
              onSend: (_) {},
              onKey: (_) {},
              onDismiss: () {},
            ),
          ]),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.text('Send again anyway'), findsOneWidget);
    });
  });
}
