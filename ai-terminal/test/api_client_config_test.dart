import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

void main() {
  group('ApiClient.serverConfig', () {
    test('GETs /api/config and surfaces the runtime subset', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode({
              'defaultCwd': r'C:\dev',
              'defaultCommand': 'claude',
              'scanFolders': [r'C:\dev'],
              'serverName': 'Home',
              'password': '***',
            }),
            200,
          );
        }),
      );

      final cfg = await client.serverConfig();
      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/config');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(cfg.defaultCwd, r'C:\dev');
      expect(cfg.defaultCommand, 'claude');
      expect(cfg.scanFolders, [r'C:\dev']);
      expect(cfg.serverName, 'Home');
    });

    test('maps a 500 to an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response('{}', 500)),
      );
      await expectLater(client.serverConfig(),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 500)));
    });
  });

  group('ApiClient.folders', () {
    test('GETs /api/history/folders with no-store, returns the flat array',
        () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode([r'C:\dev', r'C:\dev\ai-terminal', r'C:\work']),
            200,
          );
        }),
      );

      final list = await client.folders();
      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/history/folders');
      expect(captured.headers['cache-control'], 'no-store');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(list, [r'C:\dev', r'C:\dev\ai-terminal', r'C:\work']);
    });

    test('throws when the body is not a JSON array', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient(
            (req) async => http.Response(jsonEncode({'nope': true}), 200)),
      );
      await expectLater(client.folders(), throwsA(isA<ApiException>()));
    });
  });

  group('ApiClient.agents', () {
    test('GETs /api/agents and returns the parsed list', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(
            jsonEncode({
              'agents': [
                {'id': 'claude', 'label': 'Claude Code', 'color': '#d97757'},
                {'id': 'codex', 'label': 'Codex', 'color': '#10a37f'},
              ],
              'default': 'claude',
            }),
            200,
          );
        }),
      );

      final agents = await client.agents();
      expect(captured.method, 'GET');
      expect(captured.url.path, '/api/agents');
      expect(agents.map((a) => a.id), ['claude', 'codex']);
      expect(agents.first.label, 'Claude Code');
      expect(agents.first.color, '#d97757');
    });

    test('never throws — a failure yields an empty list', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response('', 500)),
      );
      expect(await client.agents(), isEmpty);
    });

    test('a malformed body (no agents array) yields an empty list', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response('{}', 200)),
      );
      expect(await client.agents(), isEmpty);
    });
  });

  group('ApiClient.createSession agent field', () {
    test('includes agent in the POST body when provided', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'id': 's1', 'name': 'n'}), 200);
        }),
      );

      final created = await client.createSession(agent: 'codex');
      expect(jsonDecode(captured.body)['agent'], 'codex');
      expect(created.agent, 'codex');
    });

    test('omits agent entirely when not provided (server infers it)', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'id': 's1', 'name': 'n'}), 200);
        }),
      );

      final created = await client.createSession();
      expect(jsonDecode(captured.body).containsKey('agent'), isFalse);
      expect(created.agent, isNull);
    });

    // #119: the created Session is what the screen opens with, and its Chat lens is
    // gated on `agent`. Reading the field back off the REQUEST discarded the server's
    // answer, so a session created with the picker on Auto opened with no chat
    // controls until a re-select replaced it with the list's copy. (The two tests
    // above pin the fallback that keeps an OLDER server, which echoes nothing, working.)
    test('takes the agent the SERVER resolved, not the one requested', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response(
              jsonEncode({'id': 's1', 'name': 'n', 'agent': 'claude'}),
              200,
            )),
      );

      final created = await client.createSession(autoCommand: 'claude --resume abc');
      expect(created.agent, 'claude');
    });

    test('a plain shell stays agentless — an explicit null is a real answer',
        () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response(
              jsonEncode({'id': 's1', 'name': 'n', 'agent': null}),
              200,
            )),
      );

      final created = await client.createSession(autoCommand: 'pwsh -NoLogo');
      expect(created.agent, isNull);
    });
  });

  group('ApiClient.reorderSessions', () {
    test('POSTs /api/sessions/order with {orderedIds}', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );

      await client.reorderSessions(['a', 'b', 'c']);
      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/sessions/order');
      expect(captured.headers['content-type'], contains('application/json'));
      expect(jsonDecode(captured.body), {
        'orderedIds': ['a', 'b', 'c']
      });
    });

    test('maps a 400 (bad ids) to an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async =>
            http.Response(jsonEncode({'error': 'orderedIds too long'}), 400)),
      );
      await expectLater(
        client.reorderSessions(['x']),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 400)
            .having((e) => e.message, 'message', 'orderedIds too long')),
      );
    });
  });

  group('ApiClient.setFavorite (#60)', () {
    test('PATCHes /api/sessions/:id/favorite with {favorite:true, rank}',
        () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );

      await client.setFavorite('sess-1', true, rank: 3);
      expect(captured.method, 'PATCH');
      expect(captured.url.path, '/api/sessions/sess-1/favorite');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(captured.headers['content-type'], contains('application/json'));
      expect(jsonDecode(captured.body), {'favorite': true, 'rank': 3});
    });

    test('unfavoriting sends only {favorite:false} — no rank key', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );

      await client.setFavorite('sess-1', false);
      expect(jsonDecode(captured.body), {'favorite': false});
    });

    test('favoriting with no rank OMITS the key entirely — never sends '
        'JSON null (the server 400s on an explicit null: '
        '`rank !== undefined` treats null as present-but-invalid)', () async {
      late http.Request captured;
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async {
          captured = req;
          return http.Response(jsonEncode({'ok': true}), 200);
        }),
      );

      await client.setFavorite('sess-1', true); // no rank — server assigns one
      final body = jsonDecode(captured.body) as Map;
      expect(body.containsKey('rank'), isFalse);
      expect(body, {'favorite': true});
    });

    test('a 404 (unknown/bogus id) surfaces as an ApiException', () async {
      final client = ApiClient(
        _server,
        httpClient: MockClient((req) async => http.Response(
            jsonEncode({'error': 'session not found'}), 404)),
      );
      await expectLater(
        client.setFavorite('nope', true, rank: 0),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 404)),
      );
    });
  });
}
