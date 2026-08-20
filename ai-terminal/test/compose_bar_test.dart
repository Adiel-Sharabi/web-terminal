// Widget tests for ComposeBar's Enter-key behavior. The field grows 1→5 lines so
// a long prompt wraps and the box gets taller. DESKTOP: the Enter shortcut
// submits (Ctrl+Enter inserts a newline), so a typed prompt goes out as `text\r`.
// MOBILE: the soft-keyboard Enter inserts a newline and the Send BUTTON submits (a
// multi-line field can't rely on the keyboard's send action there).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

Widget _wrap(Widget child) => MaterialApp(
  theme: AppTheme.dark,
  home: Scaffold(body: child),
);

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

  testWidgets('field grows to wrap long text (multi-line, newline action)', (
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
      // Grows so a long line soft-wraps + the box gets taller (not endless).
      expect(field.minLines, 1);
      expect(field.maxLines, 5);
      expect(field.keyboardType, TextInputType.multiline);
      // `newline` action → mobile's soft-keyboard Enter inserts a newline; on
      // desktop the Enter SHORTCUT submits before the field can newline.
      expect(field.textInputAction, TextInputAction.newline);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets(
    'mobile: hardware Enter does NOT submit (newline); Send button does',
    (tester) async {
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

        // No Enter shortcut on mobile → Enter is a newline, not a submit.
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(sends, 0);

        // The Send button submits.
        await tester.tap(find.byIcon(Icons.send));
        await tester.pump();
        expect(sends, 1);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('desktop: Ctrl+Enter inserts a newline and does NOT submit', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
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
      controller.selection = TextSelection.collapsed(
        offset: controller.text.length,
      );
      await tester.pump();

      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(sends, 0, reason: 'Ctrl+Enter must not submit');
      expect(
        controller.text,
        'hello\n',
        reason: 'Ctrl+Enter inserts a newline',
      );
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

  testWidgets('desktop: bare hardware Enter submits, no newline inserted', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
      var sent = 0;
      final controller = TextEditingController(text: 'hello');
      final fn = FocusNode();
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: controller,
            focusNode: fn,
            onSend: () => sent++,
            isLive: false,
          ),
        ),
      );
      fn.requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(sent, 1, reason: 'bare Enter should submit on desktop');
      expect(
        controller.text,
        'hello',
        reason: 'Enter must not insert a newline',
      );
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets(
    'desktop: hardware Enter (no modifier) sends when text is present',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
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
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );

  testWidgets('desktop: Alt+Enter does NOT send (falls through to a newline)', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
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
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('desktop: hardware Enter does not send when empty and not live', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
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
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
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

  testWidgets(
    'arrow goes to the terminal only when the compose field is empty',
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
    },
  );

  testWidgets(
    'while live, arrows reach the terminal even with text (slash-menu nav)',
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
    },
  );

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

  testWidgets(
    '#50: Tab reaches the terminal when the terminal is active (not live)',
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
    },
  );

  testWidgets(
    '#51: ComposeBar does not consume Alt+V (the global handler owns image paste)',
    (tester) async {
      // The app pastes images via a single HardwareKeyboard handler that fires
      // regardless of focus. If ComposeBar ALSO bound Alt+V, one paste added two
      // chips (#51). Prove ComposeBar leaves Alt+V alone: it must propagate to an
      // ancestor key handler rather than being swallowed by the compose field.
      var altVReachedAncestor = 0;
      final fn = FocusNode();
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Focus(
              onKeyEvent: (node, event) {
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.keyV &&
                    HardwareKeyboard.instance.isAltPressed) {
                  altVReachedAncestor++;
                  return KeyEventResult.handled;
                }
                return KeyEventResult.ignored;
              },
              child: ComposeBar(
                controller: TextEditingController(),
                focusNode: fn,
                onSend: () {},
                isLive: false,
              ),
            ),
          ),
        ),
      );
      fn.requestFocus();
      await tester.pump();

      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
      await tester.pump();

      expect(altVReachedAncestor, 1);
    },
  );

  testWidgets(
    '#50: arrows reach the terminal when active even with draft text',
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
    },
  );

  testWidgets(
    'Backspace clears the terminal line only when live AND field empty',
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
    },
  );

  // #29: image attachments render as removable thumbnail chips, and enable send
  // even with empty text.
  testWidgets(
    '#29: attachment chips render a remove ✕ and enable send when text is empty',
    (tester) async {
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
            attachments: [
              ComposeAttachment(name: '', bytes: _png1x1()),
              ComposeAttachment(name: '', bytes: _png1x1()),
            ],
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
    },
  );

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

  // #147 — the agent is not up yet, so a submit would go to the SHELL.
  //
  // Reported 2026-08-20 on all three companion platforms at once: opening a new
  // session drops you into the chat lens while `claude` is still booting, so a
  // prompt typed and sent immediately is handed to bash and lost with no error
  // anywhere. Measured on the rig (claude 2.1.237): submitted before the
  // composer marker, NO turn started and bash answered "command not found".
  //
  // The gate is SUBMIT only. Typing is untouched, and the text stays in the box
  // to be sent by the user once the bar lights up — deliberately NOT
  // auto-submitted on ready, because firing a prompt somebody was still editing
  // is its own way to lose their words.
  group('#147 agentReady gates SUBMIT, never typing', () {
    testWidgets('desktop Enter does NOT submit while the agent is starting', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        var sent = 0;
        final controller = TextEditingController(text: 'fix the flaky test');
        final fn = FocusNode();
        await tester.pumpWidget(
          _wrap(
            ComposeBar(
              controller: controller,
              focusNode: fn,
              onSend: () => sent++,
              isLive: false,
              agentReady: false,
            ),
          ),
        );
        fn.requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();

        expect(sent, 0, reason: 'a submit now would be eaten by the shell');
        expect(
          controller.text,
          'fix the flaky test',
          reason: 'the words must survive — losing them IS the bug',
        );
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('the Send button is disabled while starting, enabled once ready', (
      tester,
    ) async {
      final controller = TextEditingController(text: 'hello');
      Widget bar(bool ready) => _wrap(
        ComposeBar(
          controller: controller,
          focusNode: FocusNode(),
          onSend: () {},
          isLive: false,
          agentReady: ready,
        ),
      );

      await tester.pumpWidget(bar(false));
      expect(
        tester.widget<IconButton>(find.byType(IconButton)).onPressed,
        isNull,
      );
      // A spinner, not a dead arrow: "wait" must not read as "broken".
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpWidget(bar(true));
      await tester.pump();
      expect(
        tester.widget<IconButton>(find.byType(IconButton)).onPressed,
        isNotNull,
      );
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('the bar SAYS why it will not send yet', (tester) async {
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: TextEditingController(),
            focusNode: FocusNode(),
            onSend: () {},
            isLive: false,
            agentReady: false,
          ),
        ),
      );
      // Saying nothing was the bug: the bar looked ordinary, so the prompt went
      // to the shell behind the not-yet-started TUI and vanished.
      expect(find.textContaining('Starting the agent'), findsOneWidget);
    });

    testWidgets('typing is never blocked while starting', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(
        _wrap(
          ComposeBar(
            controller: controller,
            focusNode: FocusNode(),
            onSend: () {},
            isLive: false,
            agentReady: false,
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'typed while booting');
      await tester.pump();
      expect(controller.text, 'typed while booting');
    });

    testWidgets('agentReady defaults to TRUE — the gate fails OPEN', (
      tester,
    ) async {
      // An older server sends no such field. Reading that as "starting" would
      // refuse submit on every session it owns — worse than the bug it guards.
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        var sent = 0;
        final fn = FocusNode();
        await tester.pumpWidget(
          _wrap(
            ComposeBar(
              controller: TextEditingController(text: 'hi'),
              focusNode: fn,
              onSend: () => sent++,
              isLive: false,
            ),
          ),
        );
        fn.requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(sent, 1);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}
