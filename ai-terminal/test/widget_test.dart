// Basic smoke test for the app's theme. The old counter-app test dated back
// to the project scaffold and no longer matched anything in this app (it
// referenced a `MyApp` that hasn't existed since the Phase 1 push/TTS spike).
// A full `AiTerminalApp` widget test needs Firebase + the service layer
// wired up in a test harness, which is out of scope here — this instead
// verifies the one thing purely in this coder's ownership: the palette.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/theme/app_theme.dart';

void main() {
  test('AppTheme.dark pins the spec palette (§0.1)', () {
    final theme = AppTheme.dark;
    expect(theme.brightness, Brightness.dark);
    expect(theme.scaffoldBackgroundColor, AppColors.background);
    expect(theme.colorScheme.surface, AppColors.surface);
    expect(theme.colorScheme.primary, AppColors.primary);
    expect(theme.colorScheme.error, AppColors.error);
    expect(theme.colorScheme.surfaceTint, Colors.transparent);
  });
}
