// Widget tests for the Chat lens (ConversationView): turn rendering, fenced
// code blocks, tool-use chips, and empty/error states. Network access is
// avoided entirely via the injectable `fetchPage`.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import 'package:ai_terminal/api/agent_catalog.dart';
import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/conversation_view.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({
  String status = 'idle',
  bool compacting = false,
  int? lastActivity,
}) => Session(
  id: 'sess-1',
  name: 'proj',
  cwd: '/x',
  status: status,
  claudeSessionId: 'claude-1',
  lastActivity: lastActivity ?? DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
  compacting: compacting,
);

/// Records every launch that reaches the url_launcher platform, so a test can
/// assert that an unsafe scheme reached it NOT AT ALL. Same shape as the one in
/// chat_links_launch_test.dart.
class _RecordingLauncher extends UrlLauncherPlatform
    with MockPlatformInterfaceMixin {
  final List<String> launched = <String>[];

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> canLaunch(String url) async => true;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    launched.add(url);
    return true;
  }
}

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
    '#83: the inline `code` background is translucent, so a selection '
    'highlight underneath it stays visible',
    (tester) async {
      // The reported symptom was "I can't see the selected text, but it WAS
      // selected" — a path in inline `code` selected correctly (the clipboard
      // and SelectionArea agreed, measured with a real OS drag) while showing
      // no highlight at all, which reads as "selection is broken".
      //
      // The mechanism is a paint order, which is why this is assertable without
      // any input at all: Flutter paints the selection highlight into the
      // paragraph FIRST and the text — including a span's `backgroundColor` —
      // on top. An OPAQUE span background therefore covers the highlight
      // completely. So the invariant worth pinning is not "a drag highlights"
      // (a widget test cannot see that; synthetic events never traverse the OS
      // input path — see #55/#83) but "the code span cannot paint over it".
      final page = TranscriptPage(
        messages: const [
          TranscriptTurn(
            role: 'assistant',
            text: r'open `C:\Users\me\query-plan.sql` now.',
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

      // Find the monospace span the markdown built for the inline code, by
      // walking the REAL span tree rather than trusting the stylesheet object —
      // what matters is the style that actually reaches the painter.
      final codeStyles = <TextStyle>[];
      for (final rt in tester.widgetList<RichText>(find.byType(RichText))) {
        rt.text.visitChildren((span) {
          if (span is TextSpan && span.style?.fontFamily == 'monospace') {
            codeStyles.add(span.style!);
          }
          return true;
        });
      }

      expect(
        codeStyles,
        isNotEmpty,
        reason: 'expected an inline-code span rendered in monospace',
      );

      // Collect the backgrounds rather than skipping the null ones inline, so
      // this cannot pass while asserting nothing. A null background genuinely
      // cannot occlude a highlight, so dropping the tint WOULD also "fix" #83 —
      // but silently, by deleting the affordance that marks a span as code. That
      // is a UI decision, not a bug fix, and it should not be able to ride in
      // under a green #83 test. If you are deliberately removing the inline-code
      // background, change this expectation in the same commit and say why.
      final backgrounds = codeStyles
          .map((s) => s.backgroundColor)
          .whereType<Color>()
          .toList();
      expect(
        backgrounds,
        isNotEmpty,
        reason:
            'no inline-code span carried a backgroundColor at all — either the '
            'code affordance was removed, or this test is no longer looking at '
            'the span it thinks it is',
      );
      for (final bg in backgrounds) {
        expect(
          bg.a,
          lessThan(1.0),
          reason:
              'an opaque inline-code background is composited OVER the selection '
              'highlight and hides it — that is #83',
        );
      }
    },
  );

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

    // #88: this turn is tool-ONLY, so it is now mechanical and folded away by
    // default. Open the fold first — the card's own behaviour below is
    // unchanged, and asserting it still through the fold is the point: nothing
    // was removed, only folded.
    expect(find.text('1 step'), findsOneWidget);
    expect(find.textContaining('Bash — npm test'), findsNothing);
    await tester.tap(find.text('1 step'));
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
      // UPDATED for #118, deliberately: this used to assert the chip label was
      // the bare agent TYPE ('Explore' / 'general-purpose'), which is exactly
      // the defect #118 reports — every instance of a type renders identically.
      // The chip now leads with the per-instance description. The thing #62
      // actually cares about, one chip per subagent, is unchanged and is what
      // these two lines still pin.
      expect(find.text('do Explore'), findsOneWidget);
      expect(find.text('do general-purpose'), findsOneWidget);
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

      await tester.tap(find.text('do Explore')); // the chip (#118: labelled by task)
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

      await tester.tap(find.text('do Explore')); // chip → sheet (#118 label)
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

  // #83 — the regression gate for "dragging selects nothing".
  //
  // A widget test CANNOT prove selection works: synthetic pointer events are
  // injected straight into Flutter's gesture arena and never traverse the
  // Windows pointer path, which is why eight of them passed against the original
  // report. What it CAN prove is the structural property that caused it — a link
  // must be a TextSpan inside the paragraph, never a WidgetSpan. A WidgetSpan is
  // an opaque box the ancestor SelectionArea (#27) does not walk, and the widget
  // inside it carried a long-press recognizer that held the arena for exactly the
  // button-down a selection drag begins with. Pin the cause; the real-input rig
  // (scripts/rig/probe-drive-selection.ps1 -ShotDuring) pins the symptom.
  testWidgets('a chat link is a TextSpan in the paragraph, never a WidgetSpan', (
    tester,
  ) async {
    final page = TranscriptPage(
      messages: const [
        TranscriptTurn(
          role: 'assistant',
          text: 'see [example](https://example.com/x) and https://bare.example/y',
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

    // THE assertion: the prose AND the link occupy ONE paragraph, so a drag
    // across the sentence has a single continuous run of text to walk.
    //
    // Measured difference (test/zz_span_probe style instrumentation):
    //   old builder -> 4 RichTexts: "see " | "example" | " tail" as SEPARATE
    //                  render objects, with the tap recognizer landing on the
    //                  WRONG span (" tail" — tapping the trailing prose opened
    //                  the link);
    //   onTapLink   -> 2 RichTexts: [see ][example <-Tap][ tail] in one paragraph.
    // A bubble whose sentence is shattered into per-fragment RichTexts is the
    // structural signature of this bug.
    final bodies = tester
        .widgetList<RichText>(find.byType(RichText))
        .where((rt) => rt.text.toPlainText().contains('example'))
        .toList();
    expect(bodies, hasLength(1),
        reason: 'the sentence must be ONE paragraph, not one RichText per '
            'fragment — a split paragraph is what SelectionArea cannot walk');

    final para = bodies.single;
    final plain = para.text.toPlainText();
    // Prose either side of the link shares that same paragraph.
    expect(plain, contains('see '));
    expect(plain, contains('example'));
    expect(plain, contains('bare.example'),
        reason: 'a gitHubWeb autolinked bare URL must share the paragraph too');

    // And no widget sits in the text flow.
    para.text.visitChildren((span) {
      expect(span, isNot(isA<WidgetSpan>()),
          reason: 'a WidgetSpan in chat text breaks SelectionArea (#83)');
      return true;
    });
  });

  // The removed `_ChatLink` carried an explicit
  // `ConstrainedBox(maxWidth: 0.82 * screen)` whose comment said a WidgetSpan is
  // otherwise laid out at its INTRINSIC width, so a long bare URL would overflow
  // the bubble. Deleting a guard obliges us to show the guard is unnecessary:
  // a TextSpan is laid out by the paragraph, and Flutter breaks a word that
  // cannot fit a line rather than running off the edge.
  testWidgets('a long unbroken bare URL wraps instead of overflowing', (
    tester,
  ) async {
    const width = 400.0;
    final longUrl = 'https://example.com/${'x' * 300}';
    final page = TranscriptPage(
      messages: [
        TranscriptTurn(
          role: 'assistant',
          text: 'see $longUrl end',
          toolUses: const [],
          ts: null,
        ),
      ],
      cursor: null,
      hasMore: false,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SizedBox(
            width: width,
            height: 600,
            child: ConversationView(
              session: _session(),
              fetchPage: (id, {before, limit}) async => page,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final para = tester
        .widgetList<RichText>(find.byType(RichText))
        .where((rt) => rt.text.toPlainText().contains('example.com'))
        .toList();
    expect(para, hasLength(1), reason: 'still one paragraph');

    final size = tester.getSize(
      find.byWidget(para.single),
    );
    expect(size.width, lessThanOrEqualTo(width),
        reason: 'a 300-char unbroken URL must wrap inside the bubble, not '
            'overflow it — the ConstrainedBox that used to force this is gone');
    // It wrapped, so it occupies many lines rather than one very long one.
    expect(size.height, greaterThan(40));
  });

  // The tap-to-open path survives the WidgetSpan removal: flutter_markdown
  // attaches a TapGestureRecognizer to the link span. A tap recognizer is
  // defeated by movement, which is why it can coexist with a selection drag
  // where the old long-press recognizer could not.
  testWidgets('a chat link still carries a tap recognizer', (tester) async {
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

    // The recognizer must sit on the LINK's span, not merely exist somewhere.
    // Under the old builder it attached to the trailing prose (" tail"), so
    // tapping ordinary text opened the URL while the link itself did nothing.
    final tapped = <String>[];
    for (final rt in tester.widgetList<RichText>(find.byType(RichText))) {
      rt.text.visitChildren((span) {
        if (span is TextSpan && span.recognizer != null) {
          tapped.add(span.text ?? '');
        }
        return true;
      });
    }
    // Exact, not `contains`: the recognizer must be on the link and on NOTHING
    // else. The old builder leaked it onto the trailing prose, and a `contains`
    // assertion would have stayed green through exactly that.
    expect(tapped, ['example'],
        reason: 'the tap recognizer must be on the link text itself, alone');
  });

  // The security gate, pinned AT THE WIDGET. chat_links_launch_test.dart proves
  // openChatLink refuses unsafe schemes, and the tests above pin the span
  // structure — but nothing connected the two, so changing the call site to
  // `onTapLink: (t, h, ti) => launchUrl(Uri.parse(h!))` would pass every test in
  // the repo while making `javascript:` launchable from a chat message.
  //
  // THE POSITIVE CONTROL IS PART OF THE TEST, not politeness. Two earlier drafts
  // of this "security test" passed with the gate deliberately bypassed:
  //   * the first asserted only `takeException() == null` — never a launch signal;
  //   * the second tapped `box.left + 20`, which lands in the leading prose
  //     ("go "), not on the link glyphs, so NOTHING was ever tapped.
  // Both reported "javascript: was blocked" while the gate was wide open. A
  // negative result is worthless unless the same rig can produce a positive one,
  // so this asserts an https link DOES launch through the identical path.
  testWidgets('the launch gate holds at the widget: https yes, javascript no', (
    tester,
  ) async {
    Future<List<String>> tapLink(String markdown) async {
      final launcher = _RecordingLauncher();
      UrlLauncherPlatform.instance = launcher;
      final page = TranscriptPage(
        messages: [
          TranscriptTurn(
            role: 'assistant',
            text: markdown,
            toolUses: const [],
            ts: null,
          ),
        ],
        cursor: null,
        hasMore: false,
      );
      // A distinct key per render, and a blank pump between: without them the
      // second call reuses the FIRST subtree, so the tap lands on the previous
      // link and the new launcher records the OLD url — which reads as
      // "javascript: launched" and sent me chasing a bug that wasn't there.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        _wrap(
          ConversationView(
            key: ValueKey(markdown),
            session: _session(),
            fetchPage: (id, {before, limit}) async => page,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap the LINK's glyphs, located from the paragraph rather than guessed.
      final finder = find
          .byWidgetPredicate((w) =>
              w is RichText && w.text.toPlainText().contains('click'))
          .first;
      final para = tester.widget<RichText>(finder);
      final plain = para.text.toPlainText();
      final start = plain.indexOf('click');
      final ro = tester.renderObject(finder) as RenderParagraph;
      final boxes = ro.getBoxesForSelection(
        TextSelection(baseOffset: start, extentOffset: start + 'click'.length),
      );
      expect(boxes, isNotEmpty, reason: 'the link must be laid out to be tapped');
      final rect =
          boxes.first.toRect().shift(tester.getRect(finder).topLeft);
      await tester.tapAt(rect.center);
      await tester.pumpAndSettle();
      return launcher.launched;
    }

    // Positive control — proves the rig can register a launch at all.
    expect(await tapLink('go [click](https://example.com/x) now'),
        ['https://example.com/x']);

    // THE assertion: the same tap on an unsafe scheme launches nothing.
    expect(await tapLink('go [click](javascript:alert%281%29) now'), isEmpty);
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
          '<output-file>C:\\Users\\yourname\\tasks\\a0d2.output</output-file>\n'
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
    'a Codex session resets when the rollout changes (agentSessionId)',
    (tester) async {
      // The Office report: a live terminal beside a chat lens showing a 17h-old
      // conversation. claudeSessionId is null for EVERY Codex session, so the #35
      // reset above could never fire for one — and a Codex transcript is DISCOVERED
      // ("newest rollout for this cwd") with a new rollout written every run, so the
      // server legitimately starts serving a different conversation while nothing the
      // client could see changes. agentSessionId is that missing signal.
      TranscriptPage current = const TranscriptPage(
        messages: [
          TranscriptTurn(
              role: 'assistant', text: 'YESTERDAYS_ROLLOUT', toolUses: [], ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      Future<TranscriptPage> fetch(String id,
              {String? before, int? limit}) async =>
          current;

      // claudeSessionId stays null and lastActivity is held constant, so the ONLY
      // thing that can trigger the reset is agentSessionId.
      Session sess(String? rolloutId) => Session(
            id: 'sess-codex',
            name: 'Codex bug hunter',
            cwd: r'C:\\dev\\acme_core',
            status: 'idle',
            claudeSessionId: null,
            agentSessionId: rolloutId,
            lastActivity: 1000,
            notifyLevel: 'important',
            server: _server(),
            autoCommand: '',
            agent: 'codex',
          );
      Widget build(Session s) =>
          _wrap(ConversationView(session: s, fetchPage: fetch));

      await tester.pumpWidget(build(sess('019f84c8-410f-77f2-989e-d5a235e46b53')));
      await tester.pumpAndSettle();
      expect(find.text('YESTERDAYS_ROLLOUT'), findsOneWidget);

      // Codex started a new session: a different rollout UUID, and the server now
      // serves that conversation instead.
      current = const TranscriptPage(
        messages: [
          TranscriptTurn(
              role: 'assistant', text: 'TODAYS_ROLLOUT', toolUses: [], ts: null),
        ],
        cursor: null,
        hasMore: false,
      );
      await tester.pumpWidget(build(sess('019f8928-94e9-7072-93d3-271f00fbaea7')));
      await tester.pumpAndSettle();

      expect(find.text('YESTERDAYS_ROLLOUT'), findsNothing,
          reason: 'the stale conversation must be dropped, not kept beside the new one');
      expect(find.text('TODAYS_ROLLOUT'), findsOneWidget);
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
  group('live-poll gate (#codex chat kept up to date)', () {
    // The bug: the chat only polled while status=='working', which Claude reaches
    // via hooks but Codex never does — its status stays 'active'. So a Codex chat
    // sat frozen while its live terminal moved on (measured on Office: a week-long
    // conversation whose terminal had reached bug-hunter QA work while the chat
    // still showed a 37-min-old email). Polling on 'active' closes that gap.
    TranscriptTurn a(String text, String ts) =>
        TranscriptTurn(role: 'assistant', text: text, toolUses: const [], ts: ts);

    testWidgets("a Codex ('active') chat live-polls and picks up new turns",
        (tester) async {
      var tail = [a('EMAIL_DRAFT', '2026-07-29T12:13:00Z')];
      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'active'),
        fetchPage: (id, {before, limit}) async => TranscriptPage(
          messages: tail, cursor: null, hasMore: false),
      )));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('EMAIL_DRAFT'), findsOneWidget);
      expect(find.text('QA_RESULT'), findsNothing);

      // The session does a turn: the server tail now ends with the QA result. No
      // widget rebuild happens — only the poll timer can bring this in.
      tail = [a('EMAIL_DRAFT', '2026-07-29T12:13:00Z'), a('QA_RESULT', '2026-07-29T12:54:00Z')];
      await tester.pump(const Duration(seconds: 4)); // one poll tick
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('QA_RESULT'), findsOneWidget,
          reason: 'an active Codex chat must catch up without a rebuild');
    });

    testWidgets('an idle session does NOT poll (unchanged for Claude at rest)',
        (tester) async {
      var tail = [a('DONE', '2026-07-29T12:00:00Z')];
      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'idle'),
        fetchPage: (id, {before, limit}) async => TranscriptPage(
          messages: tail, cursor: null, hasMore: false),
      )));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      tail = [a('DONE', '2026-07-29T12:00:00Z'), a('SHOULD_NOT_APPEAR', '2026-07-29T12:01:00Z')];
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(milliseconds: 50));
      // No poll timer while idle, and no rebuild, so the new turn is not pulled in.
      expect(find.text('SHOULD_NOT_APPEAR'), findsNothing);
    });
  });

  // #111. The #47 group above covers un-pinning via _loadOlder (scrolling to the
  // very TOP). This is the other, far commoner trigger: the reader drags up a
  // little to re-read something MID-list while the agent is still working. No
  // history load happens, so none of #47's machinery runs — the only thing
  // standing between the reader and a yank to the bottom is _onScroll having
  // cleared _pinnedToBottom.
  group('#111: a new turn must not move a reader who scrolled up', () {
    List<TranscriptTurn> genTurns(String prefix, int count) => List.generate(
          count,
          (i) => TranscriptTurn(
            role: i.isEven ? 'user' : 'assistant',
            text: '${prefix}_$i',
            toolUses: const [],
            ts: null,
          ),
        );


    // A real transcript is markdown, code blocks and tool cards whose heights
    // differ by an order of magnitude. `ListView.builder` ESTIMATES
    // maxScrollExtent from what it has laid out, so with uniform short turns
    // (every other test here) the estimate is near-perfect and nothing moves.
    // This is the case that is not covered.
    List<TranscriptTurn> mixedTurns(int n) => List.generate(n, (i) {
          final body = i % 3 == 0
              ? '```dart\n${'final value = $i;\n' * 8}```'
              : 'short_$i';
          return TranscriptTurn(
            role: i.isEven ? 'user' : 'assistant',
            text: body,
            toolUses: const [],
            ts: null,
          );
        });

    testWidgets('VARIABLE-height turns must not move the reader', (
      tester,
    ) async {
      var tail = mixedTurns(40);
      Future<TranscriptPage> fetch(
        String id, {
        String? before,
        int? limit,
      }) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'working'),
        fetchPage: fetch,
      )));
      await tester.pumpAndSettle();

      final controller =
          tester.widget<ListView>(find.byType(ListView)).controller!;
      controller.jumpTo(controller.position.maxScrollExtent / 2);
      await tester.pumpAndSettle();
      final before = controller.position.pixels;

      for (var i = 1; i <= 3; i++) {
        tail = [
          ...mixedTurns(40),
          TranscriptTurn(
            role: 'assistant',
            text: '```dart\n${'streaming line\n' * (i * 10)}```',
            toolUses: const [],
            ts: null,
          ),
        ];
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
      }

      expect(controller.position.pixels, closeTo(before, 1.0),
          reason: 'variable-height turns moved the reader');
    });

    testWidgets('a STREAMING turn (the same turn growing) must not move the reader', (
      tester,
    ) async {
      // The test below appends a NEW turn. Real output is not appended: the
      // assistant's current turn GROWS, which changes item heights rather than
      // item count -- a different path through ListView.builder's extent
      // estimation, and the one that actually runs while an agent is writing.
      var tail = [
        ...genTurns('T', 40),
        const TranscriptTurn(
            role: 'assistant', text: 'streaming', toolUses: [], ts: null),
      ];
      Future<TranscriptPage> fetch(String id, {String? before, int? limit}) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'working'),
        fetchPage: fetch,
      )));
      await tester.pumpAndSettle();

      final controller =
          tester.widget<ListView>(find.byType(ListView)).controller!;
      controller.jumpTo(controller.position.maxScrollExtent / 2);
      await tester.pumpAndSettle();
      final before = controller.position.pixels;

      // Three streaming updates, as the agent writes.
      for (var i = 1; i <= 3; i++) {
        tail = [
          ...tail.sublist(0, tail.length - 1),
          TranscriptTurn(
            role: 'assistant',
            text: 'streaming ${'more text ' * (i * 8)}',
            toolUses: const [],
            ts: null,
          ),
        ];
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
      }

      expect(controller.position.pixels, closeTo(before, 1.0),
          reason: 'a growing assistant turn moved the reader');
    });

    testWidgets('mid-list scroll position survives an incoming turn', (
      tester,
    ) async {
      var tail = genTurns('T', 40);
      Future<TranscriptPage> fetch(
        String id, {
        String? before,
        int? limit,
      }) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'working'),
        fetchPage: fetch,
      )));
      await tester.pumpAndSettle();

      final controller =
          tester.widget<ListView>(find.byType(ListView)).controller!;
      expect(controller.position.maxScrollExtent, greaterThan(100),
          reason: 'the fixture must actually be scrollable');

      // Drag up to the middle — NOT to the top, so _loadOlder never fires.
      final target = controller.position.maxScrollExtent / 2;
      controller.jumpTo(target);
      await tester.pumpAndSettle();
      final before = controller.position.pixels;
      expect(before, closeTo(target, 1.0));

      // A new turn lands on the 4s poll while the reader is up here.
      tail = [
        ...tail,
        const TranscriptTurn(
          role: 'assistant',
          text: 'BRAND_NEW_TURN',
          toolUses: [],
          ts: null,
        ),
      ];
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      // The reader must not have been moved.
      expect(controller.position.pixels, closeTo(before, 1.0),
          reason: 'an incoming turn yanked the reader away from what they were '
              'reading');
    });

    // The open sequence fires FOUR jumps — two post-frame, then +150ms and
    // +400ms — because a ListView.builder only estimates maxScrollExtent until
    // the tail is laid out. Those late timers are the hole: they fire whatever
    // the reader did in the meantime, so scrolling up inside that window is
    // undone by a jump scheduled before the reader ever touched the screen.
    testWidgets('a scroll issued on open does not yank a reader who has '
        'since scrolled away', (tester) async {
      final tail = genTurns('T', 40);
      Future<TranscriptPage> fetch(
        String id, {
        String? before,
        int? limit,
      }) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(status: 'working'),
        fetchPage: fetch,
      )));
      // Let the fetch resolve and the first post-frame jumps run, but stop
      // BEFORE the +150ms / +400ms timers.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      final controller =
          tester.widget<ListView>(find.byType(ListView)).controller!;
      expect(controller.position.maxScrollExtent, greaterThan(100));

      // The reader scrolls up while those late jumps are still pending.
      final target = controller.position.maxScrollExtent / 2;
      controller.jumpTo(target);
      await tester.pump();
      final before = controller.position.pixels;

      // Now let the +150ms and +400ms jumps fire.
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();

      expect(controller.position.pixels, closeTo(before, 1.0),
          reason: 'a jump scheduled on open fired after the reader had '
              'scrolled away and dragged them back to the bottom');
    });
  });

  // #118. Ground truth (every conversation on the reporter's machine): `Agent`
  // tool_uses map 1:1 to agent-*.meta.json files and no tool_use ever carries
  // two, so the COUNT was never wrong — eight chips meant eight real subagents.
  // The defect was that all eight said the same thing, because the label led
  // with `agentType` (shared by every instance) and used `description` (the only
  // per-instance field) merely as a fallback.
  group('#118: subagent chips must be distinguishable', () {
    ToolUse sub(String type, String desc, {String id = 'x'}) => ToolUse(
          name: 'Agent',
          inputPreview: '',
          id: id,
          subagent: SubagentTrace(
            agentType: type,
            description: desc,
            running: false,
          ),
        );

    test('the per-instance description leads, not the shared type', () {
      final labels = subagentChipLabels([
        sub('general-purpose', 'Build companion 1.19.4+62', id: 'a'),
        sub('general-purpose', 'Audit the cluster tokens', id: 'b'),
        sub('general-purpose', 'Trace the submit path', id: 'c'),
      ]);
      // The reported symptom was exactly this list coming back all-identical.
      expect(labels, [
        'Build companion 1.19.4+62',
        'Audit the cluster tokens',
        'Trace the submit path',
      ]);
      expect(labels.toSet(), hasLength(3), reason: 'chips must differ');
    });

    test('a meta with no description still falls back to its type', () {
      expect(subagentChipLabels([sub('Explore', '')]), ['Explore']);
      expect(subagentChipLabels([sub('', '')]), ['subagent']);
    });

    test('genuinely identical tasks are numbered so they stay tellable apart',
        () {
      final labels = subagentChipLabels([
        sub('general-purpose', 'Sweep the repo', id: 'a'),
        sub('general-purpose', 'Sweep the repo', id: 'b'),
        sub('search', 'Find the caller', id: 'c'),
      ]);
      expect(labels, ['Sweep the repo 1', 'Sweep the repo 2', 'Find the caller']);
      expect(labels.toSet(), hasLength(3));
    });

    test('only colliding labels are numbered — the common case stays clean', () {
      final labels = subagentChipLabels([
        sub('general-purpose', 'One', id: 'a'),
        sub('general-purpose', 'Two', id: 'b'),
      ]);
      expect(labels, ['One', 'Two']);
    });
  });

  // #115. A /compact is long (the boundary this repo's own session wrote records
  // durationMs 122091) and the turn that ran it can END while compaction
  // continues, dropping the status to idle. The poll gate keyed only on
  // working/active, so the chat stopped refreshing during the ONE window where
  // the transcript is guaranteed to change — freezing the indicator and losing
  // the prompt that had been queued meanwhile.
  group('#115: chat keeps refreshing across a compaction', () {
    TranscriptTurn a(String t) =>
        TranscriptTurn(role: 'assistant', text: t, toolUses: const [], ts: null);

    testWidgets('an IDLE session that is compacting still polls', (
      tester,
    ) async {
      var tail = [a('BEFORE_COMPACT')];
      Future<TranscriptPage> fetch(
        String id, {
        String? before,
        int? limit,
      }) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      await tester.pumpWidget(_wrap(ConversationView(
        // Idle — but compacting. Before the fix this combination polled not at all.
        session: _session(status: 'idle', compacting: true),
        fetchPage: fetch,
      )));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('BEFORE_COMPACT'), findsOneWidget);

      // The queued prompt's turn starts and is finally written.
      tail = [a('BEFORE_COMPACT'), a('QUEUED_PROMPT_TURN')];
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('QUEUED_PROMPT_TURN'), findsOneWidget,
          reason: 'the chat stopped polling while compacting, so the turn that '
              'ran after compaction never arrived');
    });

    testWidgets('compaction ENDING refreshes immediately, not on the next tick',
        (tester) async {
      var tail = [a('DURING')];
      Future<TranscriptPage> fetch(
        String id, {
        String? before,
        int? limit,
      }) async =>
          TranscriptPage(messages: tail, cursor: null, hasMore: false);

      Widget build(bool compacting) => _wrap(ConversationView(
            // lastActivity pinned so the ONLY thing that changes below is
            // `compacting` — otherwise the refresh could ride that instead and
            // the test would pass without proving anything.
            session: _session(
              status: 'idle',
              compacting: compacting,
              lastActivity: 111,
            ),
            fetchPage: fetch,
          ));

      await tester.pumpWidget(build(true));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('DURING'), findsOneWidget);

      tail = [a('DURING'), a('SETTLED_AFTER_COMPACT')];
      // Compaction ends; the session is now plain idle, so the poll timer stops.
      await tester.pumpWidget(build(false));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('SETTLED_AFTER_COMPACT'), findsOneWidget,
          reason: 'nothing refreshed when compaction ended, and the poll had '
              'just been switched off — so the chat would sit stale forever');
    });
  });

  // Reported 2026-08-16: "I add prompt ... I can't see it in chat - it was entered
  // during the work." An echo is the ONLY thing showing a queued prompt, because
  // Claude writes the user message when its turn STARTS. Expiring it on a flat
  // timer deleted the prompt from chat on any turn longer than 90s.
  group('echo expiry waits for the turn, not the clock', () {
    test('a matched echo is dropped whatever the state — that is the dedupe', () {
      expect(
        shouldDropEcho(matchedInTranscript: true, timeoutRuns: false, ageMs: 0),
        isTrue,
      );
    });

    test('an old echo SURVIVES while the agent is mid-turn', () {
      expect(
        shouldDropEcho(
          matchedInTranscript: false,
          timeoutRuns: false,
          ageMs: kEchoTimeoutMs * 10,
        ),
        isFalse,
      );
    });

    test('an old unmatched echo expires once the session is done', () {
      expect(
        shouldDropEcho(
          matchedInTranscript: false,
          timeoutRuns: true,
          ageMs: kEchoTimeoutMs + 1,
        ),
        isTrue,
      );
    });

    test('a young unmatched echo is never dropped', () {
      expect(
        shouldDropEcho(matchedInTranscript: false, timeoutRuns: true, ageMs: 5),
        isFalse,
      );
    });

    test('working and compacting both hold the timeout off', () {
      expect(echoTimeoutRuns(status: 'working', compacting: false), isFalse);
      expect(echoTimeoutRuns(status: 'idle', compacting: true), isFalse);
    });

    test('waiting holds it off too — a blocked session has not started the turn', () {
      // A queued prompt behind a permission prompt or an AskUserQuestion is
      // exactly as unstarted as one behind a running tool.
      expect(echoTimeoutRuns(status: 'waiting', compacting: false), isFalse);
    });

    test('an idle session lets it run — a prompt not seen by then never arrives', () {
      expect(echoTimeoutRuns(status: 'idle', compacting: false), isTrue);
    });
  });

  // #149: "the Queued badge never clears once Claude consumes the prompt."
  //
  // The group above tests shouldDropEcho and SUPPLIES `matchedInTranscript` as an
  // input — so it passed happily against the bug, which lived entirely in how
  // that boolean was PRODUCED. The comparison was inline in two places and had no
  // test at all; that is why it could compare the submitted prompt against the
  // raw turn text, which a real prompt never equals.
  group('an echo matches its real turn through the wrappers Claude staples on', () {
    TranscriptTurn userTurn(String text, {String? typedText}) =>
        TranscriptTurn(role: 'user', text: text, toolUses: const [], ts: null, typedText: typedText);

    const reminder = '<system-reminder>\n# claudeMd\ninjected instructions\n</system-reminder>';

    test('an unwrapped prompt matches — the case that always worked', () {
      expect(
        echoMatchesTurns('run the build', [userTurn('run the build', typedText: 'run the build')]),
        isTrue,
      );
    });

    test('a TRAILING <system-reminder> on the real turn still matches', () {
      // The reported bug, in one line: raw text != submitted text, so the old
      // equality never fired and the badge stayed up forever.
      expect(
        echoMatchesTurns('run the build',
            [userTurn('run the build\n$reminder', typedText: 'run the build')]),
        isTrue,
      );
    });

    test('a LEADING <system-reminder> still matches', () {
      expect(
        echoMatchesTurns('run the build',
            [userTurn('$reminder\nrun the build', typedText: 'run the build')]),
        isTrue,
      );
    });

    test('a typed slash command matches through its real tag trio', () {
      // What a queued `/issue <text>` actually looks like in the transcript —
      // message-first, which is the order the user-typed ones arrive in.
      const trio = '<command-message>issue</command-message>\n'
          '<command-name>/issue</command-name>\n'
          '<command-args>the badge never clears</command-args>';
      expect(
        echoMatchesTurns('/issue the badge never clears',
            [userTurn(trio, typedText: '/issue the badge never clears')]),
        isTrue,
      );
    });

    test('a whitespace-only difference matches — the send path reshapes newlines', () {
      expect(
        echoMatchesTurns('run   the\r\nbuild',
            [userTurn('run the build', typedText: 'run the\nbuild')]),
        isTrue,
      );
    });

    test('a DIFFERENT prompt does not match', () {
      // The half that keeps the fix honest: loosening the comparison until
      // everything matches would clear the badge of a prompt still queued.
      expect(
        echoMatchesTurns('run the build', [userTurn('run the tests', typedText: 'run the tests')]),
        isFalse,
      );
    });

    test('a turn the human did not type never matches, even word for word', () {
      // `typedText: ''` is the server stating positively that nobody typed this.
      // A teammate message quoting the prompt must not clear its badge.
      expect(
        echoMatchesTurns('run the build',
            [userTurn('<teammate-message teammate_id="J4b2">run the build</teammate-message>', typedText: '')]),
        isFalse,
      );
      // The hard version, and the one this test claimed to cover but did not: a
      // teammate message quoting the whole COMMAND TRIO. The server's extraction
      // read a `<command-name>` anywhere in the turn, so it published
      // '/issue the badge never clears' for this quote and the badge of a prompt
      // still queued would have cleared. Fixed server-side (lib/user-turn.js
      // anchors the trio to the start of the turn); this pins the client half —
      // whatever the raw text quotes, `typedText: ''` is final.
      const quotedTrio = '<teammate-message teammate_id="J4b2">please look at '
          '<command-message>issue</command-message>\n'
          '<command-name>/issue</command-name>\n'
          '<command-args>the badge never clears</command-args></teammate-message>';
      expect(
        echoMatchesTurns('/issue the badge never clears', [userTurn(quotedTrio, typedText: '')]),
        isFalse,
      );
      // And with an older server that publishes no typedText at all, the raw text
      // is the key — a quote is not equal to the prompt, so it still cannot match.
      expect(echoMatchesTurns('/issue the badge never clears', [userTurn(quotedTrio)]), isFalse);
      // The discriminating one: `''` must produce NO key at all. The two
      // echoMatchesTurns calls above would read false either way (the raw XML is
      // not equal to the prompt), so this is what actually pins the contract.
      expect(turnMatchKey(userTurn(quotedTrio, typedText: '')), isNull);
      expect(turnMatchKey(userTurn('anything', typedText: '')), isNull);
    });

    test('an assistant turn is never an echo\'s counterpart', () {
      expect(
        echoMatchesTurns('run the build', [
          const TranscriptTurn(role: 'assistant', text: 'run the build', toolUses: [], ts: null),
        ]),
        isFalse,
      );
    });

    test('an OLDER server (no typedText at all) behaves exactly as before', () {
      // `null` is not `''`: the field is absent, so fall back to the raw text.
      // This is the whole backward-compatibility story — a companion released
      // ahead of the server must not regress.
      expect(echoMatchesTurns('run the build', [userTurn('run the build')]), isTrue);
      expect(echoMatchesTurns('run the build', [userTurn('run the build\n$reminder')]), isFalse);
      expect(turnMatchKey(userTurn('run the build')), 'run the build');
    });

    test('an empty echo matches nothing', () {
      expect(echoMatchesTurns('   ', [userTurn('anything', typedText: 'anything')]), isFalse);
    });
  });

  // The end-to-end half. The #31 widget test above lands a turn whose raw text IS
  // the submitted prompt, which no real prompt ever is — so it passed against the
  // bug too. This one lands the turn Claude really writes.
  testWidgets(
    '#149: the Queued badge clears when the wrapped real turn lands, leaving ONE bubble',
    (tester) async {
      final prompts = StreamController<String>.broadcast();
      addTearDown(prompts.close);
      var calls = 0;
      Future<TranscriptPage> fetch(String id, {String? before, int? limit}) async {
        calls++;
        if (calls == 1) {
          return const TranscriptPage(
            messages: [TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null)],
            cursor: null,
            hasMore: false,
          );
        }
        // Claude has consumed the queued prompt and written it to the transcript
        // — with the injected context the harness staples onto every real one.
        return const TranscriptPage(
          messages: [
            TranscriptTurn(role: 'assistant', text: 'hi', toolUses: [], ts: null),
            TranscriptTurn(
              role: 'user',
              text: 'run the build\n<system-reminder>\ninjected instructions\n</system-reminder>',
              typedText: 'run the build',
              toolUses: [],
              ts: null,
            ),
          ],
          cursor: null,
          hasMore: false,
        );
      }

      // status 'idle' keeps the working indicator's infinite animation out of
      // pumpAndSettle. It also removes the timeout as an explanation: an idle
      // session lets the 90s timer run, but the echo here is seconds old, so the
      // only thing that can clear it is the match.
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

      prompts.add('run the build');
      await tester.pumpAndSettle();
      expect(find.text('Queued'), findsOneWidget);

      await tester.pumpWidget(build(sess(2000)));
      await tester.pumpAndSettle();

      expect(find.text('Queued'), findsNothing,
          reason: 'the real turn landed, so the optimistic echo must be gone');
      expect(find.textContaining('run the build'), findsOneWidget,
          reason: 'exactly one bubble — a stuck echo beside the real turn is the '
              'duplicate #31 explicitly ruled out');
    },
  );

  // The OTHER call site. _addEcho carried its own copy of the same comparison,
  // so fixing only the reconcile would have traded a stuck badge for a duplicate
  // bubble on a fast round-trip: the turn is already on screen and the echo is
  // added on top of it.
  testWidgets(
    '#149: no echo is added for a prompt the transcript already shows, wrappers and all',
    (tester) async {
      final prompts = StreamController<String>.broadcast();
      addTearDown(prompts.close);
      Future<TranscriptPage> fetch(String id, {String? before, int? limit}) async =>
          const TranscriptPage(
            messages: [
              TranscriptTurn(
                role: 'user',
                text: 'run the build\n<system-reminder>\ninjected instructions\n</system-reminder>',
                typedText: 'run the build',
                toolUses: [],
                ts: null,
              ),
            ],
            cursor: null,
            hasMore: false,
          );

      await tester.pumpWidget(_wrap(ConversationView(
        session: _session(),
        fetchPage: fetch,
        submittedPrompts: prompts.stream,
      )));
      await tester.pumpAndSettle();

      prompts.add('run the build');
      await tester.pumpAndSettle();

      expect(find.text('Queued'), findsNothing,
          reason: 'the prompt is already in the transcript — there is nothing to queue');
      expect(find.textContaining('run the build'), findsOneWidget);
    },
  );

  // --- #163: a skill body arrives as a `role:user` turn with NO wrapper -------
  // Claude Code expands a skill into a user turn carrying the whole SKILL.md and
  // wraps it in nothing at all, so `parseCommandInvocation` returns null and this
  // file's `classifyUserTurn` matches no signature: the turn rendered
  // right-aligned, in the primary accent, labelled "You" — 142 KB of skill
  // instructions in the user's own bubble, burying whatever they actually typed.
  //
  // It is NOT fixable here, and that is the point of the fix: the only evidence
  // is the transcript record's `isMeta` flag, which this client never sees. The
  // server (lib/user-turn.js, the authority) reads it and publishes the verdict
  // as `userKind`; this copy defers to it and keeps its own signatures only as
  // the fallback for an older server. A fourth content signature here would be
  // the third copy of a rule that already exists twice.
  const kSkillBody =
      'Base directory for this skill: /skills/example-skill\n\n'
      '# Example skill\n\nSKILL_BODY_MARKER do the thing, then report.';
  // The two measured openings that a `Base directory` sniff would MISS — kept so
  // the fix can never regress into a content check.
  const kSkillBodyHeading =
      '# Frontend Design\n\nSKILL_HEADING_MARKER approach this as the design lead.';
  const kSkillBodyProse =
      'Review the current diff for correctness bugs and reuse cleanups. '
      'SKILL_PROSE_MARKER at the given effort level.';

  TranscriptPage pageOf(List<TranscriptTurn> turns) =>
      TranscriptPage(messages: turns, cursor: null, hasMore: false);

  Future<void> pumpTurns(WidgetTester tester, List<TranscriptTurn> turns) async {
    await tester.pumpWidget(
      _wrap(
        ConversationView(
          session: _session(),
          fetchPage: (id, {before, limit}) async => pageOf(turns),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Every `Align` between [of] and the root. The turn card picks
  /// `centerRight` for the human's own bubble and `centerLeft` for everything
  /// incoming, so this is the honest read of "was it rendered as mine?".
  Iterable<Alignment> alignmentsAround(WidgetTester tester, Finder of) => tester
      .widgetList<Align>(find.ancestor(of: of, matching: find.byType(Align)))
      .map((a) => a.alignment)
      .whereType<Alignment>();

  group('#163 userTurnKindFromWire', () {
    test('every kind the server publishes maps to a render treatment', () {
      expect(userTurnKindFromWire('human'), UserTurnKind.human);
      expect(userTurnKindFromWire('teammate'), UserTurnKind.teammate);
      expect(userTurnKindFromWire('system'), UserTurnKind.system);
      expect(userTurnKindFromWire('meta'), UserTurnKind.meta);
    });

    test('`command` is the human\'s OWN turn — #32\'s chip lives on that branch', () {
      // The server's classifier is strictly stronger than this one and names a
      // slash command as its own kind. Mapping it anywhere but `human` would
      // silently delete the #32 chip, which renders on the human branch.
      expect(userTurnKindFromWire('command'), UserTurnKind.human);
    });

    test('absent or unknown falls back to the local classifier', () {
      // null = an older server, or a Codex turn (its adapter publishes no
      // verdict). Both must behave exactly as this file did before.
      expect(userTurnKindFromWire(null), isNull);
      expect(userTurnKindFromWire(''), isNull);
      expect(userTurnKindFromWire('some-future-kind'), isNull);
    });
  });

  group('#163 injectedTurnLabel', () {
    test('names the turn by its own first line', () {
      expect(injectedTurnLabel(kSkillBodyHeading), '# Frontend Design');
    });

    test('skips leading blank lines', () {
      expect(injectedTurnLabel('\n\n  hello\nworld'), 'hello');
    });

    test('a 140 KB single line still yields a one-line label', () {
      final huge = 'Base directory for this skill: ${'x' * 142619}';
      final label = injectedTurnLabel(huge);
      expect(label.length, lessThan(90));
      expect(label, contains('…'));
      expect(label, isNot(contains('\n')));
    });

    test('text with nothing to quote still gets a label', () {
      expect(injectedTurnLabel('   \n\n'), isNotEmpty);
    });
  });

  testWidgets(
    '#163: an injected skill body is never "You" — collapsed, quiet, left',
    (tester) async {
      await pumpTurns(tester, const [
        TranscriptTurn(
          role: 'user',
          text: kSkillBody,
          toolUses: [],
          ts: null,
          typedText: '',
          userKind: 'meta',
        ),
      ]);

      // Not the human's bubble: not the label, not the lane.
      expect(find.text('You'), findsNothing);
      expect(find.text('Injected'), findsOneWidget);
      final aligns = alignmentsAround(tester, find.text('Injected'));
      expect(aligns, contains(Alignment.centerLeft));
      expect(aligns, isNot(contains(Alignment.centerRight)));

      // Not the primary accent either — that colour is the user's own.
      final tagStyle = tester.widget<Text>(find.text('Injected')).style;
      final scheme = AppTheme.dark.colorScheme;
      expect(tagStyle?.color, isNot(scheme.primary));
      expect(tagStyle?.color, scheme.onSurfaceVariant);

      // The body is collapsed behind the same chip #32 gives a wrapped skill.
      expect(find.textContaining('SKILL_BODY_MARKER'), findsNothing);
      expect(find.text('Base directory for this skill: /skills/example-skill'),
          findsOneWidget);

      // And it is still reachable — hidden, never lost.
      await tester.tap(find.text('Base directory for this skill: /skills/example-skill'));
      await tester.pumpAndSettle();
      expect(find.textContaining('SKILL_BODY_MARKER'), findsOneWidget);
    },
  );

  testWidgets(
    '#163: the openings a content sniff would miss are handled identically',
    (tester) async {
      // The whole argument for a structural flag over a fourth signature: these
      // two skill bodies open with ordinary markdown and ordinary prose.
      await pumpTurns(tester, const [
        TranscriptTurn(
          role: 'user',
          text: kSkillBodyHeading,
          toolUses: [],
          ts: null,
          typedText: '',
          userKind: 'meta',
        ),
        TranscriptTurn(
          role: 'user',
          text: kSkillBodyProse,
          toolUses: [],
          ts: null,
          typedText: '',
          userKind: 'meta',
        ),
      ]);

      expect(find.text('You'), findsNothing);
      expect(find.text('Injected'), findsNWidgets(2));
      expect(find.textContaining('SKILL_HEADING_MARKER'), findsNothing);
      expect(find.textContaining('SKILL_PROSE_MARKER'), findsNothing);
    },
  );

  testWidgets(
    '#163: a 140 KB body renders collapsed, at real scale',
    (tester) async {
      // The reported size. Collapsed is the whole point: the bug was this text
      // laid out verbatim inside the user's own bubble.
      final huge = '$kSkillBody\n${'lorem ipsum dolor sit amet ' * 5300}';
      expect(huge.length, greaterThan(140000));
      await pumpTurns(tester, [
        TranscriptTurn(
          role: 'user',
          text: huge,
          toolUses: const [],
          ts: null,
          typedText: '',
          userKind: 'meta',
        ),
      ]);

      expect(tester.takeException(), isNull);
      expect(find.text('You'), findsNothing);
      expect(find.text('Injected'), findsOneWidget);
      expect(find.textContaining('SKILL_BODY_MARKER'), findsNothing);
      expect(find.textContaining('lorem ipsum'), findsNothing);
    },
  );

  testWidgets(
    '#163: the user\'s real prompt is still "You" beside a skill body',
    (tester) async {
      // The guard. 2363 of the 3153 measured user turns are genuine prompts and
      // none of them may change — a fix that quietens real prompts is worse than
      // the bug. This is also the second half of the report: the sentence the
      // user typed has to stay findable next to the injection.
      await pumpTurns(tester, const [
        TranscriptTurn(
          role: 'user',
          text: 'MY_REAL_PROMPT_MARKER rewrite the deploy script',
          toolUses: [],
          ts: null,
          typedText: 'MY_REAL_PROMPT_MARKER rewrite the deploy script',
          userKind: 'human',
        ),
        TranscriptTurn(
          role: 'user',
          text: kSkillBody,
          toolUses: [],
          ts: null,
          typedText: '',
          userKind: 'meta',
        ),
      ]);

      expect(find.text('You'), findsOneWidget);
      expect(find.textContaining('MY_REAL_PROMPT_MARKER'), findsOneWidget);
      final aligns = alignmentsAround(tester, find.text('You'));
      expect(aligns, contains(Alignment.centerRight));
    },
  );

  testWidgets(
    '#163: a server that publishes nothing leaves this client unchanged',
    (tester) async {
      // An older server sends no `userKind`. The local classifier then decides,
      // exactly as before — including the pre-existing (unfixable here) reading
      // of a bare skill body as a prompt.
      await pumpTurns(tester, const [
        TranscriptTurn(role: 'user', text: 'plain prompt', toolUses: [], ts: null),
      ]);
      expect(find.text('You'), findsOneWidget);
      expect(find.textContaining('plain prompt'), findsOneWidget);
    },
  );

  group('#163 secondary: two commands fused into one turn', () {
    // 8 turns in the 803-file corpus carry TWO `<command-name>` tags. `firstMatch`
    // for both name and args chipped such a turn as the FIRST command wearing the
    // SECOND command's arguments, and hid the second command in the body.
    const fused =
        '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n'
        '<command-args></command-args>\n'
        '<command-name>/issue</command-name>\n<command-message>issue</command-message>\n'
        '<command-args>163 skill body renders as my prompt</command-args>';

    test('every invocation is recovered, each with its OWN arguments', () {
      final c = parseCommandInvocation(fused)!;
      expect(c.invocations, [
        '/clear',
        '/issue 163 skill body renders as my prompt',
      ]);
      // The first command's own contract is unchanged for existing callers.
      expect(c.name, 'clear');
      expect(c.args, isEmpty);
    });

    test('a single command is byte-for-byte what it always was', () {
      const one =
          '<command-name>/task</command-name>\n<command-message>task</command-message>\n'
          '<command-args>build the thing</command-args>\n\nBODY';
      final c = parseCommandInvocation(one)!;
      expect(c.name, 'task');
      expect(c.args, 'build the thing');
      expect(c.invocations, ['/task build the thing']);
      expect(c.label, '/task build the thing');
    });

    testWidgets('the chip names both, not one wearing the other\'s args',
        (tester) async {
      await pumpTurns(tester, const [
        TranscriptTurn(
          role: 'user',
          text: fused,
          toolUses: [],
          ts: null,
          userKind: 'command',
        ),
      ]);
      expect(find.text('You'), findsOneWidget);
      expect(
        find.textContaining('/issue 163 skill body renders as my prompt'),
        findsOneWidget,
      );
    });
  });
}
