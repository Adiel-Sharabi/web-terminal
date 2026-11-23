// #492 - an owner-wait push is shown (it had no spec, so it was dropped), on its own
// channel, carries its kind in the payload, and a tap of that kind opens the inbox while
// every other kind still opens its session.
import 'package:ai_terminal/main.dart' show NotificationTarget, planNotificationTarget;
import 'package:ai_terminal/services/notification_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('owner-wait has a spec: the "Waiting on you" channel, HIGH', () {
    final spec = NotificationService.specForKind('owner-wait');
    expect(spec, isNotNull, reason: 'no spec = the push is never shown');
    expect(spec!.channelId, NotificationService.channelOwnerWait);
    expect(spec.channelName, 'Waiting on you');
    expect(spec.importance, Importance.high);
    expect(spec.priority, Priority.high);
    expect(NotificationService.channelOwnerWait, isNot(NotificationService.channelApproval));
  });

  test('the other kinds keep their channels', () {
    expect(NotificationService.specForKind('approval')!.channelId, NotificationService.channelApproval);
    expect(NotificationService.specForKind('mystery'), isNull);
  });

  test('the payload carries the kind and the tap reads it back', () {
    final p = NotificationService.payloadFor('owner-wait', 'abc', 'Office');
    expect(NotificationService.tapFromPayload(p), const NotificationTap('abc', 'owner-wait'));
    expect(NotificationService.sessionIdFromPayload(p), 'abc', reason: 'the old reader still works');
    expect(NotificationService.tapFromPayload(NotificationService.payloadFor('approval', 'x', '')),
        const NotificationTap('x', 'approval'));
  });

  test('a payload from before the kind was carried is a tap with no kind', () {
    expect(NotificationService.tapFromPayload('{"sessionId":"s1","serverName":"A"}'), const NotificationTap('s1', null));
    expect(NotificationService.tapFromPayload('{"sessionId":"s1","kind":7}'), const NotificationTap('s1', null));
    expect(NotificationService.tapFromPayload(null), isNull);
    expect(NotificationService.tapFromPayload('{"kind":"owner-wait"}'), isNull, reason: 'no session, no tap');
  });

  test('routing: owner-wait opens the inbox; approval and the rest open the session', () {
    expect(planNotificationTarget('owner-wait'), NotificationTarget.inbox);
    expect(planNotificationTarget('approval'), NotificationTarget.session);
    expect(planNotificationTarget('apierror'), NotificationTarget.session);
    expect(planNotificationTarget('idle'), NotificationTarget.session);
    expect(planNotificationTarget(null), NotificationTarget.session, reason: 'an old payload');
  });
}
