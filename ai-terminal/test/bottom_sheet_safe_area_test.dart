// #285 - a bottom sheet's buttons must never be drawn under the system nav bar
// or the tablet taskbar.
//
// Flutter's modal sheet runs to the bottom edge of the screen and leaves the
// bottom system inset for the sheet's CONTENT to honour, so a sheet body that
// forgot it put Cancel/Create behind the taskbar. `showAppBottomSheet` is the
// one owner of that rule; these tests pin both the behaviour and the rule that
// every sheet goes through it.
//
// A widget test cannot see the real Android insets, so the inset is faked on
// the test view. What it CAN prove is that, given an inset, the content stays
// above it - and that the keyboard and the nav inset are not added together.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/new_session_sheet.dart';

const double _screenW = 800;
const double _screenH = 1280;
const double _taskbar = 48; // a persistent Android tablet taskbar, in dp

const _server = ServerConfig(name: 'Solo', baseUrl: 'http://x', bearerToken: 't');

/// Sizes the test view like a tablet in portrait with [bottomInset] of system
/// bar at the bottom. [keyboard] models a soft keyboard the way the engine
/// reports one: it is a view INSET, and the part of the nav-bar padding it
/// covers is no longer padding.
void _setView(WidgetTester tester, {double keyboard = 0}) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(_screenW, _screenH);
  tester.view.viewPadding = const FakeViewPadding(bottom: _taskbar);
  tester.view.padding = FakeViewPadding(
    bottom: keyboard >= _taskbar ? 0 : _taskbar - keyboard,
  );
  tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
  addTearDown(tester.view.reset);
}

Future<void> _openNewSessionSheet(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showNewSessionSheet(
              context,
              servers: const [_server],
              initialServer: _server,
              onCreated: (_) {},
              clientBuilder: (server) => ApiClient(
                server,
                httpClient: MockClient((req) async => http.Response('{}', 200)),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Rect _buttonRect(WidgetTester tester, String label) => tester.getRect(
  find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton)),
);

void main() {
  group('#285 New-session sheet sits above the system bar', () {
    testWidgets('Create and Cancel end above a bottom taskbar', (tester) async {
      _setView(tester);
      await _openNewSessionSheet(tester);

      for (final label in ['Create', 'Cancel']) {
        final rect = _buttonRect(tester, label);
        expect(
          rect.bottom,
          lessThanOrEqualTo(_screenH - _taskbar),
          reason: '$label is drawn under the taskbar (bottom ${rect.bottom})',
        );
      }
    });

    testWidgets('the sheet surface still reaches the screen edge', (
      tester,
    ) async {
      _setView(tester);
      await _openNewSessionSheet(tester);

      // Only the content is lifted; the sheet's own Material runs behind the
      // bar, so no strip of the page shows through underneath it.
      final sheet = tester.getRect(find.byType(BottomSheet));
      expect(sheet.bottom, _screenH);
    });

    testWidgets('with the keyboard up, the nav inset is NOT added on top', (
      tester,
    ) async {
      const keyboard = 300.0;
      _setView(tester, keyboard: keyboard);
      await _openNewSessionSheet(tester);

      final rect = _buttonRect(tester, 'Create');
      final keyboardTop = _screenH - keyboard;
      expect(rect.bottom, lessThanOrEqualTo(keyboardTop));
      // The sheet's own 16dp spacing above the keyboard - not 16 + 48.
      expect(keyboardTop - rect.bottom, lessThan(_taskbar));
    });
  });

  group('#285 every sheet goes through showAppBottomSheet', () {
    test('no showModalBottomSheet call outside the owner', () {
      const owner = 'lib/widgets/app_bottom_sheet.dart';
      final call = RegExp(r'showModalBottomSheet\s*[<(]');
      final offenders = <String>[];
      final files = Directory('lib')
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'));
      var ownerSeen = false;
      for (final f in files) {
        final path = f.path.replaceAll('\\', '/');
        final hits = call.allMatches(f.readAsStringSync()).length;
        if (path == owner) {
          ownerSeen = hits > 0;
        } else if (hits > 0) {
          offenders.add(path);
        }
      }
      // Positive control: the scan must actually see the one real call, or
      // an empty result proves nothing.
      expect(ownerSeen, isTrue, reason: 'scan did not find the owner call');
      expect(
        offenders,
        isEmpty,
        reason:
            'Open sheets with showAppBottomSheet (#285); a direct '
            'showModalBottomSheet can draw its buttons under the nav bar.',
      );
    });
  });
}
