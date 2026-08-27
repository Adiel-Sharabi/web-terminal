// #169, finding 3 — the wiring test the first cut did not have.
//
// `favorites_group_test.dart` drives the group, `session_card_test.dart` drives
// the card, and between them they left the JOIN untested: the dashboard's own
// `FavoritesGroup(cardBuilder: (context, s, reorderIndex) => …)`. Setting that
// one argument back to `null` left every other test in the suite green while a
// phone showed no handle and no reorder at all — which is exactly how #124
// shipped dark, and the reason that failure repeated here.
//
// So this pumps the REAL [DashboardScreen] and asserts against the REAL pinned
// row. The session list is primed from the repository's own instant-paint cache
// (`SessionRepository.primeFromCache`), so there is no network, no fake client,
// and no reimplementation of anything under test.
//
// **ONE TEST PER FILE, and it is enforced below — see [_refuseASecondTest].**
// [SessionRepository] and [ServerStore] are singletons, and their init futures
// are created inside the FakeAsync zone of whichever test touches them first.
// Awaiting such a future from a SECOND `testWidgets` hangs outright — its
// completion callback is scheduled on a zone that no longer runs — so a second
// test here would not fail, it would sit until the runner gave up. That is the
// worst failure shape there is: a ten-minute timeout with no message, nothing
// named, and no hint that the test itself is fine and the FILE is the problem.
// A comment does not stop it, so `setUp` does. Give the next test its own file.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/theme/app_theme.dart';

const _server = ServerConfig(
  name: 'Home',
  baseUrl: 'http://home.example:7681',
  bearerToken: 't',
);

Session _fav(String id, int rank) => Session(
  id: id,
  name: id,
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 1000 - rank,
  notifyLevel: 'important',
  server: _server,
  autoCommand: '',
  favorite: true,
  favoriteRank: rank,
);

/// The pinned row's own handle — scoped by the favorites group's per-row key so
/// it can never be satisfied by the main per-server list's handle further down.
Finder _pinnedHandle(String id) => find.descendant(
  of: find.byKey(ValueKey('fav-reorder-$id')),
  matching: find.byIcon(Icons.drag_handle),
);

/// Runs a modal sheet's route animation to completion. `pump`, never
/// `pumpAndSettle`: the dashboard always has a frame scheduled (the same reason
/// `adaptive_home_test.dart` gives), and `pumpAndSettle` there does not fail —
/// it sits for its ten-minute default.
Future<void> _settleSheet(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// Fails the SECOND test in this file immediately, with the reason, instead of
/// letting it hang to the runner's timeout (see the header). Deliberately a
/// `setUp` rather than a lint or a comment: it runs before the offending test's
/// body, so the singleton futures it would await are never reached.
void _refuseASecondTest() {
  var started = 0;
  setUp(() {
    if (++started > 1) {
      fail(
        'dashboard_favorites_handle_test.dart must hold exactly ONE test: '
        'SessionRepository/ServerStore are singletons whose init futures are '
        'bound to the FakeAsync zone of the first test, so a second one here '
        'HANGS to the runner timeout rather than failing. Put the new test in '
        'its own file.',
      );
    }
  });
}

void main() {
  _refuseASecondTest();

  testWidgets('touch: the dashboard gives a pinned row the app drag handle, '
      'and holding it opens no actions sheet', (tester) async {
    SharedPreferences.setMockInitialValues({
      ServerStore.storageKey: jsonEncode([
        {
          'name': _server.name,
          'baseUrl': _server.baseUrl,
          'bearerToken': _server.bearerToken,
        },
      ]),
      'wt.lastSessions': SessionRepository.encodeSessionCache([
        _fav('alpha', 0),
        _fav('bravo', 1),
      ]),
    });
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    try {
      await ServerStore.instance.init();
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.dark, home: const DashboardScreen()),
      );
      await tester.pump();
      // The stream is a broadcast with no replay, so the dashboard has to
      // already be listening — hence prime AFTER the first pump.
      await SessionRepository.instance.primeFromCache();
      await tester.pump();

      expect(
        find.text('FAVORITES'),
        findsOneWidget,
        reason: 'the primed cache must actually reach the pinned group',
      );
      expect(
        _pinnedHandle('alpha'),
        findsOneWidget,
        reason: 'nulling reorderIndex at the dashboard call site must be RED — '
            'that is the whole point of this file',
      );

      final onHandle = await tester.startGesture(
        tester.getCenter(_pinnedHandle('alpha')),
      );
      await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
      // A short move: enough to be a drag, not enough to change the drop slot —
      // a real reorder here would PATCH the owning server.
      await onHandle.moveBy(const Offset(0, 24));
      await tester.pump();
      await onHandle.up();
      await _settleSheet(tester);

      expect(
        find.text('Kill session'),
        findsNothing,
        reason: 'the actions sheet must not own the handle pixels (#169)',
      );

      // The sheet is still reachable from the row itself — #169 refuses to
      // trade one gesture for the other.
      await tester.longPress(find.byKey(const ValueKey('fav-alpha')));
      await _settleSheet(tester);
      expect(find.text('Kill session'), findsOneWidget);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
