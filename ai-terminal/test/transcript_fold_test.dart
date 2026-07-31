// #88 — the chat lens folds the agent's mechanical work so the conversation
// stands out, without dropping anything.
//
// The classification rides the TYPED TURN SHAPE, never the text: `lib/transcript.js`
// and `lib/transcript-codex.js` emit the same turn type, so one rule covers Claude
// and Codex with no provider branch — and a reply that merely *discusses* a tool
// call is prose, which string-sniffing would have folded away.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/conversation_view.dart';

TranscriptTurn _turn({
  String role = 'assistant',
  String text = '',
  List<ToolUse> tools = const <ToolUse>[],
}) =>
    TranscriptTurn(role: role, text: text, toolUses: tools, ts: null);

ToolUse _tool(String name, {String id = ''}) => ToolUse(
      name: name,
      inputPreview: '',
      id: id.isEmpty ? 'tu-$name' : id,
    );

void main() {
  group('isMechanicalTurn', () {
    test('a tool-only assistant turn is mechanical', () {
      expect(isMechanicalTurn(_turn(tools: [_tool('Read')])), isTrue);
    });

    test('an assistant turn with prose is NOT — it said something', () {
      expect(
        isMechanicalTurn(_turn(text: 'Here is what I found.', tools: [_tool('Read')])),
        isFalse,
      );
    });

    test('a user turn is never mechanical', () {
      expect(isMechanicalTurn(_turn(role: 'user', text: 'do the thing')), isFalse);
    });

    test('an empty assistant turn with no tools is not mechanical', () {
      expect(isMechanicalTurn(_turn()), isFalse);
    });

    test('whitespace-only text still counts as no prose', () {
      expect(isMechanicalTurn(_turn(text: '  \n ', tools: [_tool('Bash')])), isTrue);
    });
  });

  group('groupTranscriptTurns', () {
    test('folds a consecutive run into ONE chunk and keeps every turn', () {
      final turns = [
        _turn(role: 'user', text: 'go'),
        _turn(tools: [_tool('Read')]),
        _turn(tools: [_tool('Edit')]),
        _turn(tools: [_tool('Bash')]),
        _turn(text: 'Done.'),
      ];
      final chunks = groupTranscriptTurns(turns);
      expect(chunks.length, 3);
      expect(chunks[0].mechanical, isFalse);
      expect(chunks[1].mechanical, isTrue);
      expect(chunks[1].turns, hasLength(3));
      expect(chunks[2].mechanical, isFalse);
      // Nothing is dropped: every input turn is still represented.
      expect(
        chunks.fold<int>(0, (n, c) => n + c.turns.length),
        turns.length,
      );
    });

    test('two runs split by prose stay separate', () {
      final chunks = groupTranscriptTurns([
        _turn(tools: [_tool('Read')]),
        _turn(text: 'Thinking out loud.'),
        _turn(tools: [_tool('Bash')]),
      ]);
      expect(chunks.map((c) => c.mechanical).toList(), [true, false, true]);
    });

    test('names the distinct tools in first-use order, deduped', () {
      final chunks = groupTranscriptTurns([
        _turn(tools: [_tool('Read', id: 'a'), _tool('Read', id: 'b')]),
        _turn(tools: [_tool('Bash', id: 'c')]),
      ]);
      expect(chunks.single.toolNames, ['Read', 'Bash']);
    });

    test('foldKey comes from the FIRST turn, so a growing run keeps it', () {
      final first = _turn(tools: [_tool('Read', id: 'first')]);
      final short = groupTranscriptTurns([first]).single;
      final grown = groupTranscriptTurns([
        first,
        _turn(tools: [_tool('Edit', id: 'later')]),
      ]).single;
      // A key covering the whole run would change on every poll and slam an
      // expanded fold shut while the user was reading it.
      expect(grown.foldKey, short.foldKey);
    });

    test('an empty transcript yields no chunks', () {
      expect(groupTranscriptTurns(const []), isEmpty);
    });
  });

  group('chat lens rendering', () {
    Widget host(List<TranscriptTurn> turns) => MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: ConversationView(
              session: Session(
                id: 's1',
                name: 'proj',
                cwd: r'C:\dev',
                status: 'idle',
                claudeSessionId: null,
                lastActivity: null,
                notifyLevel: 'important',
                server: const ServerConfig(
                  name: 'Home',
                  baseUrl: 'http://x',
                  bearerToken: 't',
                ),
                agent: 'claude',
              ),
              fetchPage: (String id, {String? before, int? limit}) async =>
                  TranscriptPage(messages: turns, cursor: null, hasMore: false),
            ),
          ),
        );

    testWidgets('mechanical work is folded away by default', (tester) async {
      await tester.pumpWidget(host([
        _turn(role: 'user', text: 'please investigate'),
        _turn(tools: [_tool('Read')]),
        _turn(tools: [_tool('Bash')]),
        _turn(text: 'I found the cause.'),
      ]));
      await tester.pumpAndSettle();

      // The conversation itself is visible...
      expect(find.text('please investigate'), findsOneWidget);
      expect(find.text('I found the cause.'), findsOneWidget);
      // ...and the two tool turns are behind one marker naming what was done.
      expect(find.text('2 steps'), findsOneWidget);
      expect(find.text('Read · Bash'), findsOneWidget);
    });

    testWidgets('tapping the marker reveals the folded turns', (tester) async {
      // The ROLE TAG is the discriminator. The tool name cannot be: the
      // collapsed marker deliberately names the tools, so 'Read' is on screen
      // either way. The marker renders no role tag at all — that is the whole
      // point of it not looking like a turn — so 'Assistant' appears only once
      // a real bubble is mounted. Only the mechanical turn is in this
      // transcript, so nothing else can supply one.
      await tester.pumpWidget(host([
        _turn(tools: [_tool('Read')]),
      ]));
      await tester.pumpAndSettle();

      expect(find.text('1 step'), findsOneWidget);
      expect(find.text('Assistant'), findsNothing);

      await tester.tap(find.text('1 step'));
      await tester.pumpAndSettle();
      // The real turn bubble is now mounted — nothing was lost, only folded.
      expect(find.text('Assistant'), findsOneWidget);

      await tester.tap(find.text('1 step'));
      await tester.pumpAndSettle();
      expect(find.text('Assistant'), findsNothing);
    });
  });
}
