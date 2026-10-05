// #286 — rotating a tablet reloaded the session list from scratch.
//
// A tablet's landscape width is above [AdaptiveHome.splitBreakpoint] and its
// portrait width is below it, so EVERY rotation crosses the breakpoint. Wide
// mounts the [DashboardScreen] inside the split's rail (`Row > SizedBox`),
// narrow mounts it as the whole body - two different tree positions, so the
// crossing disposed the dashboard's State and built a fresh one. The fresh one
// lost the server filter, the scroll position and the loaded collapse state,
// and its `StreamBuilder` listens to a broadcast stream with no replay: it sat
// on the loading spinner until the repository happened to emit again (the 30s
// poll), which is the "empties out and loads again" the report describes.
//
// This pumps the REAL [AdaptiveHome] -> [DashboardScreen] against the
// repository's own instant-paint cache (no network, no fake client) and
// rotates the view across the breakpoint and back, then without crossing it.
//
// **ONE TEST PER FILE**, for the reason `dashboard_favorites_handle_test.dart`
// gives: [SessionRepository] and [ServerStore] are singletons whose init futures
// are bound to the FakeAsync zone of the first test that touches them, so a
// second test here would hang rather than fail. Each rotation is a phase of the
// one test instead.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/adaptive_home.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

const _home = ServerConfig(
  name: 'Home',
  baseUrl: 'http://home.example:7681',
  bearerToken: 't',
);
const _office = ServerConfig(
  name: 'Office',
  baseUrl: 'http://office.example:7681',
  bearerToken: 't',
);

Session _session(String id, ServerConfig server) => Session(
  id: id,
  name: id,
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 1000,
  notifyLevel: 'important',
  server: server,
  autoCommand: '',
);

// Logical sizes (devicePixelRatio 1.0). A tablet: landscape is split, portrait
// is single-pane. A desktop window and a phone: rotation stays on one side.
const _tabletLandscape = Size(1280, 800);
const _tabletPortrait = Size(800, 1280);
const _wideLandscape = Size(1400, 1000);
const _widePortrait = Size(1000, 1400);
const _phonePortrait = Size(400, 800);
const _phoneLandscape = Size(800, 400);

void main() {
  testWidgets('a rotation keeps the dashboard State, its server filter and its '
      'rows - with or without crossing the split breakpoint', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        for (final s in [_home, _office])
          {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _session('home-one', _home),
        _session('office-one', _office),
      ]),
    });
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = _tabletLandscape;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await ServerStore.instance.init();
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.dark, home: const AdaptiveHome()),
    );
    await tester.pump();
    // The stream is a broadcast with no replay, so the dashboard has to already
    // be listening - hence prime AFTER the first pump.
    await SessionRepository.instance.primeFromCache();
    await tester.pump();

    expect(find.text('Pick a session'), findsOneWidget,
        reason: 'the tablet starts in the split view');
    expect(find.text('office-one'), findsOneWidget,
        reason: 'the primed cache must actually reach the list');

    // Narrow the list to one server, the way a user would.
    await tester.tap(find.widgetWithText(ChoiceChip, 'Office'));
    await tester.pump();
    expect(find.text('home-one'), findsNothing);

    final original = tester.state(find.byType(DashboardScreen));

    Future<void> rotateTo(Size size, {required bool wide}) async {
      tester.view.physicalSize = size;
      await tester.pump();
      expect(find.text('Pick a session'), wide ? findsOneWidget : findsNothing,
          reason: 'the layout must actually be the one this phase is about');
      expect(
        identical(tester.state(find.byType(DashboardScreen)), original),
        isTrue,
        reason: 'rotating to $size must keep the SAME dashboard State - a new '
            'one is a list rebuilt from scratch (#286)',
      );
      expect(find.byType(CircularProgressIndicator), findsNothing,
          reason: 'the list must not empty out into a loading spinner');
      expect(find.text('office-one'), findsOneWidget);
      expect(
        tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Office'))
            .selected,
        isTrue,
        reason: 'the selected server chip must survive the rotation',
      );
      expect(find.text('home-one'), findsNothing,
          reason: 'the filter it selects must still be applied');
    }

    // Across the breakpoint: split -> single pane -> split.
    await rotateTo(_tabletPortrait, wide: false);
    await rotateTo(_tabletLandscape, wide: true);

    // Without crossing it: both orientations split, then both single-pane.
    await rotateTo(_widePortrait, wide: true);
    await rotateTo(_wideLandscape, wide: true);
    await rotateTo(_phonePortrait, wide: false);
    await rotateTo(_phoneLandscape, wide: false);
  });
}
