import 'package:ai_terminal/services/notification_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('NotificationService.buildBody', () {
    test('approval with a cached name', () {
      expect(NotificationService.buildBody('approval', 'my-proj'),
          'my-proj needs your approval');
    });

    test('apierror with a cached name', () {
      expect(NotificationService.buildBody('apierror', 'my-proj'),
          'my-proj stopped — API error');
    });

    test('idle with a cached name', () {
      expect(
          NotificationService.buildBody('idle', 'my-proj'), 'my-proj finished');
    });

    test('cache miss (null name) falls back to "A session"', () {
      expect(NotificationService.buildBody('approval', null),
          'A session needs your approval');
      expect(NotificationService.buildBody('apierror', ''),
          'A session stopped — API error');
    });

    test('owner-wait (#492) says it waits on you', () {
      expect(NotificationService.buildBody('owner-wait', 'my-proj'), 'my-proj waits on you');
      expect(NotificationService.buildBody('owner-wait', null), 'A session waits on you');
    });

    test('unknown kind → bare name', () {
      expect(NotificationService.buildBody('mystery', 'x'), 'x');
      expect(NotificationService.buildBody('mystery', null), 'A session');
    });
  });

  group('NotificationService.nameCacheKey', () {
    test('keys by sessionId alone (UUIDs are globally unique)', () {
      expect(NotificationService.nameCacheKey('sess-uuid-1'), 'sess-uuid-1');
    });
  });
}
