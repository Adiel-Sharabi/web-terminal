// #73 — the agent's task list in the chat lens.
//
// Driven through the real ConversationView with an injected `fetchPage`, so the panel is
// exercised exactly where it ships: it reads whatever the SERVER put on the transcript
// response and holds no agent knowledge of its own. That is the property worth pinning —
// Claude's list is folded from hook deltas and Codex's is a whole `update_plan` snapshot,
// and the client must not be able to tell which.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/conversation_view.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session() => Session(
      id: 'sess-1',
      name: 'proj',
      cwd: '/x',
      // 'idle' on purpose: a 'working' session renders the infinitely-pulsing
      // activity indicator, and pumpAndSettle never returns. The panel is
      // independent of status, so nothing here is weakened by it.
      status: 'idle',
      claudeSessionId: 'claude-1',
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: _server(),
      autoCommand: '',
    );

Widget _wrap(Widget child) => MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(body: SizedBox(height: 600, child: child)),
    );

TranscriptPage _page(List<AgentTask>? tasks) => TranscriptPage(
      messages: const [
        TranscriptTurn(role: 'user', text: 'do the thing', toolUses: [], ts: null),
      ],
      cursor: null,
      hasMore: false,
      taskList: tasks,
    );

Future<void> _pump(WidgetTester tester, List<AgentTask>? tasks) async {
  await tester.pumpWidget(
    _wrap(
      ConversationView(
        session: _session(),
        fetchPage: (id, {before, limit}) async => _page(tasks),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

const _threeTasks = [
  AgentTask(id: '1', subject: 'Read the parser', status: 'completed'),
  AgentTask(id: '2', subject: 'Fold the deltas', status: 'in_progress'),
  AgentTask(id: '3', subject: 'Render the panel', status: 'pending'),
];

void main() {
  group('when there is no task list', () {
    testWidgets('no panel and no empty-state clutter', (tester) async {
      await _pump(tester, null);
      expect(find.byIcon(Icons.checklist), findsNothing);
      expect(find.textContaining('/'), findsNothing);
      // The conversation itself is unaffected.
      expect(find.text('do the thing'), findsOneWidget);
    });

    testWidgets('an EMPTY list also renders nothing', (tester) async {
      // Distinct from null on the wire (Codex reporting zero steps), identical here.
      await _pump(tester, const []);
      expect(find.byIcon(Icons.checklist), findsNothing);
    });
  });

  group('collapsed header', () {
    testWidgets('shows progress and the task in progress right now', (tester) async {
      await _pump(tester, _threeTasks);
      expect(find.text('1/3'), findsOneWidget);
      expect(find.text('Fold the deltas'), findsOneWidget);
      // Collapsed: the other rows are NOT rendered. This is the point of collapsing —
      // a long plan must not push the conversation off screen.
      expect(find.text('Read the parser'), findsNothing);
      expect(find.text('Render the panel'), findsNothing);
    });

    testWidgets('with nothing in progress it names the next unfinished task', (tester) async {
      await _pump(tester, const [
        AgentTask(id: '1', subject: 'First', status: 'completed'),
        AgentTask(id: '2', subject: 'Second', status: 'pending'),
      ]);
      expect(find.text('1/2'), findsOneWidget);
      expect(find.text('Second'), findsOneWidget);
    });

    testWidgets('says so when every task is done', (tester) async {
      await _pump(tester, const [
        AgentTask(id: '1', subject: 'First', status: 'completed'),
        AgentTask(id: '2', subject: 'Second', status: 'completed'),
      ]);
      expect(find.text('2/2'), findsOneWidget);
      expect(find.text('All tasks complete'), findsOneWidget);
    });
  });

  group('expanding', () {
    testWidgets('a tap reveals every task with its status', (tester) async {
      await _pump(tester, _threeTasks);
      await tester.tap(find.byIcon(Icons.checklist));
      await tester.pumpAndSettle();

      expect(find.text('Read the parser'), findsOneWidget);
      expect(find.text('Render the panel'), findsOneWidget);
      // Status is carried by an icon as well as by styling, so it does not depend on
      // the user being able to distinguish colours.
      expect(find.byIcon(Icons.check_circle), findsOneWidget);
      expect(find.byIcon(Icons.play_circle_fill), findsOneWidget);
      expect(find.byIcon(Icons.radio_button_unchecked), findsOneWidget);
    });

    testWidgets('a completed task is struck through', (tester) async {
      await _pump(tester, _threeTasks);
      await tester.tap(find.byIcon(Icons.checklist));
      await tester.pumpAndSettle();
      final done = tester.widget<Text>(find.text('Read the parser'));
      expect(done.style?.decoration, TextDecoration.lineThrough);
      // The in-progress task appears TWICE while expanded — once in the header as the
      // current task and once in the list — so assert over every match rather than
      // demanding a single one.
      final active = tester.widgetList<Text>(find.text('Fold the deltas'));
      expect(active, isNotEmpty);
      for (final t in active) {
        expect(t.style?.decoration, isNot(TextDecoration.lineThrough));
      }
    });

    testWidgets('tapping again collapses it', (tester) async {
      await _pump(tester, _threeTasks);
      await tester.tap(find.byIcon(Icons.checklist));
      await tester.pumpAndSettle();
      expect(find.text('Read the parser'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.checklist));
      await tester.pumpAndSettle();
      expect(find.text('Read the parser'), findsNothing);
    });
  });

  group('a task whose create was never seen', () {
    testWidgets('renders as "Task #id" rather than a blank row', (tester) async {
      // The mid-session-start case: the server folds an update for an id it never saw
      // created, so the subject is empty. Showing the row is the point — dropping it
      // would hide in-progress work.
      await _pump(tester, const [
        AgentTask(id: '7', subject: '', status: 'in_progress'),
      ]);
      expect(find.text('Task #7'), findsOneWidget);
    });
  });

  group('the wire shape', () {
    test('an absent taskList parses to null (an older server), not to []', () {
      final page = TranscriptPage.fromJson({
        'messages': <dynamic>[],
        'cursor': null,
        'hasMore': false,
      });
      expect(page.taskList, isNull);
    });

    test('a present taskList parses into typed entries', () {
      final page = TranscriptPage.fromJson({
        'messages': <dynamic>[],
        'cursor': null,
        'hasMore': false,
        'taskList': [
          {'id': '1', 'subject': 'Do it', 'status': 'in_progress'},
        ],
      });
      expect(page.taskList, hasLength(1));
      expect(page.taskList!.first.isInProgress, isTrue);
      expect(page.taskList!.first.displaySubject, 'Do it');
    });

    test('AgentTask is a value type so an unchanged poll causes no rebuild', () {
      const a = AgentTask(id: '1', subject: 's', status: 'pending');
      const b = AgentTask(id: '1', subject: 's', status: 'pending');
      const c = AgentTask(id: '1', subject: 's', status: 'completed');
      expect(a, equals(b));
      expect(a, isNot(equals(c)));
    });
  });
}
