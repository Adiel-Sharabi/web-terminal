// #283 — on an Android soft keyboard with suggestions, typing into the terminal
// lens left the cursor at the START of the word until Space was pressed.
//
// The keyboard holds the word being typed in a COMPOSING region until it commits
// it (Space, a suggestion tap). Stock xterm 4.0.0's `CustomTextEdit` sent nothing
// to the terminal while a region was open: it painted the word as an overlay at
// the cursor, which did not move, over whatever the TUI had drawn after it — so
// `/resume health` read `/resume ▮ealth…` and Claude's slash menu never narrowed.
//
// The vendored patch (third_party/xterm, `WEB-TERMINAL PATCH (#283)`) mirrors the
// IME buffer to the terminal on every update: backspace over what changed, type
// the rest. These drive the REAL `CustomTextEdit` through the test text-input
// channel — the same `updateEditingValue` calls an IME makes — and assert on the
// bytes the terminal emits toward the PTY.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

const del = '\x7f';

/// [text] with the composing region over `text.substring(from)` - by default the
/// whole of it, which is how a keyboard holds a single word.
TextEditingValue composing(String text, {int from = 0}) => TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
      composing: TextRange(start: from, end: text.length),
    );

TextEditingValue committed(String text) => TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );

void main() {
  late Terminal terminal;
  late StringBuffer out;
  late GlobalKey<TerminalViewState> viewKey;
  final focusNode = FocusNode();

  Future<void> pumpAndFocus(
    WidgetTester tester, {
    bool deleteDetection = false,
    void Function(String data)? onOutput,
  }) async {
    terminal = Terminal();
    out = StringBuffer();
    viewKey = GlobalKey<TerminalViewState>();
    terminal.onOutput = onOutput ?? out.write;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalView(
            terminal,
            key: viewKey,
            focusNode: focusNode,
            textStyle: const TerminalStyle(fontSize: 12),
            autofocus: false,
            readOnly: false,
            deleteDetection: deleteDetection,
          ),
        ),
      ),
    );
    await tester.tap(find.byType(TerminalView));
    // Past the double-tap window, so no gesture timer outlives the test.
    await tester.pump(const Duration(seconds: 1));
    expect(tester.testTextInput.hasAnyClients, isTrue,
        reason: 'a tap must open the IME connection the patch lives on');
  }

  Future<void> ime(WidgetTester tester, TextEditingValue v) async {
    tester.testTextInput.updateEditingValue(v);
    await tester.pump();
  }

  testWidgets('each keystroke of a composing word reaches the PTY at once',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('h'));
    expect(out.toString(), 'h');
    await ime(tester, composing('he'));
    await ime(tester, composing('hea'));
    expect(out.toString(), 'hea',
        reason: 'stock sent NOTHING until Space committed the word');

    await ime(tester, committed('health '));
    expect(out.toString(), 'health ',
        reason: 'the commit sends only what was not already mirrored');
  });

  testWidgets('autocorrect on commit is expressed as backspaces + retype',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('teh'));
    await ime(tester, committed('the '));
    expect(out.toString(), 'teh$del${del}he ');
  });

  testWidgets('backspacing inside the composing word deletes in the PTY',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('ab'));
    await ime(tester, composing('a'));
    await ime(tester, committed(''));
    expect(out.toString(), 'ab$del$del');
  });

  testWidgets('a suggestion tap that rewrites the word replaces it at once',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('hte'));
    await ime(tester, composing('the'));
    expect(out.toString(), 'hte$del$del${del}the',
        reason: 'no common prefix: the whole word is erased and retyped');
    await ime(tester, committed('the '));
    expect(out.toString(), 'hte$del$del${del}the ');
  });

  testWidgets('the next word does not erase the one just committed',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('health'));
    await ime(tester, committed('health '));
    await ime(tester, composing('x'));
    expect(out.toString(), 'health x');
  });

  testWidgets('a commit and a new composing word in ONE update', (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('hello'));
    await ime(tester, composing('hello wo', from: 6));
    expect(out.toString(), 'hello wo');
    await ime(tester, committed('hello world '));
    expect(out.toString(), 'hello world ');
  });

  testWidgets('finishComposing: text written around the IME is never erased',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('helo'));
    // e.g. a key-strip arrow: the app finishes the word before writing.
    viewKey.currentState!.finishComposing();
    await tester.pump();
    expect(tester.testTextInput.editingState?['text'], '',
        reason: 'the IME must start over, or it keeps rewriting "helo"');
    await ime(tester, composing('x'));
    await ime(tester, committed('x '));
    expect(out.toString(), 'helox ');
  });

  testWidgets('finishComposing from INSIDE an emission survives it',
      (tester) async {
    // A sticky Ctrl consumes the first mirrored letter from within the output
    // callback and finishes the word there. The mirror must not then record
    // that letter as sent, or the next word opens with a DEL.
    late GlobalKey<TerminalViewState> key;
    await pumpAndFocus(tester, onOutput: (data) {
      out.write(data);
      if (data == 'c') key.currentState!.finishComposing();
    });
    key = viewKey;

    await ime(tester, composing('c'));
    await ime(tester, composing('x'));
    expect(out.toString(), 'cx');
  });

  testWidgets('deleteDetection: the two-space buffer is mirrored the same way',
      (tester) async {
    await pumpAndFocus(tester, deleteDetection: true);

    await ime(tester, composing('  ab', from: 2));
    expect(out.toString(), 'ab');
    await ime(tester, committed('  '));
    expect(out.toString(), 'ab$del$del');
    // A delete past the padding with nothing composing is one plain backspace.
    await ime(tester, committed(' '));
    expect(out.toString(), 'ab$del$del$del');
  });

  testWidgets('a grapheme cluster is erased with ONE backspace',
      (tester) async {
    await pumpAndFocus(tester);

    // Hebrew letter + combining point: two code units, one visible character.
    await ime(tester, composing('\u05E9\u05C1'));
    await ime(tester, committed(''));
    expect(out.toString(), '\u05E9\u05C1$del');
  });

  testWidgets('a word left composing when the keyboard closed is not erased '
      'by the next connection', (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('ab'));
    focusNode.unfocus();
    await tester.pump();
    await tester.tap(find.byType(TerminalView));
    await tester.pump(const Duration(seconds: 1));
    await ime(tester, composing('c'));
    expect(out.toString(), 'abc');
  });

  testWidgets('a reopened connection does not swallow hardware keys',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('ab'));
    focusNode.unfocus();
    await tester.pump();
    await tester.tap(find.byType(TerminalView));
    await tester.pump(const Duration(seconds: 1));
    // Keys are skipped while a region is composing; the stale region from the
    // closed connection must not count.
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    expect(out.toString(), 'ab$del');
  });

  testWidgets('no composing overlay is painted any more', (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('hea'));
    // The overlay was the only thing that drew text the terminal buffer does not
    // hold; with the word mirrored to the PTY it must never be set.
    final view = tester.widget(find.byWidgetPredicate(
        (w) => w.runtimeType.toString() == '_TerminalView'));
    expect((view as dynamic).composingText, isNull);
  });

  // The app writes to the terminal around the keyboard in a few places. Each
  // must finish the composing word first, or the mirror's next rewrite erases
  // text the word never typed. No widget test reaches these paths cheaply, and
  // a new one added next year would leave every behavioural test green, so the
  // rule is asserted against the SOURCE.
  group('session_screen finishes the composing word before an outside write',
      () {
    final src = File('lib/screens/session_screen.dart')
        .readAsStringSync()
        .replaceAll('\r\n', '\n');

    test('the key strip', () {
      expect(
          RegExp(r'void _sendRawToTerminal\(String sequence\) \{\s*'
                  r'_finishTerminalComposing\(\);')
              .hasMatch(src),
          isTrue);
    });

    test('every paste into the terminal', () {
      final pastes = RegExp(r'_terminal\.paste\(').allMatches(src).toList();
      expect(pastes, isNotEmpty);
      for (final m in pastes) {
        final before = src.substring(0, m.start).trimRight();
        expect(before.endsWith('_finishTerminalComposing();'), isTrue,
            reason: 'paste at offset ${m.start} is not preceded by it');
      }
    });

    test('both sticky modifiers', () {
      final body = src.substring(
          src.indexOf('void _handleTerminalOutput(String data) {'));
      final end = body.indexOf('_connection?.sendInput(terminalOutputToPty');
      expect(
          '_finishTerminalComposing();'.allMatches(body.substring(0, end)),
          hasLength(2));
    });
  });
}
