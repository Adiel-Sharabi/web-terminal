// Widget tests for the Chat lens (ConversationView): turn rendering, fenced
// code blocks, tool-use chips, and empty/error states. Network access is
// avoided entirely via the injectable `fetchPage`.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/conversation_view.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({String status = 'idle'}) => Session(
  id: 'sess-1',
  name: 'proj',
  cwd: '/x',
  status: status,
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

void main() {
  testWidgets('renders assistant and user turns', (tester) async {
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'user',
          text: 'hello there',
          toolUses: [],
          ts: null,
        ),
        TranscriptTurn(
          role: 'assistant',
          text: 'Hi! How can I help?',
          toolUses: [],
          ts: null,
        ),
      ],
      cursor: null,
      hasMore: false,
    );
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => page,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('hello there'), findsOneWidget);
    expect(find.textContaining('Hi! How can I help'), findsOneWidget);
  });

  testWidgets('renders a fenced code block with a copy button', (tester) async {
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'assistant',
          text: 'Here:\n```\nprint(1)\n```',
          toolUses: [],
          ts: null,
        ),
      ],
      cursor: null,
      hasMore: false,
    );
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => page,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('print(1)'), findsOneWidget);
    expect(find.byIcon(Icons.copy_all_outlined), findsOneWidget);
  });

  testWidgets('drops a language tag on the fenced block\'s first line', (
    tester,
  ) async {
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'assistant',
          text: '```dart\nprint(1)\n```',
          toolUses: [],
          ts: null,
        ),
      ],
      cursor: null,
      hasMore: false,
    );
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => page,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('dart\nprint'), findsNothing);
    expect(find.textContaining('print(1)'), findsOneWidget);
  });

  testWidgets('renders a collapsed tool-use chip that expands on tap', (
    tester,
  ) async {
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'assistant',
          text: '',
          toolUses: [
            ToolUse(
              name: 'Bash',
              inputPreview:
                  '{"command":"a very long command that should be truncated when collapsed"}',
            ),
          ],
          ts: null,
        ),
      ],
      cursor: null,
      hasMore: false,
    );
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => page,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('▸ Bash'), findsOneWidget);
    expect(find.textContaining('should be truncated'), findsNothing);

    await tester.tap(find.textContaining('▸ Bash'));
    await tester.pumpAndSettle();

    expect(find.textContaining('should be truncated'), findsOneWidget);
  });

  testWidgets('shows an empty state when there are no turns', (tester) async {
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async =>
              const TranscriptPage(messages: [], cursor: null, hasMore: false),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('No messages'), findsOneWidget);
  });

  testWidgets('shows an error state with retry when the fetch fails', (
    tester,
  ) async {
    var attempts = 0;
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async {
            attempts++;
            throw Exception('boom');
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Could not load'), findsOneWidget);
    expect(attempts, 1);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(attempts, 2);
  });

  testWidgets(
    'calls onNoTranscript on a 404 and renders nothing crash-worthy',
    (tester) async {
      var called = 0;
      await tester.pumpWidget(
        _wrap(
          ConversationView(
            session: _session(),
            onNoTranscript: () => called++,
            fetchPage: (id, {before, limit}) async {
              throw const ApiException(404, 'No transcript for session');
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(called, 1);
    },
  );

  testWidgets('newest turn is visible after initial load (pinned to bottom)', (
    tester,
  ) async {
    final turns = List.generate(
      40,
      (i) => TranscriptTurn(
        role: i.isEven ? 'user' : 'assistant',
        text: 'message number $i',
        toolUses: const [],
        ts: null,
      ),
    );
    final page = TranscriptPage(messages: turns, cursor: null, hasMore: false);
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => page,
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The last turn (newest) should be on-screen without any manual scroll —
    // "jump to bottom" on initial load.
    expect(find.text('message number 39'), findsOneWidget);
    // The very first turn should have scrolled out of view.
    expect(find.text('message number 0'), findsNothing);
  });
}
