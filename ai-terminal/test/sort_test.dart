import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'S', baseUrl: 'http://x', bearerToken: 't');

Session _mk(String id, String status, {int? last}) => Session(
      id: id,
      name: id,
      cwd: '',
      status: status,
      claudeSessionId: null,
      lastActivity: last,
      notifyLevel: 'important',
      server: _server,
      autoCommand: '',
    );

void main() {
  group('SessionRepository.compareSessions', () {
    test('orders attention-first: waiting, api_error, idle, working, other', () {
      final list = <Session>[
        _mk('other', 'starting'),
        _mk('working', 'working'),
        _mk('idle', 'idle'),
        _mk('apierr', 'api_error'),
        _mk('waiting', 'waiting'),
      ]..sort(SessionRepository.compareSessions);

      expect(
        list.map((s) => s.id).toList(),
        ['waiting', 'apierr', 'idle', 'working', 'other'],
      );
    });

    test('breaks ties by most-recent activity first', () {
      final list = <Session>[
        _mk('older', 'working', last: 1000),
        _mk('newer', 'working', last: 5000),
        _mk('noTime', 'working'),
      ]..sort(SessionRepository.compareSessions);

      expect(list.map((s) => s.id).toList(), ['newer', 'older', 'noTime']);
    });

    test('api_error sorts above idle', () {
      final list = <Session>[
        _mk('idle', 'idle'),
        _mk('apierr', 'api_error'),
      ]..sort(SessionRepository.compareSessions);
      expect(list.first.id, 'apierr');
    });
  });
}
