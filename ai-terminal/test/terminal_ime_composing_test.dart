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

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

const del = '\x7f';

TextEditingValue composing(String text) => TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
      composing: TextRange(start: 0, end: text.length),
    );

TextEditingValue committed(String text) => TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );

void main() {
  late Terminal terminal;
  late StringBuffer out;
  final focusNode = FocusNode();

  Future<void> pumpAndFocus(WidgetTester tester) async {
    terminal = Terminal();
    out = StringBuffer();
    terminal.onOutput = out.write;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalView(
            terminal,
            focusNode: focusNode,
            textStyle: const TerminalStyle(fontSize: 12),
            autofocus: false,
            readOnly: false,
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

  testWidgets('a suggestion tap that rewrites the word replaces it',
      (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('heal'));
    await ime(tester, composing('healthcare'));
    await ime(tester, committed('healthcare '));
    expect(out.toString(), 'healthcare ');
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

  testWidgets('no composing overlay is painted any more', (tester) async {
    await pumpAndFocus(tester);

    await ime(tester, composing('hea'));
    // The overlay was the only thing that drew text the terminal buffer does not
    // hold; with the word mirrored to the PTY it must never be set.
    final view = tester.widget(find.byWidgetPredicate(
        (w) => w.runtimeType.toString() == '_TerminalView'));
    expect((view as dynamic).composingText, isNull);
  });
}
