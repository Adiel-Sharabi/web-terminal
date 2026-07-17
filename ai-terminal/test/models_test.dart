import 'package:ai_terminal/api/models.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

void main() {
  group('Session.fromJson', () {
    test('parses a full record', () {
      final s = Session.fromJson(_server, {
        'id': 'abc12345-6789',
        'name': 'my-project',
        'cwd': '/home/x/proj',
        'status': 'working',
        'claudeSessionId': 'claude-1',
        'lastActivity': 1720000000000,
        'notifyLevel': 'all',
      });
      expect(s.id, 'abc12345-6789');
      expect(s.name, 'my-project');
      expect(s.status, 'working');
      expect(s.claudeSessionId, 'claude-1');
      expect(s.lastActivity, 1720000000000);
      expect(s.notifyLevel, 'all');
      expect(s.server, _server);
      expect(s.shortId, 'abc12345');
    });

    test('parses autoCommand (server sends it per session)', () {
      final s = Session.fromJson(_server, {
        'id': 'x',
        'autoCommand': 'claude --dangerously-skip-permissions',
      });
      expect(s.autoCommand, 'claude --dangerously-skip-permissions');
    });

    test('applies defaults for missing fields', () {
      final s = Session.fromJson(_server, {'id': 'x'});
      expect(s.name, '');
      expect(s.status, 'idle');
      expect(s.claudeSessionId, isNull);
      expect(s.lastActivity, isNull);
      expect(s.notifyLevel, 'important');
      expect(s.autoCommand, '');
    });

    test('coerces a numeric-string lastActivity', () {
      final s = Session.fromJson(_server, {'id': 'x', 'lastActivity': '42'});
      expect(s.lastActivity, 42);
    });

    test('parses the agent id when the server reports one', () {
      final s = Session.fromJson(_server, {'id': 'x', 'agent': 'codex'});
      expect(s.agent, 'codex');
    });

    test('agent is null for a plain shell, NOT defaulted to "claude"', () {
      final s = Session.fromJson(_server, {'id': 'x'});
      expect(s.agent, isNull);
    });

    test('parses favorite + favoriteRank (#60)', () {
      final s = Session.fromJson(_server, {
        'id': 'x',
        'favorite': true,
        'favoriteRank': 4,
      });
      expect(s.favorite, isTrue);
      expect(s.favoriteRank, 4);
    });

    test('defaults to not-favorited, null rank when absent', () {
      final s = Session.fromJson(_server, {'id': 'x'});
      expect(s.favorite, isFalse);
      expect(s.favoriteRank, isNull);
    });

    test('favorite false is never coerced true by a stray favoriteRank', () {
      final s = Session.fromJson(_server, {'id': 'x', 'favoriteRank': 2});
      expect(s.favorite, isFalse);
    });

    test('parses compacting + compactingSince (#65)', () {
      final s = Session.fromJson(_server, {
        'id': 'x',
        'compacting': true,
        'compactingSince': 1720000000000,
      });
      expect(s.compacting, isTrue);
      expect(s.compactingSince, 1720000000000);
    });

    test('defaults to not-compacting, null since when absent', () {
      final s = Session.fromJson(_server, {'id': 'x'});
      expect(s.compacting, isFalse);
      expect(s.compactingSince, isNull);
    });
  });

  group('Session.pinnedOrder (#60)', () {
    Session mk(String id, {bool favorite = false, int? rank}) => Session(
          id: id,
          name: id,
          cwd: '/x',
          status: 'idle',
          claudeSessionId: null,
          lastActivity: 1,
          notifyLevel: 'important',
          server: _server,
          favorite: favorite,
          favoriteRank: rank,
        );

    test('pinnedOrder keeps only favorited sessions, sorted by rank', () {
      final sessions = [
        mk('a', favorite: true, rank: 2),
        mk('b'),
        mk('c', favorite: true, rank: 0),
      ];
      expect(Session.pinnedOrder(sessions).map((s) => s.id), ['c', 'a']);
    });

    test('pinnedOrder ties (equal/absent rank) break on id', () {
      final sessions = [
        mk('b', favorite: true),
        mk('a', favorite: true),
      ];
      expect(Session.pinnedOrder(sessions).map((s) => s.id), ['a', 'b']);
    });
  });

  group('AttentionInfo.fromJson', () {
    test('surfaces an uncleared event', () {
      final a = AttentionInfo.fromJson({
        'id': 's1',
        'serverName': 'Home',
        'kind': 'approval',
        'reason': 'Running: npm install',
        'name': 'proj',
        'at': 1720000000000,
        'cleared': false,
        'lastMessage': 'hi',
      });
      expect(a.kind, 'approval');
      expect(a.cleared, false);
      expect(a.hasAttention, isTrue);
      expect(a.serverName, 'Home');
    });

    test('empty state → all null event fields, no attention', () {
      final a = AttentionInfo.fromJson({
        'id': 's1',
        'serverName': 'Home',
        'kind': null,
        'reason': null,
        'name': null,
        'at': null,
        'cleared': null,
        'lastMessage': '',
      });
      expect(a.kind, isNull);
      expect(a.cleared, isNull);
      expect(a.hasAttention, isFalse);
    });

    test('cleared event does not count as active attention', () {
      final a = AttentionInfo.fromJson({
        'serverName': 'Home',
        'kind': 'apierror',
        'cleared': true,
      });
      expect(a.hasAttention, isFalse);
    });
  });

  group('NotifyEvent.fromJson', () {
    test('unwraps the {notification: {...}} envelope', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'approval_needed',
          'message': 'proj: run cmd',
          'sessionId': 's9',
          'status': 'waiting',
        }
      });
      expect(e.type, 'approval_needed');
      expect(e.sessionId, 's9');
      expect(e.status, 'waiting');
      expect(e.apiError, isFalse);
    });

    test('reads the apiError flag from an api_error frame', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'api_error',
          'sessionId': 's9',
          'status': 'api_error',
          'apiError': true,
        }
      });
      expect(e.apiError, isTrue);
    });

    test('accepts a bare notification object', () {
      final e = NotifyEvent.fromJson({'type': 'idle', 'sessionId': 's'});
      expect(e.type, 'idle');
      expect(e.message, '');
    });

    test('parses the extended api-error fields on an api_error frame', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'api_error',
          'sessionId': 's9',
          'apiError': true,
          'apiErrorText': 'overloaded_error',
          'transient': true,
          'autoContinue': 0,
          'action': 'retry',
          'replayText': '\r',
        }
      });
      expect(e.apiError, isTrue);
      expect(e.apiErrorText, 'overloaded_error');
      expect(e.transient, isTrue);
      expect(e.autoContinue, 0);
      expect(e.action, 'retry');
      expect(e.replayText, '\r');
      expect(e.cleared, isFalse);
      expect(e.hasApiErrorSignal, isTrue);
    });

    test('coerces a numeric-string autoContinue', () {
      final e = NotifyEvent.fromJson({
        'notification': {'sessionId': 's', 'apiError': true, 'autoContinue': '3'}
      });
      expect(e.autoContinue, 3);
    });

    test('a recovery frame carries the api-error signal with apiError false',
        () {
      // The server signals recovery with type:'status', apiError:false — it must
      // still be recognisable as an api-error frame so the UI can clear.
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'status',
          'sessionId': 's9',
          'apiError': false,
          'apiErrorText': '',
        }
      });
      expect(e.apiError, isFalse);
      expect(e.hasApiErrorSignal, isTrue);
    });

    test('an ordinary status frame carries NO api-error signal', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'status',
          'sessionId': 's9',
          'status': 'working',
        }
      });
      expect(e.apiError, isFalse);
      expect(e.hasApiErrorSignal, isFalse);
      expect(e.apiErrorText, isNull);
      expect(e.autoContinue, 0);
    });

    test('parses a compacting frame, whose session id key is "id" not '
        '"sessionId" (#65)', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'compacting',
          'id': 's9',
          'compacting': true,
          'since': 1720000000000,
        }
      });
      expect(e.type, 'compacting');
      expect(e.sessionId, 's9');
      expect(e.compacting, isTrue);
      expect(e.compactingSince, 1720000000000);
      expect(e.hasCompactingSignal, isTrue);
      // Independent of the api-error signal.
      expect(e.hasApiErrorSignal, isFalse);
    });

    test('a compacting-cleared frame reports compacting false, still signalled',
        () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'compacting',
          'id': 's9',
          'compacting': false,
          'since': null,
        }
      });
      expect(e.compacting, isFalse);
      expect(e.compactingSince, isNull);
      expect(e.hasCompactingSignal, isTrue);
    });

    test('an ordinary status frame carries NO compacting signal', () {
      final e = NotifyEvent.fromJson({
        'notification': {
          'type': 'status',
          'sessionId': 's9',
          'status': 'working',
        }
      });
      expect(e.compacting, isFalse);
      expect(e.hasCompactingSignal, isFalse);
      expect(e.compactingSince, isNull);
    });
  });

  group('ApiErrorInfo', () {
    test('defaults', () {
      const info = ApiErrorInfo(active: true);
      expect(info.active, isTrue);
      expect(info.text, isNull);
      expect(info.transient, isFalse);
      expect(info.autoContinue, 0);
      expect(info.action, isNull);
    });
  });

  group('CompactingInfo (#65)', () {
    test('defaults', () {
      const info = CompactingInfo(active: true);
      expect(info.active, isTrue);
      expect(info.since, isNull);
    });
  });

  group('ServerRuntimeConfig.fromJson', () {
    test('parses the four fields, ignoring the rest', () {
      final c = ServerRuntimeConfig.fromJson({
        'defaultCwd': r'C:\dev',
        'defaultCommand': 'claude',
        'scanFolders': [r'C:\dev', r'C:\work'],
        'serverName': 'Home',
        // Ignored keys:
        'password': '***',
        'port': 7785,
        'cluster': [],
      });
      expect(c.defaultCwd, r'C:\dev');
      expect(c.defaultCommand, 'claude');
      expect(c.scanFolders, [r'C:\dev', r'C:\work']);
      expect(c.serverName, 'Home');
    });

    test('applies defaults for missing / wrongly-typed fields', () {
      final c = ServerRuntimeConfig.fromJson({'scanFolders': 'not-a-list'});
      expect(c.defaultCwd, '');
      expect(c.defaultCommand, '');
      expect(c.scanFolders, isEmpty);
      expect(c.serverName, '');
    });
  });

  group('ServerInfo.fromJson', () {
    test('parses capabilities list', () {
      final v = ServerInfo.fromJson({
        'version': '1.19.0',
        'serverName': 'Shadow',
        'capabilities': ['attention', 'clear', 'fcm'],
      });
      expect(v.version, '1.19.0');
      expect(v.serverName, 'Shadow');
      expect(v.has('fcm'), isTrue);
      expect(v.has('nope'), isFalse);
    });

    test('missing capabilities → empty list', () {
      final v = ServerInfo.fromJson({'version': '1', 'serverName': 'x'});
      expect(v.capabilities, isEmpty);
    });
  });

  group('ScrollbackChunk.fromJson', () {
    test('parses numeric fields, incl. numeric strings', () {
      final c = ScrollbackChunk.fromJson({
        'data': 'hello',
        'total': 100,
        'offset': '10',
        'limit': 5,
      });
      expect(c.data, 'hello');
      expect(c.total, 100);
      expect(c.offset, 10);
      expect(c.limit, 5);
    });
  });

  group('SessionMetrics', () {
    test('parsed from a session record with metrics', () {
      final s = Session.fromJson(_server, {
        'id': 'x',
        'name': 'n',
        'cwd': '/p',
        'status': 'working',
        'metrics': {'ctx': 42.6, 'fiveH': 18, 'sevenD': 63, 'model': 'Opus'},
      });
      expect(s.metrics, isNotNull);
      expect(s.metrics!.ctx, 43); // rounded
      expect(s.metrics!.fiveH, 18);
      expect(s.metrics!.sevenD, 63);
      expect(s.metrics!.model, 'Opus');
      expect(s.metrics!.hasAny, isTrue);
    });

    test('null when metrics absent', () {
      final s = Session.fromJson(_server, {'id': 'x', 'name': 'n', 'cwd': '/p'});
      expect(s.metrics, isNull);
    });

    test('null when no numeric metric present', () {
      expect(SessionMetrics.fromJson({'model': 'Opus'}), isNull);
    });

    test('clamps out-of-range percentages', () {
      final m = SessionMetrics.fromJson({'ctx': 150, 'fiveH': -5, 'sevenD': 0});
      expect(m, isNotNull);
      expect(m!.ctx, 100);
      expect(m.fiveH, 0);
      expect(m.sevenD, 0);
    });
  });

  group('ToolUse.fromJson', () {
    test('parses id, structured input, and result; back-compat defaults', () {
      final t = ToolUse.fromJson({
        'name': 'Bash',
        'inputPreview': '{"command":"npm test"}',
        'id': 'tu_1',
        'input': {'command': 'npm test'},
        'result': 'PASS',
      });
      expect(t.name, 'Bash');
      expect(t.id, 'tu_1');
      expect(t.input['command'], 'npm test');
      expect(t.result, 'PASS');

      // Old-server payload (no id/input/result) → safe defaults.
      final old = ToolUse.fromJson({'name': 'Read', 'inputPreview': '{"file":"a"}'});
      expect(old.id, '');
      expect(old.input, isEmpty);
      expect(old.result, isNull);
    });
  });

  group('TranscriptTurn.ctxTokens', () {
    test('parsed when present and positive', () {
      final t = TranscriptTurn.fromJson(
          {'role': 'assistant', 'text': 'hi', 'ctxTokens': 42000});
      expect(t.ctxTokens, 42000);
    });

    test('null when absent or non-positive', () {
      expect(TranscriptTurn.fromJson({'role': 'assistant', 'text': 'hi'}).ctxTokens,
          isNull);
      expect(
          TranscriptTurn.fromJson({'role': 'user', 'text': 'x', 'ctxTokens': 0})
              .ctxTokens,
          isNull);
    });
  });

  group('AgentInfo.fromJson', () {
    test('parses id, label and color', () {
      final a = AgentInfo.fromJson({
        'id': 'codex',
        'label': 'Codex',
        'color': '#10a37f',
      });
      expect(a.id, 'codex');
      expect(a.label, 'Codex');
      expect(a.color, '#10a37f');
    });

    test('applies defaults for missing fields', () {
      final a = AgentInfo.fromJson({});
      expect(a.id, '');
      expect(a.label, '');
      expect(a.color, '');
    });
  });

  group('ServerConfig', () {
    test('copyWith replaces only the given field', () {
      final c = _server.copyWith(name: 'Renamed');
      expect(c.name, 'Renamed');
      expect(c.baseUrl, _server.baseUrl);
      expect(c.bearerToken, _server.bearerToken);
    });

    test('value equality', () {
      expect(
        _server,
        const ServerConfig(
            name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok'),
      );
    });
  });
}
