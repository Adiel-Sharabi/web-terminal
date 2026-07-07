// Widget tests for TerminalKeyStrip's dedicated Enter key (owner: "add
// 'enter' key ... send to actual send to the session") — it must emit a raw
// '\r' via onKey, the same path every other raw-sequence key uses, so it
// reaches the PTY directly (bypassing compose).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/terminal_key_strip.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('Enter key sends a raw CR via onKey', (tester) async {
    String? sent;
    await tester.pumpWidget(
      _wrap(
        TerminalKeyStrip(
          onKey: (seq) => sent = seq,
          ctrlActive: false,
          onToggleCtrl: () {},
          altActive: false,
          onToggleAlt: () {},
          onPaste: () {},
          onImage: () {},
          rawMode: false,
          onToggleRawMode: () {},
        ),
      ),
    );

    expect(find.byIcon(Icons.keyboard_return), findsOneWidget);
    await tester.tap(find.byIcon(Icons.keyboard_return));
    expect(sent, '\r');
  });

  testWidgets('Enter key has a discoverable tooltip', (tester) async {
    await tester.pumpWidget(
      _wrap(
        TerminalKeyStrip(
          onKey: (_) {},
          ctrlActive: false,
          onToggleCtrl: () {},
          altActive: false,
          onToggleAlt: () {},
          onPaste: () {},
          onImage: () {},
          rawMode: false,
          onToggleRawMode: () {},
        ),
      ),
    );

    expect(find.byTooltip('Enter'), findsOneWidget);
  });

  // #30/#11: the raw-keyboard toggle is shown by default (mobile) but hidden
  // when showRawToggle is false (desktop), where it stranded the user.
  testWidgets('raw-keyboard toggle shows by default, hides when suppressed',
      (tester) async {
    Widget strip({required bool showRawToggle}) => TerminalKeyStrip(
          onKey: (_) {},
          ctrlActive: false,
          onToggleCtrl: () {},
          altActive: false,
          onToggleAlt: () {},
          onPaste: () {},
          onImage: () {},
          rawMode: false,
          onToggleRawMode: () {},
          showRawToggle: showRawToggle,
        );

    await tester.pumpWidget(_wrap(strip(showRawToggle: true)));
    expect(find.byTooltip('Raw keyboard mode'), findsOneWidget);

    await tester.pumpWidget(_wrap(strip(showRawToggle: false)));
    expect(find.byTooltip('Raw keyboard mode'), findsNothing);
    // The other keys remain (only the raw toggle is gated).
    expect(find.byTooltip('Enter'), findsOneWidget);
  });
}
