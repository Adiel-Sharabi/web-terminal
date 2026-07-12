// Widget tests for ComposeBar's Enter-key behavior. The field is platform-
// branched: on mobile it is SINGLE-LINE with a native Send action, so a soft-
// keyboard Enter fires onSubmitted (submits) and never inserts a newline — the
// only combination Android honors, and it keeps every submit a plain `text\r`
// the TUI acts on (a newline would be sent as a bracketed paste whose submit-CR
// the TUI absorbs). On desktop it is multi-line: a hardware Enter submits via the
// _SendIntent shortcut and Shift/Alt+Enter inserts a newline.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

/// A valid 1×1 transparent PNG, so attachment-thumbnail tests exercise the real
/// Image.memory path (not the error fallback).
Uint8List _png1x1() => Uint8List.fromList(const [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, //
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, //
      0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 250, 207, 0, 0, //
      0, 3, 1, 1, 0, 24, 221, 141, 219, 0, 0, 0, 0, 73, 69, 78, 68, //
      174, 66, 96, 130,
    ]);

void main() {
  group('composeUsesSoftKeyboard', () {
    test('mobile platforms use a soft keyboard, desktop does not', () {
      expect(composeUsesSoftKeyboard(TargetPlatform.android), isTrue);
      expect(composeUsesSoftKeyboard(TargetPlatform.iOS), isTrue);
      expect(composeUsesSoftKeyboard(TargetPlatform.windows), isFalse);
      expect(composeUsesSoftKeyboard(TargetPlatform.macOS), isFalse);
      expect(composeUsesSoftKeyboard(TargetPlatform.linux), isFalse);
    });
  });

  testWidgets('desktop: multi-line field, newline action (Shift+Enter → newline)', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: TextEditingController(),
            focusNode: FocusNode(),
            onSend: () {},
            isLive: false,
          ),
        ),
      );
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.textInputAction, TextInputAction.newline);
      expect(field.keyboardType, TextInputType.multiline);
      expect(field.maxLines, greaterThan(1));
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('mobile: single-line field, send action so Enter submits', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: TextEditingController(),
            focusNode: FocusNode(),
            onSend: () {},
            isLive: false,
          ),
        ),
      );
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.textInputAction, TextInputAction.send);
      expect(field.keyboardType, TextInputType.text);
      expect(field.maxLines, 1);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('mobile: the soft-keyboard send action submits (once, when it can)', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      var sends = 0;
      final controller = TextEditingController(text: 'hello');
      final fn = FocusNode();
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: controller,
            focusNode: fn,
            onSend: () => sends++,
            isLive: false,
          ),
        ),
      );
      fn.requestFocus();
      await tester.pump();

      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();
      expect(sends, 1);

      // Empty field → the send action is a no-op (no stray blank submit).
      controller.clear();
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();
      expect(sends, 1);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
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

  testWidgets('while live, arrows reach the terminal even with text (slash-menu nav)',
      (tester) async {
    final seqs = <String>[];
    final controller = TextEditingController(text: '/comp');
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: fn,
          onSend: () {},
          isLive: true, // a '/' line is streaming
          onArrow: seqs.add,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();

    // Text present but live → ↑/↓ navigate Claude's menu (reach the terminal).
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(seqs, ['\x1b[B', '\x1b[A']);
  });

  testWidgets('Tab autocompletes only while live', (tester) async {
    var tabs = 0;
    final controller = TextEditingController(text: '/comp');
    final fn = FocusNode();

    Widget build(bool live) => _wrap(
          ComposeBar(
            controller: controller,
            focusNode: fn,
            onSend: () {},
            isLive: live,
            onTab: () => tabs++,
          ),
        );

    // Not live → Tab does NOT autocomplete (falls through to focus traversal).
    await tester.pumpWidget(build(false));
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(tabs, 0);

    // Live → Tab fires onTab (autocomplete the highlighted command).
    await tester.pumpWidget(build(true));
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(tabs, 1);
  });

  testWidgets('#50: Tab reaches the terminal when the terminal is active (not live)',
      (tester) async {
    var tabs = 0;
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: TextEditingController(),
          focusNode: fn,
          onSend: () {},
          isLive: false, // NOT a slash line
          terminalActive: true, // Terminal lens / question overlay up
          onTab: () => tabs++,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(tabs, 1); // Tab drives Claude's TUI, not focus traversal
  });

  testWidgets('#50: arrows reach the terminal when active even with draft text',
      (tester) async {
    final seqs = <String>[];
    final fn = FocusNode();
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: TextEditingController(text: 'draft'),
          focusNode: fn,
          onSend: () {},
          isLive: false,
          terminalActive: true,
          onArrow: seqs.add,
        ),
      ),
    );
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(seqs, ['\x1b[B']); // arrow reaches the PTY despite the caret text
  });

  testWidgets('Backspace clears the terminal line only when live AND field empty',
      (tester) async {
    var backspaces = 0;
    final controller = TextEditingController();
    final fn = FocusNode();

    Widget build(bool live) => _wrap(
          ComposeBar(
            controller: controller,
            focusNode: fn,
            onSend: () {},
            isLive: live,
            onBackspace: () => backspaces++,
          ),
        );

    // Not live, empty → default backspace, no raw send.
    await tester.pumpWidget(build(false));
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(backspaces, 0);

    // Live but field has text → the field edits normally (stream sends the DEL),
    // so the raw forwarder does NOT fire.
    controller.text = '/comp';
    await tester.pumpWidget(build(true));
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(backspaces, 0);

    // Live AND field empty → forward a raw backspace to clear a Tab-completed
    // leftover in Claude's input line.
    controller.clear();
    await tester.pumpWidget(build(true));
    fn.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(backspaces, 1);
  });

  // #29: image attachments render as removable thumbnail chips, and enable send
  // even with empty text.
  testWidgets('#29: attachment chips render a remove ✕ and enable send when text is empty', (
    tester,
  ) async {
    var sent = false;
    var removed = -1;
    final controller = TextEditingController(); // no text — attachments alone
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: controller,
          focusNode: FocusNode(),
          onSend: () => sent = true,
          isLive: false,
          attachments: [_png1x1(), _png1x1()],
          onRemoveAttachment: (i) => removed = i,
        ),
      ),
    );
    await tester.pump();

    // Two attachments → two remove ✕ affordances.
    expect(find.byIcon(Icons.close), findsNWidgets(2));

    // Send is enabled despite the empty text field (attachments count).
    final sendButton = tester.widget<IconButton>(find.byType(IconButton));
    expect(sendButton.onPressed, isNotNull);
    await tester.tap(find.byIcon(Icons.send));
    expect(sent, isTrue);

    // Tapping the first chip's ✕ reports index 0.
    await tester.tap(find.byIcon(Icons.close).first);
    expect(removed, 0);
  });

  testWidgets('#29: with no attachments and empty text, send stays disabled', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        ComposeBar(
          controller: TextEditingController(),
          focusNode: FocusNode(),
          onSend: () {},
          isLive: false,
          attachments: const [],
        ),
      ),
    );
    final sendButton = tester.widget<IconButton>(find.byType(IconButton));
    expect(sendButton.onPressed, isNull);
  });
}
