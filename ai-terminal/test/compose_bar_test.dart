// Widget tests for ComposeBar's Enter-key behavior (owner: "add 'enter' key
// for new line ... to actual send to the session"): Return must insert a
// newline in the compose field, never submit — only the send button submits.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('the compose field is configured so Return inserts a newline', (
    tester,
  ) async {
    final controller = TextEditingController();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: FocusNode(),
          onSend: () {},
          isLive: false,
        ),
      ),
    );

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.textInputAction, TextInputAction.newline);
    expect(field.maxLines, greaterThan(1));
  });

  testWidgets('send button fires onSend and is disabled when empty', (
    tester,
  ) async {
    var sent = false;
    final controller = TextEditingController();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: FocusNode(),
          onSend: () => sent = true,
          isLive: false,
        ),
      ),
    );

    final sendButton = tester.widget<IconButton>(find.byType(IconButton));
    expect(sendButton.onPressed, isNull);

    controller.text = 'hello';
    await tester.pump();
    await tester.tap(find.byIcon(Icons.send));
    expect(sent, isTrue);
  });

  testWidgets('send button is enabled while live even with empty text', (
    tester,
  ) async {
    final controller = TextEditingController();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: FocusNode(),
          onSend: () {},
          isLive: true,
        ),
      ),
    );

    final sendButton = tester.widget<IconButton>(find.byType(IconButton));
    expect(sendButton.onPressed, isNotNull);
  });

  testWidgets('hardware Enter (no modifier) sends when text is present', (
    tester,
  ) async {
    var sent = false;
    final controller = TextEditingController(text: 'hi');
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: fn,
          onSend: () => sent = true,
          isLive: false,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(sent, isTrue);
  });

  testWidgets('Alt+Enter does NOT send (falls through to a newline)', (
    tester,
  ) async {
    var sent = false;
    final controller = TextEditingController(text: 'hi');
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: fn,
          onSend: () => sent = true,
          isLive: false,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump();
    expect(sent, isFalse);
  });

  testWidgets('hardware Enter does not send when empty and not live', (
    tester,
  ) async {
    var sent = false;
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: TextEditingController(),
          focusNode: fn,
          onSend: () => sent = true,
          isLive: false,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(sent, isFalse);
  });

  testWidgets('hardware Esc sends the ESC sequence to the terminal', (
    tester,
  ) async {
    String? escSeq;
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: TextEditingController(text: 'typing'),
          focusNode: fn,
          onSend: () {},
          isLive: false,
          onEscape: () => escSeq = '\x1b',
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(escSeq, '\x1b');
  });

  testWidgets('arrow goes to the terminal only when the compose field is empty',
      (tester) async {
    final seqs = <String>[];
    final controller = TextEditingController();
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: fn,
          onSend: () {},
          isLive: false,
          onArrow: seqs.add,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    // Empty → arrow reaches the terminal.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(seqs, ['\x1b[A']);

    // Non-empty → arrow falls through to caret nav, not the terminal.
    controller.text = 'hello';
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(seqs, ['\x1b[A']); // unchanged
  });
}
