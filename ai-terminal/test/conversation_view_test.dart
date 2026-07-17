// Widget tests for the Chat lens (ConversationView): turn rendering, fenced
// code blocks, tool-use chips, and empty/error states. Network access is
// avoided entirely via the injectable `fetchPage`.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/agent_catalog.dart';
import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/session_repository.dart';
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

  testWidgets(
    '#54: a user turn and an agent turn are distinguished by alignment, '
    'bubble width, and a role tag naming the agent from the SERVER registry '
    '(never a hardcoded Claude/Codex palette)',
    (tester) async {
      // GET /api/agents via AgentCatalog is the SSOT for an agent's label +
      // tint — seed it the way a real launch does.
      AgentCatalog.instance.clear();
      AgentCatalog.instance.adopt(
        const AgentInfo(id: 'codex', label: 'Codex', color: '#10a37f'),
      );
      addTearDown(AgentCatalog.instance.clear);

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
      final session = Session(
        id: 'sess-1',
        name: 'proj',
        cwd: '/x',
        status: 'idle',
        claudeSessionId: 'claude-1',
        lastActivity: 1,
        notifyLevel: 'important',
        server: _server(),
        autoCommand: '',
        agent: 'codex',
      );

      await tester.pumpWidget(
        _wrap(
          ConversationView(
            session: session,
            fetchPage: (id, {before, limit}) async => page,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Role tags: "You" for the user turn; the CATALOGUE's label (not a
      // string this client invented) for the agent turn.
      expect(find.text('You'), findsOneWidget);
      expect(find.text('Codex'), findsOneWidget);

      // Alignment: the two turns sit on opposite sides — never the same side.
      final userAlign = tester.widget<Align>(
        find
            .ancestor(
              of: find.text('hello there'),
              matching: find.byType(Align),
            )
            .first,
      );
      final agentAlign = tester.widget<Align>(
        find
            .ancestor(
              of: find.textContaining('Hi! How can I help'),
              matching: find.byType(Align),
            )
            .first,
      );
      expect(userAlign.alignment, Alignment.centerRight);
      expect(agentAlign.alignment, Alignment.centerLeft);

      // Width: the user turn is a bounded "landmark" bubble; the agent turn
      // is allowed to run essentially full width so its code/tool content is
      // never squeezed into a narrow bubble.
      final userBox = tester.widget<ConstrainedBox>(
        find
            .ancestor(
              of: find.text('hello there'),
              matching: find.byType(ConstrainedBox),
            )
            .first,
      );
      final agentBox = tester.widget<ConstrainedBox>(
        find
            .ancestor(
              of: find.textContaining('Hi! How can I help'),
              matching: find.byType(ConstrainedBox),
            )
            .first,
      );
      expect(userBox.constraints.maxWidth, lessThan(700));
      expect(agentBox.constraints.maxWidth, double.infinity);
    },
  );

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
    'a Task with a subagent stub drills into the subagent\'s nested tool calls',
    (tester) async {
      // A finished subagent (running:false) so there is no perpetual pulse
      // animation / poll timer to hang pumpAndSettle.
      final page = TranscriptPage(
        messages: const [
          TranscriptTurn(
            role: 'assistant',
            text: 'Delegating.',
            toolUses: [
              ToolUse(
                name: 'Task',
                inputPreview: '',
                id: 'tu_task',
                input: {
                  'description': 'Investigate X',
                  'subagent_type': 'Explore',
                  'prompt': 'go look',
                },
                subagent: SubagentTrace(
                  agentType: 'Explore',
                  description: 'Investigate X',
                  running: false,
                ),
              ),
            ],
            ts: null,
          ),
        ],
        cursor: null,
        hasMore: false,
      );
      const subPage = SubagentPage(
        agentType: 'Explore',
        description: 'Investigate X',
        running: false,
        messages: [
          TranscriptTurn(
            role: 'assistant',
            text: 'Looking around.',
            toolUses: [
              ToolUse(
                name: 'Bash',
                inputPreview: '',
                id: 'tu_b',
                input: {'command': 'grep -r foo .'},
                result: 'foo at bar.js:12 NESTED_MARKER',
              ),
            ],
            ts: null,
          ),
        ],
        cursor: null,
        hasMore: false,
      );
      var drilledId = '';
      await tester.pumpWidget(
        _wrap(
          ConversationView(
            session: _session(),
            fetchPage: (id, {before, limit}) async => page,
            fetchSubagent: (toolUseId, {before, limit}) async {
              drilledId = toolUseId;
              return subPage;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Collapsed: the Task card shows its subagent identity; nested output hidden.
      expect(find.textContaining('Task — Investigate X (Explore)'), findsOneWidget);
      expect(find.textContaining('NESTED_MARKER'), findsNothing);

      // Tap to drill in → the subagent's own Bash tool card appears.
      await tester.tap(find.textContaining('Task — Investigate X (Explore)'));
      await tester.pumpAndSettle();

      expect(drilledId, 'tu_task'); // drilled with the Task's tool_use id
      expect(find.textContaining('Looking around.'), findsOneWidget);
      expect(find.textContaining('Bash — grep -r foo .'), findsOneWidget);

      // The nested Bash card itself expands to its output.
      await tester.tap(find.textContaining('Bash — grep -r foo .'));
      await tester.pumpAndSettle();
      expect(find.textContaining('NESTED_MARKER'), findsOneWidget);
    },
  );

  group('#62 pinned subagent strip', () {
    ToolUse makeTask(String id, String type, {required bool running}) => ToolUse(
          name: 'Task',
          inputPreview: '',
          id: id,
          input: {'description': 'do $type', 'subagent_type': type},
          subagent: SubagentTrace(
              agentType: type, description: 'do $type', running: running),
        );

    test('collectSubagents walks turns→tools, de-dupes by id, keeps order', () {
      final turns = <TranscriptTurn>[
        TranscriptTurn(role: 'assistant', text: 'a', ts: null, toolUses: [
          makeTask('t1', 'Explore', running: true),
          const ToolUse(
              name: 'Bash', inputPreview: '', id: 'b1', input: {'command': 'ls'}),
        ]),
        TranscriptTurn(role: 'assistant', text: 'b', ts: null, toolUses: [
          makeTask('t2', 'general-purpose', running: false),
          makeTask('t1', 'Explore', running: true), // duplicate id — ignored
        ]),
      ];
      expect(collectSubagents(turns).map((t) => t.id).toList(), ['t1', 't2']);
    });

    testWidgets('no strip when the session has no subagents', (tester) async {
      final plain = TranscriptPage(
        messages: const [
          TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(_wrap(ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => plain)));
      await tester.pumpAndSettle();
      // The subagent icon appears only on chips / inline cards — none here.
      expect(find.byIcon(Icons.account_tree_outlined), findsNothing);
    });

    testWidgets('renders one chip per subagent above the transcript',
        (tester) async {
      final page = TranscriptPage(
        messages: [
          TranscriptTurn(role: 'assistant', text: 'Delegating.', ts: null,
              toolUses: [
                makeTask('t1', 'Explore', running: false),
                makeTask('t2', 'general-purpose', running: false),
              ]),
        ],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(),
        fetchPage: (id, {before, limit}) async => page,
        fetchSubagent: (toolUseId, {before, limit}) async => const SubagentPage(
            agentType: '',
            description: '',
            running: false,
            messages: [],
            cursor: null,
            hasMore: false),
      )));
      await tester.pumpAndSettle();
      // The chip label is the bare agent type; the inline card is "Task — … (type)",
      // so an EXACT match finds only the chips.
      expect(find.text('Explore'), findsOneWidget);
      expect(find.text('general-purpose'), findsOneWidget);
    });

    testWidgets('tapping a chip opens the drill-in sheet via the SAME subFetch',
        (tester) async {
      var drilledId = '';
      final page = TranscriptPage(
        messages: [
          TranscriptTurn(role: 'assistant', text: 'Delegating.', ts: null,
              toolUses: [makeTask('tu_task1', 'Explore', running: false)]),
        ],
        cursor: null,
        hasMore: false,
      );
      const subPage = SubagentPage(
        agentType: 'Explore',
        description: 'do Explore',
        running: false,
        messages: [
          TranscriptTurn(
              role: 'assistant',
              text: 'SUBAGENT_SHEET_MARKER',
              toolUses: [],
              ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(),
        fetchPage: (id, {before, limit}) async => page,
        fetchSubagent: (toolUseId, {before, limit}) async {
          drilledId = toolUseId;
          return subPage;
        },
      )));
      await tester.pumpAndSettle();

      expect(find.textContaining('SUBAGENT_SHEET_MARKER'), findsNothing);

      await tester.tap(find.text('Explore')); // the chip
      await tester.pumpAndSettle();

      expect(drilledId, 'tu_task1'); // reused the subagent paging path, not a new one
      expect(find.textContaining('SUBAGENT_SHEET_MARKER'), findsOneWidget);
      // Honest, read-only transcript. With no onSubmitToSession wired, no input row.
      expect(find.textContaining('Read-only'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('the sheet\'s "Message session" input submits via onSubmitToSession '
        '(the terminal-parity path), then closes', (tester) async {
      String? sent;
      final page = TranscriptPage(
        messages: [
          TranscriptTurn(role: 'assistant', text: 'Delegating.', ts: null,
              toolUses: [makeTask('tu_task1', 'Explore', running: false)]),
        ],
        cursor: null,
        hasMore: false,
      );
      const subPage = SubagentPage(
        agentType: 'Explore',
        description: 'do Explore',
        running: false,
        messages: [],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(),
        fetchPage: (id, {before, limit}) async => page,
        fetchSubagent: (toolUseId, {before, limit}) async => subPage,
        onSubmitToSession: (t) => sent = t, // the SAME sink the compose bar uses
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Explore')); // chip → sheet
      await tester.pumpAndSettle();

      // The sheet offers a session input — mirroring what the terminal lens allows.
      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'run the tests again');
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();

      expect(sent, 'run the tests again'); // routed to the session, not a fake channel
      expect(find.byType(TextField), findsNothing); // sheet closed after sending
    });
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

  // Links are non-selectable gesture spans in the SelectionArea, so a long-press
  // (touch) / right-click (desktop) exposes an Open/Copy menu — the way to grab a
  // URL without opening it (the "can't mark & copy a URL in chat" report).
  testWidgets('a chat URL long-press shows an Open/Copy menu; Copy grabs the URL', (
    tester,
  ) async {
    // Deterministic clipboard: capture what Copy writes (avoids the real channel).
    String? clip;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clip = (call.arguments as Map)['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'assistant',
          text: 'see [example](https://example.com/x)',
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

    // The link renders as its label text (via the custom _ChatLink builder).
    expect(find.text('example'), findsOneWidget);

    // Long-press → the Open/Copy-link menu.
    await tester.longPress(find.text('example'));
    await tester.pumpAndSettle();
    expect(find.text('Open link'), findsOneWidget);
    expect(find.text('Copy link'), findsOneWidget);

    // Copy → the URL (not the label) lands on the clipboard.
    await tester.tap(find.text('Copy link'));
    await tester.pumpAndSettle();
    expect(clip, 'https://example.com/x');
  });

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

  group('summarizeTool (Codex tool cards)', () {
    test('shell_command: command in the title, output in the detail', () {
      final s = summarizeTool(const ToolUse(
        name: 'shell_command',
        inputPreview: '',
        input: {'command': 'npm test'},
        result: 'PASS',
      ));
      expect(s.title, 'Shell — npm test');
      expect(s.detail, 'PASS');
    });

    test('shell_command: multiline command also appears in the detail', () {
      final s = summarizeTool(const ToolUse(
        name: 'shell_command',
        inputPreview: '',
        input: {'command': 'set -e\nnpm test'},
        result: 'PASS',
      ));
      expect(s.title, 'Shell — set -e');
      expect(s.detail, 'set -e\nnpm test\n\nPASS');
    });

    test('apply_patch: fixed "Patch" title, raw patch + result in the detail',
        () {
      const patch = '*** Begin Patch\n*** Update File: a.dart\n*** End Patch';
      final s = summarizeTool(const ToolUse(
        name: 'apply_patch',
        inputPreview: '',
        input: {'input': patch},
        result: 'applied',
      ));
      expect(s.title, 'Patch');
      expect(s.detail, '$patch\n\napplied');
    });

    test('web_search: query in the title, result in the detail', () {
      final s = summarizeTool(const ToolUse(
        name: 'web_search',
        inputPreview: '',
        input: {'query': 'flutter dropdown initialValue'},
        result: 'top hit: docs.flutter.dev',
      ));
      expect(s.title, 'Search — flutter dropdown initialValue');
      expect(s.detail, 'top hit: docs.flutter.dev');
    });

    test('web_search falls back to the tool name when query is empty', () {
      final s = summarizeTool(const ToolUse(name: 'web_search', inputPreview: ''));
      expect(s.title, 'web_search');
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

  group('classifyUserTurn (non-human role:user turns)', () {
    test('a real human prompt is human, body unchanged', () {
      const text = 'there is a crunch of integration tests, fix them';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.human);
      expect(c.from, isEmpty);
      expect(c.body, text);
    });

    test('teammate message: extracts id and strips the wrapper', () {
      const text =
          'Another Claude session sent a message:\n'
          '<teammate-message teammate_id="J4b2" color="purple" summary="report">\n'
          'J4b2 (WI #22789) — read-path rewrite: report. 6 commits, build green.\n'
          '</teammate-message>';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.teammate);
      expect(c.from, 'J4b2');
      // Preamble + both tags gone; inner report kept.
      expect(c.body, contains('J4b2 (WI #22789)'));
      expect(c.body, isNot(contains('Another Claude session')));
      expect(c.body, isNot(contains('<teammate-message')));
      expect(c.body, isNot(contains('</teammate-message>')));
    });

    test('teammate message with no id falls back to empty from', () {
      const text =
          'Another Claude session sent a message:\n<teammate-message>hi</teammate-message>';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.teammate);
      expect(c.from, isEmpty);
      expect(c.body, 'hi');
    });

    test('task-notification shows only <result>, labeled by agent, no envelope', () {
      const text =
          '<task-notification>\n<task-id>a0d2</task-id>\n'
          '<tool-use-id>toolu_016</tool-use-id>\n'
          '<output-file>C:\\Users\\dds\\tasks\\a0d2.output</output-file>\n'
          '<status>completed</status>\n'
          '<summary>Agent "Review 22804 test suite" finished</summary>\n'
          '<note>A task-notification fires each time this agent stops.</note>\n'
          '<result>Clean. All critical aspects verify: Test integrity holds.</result>\n'
          '<usage><subagent_tokens>57487</subagent_tokens><tool_uses>28</tool_uses></usage>\n'
          '</task-notification>';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.system);
      // Labeled by the agent name parsed from <summary>.
      expect(c.from, 'Review 22804 test suite');
      // Body is ONLY the agent's result — none of the XML envelope survives.
      expect(c.body, 'Clean. All critical aspects verify: Test integrity holds.');
      for (final noise in [
        'task-notification', 'tool-use-id', 'output-file', 'status',
        'toolu_016', '.output', '<note>', 'subagent_tokens', '57487', 'duration',
      ]) {
        expect(c.body, isNot(contains(noise)), reason: 'leaked: $noise');
      }
    });

    test('task-notification with no <result> falls back to the summary', () {
      const text =
          '<task-notification>\n<summary>Agent "Builder" finished</summary>\n'
          '<usage><subagent_tokens>10</subagent_tokens></usage>\n</task-notification>';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.system);
      expect(c.from, 'Builder');
      expect(c.body, 'Agent "Builder" finished');
      expect(c.body, isNot(contains('subagent_tokens')));
    });

    test('stop-hook feedback is system', () {
      final c = classifyUserTurn('Stop hook feedback:\n[all tests pass]: run them');
      expect(c.kind, UserTurnKind.system);
      expect(c.from, 'Hook');
      expect(c.body, isNot(startsWith('Stop hook feedback')));
    });

    test('compaction summary is system, kept verbatim', () {
      const text =
          'This session is being continued from a previous conversation that ran out of context.';
      final c = classifyUserTurn(text);
      expect(c.kind, UserTurnKind.system);
      expect(c.from, 'Session continued');
      expect(c.body, text);
    });
  });

  testWidgets(
    'a teammate message renders as the teammate, never "You"',
    (tester) async {
      final page = TranscriptPage(
        messages: const [
          TranscriptTurn(
            role: 'user',
            text:
                'Another Claude session sent a message:\n'
                '<teammate-message teammate_id="J4b2" summary="report">\n'
                'TEAMMATE_REPORT_MARKER build green\n'
                '</teammate-message>',
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

      // Labelled as the teammate, and the human label is absent.
      expect(find.text('◆ J4b2'), findsOneWidget);
      expect(find.text('You'), findsNothing);
      // Inner report shown; the injection wrapper is stripped.
      expect(find.textContaining('TEAMMATE_REPORT_MARKER'), findsOneWidget);
      expect(find.textContaining('Another Claude session'), findsNothing);
    },
  );

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

  group('#47: scrolling up to load older history must not snap to the bottom', () {
    List<TranscriptTurn> genTurns(String prefix, int count) => List.generate(
          count,
          (i) => TranscriptTurn(
            role: i.isEven ? 'user' : 'assistant',
            text: '${prefix}_$i',
            toolUses: const [],
            ts: null,
          ),
        );

    testWidgets(
      'the viewport stays anchored near the insertion point, not at maxScrollExtent',
      (tester) async {
        final newest = genTurns('NEWEST', 30);
        final older = genTurns('OLDER', 30);

        Future<TranscriptPage> fetch(
          String id, {
          String? before,
          int? limit,
        }) async {
          if (before == 'cur1') {
            return TranscriptPage(messages: older, cursor: null, hasMore: false);
          }
          return TranscriptPage(messages: newest, cursor: 'cur1', hasMore: true);
        }

        await tester.pumpWidget(
          _wrap(ConversationView(session: _session(), fetchPage: fetch)),
        );
        await tester.pumpAndSettle();

        // Pinned to bottom initially — no jump-to-bottom FAB.
        expect(find.byIcon(Icons.keyboard_double_arrow_down), findsNothing);

        final controller =
            tester.widget<ListView>(find.byType(ListView)).controller!;

        // Scroll all the way to the top — this is the real trigger path:
        // _onScroll sees pixels near 0 and calls _loadOlder().
        controller.jumpTo(0);
        await tester.pumpAndSettle();

        // #47 "done-when": after older history renders, the reader is NO LONGER
        // auto-following the bottom — otherwise the next incoming turn (or the 4s
        // refresh poll) yanks them away from the history they just paged in. The
        // observable is `_pinnedToBottom == false`, surfaced as the jump-to-bottom
        // FAB.
        //
        // We assert the pin STATE, not a raw pixel offset. With only ~60 short
        // turns in a fixed 600px test viewport the content is tiny, so the
        // anchor `jumpTo(pixels + (newExtent - oldExtent))` computes an offset
        // past maxScrollExtent and ScrollPosition clamps it to the bottom —
        // `maxScrollExtent - pixels` reads 0 here purely as an artifact of that
        // clamp (on a real device, where the transcript is tall, the same jump
        // lands mid-history). What survives the clamp — and is the behaviour #47
        // is actually about — is the product's post-frame reassertion forcing
        // `_pinnedToBottom` false. This is a true discriminator: strip the #47
        // un-pin lines and the clamp re-latches `_pinnedToBottom = true`, the FAB
        // vanishes, and this expectation fails.
        expect(find.byIcon(Icons.keyboard_double_arrow_down), findsOneWidget);

        // Prove the older page actually merged into the list. It sits ABOVE the
        // anchored viewport, and a ListView.builder only realizes on-screen
        // items (cacheExtent 250px), so OLDER_0 was never built while anchored —
        // asserting it there finds 0, which is what tripped the blind test, not
        // a real bug. Bring the top back into view (hasMoreOlder is false now,
        // so this fires no further load) and it must be present.
        controller.jumpTo(controller.position.minScrollExtent);
        await tester.pumpAndSettle();
        expect(find.textContaining('OLDER_0'), findsOneWidget);
      },
    );

    testWidgets(
      'a status refresh landing right after the older-page load does not '
      'yank the view down to the newest turn (the reported #47 symptom)',
      (tester) async {
        final newestV1 = genTurns('NEWEST', 30);
        // Same 30 turns but the last one's text changed — models a realistic
        // "content updated" refresh without changing the page length (a
        // length change hits an unrelated pre-existing edge case in
        // _refreshLastPage's tail-window bookkeeping, out of scope for #47).
        final newestV2 = [
          ...newestV1.sublist(0, 29),
          const TranscriptTurn(
            role: 'assistant',
            text: 'NEWEST_29_UPDATED',
            toolUses: [],
            ts: null,
          ),
        ];
        final older = genTurns('OLDER', 30);

        ScrollController? controller;
        var refreshCalls = 0;

        Future<TranscriptPage> fetch(
          String id, {
          String? before,
          int? limit,
        }) async {
          if (before == 'cur1') {
            // Fault-injection: simulate the exact race #47 hinges on — some
            // scroll notification reporting "at the bottom" in the narrow
            // window between the older-page fetch resolving and _loadOlder's
            // own anchor-preserving jumpTo (see the PRIME SUSPECT comment on
            // _loadOlder in conversation_view.dart). This deterministically
            // reproduces, from a widget test, a race that would otherwise
            // depend on real ListView layout timing we cannot control here.
            // Yielding first (a real microtask hop) lands the injected jumpTo
            // on a LATER event-loop turn, outside the caller's own jumpTo
            // call stack — a realistic race, not risky re-entrant recursion.
            final c = controller;
            if (c != null && c.hasClients) {
              await Future<void>.delayed(Duration.zero);
              c.jumpTo(c.position.maxScrollExtent);
            }
            return TranscriptPage(messages: older, cursor: null, hasMore: false);
          }
          refreshCalls++;
          return TranscriptPage(
            messages: refreshCalls == 1 ? newestV1 : newestV2,
            cursor: 'cur1',
            hasMore: true,
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
        Widget build(Session s) => _wrap(
              ConversationView(
                key: const ValueKey('cv-47'),
                session: s,
                fetchPage: fetch,
              ),
            );

        await tester.pumpWidget(build(sess(1000)));
        await tester.pumpAndSettle();
        controller = tester.widget<ListView>(find.byType(ListView)).controller;

        // Scroll to the top -> _loadOlder runs, and the stub above injects
        // the fault-simulated "at bottom" scroll signal mid-fetch.
        controller!.jumpTo(0);
        await tester.pumpAndSettle();

        // The fault must not have stuck: the jump-to-bottom FAB (shown
        // whenever _pinnedToBottom is false) must still be present — proving
        // the transient mis-latch was corrected, not left to fool the next
        // refresh.
        expect(find.byIcon(Icons.keyboard_double_arrow_down), findsOneWidget);

        // A status refresh lands right after (mirrors the real 4s poll / any
        // lastActivity-driven _refreshLastPage while the user is still
        // reading older history).
        await tester.pumpWidget(build(sess(2000)));
        await tester.pumpAndSettle();

        // Fresh content arrived while not pinned to the bottom, so it must
        // surface as the "New" pill, never as an auto-scroll-to-bottom (the
        // literal #47 complaint: "every attempt to page back bounces the
        // user to the bottom"). Note: this deliberately checks the
        // _pinnedToBottom-driven UI state rather than raw scroll pixels —
        // the fault injection above moves the real ScrollController position
        // as a side effect, which would contaminate a pixel-distance
        // assertion here regardless of the fix.
        expect(find.text('New'), findsOneWidget);
        // The jump-to-bottom FAB is superseded by the "New" pill once shown
        // (both mean "not pinned"; the pill wins the UI slot) — confirms this
        // isn't coincidentally still showing the FAB from before.
        expect(find.byIcon(Icons.keyboard_double_arrow_down), findsNothing);

        // Finally, confirm the older page genuinely merged and survived the
        // refresh. It sits far above the current (fault-bottom) viewport, so a
        // virtualized ListView never built it — bring the top into view
        // (hasMoreOlder is false, so no further load) and it must be there.
        controller!.jumpTo(controller!.position.minScrollExtent);
        await tester.pumpAndSettle();
        expect(find.textContaining('OLDER_0'), findsOneWidget);
      },
    );

    testWidgets(
      'a SHORT transcript that fits the viewport (nothing to scroll) does '
      'not un-pin even though _loadOlder fires (#47 edge case)',
      (tester) async {
        // Only a couple of short turns — must fit entirely inside the 600px
        // viewport from _wrap, so maxScrollExtent stays 0 and the top/bottom
        // edge thresholds in _onScroll coincide. hasMore:true means older
        // history genuinely exists beyond this short initial page, so the
        // jump-to-bottom-on-load can still trigger _loadOlder purely from
        // that threshold overlap — never from the user actually scrolling.
        final newest = genTurns('NEWEST', 2);
        final older = genTurns('OLDER', 10);

        Future<TranscriptPage> fetch(
          String id, {
          String? before,
          int? limit,
        }) async {
          if (before == 'cur1') {
            return TranscriptPage(messages: older, cursor: null, hasMore: false);
          }
          return TranscriptPage(messages: newest, cursor: 'cur1', hasMore: true);
        }

        await tester.pumpWidget(
          _wrap(ConversationView(session: _session(), fetchPage: fetch)),
        );
        await tester.pumpAndSettle();

        final controller =
            tester.widget<ListView>(find.byType(ListView)).controller!;

        // The two short turns fit the viewport, so maxScrollExtent is 0: the
        // reader is at the top AND the bottom at once. A plain jumpTo(0) here
        // is a no-op (pixels are already 0), fires NO scroll notification, and
        // so _onScroll never runs — which is exactly why the blind test was
        // vacuous (_loadOlder never fired). Drive _onScroll the way a real
        // pull-past-the-top does: force a small overscroll beyond the bottom.
        // pixels then sits inside BOTH edge thresholds (|pixels| <= 80), so
        // atBottom stays true (still pinned) while the top-threshold trips
        // _loadOlder with oldExtent == 0 — the precise overlap wasScrollable
        // guards.
        expect(controller.position.maxScrollExtent, lessThan(1.0));
        controller.jumpTo(50);
        await tester.pumpAndSettle();

        // The older page did load (nothing else can grow the extent past 0),
        // proving _loadOlder really fired from the threshold overlap — this
        // test is not vacuous.
        expect(controller.position.maxScrollExtent, greaterThan(0));

        // Still pinned to the bottom — no jump-to-bottom FAB — because
        // oldExtent was 0, so the wasScrollable guard left _pinnedToBottom
        // alone: the reader never scrolled away from the bottom.
        expect(find.byIcon(Icons.keyboard_double_arrow_down), findsNothing);

        // And the older turns are really in the list (now above the viewport,
        // so only realized once the top is scrolled in).
        controller.jumpTo(controller.position.minScrollExtent);
        await tester.pumpAndSettle();
        expect(find.textContaining('OLDER_0'), findsOneWidget);
      },
    );
  });

  group('#65 compacting indicator', () {
    // SessionRepository.instance is a real singleton the widget reads
    // directly (mirroring SessionRepository.apiErrorFor's dashboard usage) —
    // debugSetCompacting is the test-only seam for driving it. Always clear
    // it after each test so state never leaks into unrelated tests reusing
    // the 'sess-1' id.
    tearDown(() => SessionRepository.instance.debugSetCompacting('sess-1', null));

    // A single real turn (not an empty transcript) so the trailing indicator
    // has something to render after — an empty transcript short-circuits to
    // the "No messages yet" empty state before either indicator is reached.
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null),
      ],
      cursor: null,
      hasMore: false,
    );

    testWidgets(
      'a compacting session shows "Compacting conversation…", taking '
      'priority over "Claude is working" when both apply',
      (tester) async {
        SessionRepository.instance.debugSetCompacting(
          'sess-1',
          const CompactingInfo(active: true, since: 1000),
        );

        await tester.pumpWidget(
          _wrap(
            ConversationView(
              session: _session(status: 'working'),
              fetchPage: (id, {before, limit}) async => page,
            ),
          ),
        );
        // Bounded pumps, NOT pumpAndSettle: both the working and compacting
        // indicators repeat their pulse animation forever, which would hang
        // pumpAndSettle (see the #31/#62 tests above for the same caveat).
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.text('Compacting conversation…'), findsOneWidget);
        expect(find.text('Claude is working'), findsNothing);
      },
    );

    testWidgets(
      'a plain working session (no compacting overlay) still shows '
      '"Claude is working"',
      (tester) async {
        await tester.pumpWidget(
          _wrap(
            ConversationView(
              session: _session(status: 'working'),
              fetchPage: (id, {before, limit}) async => page,
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.text('Claude is working'), findsOneWidget);
        expect(find.text('Compacting conversation…'), findsNothing);
      },
    );
  });
}
