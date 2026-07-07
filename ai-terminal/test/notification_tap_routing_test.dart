import 'dart:convert';

import 'package:ai_terminal/services/notification_service.dart';
import 'package:flutter_test/flutter_test.dart';

// Issue #20: every notification tap (foreground stream, cold-launch details)
// routes by pulling the sessionId out of the toast/push payload. If this parse
// is wrong the tap opens the wrong session / no session, so pin its behavior.
void main() {
  group('NotificationService.sessionIdFromPayload', () {
    test('extracts sessionId from a well-formed desktop/push payload', () {
      final p = jsonEncode({'sessionId': 'abc-123', 'serverName': 'Adiel-Home'});
      expect(NotificationService.sessionIdFromPayload(p), 'abc-123');
    });

    test('null / empty payload → null (no route)', () {
      expect(NotificationService.sessionIdFromPayload(null), isNull);
      expect(NotificationService.sessionIdFromPayload(''), isNull);
    });

    test('malformed JSON → null (must not throw)', () {
      expect(NotificationService.sessionIdFromPayload('not json'), isNull);
      expect(NotificationService.sessionIdFromPayload('{oops'), isNull);
    });

    test('payload without a sessionId → null', () {
      expect(
        NotificationService.sessionIdFromPayload(jsonEncode({'serverName': 'X'})),
        isNull,
      );
    });

    test('non-string sessionId is coerced to string', () {
      expect(
        NotificationService.sessionIdFromPayload(jsonEncode({'sessionId': 42})),
        '42',
      );
    });
  });
}
