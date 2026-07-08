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

  testWidgets('a Bash tool card shows the command and expands to the output', (
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
              inputPreview: '{"command":"npm test"}',
              id: 'tu_1',
              input: {'command': 'npm test'},
              result: 'PASS — 3 tests OUTPUT_MARKER',
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

    // Collapsed: command in the title, output hidden.
    expect(find.textContaining('Bash — npm test'), findsOneWidget);
    expect(find.textContaining('OUTPUT_MARKER'), findsNothing);

    await tester.tap(find.textContaining('Bash — npm test'));
    await tester.pumpAndSettle();

    // Expanded: the tool's output (tool_result) is shown.
    expect(find.textContaining('OUTPUT_MARKER'), findsOneWidget);
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

  group('summarizeTool (rich tool cards)', () {
    test('Bash: command in the title, output in the detail', () {
      final s = summarizeTool(const ToolUse(
        name: 'Bash',
        inputPreview: '',
        input: {'command': 'npm test'},
        result: 'PASS',
      ));
      expect(s.title, 'Bash — npm test');
      expect(s.detail, 'PASS');
    });

    test('Task: description + subagent in the title, prompt+report in detail', () {
      final s = summarizeTool(const ToolUse(
        name: 'Task',
        inputPreview: '',
        input: {'description': 'find bug', 'subagent_type': 'search', 'prompt': 'go look'},
        result: 'found it',
      ));
      expect(s.title, 'Task — find bug (search)');
      expect(s.detail, contains('go look'));
      expect(s.detail, contains('found it'));
    });

    test('Read/Edit: basename title; Edit detail carries a diff', () {
      expect(
        summarizeTool(const ToolUse(
                name: 'Read', inputPreview: '', input: {'file_path': '/a/b/c.dart'}))
            .title,
        'Read — c.dart',
      );
      final edit = summarizeTool(const ToolUse(
        name: 'Edit',
        inputPreview: '',
        input: {'file_path': '/x/y.dart', 'old_string': 'foo', 'new_string': 'bar'},
      ));
      expect(edit.title, 'Edit — y.dart');
      expect(edit.detail, '- foo\n+ bar');
    });

    test('WebFetch shows the host; unknown tool falls back to name + preview', () {
      expect(
        summarizeTool(const ToolUse(
                name: 'WebFetch', inputPreview: '', input: {'url': 'https://example.com/x'}))
            .title,
        'Fetch — example.com',
      );
      expect(
        summarizeTool(const ToolUse(name: 'Frobnicate', inputPreview: '{"a":1}')).title,
        'Frobnicate — {"a":1}',
      );
    });
  });

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

  testWidgets(
    '#35: /clear (new claudeSessionId, same pty session) resets — stale turns gone',
    (tester) async {
      // The PTY session id is constant throughout; only the Claude session id
      // changes, exactly as it does on /clear (Claude mints a new session → a
      // new .jsonl the server then serves). lastActivity is held constant so the
      // ONLY thing that can trigger a reset is the claudeSessionId change.
      TranscriptPage current = const TranscriptPage(
        messages: [
          TranscriptTurn(
              role: 'assistant', text: 'OLD_A_MESSAGE', toolUses: [], ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      Future<TranscriptPage> fetch(String id,
              {String? before, int? limit}) async =>
          current;

      Session sess(String? claudeId) => Session(
            id: 'sess-1',
            name: 'proj',
            cwd: '/x',
            status: 'idle',
            claudeSessionId: claudeId,
            lastActivity: 1000,
            notifyLevel: 'important',
            server: _server(),
            autoCommand: '',
          );
      Widget build(Session s) =>
          _wrap(ConversationView(session: s, fetchPage: fetch));

      await tester.pumpWidget(build(sess('claude-1')));
      await tester.pumpAndSettle();
      expect(find.text('OLD_A_MESSAGE'), findsOneWidget);

      // /clear: a new Claude session id, and the server now serves the fresh
      // (post-clear) transcript.
      current = const TranscriptPage(
        messages: [
          TranscriptTurn(
              role: 'assistant', text: 'NEW_B_MESSAGE', toolUses: [], ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(build(sess('claude-2')));
      await tester.pumpAndSettle();

      expect(find.text('OLD_A_MESSAGE'), findsNothing);
      expect(find.text('NEW_B_MESSAGE'), findsOneWidget);
    },
  );

  testWidgets(
    '#35: a transcript that shrinks in place is reflected, not left stale',
    (tester) async {
      // Same claudeSessionId throughout, so the didUpdateWidget reset path is
      // NOT taken — this isolates _refreshLastPage's ability to shrink/replace.
      var calls = 0;
      Future<TranscriptPage> fetch(String id,
          {String? before, int? limit}) async {
        calls++;
        if (calls == 1) {
          return const TranscriptPage(
            messages: [
              TranscriptTurn(
                  role: 'user', text: 'STALE_1', toolUses: [], ts: null),
              TranscriptTurn(
                  role: 'assistant', text: 'STALE_2', toolUses: [], ts: null),
              TranscriptTurn(
                  role: 'user', text: 'STALE_3', toolUses: [], ts: null),
            ],
            cursor: null,
            hasMore: false,
          );
        }
        // Transcript reset in place to a single fresh turn (fewer than we hold).
        return const TranscriptPage(
          messages: [
            TranscriptTurn(
                role: 'assistant', text: 'FRESH_ONLY', toolUses: [], ts: null),
          ],
          cursor: null,
          hasMore: false,
        );
      }

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
      Widget build(Session s) =>
          _wrap(ConversationView(session: s, fetchPage: fetch));

      await tester.pumpWidget(build(sess(1000)));
      await tester.pumpAndSettle();
      expect(find.text('STALE_1'), findsOneWidget);
      expect(find.text('STALE_3'), findsOneWidget);

      // A lastActivity bump triggers _refreshLastPage; the fetch now returns the
      // shrunken transcript.
      await tester.pumpWidget(build(sess(2000)));
      await tester.pumpAndSettle();

      expect(find.text('FRESH_ONLY'), findsOneWidget);
      expect(find.text('STALE_1'), findsNothing);
      expect(find.text('STALE_2'), findsNothing);
      expect(find.text('STALE_3'), findsNothing);
    },
  );

  testWidgets(
    '#35: an emptied transcript clears the chat (hasMore=false, no turns)',
    (tester) async {
      var calls = 0;
      Future<TranscriptPage> fetch(String id,
          {String? before, int? limit}) async {
        calls++;
        if (calls == 1) {
          return const TranscriptPage(
            messages: [
              TranscriptTurn(
                  role: 'assistant',
                  text: 'BEFORE_CLEAR',
                  toolUses: [],
                  ts: null),
            ],
            cursor: null,
            hasMore: false,
          );
        }
        return const TranscriptPage(messages: [], cursor: null, hasMore: false);
      }

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
      Widget build(Session s) =>
          _wrap(ConversationView(session: s, fetchPage: fetch));

      await tester.pumpWidget(build(sess(1000)));
      await tester.pumpAndSettle();
      expect(find.text('BEFORE_CLEAR'), findsOneWidget);

      await tester.pumpWidget(build(sess(2000)));
      await tester.pumpAndSettle();

      expect(find.text('BEFORE_CLEAR'), findsNothing);
      expect(find.textContaining('No messages'), findsOneWidget);
    },
  );

  // #35 /compact: two possible transcript behaviours, decided by real data.
  //  * If /compact mints a NEW Claude session id (a new .jsonl), it is
  //    behaviourally identical to /clear — the "new claudeSessionId resets"
  //    test above already covers it (the chat resets to the fresh, compacted
  //    session). On-disk evidence supports this: every transcript .jsonl carries
  //    a single stable sessionId, i.e. a session id maps 1:1 to a file.
  //  * If instead /compact stays in the SAME .jsonl and appends a
  //    `type:"summary"` compaction boundary, the server would need to surface
  //    that boundary (lib/transcript.js). That format could NOT be confirmed
  //    from any real transcript on disk (no `type:"summary"` line exists), so
  //    per the engineering standards it is intentionally left unimplemented and
  //    is pinned here as a skipped, on-device-verification-required test rather
  //    than guessed at. Note that even unhandled, the same-file case merely
  //    keeps showing the (legitimately) continuing conversation — it is not the
  //    "chat wiped by /clear" failure #35 is about.
  testWidgets(
    '#35: /compact same-file summary boundary — needs on-device verification',
    (tester) async {},
    skip: true,
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
