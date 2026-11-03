// A session this client just created must stay in the list until its server has
// had the chance to answer for it.
//
// The new session's screen opens BEFORE any list has it (the New session sheet no
// longer waits on a refresh that fans out to every server - an offline peer held
// it 27-40 s). A SessionScreen reads a list without its session as "gone" and
// closes, so a list painted from the creating server's PRE-create rows - a fast
// peer answering first, or a poll round already in flight - would shut the screen
// that just opened (review of the fix, 2026-11-03).
//
// `noteCreated` keeps the row until a fetch of that server which STARTED after the
// create comes back. These tests pin both directions: an older answer cannot drop
// it, and a newer one is the truth - including "it is gone".
import 'dart:async';
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _office =
    ServerConfig(name: 'Office', baseUrl: 'http://a:7785', bearerToken: 'ta');

String _encodeServers(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

String _row(String id) => jsonEncode({'id': id, 'name': id, 'status': 'active'});

/// `/api/sessions` answers from [next]: each call takes the head (a completer the
/// test resolves with that call's JSON body), so a test controls WHEN each fetch
/// was issued and what it says.
class _Server {
  final List<Completer<String>> calls = [];
  int issued = 0;

  ApiClient client(ServerConfig s) => ApiClient(
        s,
        httpClient: MockClient((req) async {
          if (req.url.path == '/api/sessions') {
            issued++;
            final c = Completer<String>();
            calls.add(c);
            return http.Response(await c.future, 200);
          }
          return http.Response('{}', 200);
        }),
      );

  /// Waits until fetch number [n] (1-based) has been issued.
  Future<void> waitIssued(int n) async {
    for (var i = 0; i < 200 && issued < n; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    expect(issued, greaterThanOrEqualTo(n), reason: 'fetch $n never issued');
  }
}

Future<SessionRepository> _repo(_Server server) async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: _encodeServers([_office]),
  });
  final store = ServerStore.forTest();
  await store.init();
  return SessionRepository.forTest(store: store, clientFactory: server.client);
}

Session _created(String id) => Session.fromJson(_office, {'id': id, 'name': id});

bool _has(SessionRepository r, String id) => r.current.any((s) => s.id == id);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the created session is in the list at once', () async {
    final server = _Server();
    final repo = await _repo(server);
    repo.noteCreated(_created('new-1'));
    expect(_has(repo, 'new-1'), isTrue);
  });

  test('a fetch issued BEFORE the create cannot drop it (a round in flight)', () async {
    final server = _Server();
    final repo = await _repo(server);
    final inFlight = repo.refresh(); // a poll round, already asking
    await server.waitIssued(1);

    repo.noteCreated(_created('new-1')); // queues its own round behind that one
    server.calls[0].complete('[${_row('old')}]'); // the PRE-create answer
    await inFlight;

    expect(_has(repo, 'old'), isTrue);
    expect(_has(repo, 'new-1'), isTrue,
        reason: 'a list asked for before the create says nothing about it');

    // Its own round (issued after the create) carries it: server truth from here.
    await server.waitIssued(2);
    server.calls[1].complete('[${_row('old')},${_row('new-1')}]');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(_has(repo, 'new-1'), isTrue);
  });

  test('a fetch issued AFTER the create is the truth, even "it is gone"', () async {
    final server = _Server();
    final repo = await _repo(server);
    repo.noteCreated(_created('new-1')); // its round is issued now, after the create
    await server.waitIssued(1);
    server.calls[0].complete('[]'); // the session died at once
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(_has(repo, 'new-1'), isFalse,
        reason: 'the record must not outlive an answer that could include it');
  });

  test('a failed fetch keeps it (the server never answered for it)', () async {
    final repo = SessionRepository.forTest(
      store: await (() async {
        SharedPreferences.setMockInitialValues({
          ServerStore.storageKey: _encodeServers([_office]),
        });
        final store = ServerStore.forTest();
        await store.init();
        return store;
      })(),
      clientFactory: (s) => ApiClient(
        s,
        httpClient: MockClient((_) async => http.Response('', 503)),
      ),
    );
    repo.noteCreated(_created('new-1'));
    await repo.refresh();
    expect(_has(repo, 'new-1'), isTrue);
  });
}
