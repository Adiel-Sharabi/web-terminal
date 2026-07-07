import 'package:ai_terminal/services/notification_service.dart';
import 'package:flutter_test/flutter_test.dart';

// #2: opening/viewing a session must cancel its OS notification on THIS device.
// The server's FCM 'clear' round-trip is for *other* devices and never fires
// while this app is foreground, so a local cancel is required (cancelForSession
// / the foreground 'clear' branch of showFromPush). Correctness hinges on the
// cancel targeting the SAME notification the show posted: same id + same tag.
// notifKey is the single source both paths use; these tests lock its contract.
// (The plugin's cancel/show calls can't be intercepted in a host unit test —
// the desktop impl bypasses the method channel — so the id/tag agreement, not
// the channel round-trip, is what's asserted here.)
void main() {
  test('notifKey namespaces the tag as wt-<id>', () {
    expect(NotificationService.notifKey('sess-123').tag, 'wt-sess-123');
    expect(NotificationService.notifKey('').tag, 'wt-');
  });

  test('notifKey id is a stable, non-negative per-session hash', () {
    final a = NotificationService.notifKey('sess-9');
    final b = NotificationService.notifKey('sess-9');
    expect(a.id, b.id, reason: 'deterministic — show and a later cancel agree');
    expect(a.id, isNonNegative);
  });

  test('distinct sessions map to distinct notifications', () {
    final a = NotificationService.notifKey('sess-A');
    final b = NotificationService.notifKey('sess-B');
    expect(a.tag, isNot(b.tag));
    expect(a.id, isNot(b.id));
  });

  test('cancelForSession is a safe no-op for an empty id', () async {
    // Empty id returns before touching the plugin — must not throw.
    await NotificationService.cancelForSession('');
  });
}
