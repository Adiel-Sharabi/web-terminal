import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

void main() {
  group('TranscriptTurn.fromJson', () {
    test('assistant turn with toolUses + ts', () {
      final t = TranscriptTurn.fromJson({
        'role': 'assistant',
        'text': 'Running the build',
        'toolUses': [
          {'name': 'Bash', 'inputPreview': 'npm run build'},
          {'name': 'Edit', 'inputPreview': 'lib/x.dart'},
        ],
        'ts': '2026-07-05T14:32:00.000Z',
      });
      expect(t.isAssistant, isTrue);
      expect(t.isUser, isFalse);
      expect(t.text, 'Running the build');
      expect(t.ts, '2026-07-05T14:32:00.000Z');
      expect(t.toolUses.length, 2);
      expect(t.toolUses.first.name, 'Bash');
      expect(t.toolUses.first.inputPreview, 'npm run build');
    });

    test('user turn: empty toolUses, null ts', () {
      final t = TranscriptTurn.fromJson({
        'role': 'user',
        'text': 'please build',
        'toolUses': [],
        'ts': null,
      });
      expect(t.isUser, isTrue);
      expect(t.toolUses, isEmpty);
      expect(t.ts, isNull);
    });

    test('missing fields default safely', () {
      final t = TranscriptTurn.fromJson({'role': 'assistant'});
      expect(t.text, '');
      expect(t.toolUses, isEmpty);
      expect(t.ts, isNull);
    });

    test('ToolUse tolerates missing name/preview', () {
      final u = ToolUse.fromJson({});
      expect(u.name, '');
      expect(u.inputPreview, '');
    });
  });

  group('TranscriptPage.fromJson', () {
    test('parses messages (newest-last), cursor, hasMore', () {
      final p = TranscriptPage.fromJson({
        'messages': [
          {'role': 'user', 'text': 'older', 'toolUses': [], 'ts': null},
          {'role': 'assistant', 'text': 'newer', 'toolUses': [], 'ts': null},
        ],
        'cursor': 'MTIz',
        'hasMore': true,
      });
      expect(p.messages.map((m) => m.text).toList(), ['older', 'newer']);
      expect(p.cursor, 'MTIz');
      expect(p.hasMore, isTrue);
    });

    test('end of history: null cursor, hasMore false', () {
      final p = TranscriptPage.fromJson({
        'messages': [
          {'role': 'assistant', 'text': 'first', 'toolUses': []},
        ],
        'cursor': null,
        'hasMore': false,
      });
      expect(p.cursor, isNull);
      expect(p.hasMore, isFalse);
    });

    test('empty page with hasMore true is handled gracefully', () {
      final p = TranscriptPage.fromJson({
        'messages': [],
        'cursor': null,
        'hasMore': true,
      });
      expect(p.messages, isEmpty);
      expect(p.hasMore, isTrue);
      expect(p.cursor, isNull);
    });

    test('parses the agent field naming the provider that parsed it', () {
      final p = TranscriptPage.fromJson({
        'messages': [],
        'cursor': null,
        'hasMore': false,
        'agent': 'codex',
      });
      expect(p.agent, 'codex');
    });

    test('agent is null when the server omits it', () {
      final p = TranscriptPage.fromJson({
        'messages': [],
        'cursor': null,
        'hasMore': false,
      });
      expect(p.agent, isNull);
    });
  });

  group('subagent trace models', () {
    test('ToolUse parses a Task subagent stub', () {
      final u = ToolUse.fromJson({
        'name': 'Task',
        'inputPreview': '',
        'id': 'tu_task',
        'input': {'description': 'Investigate X', 'subagent_type': 'Explore'},
        'subagent': {
          'agentType': 'Explore',
          'description': 'Investigate X',
          'running': true,
        },
      });
      expect(u.subagent, isNotNull);
      expect(u.subagent!.agentType, 'Explore');
      expect(u.subagent!.description, 'Investigate X');
      expect(u.subagent!.running, isTrue);
    });

    test('ToolUse.subagent is null when the stub is absent', () {
      final u = ToolUse.fromJson({'name': 'Bash', 'inputPreview': 'ls'});
      expect(u.subagent, isNull);
    });

    test('SubagentTrace.running defaults to false for a non-bool', () {
      final s = SubagentTrace.fromJson({'agentType': 'X'});
      expect(s.running, isFalse);
      expect(s.description, '');
    });

    test('SubagentPage parses identity, running, and nested messages', () {
      final p = SubagentPage.fromJson({
        'agentType': 'Explore',
        'description': 'Investigate X',
        'running': true,
        'messages': [
          {'role': 'assistant', 'text': 'Looking', 'toolUses': [
            {'name': 'Bash', 'inputPreview': 'grep foo', 'id': 'b1'},
          ], 'ts': null},
        ],
        'cursor': 'MTIz',
        'hasMore': true,
      });
      expect(p.agentType, 'Explore');
      expect(p.running, isTrue);
      expect(p.messages.single.toolUses.single.name, 'Bash');
      expect(p.cursor, 'MTIz');
      expect(p.hasMore, isTrue);
    });
  });

  group('ApiClient.transcript', () {
    test('builds before + limit query and parses the page', () async {
      late Uri captured;
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        captured = req.url;
        return http.Response(
          jsonEncode({
            'messages': [
              {'role': 'assistant', 'text': 'hi', 'toolUses': [], 'ts': null}
            ],
            'cursor': 'abc',
            'hasMore': true,
          }),
          200,
        );
      }));

      final page = await client.transcript('s1', before: 'cur0', limit: 25);

      expect(captured.path, '/api/sessions/s1/transcript');
      expect(captured.queryParameters['before'], 'cur0');
      expect(captured.queryParameters['limit'], '25');
      expect(page.messages.single.text, 'hi');
      expect(page.cursor, 'abc');
    });

    test('omits query params when not provided', () async {
      late Uri captured;
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        captured = req.url;
        return http.Response(
            jsonEncode({'messages': [], 'cursor': null, 'hasMore': false}), 200);
      }));

      await client.transcript('s1');

      expect(captured.queryParameters.containsKey('before'), isFalse);
      expect(captured.queryParameters.containsKey('limit'), isFalse);
    });

    test('404 (no transcript) surfaces as ApiException(404)', () async {
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        return http.Response(
            jsonEncode({'error': 'no transcript for session'}), 404);
      }));

      await expectLater(
        client.transcript('shell-session'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 404)
            .having((e) => e.message, 'message', 'no transcript for session')),
      );
    });

    test('400 (bad cursor) surfaces as ApiException(400)', () async {
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        return http.Response(jsonEncode({'error': 'invalid cursor'}), 400);
      }));

      await expectLater(
        client.transcript('s1', before: 'garbage'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 400)),
      );
    });
  });

  group('ApiClient.subagent', () {
    test('builds the /subagent path (encoded id) + query and parses the page',
        () async {
      late Uri captured;
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        captured = req.url;
        return http.Response(
          jsonEncode({
            'agentType': 'Explore',
            'description': 'Investigate X',
            'running': true,
            'messages': [
              {'role': 'assistant', 'text': 'found it', 'toolUses': [], 'ts': null}
            ],
            'cursor': 'abc',
            'hasMore': false,
          }),
          200,
        );
      }));

      final page =
          await client.subagent('s1', 'toolu_task', before: 'cur0', limit: 25);

      expect(captured.path, '/api/sessions/s1/subagent/toolu_task');
      expect(captured.queryParameters['before'], 'cur0');
      expect(captured.queryParameters['limit'], '25');
      expect(page.agentType, 'Explore');
      expect(page.running, isTrue);
      expect(page.messages.single.text, 'found it');
    });

    test('404 (no subagent) surfaces as ApiException(404)', () async {
      final client = ApiClient(_server, httpClient: MockClient((req) async {
        return http.Response(
            jsonEncode({'error': 'no subagent for tool_use'}), 404);
      }));

      await expectLater(
        client.subagent('s1', 'toolu_missing'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)),
      );
    });
  });

  group('transcript capability gate', () {
    test('ServerInfo.has("transcript") reflects the capability list', () {
      final v = ServerInfo.fromJson({
        'version': '1.21.0',
        'serverName': 'Shadow',
        'capabilities': ['attention', 'clear', 'push-devices', 'transcript'],
      });
      expect(v.has('transcript'), isTrue);

      final noTranscript = ServerInfo.fromJson({
        'version': '1.0.0',
        'serverName': 'Old',
        'capabilities': ['attention'],
      });
      expect(noTranscript.has('transcript'), isFalse);
    });
  });
}
