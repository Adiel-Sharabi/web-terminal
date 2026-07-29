// Tests for the interactive-question overlay (issue #19): the pure frame
// builder that drives Claude's TUI selector with ABSOLUTE row digits,
// PendingQuestion parsing, and the overlay's select-then-send interaction.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

    test('multi-select (single question): toggle digits, Right-arrow, "1" (#39)',
        () {
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      // Verified on-device: select A and C -> toggle 1, toggle 3; then Enter
      // would only TOGGLE the highlighted row (never submits), so Right-arrow
      // jumps to the "Submit" review and digit "1" ("Submit answers") finalizes.
      expect(_keys(buildAnswerFrames(qs, [
        {0, 2}
      ])), ['1', '3', '\x1b[C', '1']);
    });

    test('multi-select toggle+submit frames land in separate PTY reads (#39)',
        () {
      // The toggles may coalesce safely (settle), but the Right-arrow and the
      // "1" must each be read separately (a coalesced Right+1 would misfire).
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], multi: true)], [
        {0, 2}
      ]);
      // last two frames = Right-arrow, then "1"
      expect(frames[frames.length - 2].keys, '\x1b[C');
      expect(frames.last.keys, '1');
      expect(frames[frames.length - 2].delayMs, greaterThanOrEqualTo(500));
      expect(frames.last.delayMs, greaterThanOrEqualTo(500));
    });

    test('multiple questions: a digit per tab, then a final Submit Enter', () {
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'])];
      // Q1 -> B (digit 2, advances); Q2 -> X (digit 1, advances); Submit (Enter)
      expect(_keys(buildAnswerFrames(qs, [
        {1},
        {0}
      ])), ['2', '1', '\r']);
    });

    test('multi-question + multi-select: advance a multi-select tab with →, not Enter',
        () {
      // The bug: this branch sent Enter to advance, but in the multi-select
      // selector Enter TOGGLES the highlighted row and stays on the tab — so the
      // trailing Enter un-toggled a row and never advanced, later digits fell on
      // the wrong question, and the remaining tabs recorded nothing. Proven on
      // the real Opus-5 TUI (claude 2.1.220): `1,3,Enter,2,Enter` recorded
      // Red+Blue+Green for Q1 and NOTHING for Q2; `1,3,→,2,Enter` recorded
      // Red+Green for Q1 and the Q2 pick correctly. Q1 multi-select {A,C} ->
      // toggle 1, toggle 3, → to next tab; Q2 single {Y} -> digit 2 (advances to
      // the Submit review); trailing Enter finalizes.
      final qs = [_q(['A', 'B', 'C'], multi: true), _q(['X', 'Y', 'Z'])];
      expect(_keys(buildAnswerFrames(qs, [
        {0, 2},
        {1}
      ])), ['1', '3', '\x1b[C', '2', '\r']);
    });

    test('multi-question ending in a multi-select tab: → reaches Submit, Enter finalizes',
        () {
      // A multi-select as the LAST question: the → lands on the Submit review
      // (one tab past the last question), and the single post-loop Enter submits
      // — same endpoint as a single-select last tab.
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'], multi: true)];
      expect(_keys(buildAnswerFrames(qs, [
        {0},
        {1, 2}
      ])), ['1', '2', '3', '\x1b[C', '\r']);
    });

    test('transition frames use a gap so they land in separate PTY reads', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ]);
      expect(frames.single.delayMs, greaterThanOrEqualTo(500));
    });

    test(
        'single-select via Other free-text: "Type something." row, text, submit',
        () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [<int>{}],
        otherText: const ['deploy to staging'],
      );
      // 3 options -> the implied "Type something." row is digit 4; the digit is
      // CONSUMED (selects the row, not part of the answer); then the free text;
      // then Enter submits.
      expect(_keys(frames), ['4', 'deploy to staging', '\r']);
      // All three must land in SEPARATE stdin reads (text+CR in one burst reads
      // as a paste, not a submit) -> each carries the full inter-frame gap.
      for (final f in frames) {
        expect(f.delayMs, greaterThanOrEqualTo(500));
      }
    });

    test('Other free-text is trimmed before it is sent', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [<int>{}], otherText: const ['  hi there '])),
        ['4', 'hi there', '\r'],
      );
    });

    test('multi-select ignores Other entirely (no free-text path)', () {
      // On-device: in multi-select the "Type something." row is a CHECKBOX —
      // digit N+1 only toggles it, it does NOT open a free-text input and any
      // typed text is discarded. So Other is not offered for multi-select and
      // buildAnswerFrames must ignore otherText here, emitting the normal
      // toggle+confirm frames instead.
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0, 2}
        ], otherText: const ['custom'])),
        ['1', '3', '\x1b[C', '1'],
      );
    });

    test('blank/whitespace Other falls back to the numeric selection', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {1}
        ], otherText: const ['   '])),
        ['2'],
      );
    });

    test('otherText default does not change existing (non-Other) frames', () {
      final qs = [_q(['A', 'B', 'C'])];
      // Regression guard: passing otherText:[null] must be byte-for-byte
      // identical to omitting it entirely.
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ])),
        _keys(buildAnswerFrames(qs, [
          {0}
        ], otherText: const [null])),
      );
    });

    test(
      'multi-question + Other is deferred (unverified TUI tab-advance semantics)',
      () {
        // The on-device proof covers a SINGLE question only. Whether a
        // free-text submit advances to the next tab like a single-select digit
        // does is unverified, so the overlay hides the Other row when there is
        // more than one question and buildAnswerFrames ignores otherText in the
        // multi-question case. This test pins that intent; unskip it once the
        // multi-question mechanism is verified on-device.
        final qs = [_q(['A', 'B']), _q(['X', 'Y'])];
        final frames = buildAnswerFrames(
          qs,
          [<int>{}, {0}],
          otherText: const ['freeform', null],
        );
        expect(_keys(frames), isNot(contains('freeform')));
      },
      skip: 'multi-question + Other deferred until the TUI mechanism is verified',
    );

    test(
      'multi-select + Other is deferred (checkbox row, no free-text input)',
      () {
        // On-device: the multi-select "Type something." row is a CHECKBOX that
        // toggles rather than opening a free-text field, so the digit+text+CR
        // sequence would submit a checked-but-EMPTY option and lose the typed
        // text. Other is therefore restricted to single-select single questions
        // and buildAnswerFrames never emits the free-text path for multi-select.
        final qs = [_q(['A', 'B', 'C'], multi: true)];
        final frames = buildAnswerFrames(qs, [<int>{}], otherText: const ['x']);
        expect(_keys(frames), isNot(contains('x')));
      },
      skip: 'multi-select Other deferred: TUI checkbox row has no free-text input',
    );
  });

  group('buildAnswerFrames — note attached to an option (#64 Gap 1)', () {
    test(
        'note on an already-chosen option: highlight move, n, note text, '
        'submit — as SEPARATE frames', () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ], // "B" already chosen (index 1)
        noteText: const ['please clarify the deploy target'],
      );
      // A single-select digit SELECTS AND SUBMITS (can't be reused here), so
      // the highlight is walked down from the assumed default top row
      // instead (1 Down-arrow to reach index 1); then n opens the note
      // editor, the text, then Enter submits.
      expect(_keys(frames),
          ['\x1b[B', 'n', 'please clarify the deploy target', '\r']);
      // n / note text / submit must each land in a SEPARATE PTY read.
      expect(frames[1].delayMs, greaterThanOrEqualTo(500));
      expect(frames[2].delayMs, greaterThanOrEqualTo(500));
      expect(frames[3].delayMs, greaterThanOrEqualTo(500));
    });

    test('note on the first option (index 0): no highlight move needed', () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {0}
        ],
        noteText: const ['note for A'],
      );
      expect(_keys(frames), ['n', 'note for A', '\r']);
    });

    test('note on the third option: TWO highlight-move frames first', () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {2}
        ],
        noteText: const ['note for C'],
      );
      expect(_keys(frames), ['\x1b[B', '\x1b[B', 'n', 'note for C', '\r']);
    });

    test('note text is trimmed before it is sent', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ], noteText: const ['  hi  '])),
        ['n', 'hi', '\r'],
      );
    });

    test('blank/whitespace note falls back to the plain digit path (no note)',
        () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {1}
        ], noteText: const ['   '])),
        ['2'],
      );
    });

    test('no note set does not change the existing single-select path '
        '(regression guard)', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ])),
        _keys(buildAnswerFrames(qs, [
          {0}
        ], noteText: const [null])),
      );
    });

    test('note is ignored when no option is selected yet (falls back to the '
        'plain digit path, defaulting to row 1)', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [<int>{}], noteText: const ['orphan'])),
        ['1'],
      );
    });

    test(
        'note state is independent of otherText: when BOTH are set, Other '
        'wins and the note is never sent (mutually exclusive at the UI '
        'layer, but buildAnswerFrames must still resolve deterministically)',
        () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ],
        otherText: const ['free text answer'],
        noteText: const ['should never appear'],
      );
      expect(_keys(frames), ['4', 'free text answer', '\r']);
      expect(_keys(frames), isNot(contains('should never appear')));
    });

    test(
        'note state is independent of otherText: a note-only call never '
        'touches the Other path', () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {0}
        ],
        noteText: const ['just a note'],
      );
      // No "Type something." row digit (options.length + 1 == "4") appears —
      // this went through the note path, not Other's.
      expect(_keys(frames), isNot(contains('4')));
      expect(_keys(frames), ['n', 'just a note', '\r']);
    });

    test('note is ignored for multi-select (same deferred scope as Other)',
        () {
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0, 2}
        ], noteText: const ['x'])),
        ['1', '3', '\x1b[C', '1'],
      );
    });

    test('note is ignored for multi-question (same deferred scope as Other)',
        () {
      final qs = [_q(['A', 'B']), _q(['X', 'Y'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {1},
          {0}
        ],
        noteText: const ['x', null],
      );
      expect(_keys(frames), isNot(contains('x')));
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

    test('multi-select (single question) needs no confirm — ends in digit "1"',
        () {
      // #39: the sequence now ends in "1" ("Submit answers"), which auto-submits
      // like a single-select digit. A re-sent Enter would toggle a row, so this
      // must NOT trigger the confirm re-send.
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], multi: true)], [
        {0, 2}
      ]);
      expect(answerNeedsConfirm(frames), isFalse);
    });

    test('multi-question needs a confirm (Submit-review Enter)', () {
      final frames = buildAnswerFrames([_q(['A', 'B']), _q(['X', 'Y'])], [
        {0},
        {1}
      ]);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('Other free-text answer ends in Enter -> needs confirm', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [<int>{}],
          otherText: const ['hello']);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('note (#64 Gap 1) ends in Enter -> needs confirm', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ], noteText: const ['a note']);
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

  testWidgets(
      'typing a free-text (Other) answer frees vertical room: the context panel '
      'and the numeric-nav keys hide so the input + Send stay above the keyboard',
      (tester) async {
    // The reported bug: with the soft keyboard up, the fixed "Claude said" panel
    // and the ^/v/Space/Tab/Enter row over-filled the card and clipped the field +
    // Send button — you could not see what you were typing. Both are useless while
    // free-texting, so they collapse in that mode.
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'tk',
                  questions: [_q(['A', 'B'])], // single-select single → Other offered
                ),
                contextText: 'CTX_CLAUDE_SAID that should hide while typing.',
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

    // Numeric mode: the space-eaters are present.
    expect(find.text('Claude said'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Space'), findsOneWidget);

    // Enter free-text mode and type an answer.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'my typed answer');
    await tester.pumpAndSettle();

    // The context panel + nav-key row are gone; the field + Send remain visible.
    expect(find.text('Claude said'), findsNothing);
    expect(find.textContaining('CTX_CLAUDE_SAID'), findsNothing);
    expect(find.widgetWithText(OutlinedButton, 'Space'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Send answer'), findsOneWidget);
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

  testWidgets(
      '#50: hardware Tab forwards to the PTY; arrows stay with a focused field',
      (tester) async {
    final keys = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't50',
                  questions: [_q(['A', 'B'])], // single-select → Other offered
                ),
                onSend: (_) {},
                onKey: keys.add,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Reveal + autofocus the free-text ("Other") field, so a control inside the
    // overlay's Shortcuts subtree holds focus.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    // Hardware Tab is NOT consumed by a text field → the overlay Shortcuts
    // forwards it to the PTY (drives Claude's TUI, e.g. /status tabs).
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(keys, ['\t']);

    // A hardware arrow IS consumed by the focused field (caret nav) before the
    // ancestor Shortcuts sees it → not forwarded, so typing in Other still works.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(keys, ['\t']); // unchanged
  });

  testWidgets('#50: hardware arrows forward to the PTY from a focused overlay button',
      (tester) async {
    final keys = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't50b',
                  questions: [_q(['A', 'B'])],
                ),
                onSend: (_) {},
                onKey: keys.add,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Focus a non-text overlay control (Other is inactive → no free-text field),
    // then prove a HARDWARE arrow is forwarded to the PTY rather than moving the
    // app's focus ring.
    FocusScope.of(tester.element(find.byType(QuestionOverlay))).nextFocus();
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(keys, ['\x1b[B']);
  });

  testWidgets(
      'Other row reveals a field; Send gated on text; sends digit+text+Enter',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 'other1',
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

    // Nothing picked yet -> Send disabled, no free-text field shown.
    expect(find.byType(TextField), findsNothing);
    expect(
      tester
          .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Pick an option'))
          .onPressed,
      isNull,
    );

    // Choose the free-text ("Other") row -> a field appears.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    // Gating: still disabled while the field is empty.
    expect(
      tester
          .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Pick an option'))
          .onPressed,
      isNull,
    );

    await tester.enterText(find.byType(TextField), 'deploy to staging');
    await tester.pumpAndSettle();

    final ready = find.widgetWithText(FilledButton, 'Send answer');
    expect(tester.widget<FilledButton>(ready).onPressed, isNotNull);
    await tester.tap(ready);
    await tester.pumpAndSettle();

    // 3 options -> "Type something." is row 4, then the text, then submit.
    expect(_keys(sent!), ['4', 'deploy to staging', '\r']);
  });

  testWidgets('picking a listed option after Other exits free-text mode',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 'other2',
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

    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'ignore me');
    await tester.pumpAndSettle();

    // Switching back to a real option must clear Other (field disappears) and
    // send the plain row digit, not the free text.
    await tester.tap(find.text('Beta'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
    await tester.pumpAndSettle();
    expect(_keys(sent!), ['2']);
  });

  group('note attached to a selected option (#64 Gap 1)', () {
    testWidgets(
        'affordance hidden until a real option is picked; toggling it '
        'reveals a field; Send emits select-move + n + note + submit',
        (tester) async {
      List<AnswerFrame>? sent;
      final pq = PendingQuestion(
        toolUseId: 'note1',
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
      await tester.pumpAndSettle();

      // No option picked yet -> no note affordance.
      expect(find.text('Add a note'), findsNothing);

      await tester.tap(find.text('Beta')); // index 1
      await tester.pumpAndSettle();

      // Now the affordance appears, but the field is not revealed yet.
      expect(find.text('Add a note'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text('Add a note'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Remove note'), findsOneWidget);

      await tester.enterText(
          find.byType(TextField), 'please explain the tradeoffs');
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      // Beta is index 1 -> one Down-arrow to reach it, then n, note, submit.
      expect(_keys(sent!),
          ['\x1b[B', 'n', 'please explain the tradeoffs', '\r']);
    });

    testWidgets(
        'note field is independent of the Other field (#64 Gap 1 vs #36)',
        (tester) async {
      final pq = PendingQuestion(
        toolUseId: 'note2',
        questions: [_q(['Alpha', 'Beta'])],
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: pq,
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

      await tester.tap(find.text('Alpha'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add a note'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'note text');
      await tester.pumpAndSettle();

      // Switching to Other clears _selected -> the note affordance/field
      // hide (same gate as picking a listed option), and the Other field
      // must NOT show the note's text — separate controllers, separate state.
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      expect(find.text('Add a note'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller?.text ?? '', isEmpty);
    });

    testWidgets('note affordance is not offered for a multi-select question',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'msnote1',
                    questions: [
                      _q(['Alpha', 'Beta', 'Gamma'], multi: true)
                    ],
                  ),
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

      await tester.tap(find.text('Alpha'));
      await tester.pumpAndSettle();
      expect(find.text('Add a note'), findsNothing);
    });

    testWidgets(
        'no note set does not regress the plain single-select Send path',
        (tester) async {
      List<AnswerFrame>? sent;
      final pq = PendingQuestion(
        toolUseId: 'note3',
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
      await tester.pumpAndSettle();

      await tester.tap(find.text('Gamma'));
      await tester.pumpAndSettle();
      // The note affordance appeared but was never tapped -> no note active.
      expect(find.text('Add a note'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      expect(_keys(sent!), ['3']);
    });
  });

  group('hardware Enter submits the selection (#64 Gap 2)', () {
    testWidgets(
        'select an option then a real hardware Enter sends the SAME frames '
        'as tapping Send', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<AnswerFrame>? sent;
        final pq = PendingQuestion(
          toolUseId: 'enter1',
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
        await tester.pumpAndSettle();

        await tester.tap(find.text('Gamma'));
        await tester.pumpAndSettle();

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();

        // Gamma is index 2 -> the same absolute row digit "3" the Send
        // button would have sent (see 'select an option then Send forwards
        // the built frames' above).
        expect(sent, isNotNull);
        expect(_keys(sent!), ['3']);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('Enter before any option is picked is a no-op', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<AnswerFrame>? sent;
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: Stack(
                children: [
                  QuestionOverlay(
                    question: PendingQuestion(
                      toolUseId: 'enter2',
                      questions: [_q(['A', 'B'])],
                    ),
                    onSend: (s) => sent = s,
                    onKey: (_) {},
                    onDismiss: () {},
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();

        expect(sent, isNull, reason: 'an incomplete selection must not submit');
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets(
        'on Android/iOS Enter is NOT bound — a soft-keyboard Enter must not '
        'submit (#55 mobile contract)', (tester) async {
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        debugDefaultTargetPlatformOverride = platform;
        try {
          List<AnswerFrame>? sent;
          final pq = PendingQuestion(
            toolUseId: 'enter3-$platform',
            questions: [_q(['Alpha', 'Beta'])],
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
          await tester.pumpAndSettle();

          await tester.tap(find.text('Beta'));
          await tester.pumpAndSettle();

          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();

          expect(
            sent,
            isNull,
            reason: 'mobile Enter must stay unbound (newline/no-op), '
                'per the #55 platform contract',
          );

          // The Send button still works — mobile just relies on it instead
          // of the key.
          await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
          await tester.pumpAndSettle();
          expect(_keys(sent!), ['2']);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      }
    });
  });

  testWidgets('Other row is not offered for a multi-select question',
      (tester) async {
    // Multi-select's "Type something." row is a TUI checkbox that never opens a
    // free-text input (on-device verified), so the overlay must not offer Other.
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'ms1',
                  questions: [_q(['Alpha', 'Beta', 'Gamma'], multi: true)],
                ),
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
    expect(find.text('Other…'), findsNothing);
    expect(find.byType(TextField), findsNothing);
  });
}
