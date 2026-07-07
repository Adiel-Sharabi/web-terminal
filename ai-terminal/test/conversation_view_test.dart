// Widget tests for the Chat lens (ConversationView): turn rendering, fenced
// code blocks, tool-use chips, and empty/error states. Network access is
// avoided entirely via the injectable `fetchPage`.
import 'dart:async';

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

  testWidgets(
    '#27: the message list is wrapped in one SelectionArea (cross-bubble drag), '
    'and bubbles no longer self-select',
    (tester) async {
      final page = TranscriptPage(
        messages: const [
          TranscriptTurn(
            role: 'user',
            text: 'first message',
            toolUses: [],
            ts: null,
          ),
          TranscriptTurn(
            role: 'assistant',
            text: 'second message\n```\ncode()\n```',
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

      // A single ancestor SelectionArea owns selection for the whole list, so a
      // drag can span lines and adjacent bubbles.
      expect(find.byType(SelectionArea), findsOneWidget);
      // Inner islands are gone: code blocks are plain Text now, and no
      // self-selecting SelectableText competes with the SelectionArea.
      expect(find.byType(SelectableText), findsNothing);
      expect(find.textContaining('code()'), findsOneWidget);
    },
  );

  group('#32 parseCommandInvocation', () {
    test('extracts name (slash stripped), args, and body', () {
      const text =
          '<command-name>/task</command-name>\n<command-message>task</command-message>\n'
          '<command-args>build the thing</command-args>\n\nFULL SKILL BODY LINE 1\nLINE 2';
      final c = parseCommandInvocation(text);
      expect(c, isNotNull);
      expect(c!.name, 'task');
      expect(c.args, 'build the thing');
      expect(c.body, 'FULL SKILL BODY LINE 1\nLINE 2');
    });

    test('empty args and no body', () {
      const text =
          '<command-name>compact</command-name><command-args></command-args>';
      final c = parseCommandInvocation(text);
      expect(c!.name, 'compact');
      expect(c.args, isEmpty);
      expect(c.body, isEmpty);
    });

    test('plain prose is not a command', () {
      expect(parseCommandInvocation('just a normal message'), isNull);
      expect(parseCommandInvocation('use /task later, not now'), isNull);
    });
  });

  testWidgets(
    '#32: a skill turn renders the compact command, not the whole body',
    (tester) async {
      final page = TranscriptPage(
        messages: const [
          TranscriptTurn(
            role: 'user',
            text:
                '<command-name>/task</command-name>\n<command-args>do X</command-args>\n\n'
                'ENORMOUS_SKILL_BODY_MARKER should be hidden by default',
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

      // Compact invocation shown; the injected body is collapsed away.
      expect(find.text('/task do X'), findsOneWidget);
      expect(find.textContaining('ENORMOUS_SKILL_BODY_MARKER'), findsNothing);

      // Expanding reveals the body.
      await tester.tap(find.text('/task do X'));
      await tester.pumpAndSettle();
      expect(find.textContaining('ENORMOUS_SKILL_BODY_MARKER'), findsOneWidget);
    },
  );

  testWidgets(
    '#31: a submitted prompt echoes as Queued, then reconciles when it lands',
    (tester) async {
      final prompts = StreamController<String>.broadcast();
      addTearDown(prompts.close);
      var calls = 0;
      Future<TranscriptPage> fetch(String id, {String? before, int? limit}) async {
        calls++;
        if (calls == 1) {
          return const TranscriptPage(
            messages: [
              TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null),
            ],
            cursor: null,
            hasMore: false,
          );
        }
        // The user's prompt has now landed in the real transcript.
        return const TranscriptPage(
          messages: [
            TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null),
            TranscriptTurn(
                role: 'user', text: 'run the build', toolUses: [], ts: null),
          ],
          cursor: null,
          hasMore: false,
        );
      }

      // Explicit lastActivity so a change reliably triggers _refreshLastPage.
      // (status is 'idle', not 'working', to avoid the working indicator's
      // infinite repeat animation which would hang pumpAndSettle.)
      Session sess(int lastActivity) => Session(
            id: 'sess-1',
            name: 'proj',
            cwd: '/x',
            status: 'idle',
            claudeSessionId: 'claude-1',
            lastActivity: lastActivity,
            notifyLevel: 'important',
            server: _server(),
            autoCommand: '',
          );
      Widget build(Session s) => _wrap(
            ConversationView(
              key: const ValueKey('cv'),
              session: s,
              fetchPage: fetch,
              submittedPrompts: prompts.stream,
            ),
          );

      await tester.pumpWidget(build(sess(1000)));
      await tester.pumpAndSettle();

      // Submit → immediate optimistic "Queued" echo (before the transcript has it).
      prompts.add('run the build');
      await tester.pumpAndSettle();
      expect(find.text('run the build'), findsOneWidget);
      expect(find.text('Queued'), findsOneWidget);

      // The real turn lands: a lastActivity change triggers a transcript refresh
      // → the echo reconciles away, no duplicate.
      await tester.pumpWidget(build(sess(2000)));
      await tester.pumpAndSettle();
      expect(find.text('Queued'), findsNothing);
      expect(find.text('run the build'), findsOneWidget);
    },
  );

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
