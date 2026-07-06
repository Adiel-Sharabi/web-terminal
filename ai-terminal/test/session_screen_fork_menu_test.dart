// Unit test for canForkFromMenu — the app-bar overflow menu's "Fork session"
// enable/disable rule (owner: "cant see fork"). Pulled out as a pure
// function, mirroring buildForkAutoCommand, so the rule is testable without
// pumping the whole SessionScreen (which needs a live ApiClient/
// SessionRepository/notification stack — out of scope for a unit test).
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({required String? claudeSessionId}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: claudeSessionId,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

void main() {
  group('canForkFromMenu', () {
    test('true for a Claude session', () {
      expect(canForkFromMenu(_session(claudeSessionId: 'claude-abc')), isTrue);
    });

    test('false for a plain shell session', () {
      expect(canForkFromMenu(_session(claudeSessionId: null)), isFalse);
    });
  });

  group('composeBarVisible', () {
    // Compose mode (not raw): the compose bar is the primary input, always shown.
    test('shown in compose mode on either lens', () {
      expect(composeBarVisible(rawMode: false, activeLens: 'terminal'), isTrue);
      expect(composeBarVisible(rawMode: false, activeLens: 'chat'), isTrue);
    });

    // Raw mode + Terminal lens: the terminal itself takes keystrokes, so the
    // compose bar is intentionally hidden.
    test('hidden in raw mode on the terminal lens', () {
      expect(composeBarVisible(rawMode: true, activeLens: 'terminal'), isFalse);
    });

    // The regression this guards: raw mode + Chat lens must STILL show the
    // compose bar, or there's no way to type in chat view (issue #12).
    test('shown in raw mode when the chat lens is active', () {
      expect(composeBarVisible(rawMode: true, activeLens: 'chat'), isTrue);
    });
  });
}
