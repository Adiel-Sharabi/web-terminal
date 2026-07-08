// Tests for the header app-version label (issue #40 — "show the companion
// app's own version in the header so the running build is identifiable").
//
// Two layers, tested separately:
//   1. AppVersionLabel — pure presentation. Given a version + build number it
//      renders `v{version}+{buildNumber}` in the muted header style. No async,
//      no platform channel, so the assertion is fully deterministic.
//   2. AppVersionBadge — the loader. It reads the RUNNING build's version from
//      PackageInfo at runtime (SSOT: pubspec.yaml, never hardcoded) and hands it
//      to AppVersionLabel. Driven here via PackageInfo.setMockInitialValues so
//      the wiring is verified without the real platform channel.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/app_version_label.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  group('AppVersionLabel (pure)', () {
    testWidgets('renders v{version}+{buildNumber}', (tester) async {
      await tester.pumpWidget(
        _wrap(const AppVersionLabel(version: '1.6.0', buildNumber: '18')),
      );

      expect(find.text('v1.6.0+18'), findsOneWidget);
    });

    testWidgets('uses the muted onSurfaceVariant header color', (tester) async {
      await tester.pumpWidget(
        _wrap(const AppVersionLabel(version: '1.6.0', buildNumber: '18')),
      );

      final text = tester.widget<Text>(find.text('v1.6.0+18'));
      expect(text.style?.color, AppTheme.dark.colorScheme.onSurfaceVariant);
    });
  });

  group('AppVersionBadge (loader wiring)', () {
    testWidgets('shows nothing until PackageInfo has loaded', (tester) async {
      PackageInfo.setMockInitialValues(
        appName: 'ai_terminal',
        packageName: 'net.hilash.ai_terminal',
        version: '1.6.0',
        buildNumber: '18',
        buildSignature: '',
      );

      await tester.pumpWidget(_wrap(const AppVersionBadge()));
      // First synchronous build: the future hasn't resolved yet.
      expect(find.byType(AppVersionLabel), findsNothing);

      await tester.pumpAndSettle();
      expect(find.text('v1.6.0+18'), findsOneWidget);
    });

    testWidgets('renders the running build version from PackageInfo', (
      tester,
    ) async {
      PackageInfo.setMockInitialValues(
        appName: 'ai_terminal',
        packageName: 'net.hilash.ai_terminal',
        version: '2.0.1',
        buildNumber: '42',
        buildSignature: '',
      );

      await tester.pumpWidget(_wrap(const AppVersionBadge()));
      await tester.pumpAndSettle();

      expect(find.text('v2.0.1+42'), findsOneWidget);
    });
  });
}
