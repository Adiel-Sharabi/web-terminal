// Tests for the desktop alert decision logic (issue #16): the status->kind
// mapping, the per-session Notify Level gate, and the DesktopAlertDecider's
// seeding / transition-only / focus-suppression behavior. The plugin + repo
// wiring is left to manual verification; all the branching lives here.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/services/desktop_alert_service.dart';

SessionAlertInput _in(
  String id,
  String status, {
  bool apiError = false,
  String level = 'important',
  String name = 'proj',
  String server = 'Home',
}) =>
    SessionAlertInput(
      id: id,
      status: status,
      apiError: apiError,
      notifyLevel: level,
      name: name,
      serverName: server,
    );

void main() {
  group('desktopAlertKind', () {
    test('waiting -> approval', () {
      expect(desktopAlertKind('waiting', false), 'approval');
    });
    test('api_error status -> apierror', () {
      expect(desktopAlertKind('api_error', false), 'apierror');
    });
    test('live api-error flag wins over any status', () {
      expect(desktopAlertKind('working', true), 'apierror');
      expect(desktopAlertKind('waiting', true), 'apierror');
    });
    test('idle -> idle; working -> none', () {
      expect(desktopAlertKind('idle', false), 'idle');
      expect(desktopAlertKind('working', false), 'none');
    });
  });

  group('desktopAlertPasses', () {
    test('off never alerts', () {
      expect(desktopAlertPasses('approval', 'off'), isFalse);
      expect(desktopAlertPasses('apierror', 'off'), isFalse);
    });
    test('important allows approval + apierror, not idle', () {
      expect(desktopAlertPasses('approval', 'important'), isTrue);
      expect(desktopAlertPasses('apierror', 'important'), isTrue);
      expect(desktopAlertPasses('idle', 'important'), isFalse);
    });
    test('all allows finished too, but never none', () {
      expect(desktopAlertPasses('idle', 'all'), isTrue);
      expect(desktopAlertPasses('none', 'all'), isFalse);
    });
    test('unknown level defaults to important', () {
      expect(desktopAlertPasses('approval', 'bogus'), isTrue);
      expect(desktopAlertPasses('idle', 'bogus'), isFalse);
    });
  });

  group('DesktopAlertDecider', () {
    test('the first evaluation only seeds — no alerts fire at launch', () {
      final d = DesktopAlertDecider();
      final alerts = d.evaluate(
        [_in('a', 'waiting')],
        appFocused: false,
        visible: const {},
      );
      expect(alerts, isEmpty);
      expect(d.seeded, isTrue);
    });

    test('fires on a transition into an alert state', () {
      final d = DesktopAlertDecider();
      d.evaluate([_in('a', 'working')], appFocused: false, visible: const {});
      final alerts = d.evaluate(
        [_in('a', 'waiting')],
        appFocused: false,
        visible: const {},
      );
      expect(alerts.map((x) => x.kind), ['approval']);
      expect(alerts.single.sessionId, 'a');
    });

    test('does not re-fire while the state is unchanged', () {
      final d = DesktopAlertDecider();
      d.evaluate([_in('a', 'working')], appFocused: false, visible: const {});
      d.evaluate([_in('a', 'waiting')], appFocused: false, visible: const {});
      final again = d.evaluate(
        [_in('a', 'waiting')],
        appFocused: false,
        visible: const {},
      );
      expect(again, isEmpty);
    });

    test('honors the per-session level (off = silent)', () {
      final d = DesktopAlertDecider();
      d.evaluate([_in('a', 'working', level: 'off')],
          appFocused: false, visible: const {});
      final alerts = d.evaluate(
        [_in('a', 'waiting', level: 'off')],
        appFocused: false,
        visible: const {},
      );
      expect(alerts, isEmpty);
    });

    test('suppresses a session that is visible in a focused window', () {
      final d = DesktopAlertDecider();
      d.evaluate([_in('a', 'working')], appFocused: true, visible: const {'a'});
      final focused = d.evaluate(
        [_in('a', 'waiting')],
        appFocused: true,
        visible: const {'a'},
      );
      expect(focused, isEmpty, reason: 'looking right at it');
    });

    test('still alerts a visible session when the window is not focused', () {
      final d = DesktopAlertDecider();
      d.evaluate([_in('a', 'working')], appFocused: false, visible: const {'a'});
      final alerts = d.evaluate(
        [_in('a', 'waiting')],
        appFocused: false,
        visible: const {'a'},
      );
      expect(alerts.single.kind, 'approval');
    });

    test('idle (finished) fires only at the all level', () {
      final dImportant = DesktopAlertDecider();
      dImportant.evaluate([_in('a', 'working', level: 'important')],
          appFocused: false, visible: const {});
      expect(
        dImportant.evaluate([_in('a', 'idle', level: 'important')],
            appFocused: false, visible: const {}),
        isEmpty,
      );

      final dAll = DesktopAlertDecider();
      dAll.evaluate([_in('a', 'working', level: 'all')],
          appFocused: false, visible: const {});
      expect(
        dAll
            .evaluate([_in('a', 'idle', level: 'all')],
                appFocused: false, visible: const {})
            .single
            .kind,
        'idle',
      );
    });
  });
}
