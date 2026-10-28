// #402 - the dashboard's cloud-off badge showed only a COUNT of down servers,
// so with two or more down nothing said which. It now carries a tooltip with
// the banner's own words (names and reasons) - the only place that names them
// when every server is down and the banner is hidden.
//
// Source-level: the badge renders only while SessionRepository.instance (a
// singleton with no injectable client) has CONFIRMED a server offline, which a
// widget test cannot reach without real failed polls. The wording itself is
// pinned in session_repository_needs_auth_test.dart.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final src = File('lib/screens/dashboard_screen.dart').readAsStringSync();

  test('the down-count badge carries the banner message as its tooltip', () {
    final i = src.indexOf("ValueKey('servers-down-badge')");
    expect(i, greaterThanOrEqualTo(0), reason: 'the tooltip is gone');
    final badge = src.indexOf('Icons.cloud_off', i);
    expect(badge, greaterThan(i));
    final b = src.substring(i, badge);
    // BOTH lists: an offline-only tooltip would hide who needs sign-in.
    expect(
        b,
        contains(RegExp(r'OfflineBanner\.messageFor\(\s*'
            r'offline: offlineNames,\s*needsAuth: needsAuthNames,')));
    expect(b, contains('label: Text(\'\$downCount\')'));
    // Tappable on a phone, where there is no hover.
    expect(b, contains('TooltipTriggerMode.tap'));
  });
}
