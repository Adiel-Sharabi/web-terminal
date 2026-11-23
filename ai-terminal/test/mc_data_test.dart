// #507 - Mission Control's data layer against synthetic fixtures (the server routes are
// built in parallel): the wire parse is tolerant of junk and unknown fields, the client
// maps 200/404/409 the way the contract says, and the feed finds the ONE server that
// answers (asking the authority a peer names, and saying exactly why when it cannot).
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/mc_models.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/mc_feed.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> nowFixture() =>
    jsonDecode(File('test/fixtures/mc_now.json').readAsStringSync()) as Map<String, dynamic>;

const _a = ServerConfig(name: 'Alpha', baseUrl: 'http://alpha.test:7681', bearerToken: 'ta');
const _b = ServerConfig(name: 'Beta', baseUrl: 'http://beta.test:7681', bearerToken: 'tb');
const _c = ServerConfig(name: 'Gamma', baseUrl: 'http://gamma.test:7681', bearerToken: 'tc');

http.Response _json(Object body, int status) => http.Response(jsonEncode(body), status);

void main() {
  group('McNow.fromJson', () {
    test('reads the fixture: cards in the server order, why, decision, to-dos, moving, projects', () {
      final now = McNow.fromJson(nowFixture());
      expect(now.answerNow.map((c) => c.id), ['alpha|s-1|you:pick', 'beta|s-9|you:look'],
          reason: 'the card with no id is dropped; the order is the server\'s');
      final c = now.answerNow.first;
      expect(c.kind, 'decision');
      expect(c.ref, '#41');
      expect(c.why.blocks, 3);
      expect(c.why.blockedSessions.map((s) => s.name), ['Child: write the test', 'Child: check the docs']);
      expect(c.why.severity, 1);
      expect(c.why.ageMin, 42);
      expect(c.why.text, 'blocks 3 sessions');
      expect(c.decision?.options.map((o) => o.label), ['Retry once', 'Refresh first']);
      expect(c.decision?.recommended, 1);
      expect(c.answerable, isTrue);
      expect(now.answerNow[1].answerable, isTrue, reason: 'the inbox answers a reported wait too (#383)');
      expect(const McCard(id: 'n').answerable, isFalse, reason: 'no session: nothing to answer in');
      expect(now.todo.map((t) => t.done), [false, true]);
      expect(now.moving.working, 4);
      expect(now.moving.total, 6);
      final p = now.projects.first;
      expect(p.trackerLabel, 'acme/widgets');
      expect(p.areas.map((a) => a.name), ['Companion', 'Server']);
      expect(p.counts.stages.map((s) => s.stage), ['triage', 'fixing', 'pr-open', 'merged'], reason: 'server order kept');
      expect(p.counts.stages[2].name, 'PR open');
      expect(p.counts.stageTotal, 4);
      final junk = now.projects[1].counts;
      expect([junk.active, junk.sessions], [0, 0], reason: 'junk and negative counts read as 0');
      expect(now.generatedAt, isNotNull);
    });

    test('anything that is not the shape reads as empty, never throws', () {
      for (final body in [null, 'x', 3, <dynamic>[], {'answerNow': 'no', 'todo': {}, 'moving': [], 'projects': 7}]) {
        final now = McNow.fromJson(body);
        expect(now.answerNow, isEmpty);
        expect(now.todo, isEmpty);
        expect(now.projects, isEmpty);
        expect(now.moving.total, 0);
      }
    });

    test('a timestamp beyond what a date can hold reads as unknown, never throws', () {
      final now = McNow.fromJson({
        'generatedAt': 1e18,
        'answerNow': [
          {'id': 'x', 'askedAt': 1e18},
          {'id': 'y', 'askedAt': 9007199254740993000.0},
        ],
        'todo': [
          {'id': 't', 'createdAt': -5, 'doneAt': 8640000000000001},
        ],
      });
      expect(now.answerNow.map((c) => c.askedAt), [null, null]);
      expect(now.todo.single.createdAt, isNull);
      expect(now.todo.single.done, isFalse);
      expect(now.generatedAt, isNull);
    });

    test('stages may come as an ordered map too', () {
      final k = McCounts.fromJson({
        'stages': {'triage': 2, 'merged': 1}
      });
      expect(k.stages.map((s) => '${s.stage}=${s.count}'), ['triage=2', 'merged=1']);
    });

    test('a peer answer names the authority; anything else is not one', () {
      final a = McAuthority.fromPeerAnswer({
        'role': 'peer',
        'authority': {'name': 'Beta', 'url': 'http://beta.test:7681'}
      })!;
      expect([a.name, a.url, a.label], ['Beta', 'http://beta.test:7681', 'Beta']);
      expect(McAuthority.fromPeerAnswer({'role': 'none'}), isNull);
      expect(McAuthority.fromPeerAnswer({'error': 'busy'}), isNull);
    });
  });

  group('ApiClient Mission Control', () {
    late List<http.Request> seen;
    ApiClient client(http.Response Function(http.Request) answer) => ApiClient(_a, httpClient: MockClient((req) async {
          seen.add(req);
          return answer(req);
        }));
    setUp(() => seen = []);

    test('mcNow: 200 is the answer, asked with the bearer token', () async {
      final now = await client((_) => _json(nowFixture(), 200)).mcNow();
      expect(now.answerNow, hasLength(2));
      expect(seen.single.url.path, '/api/mc/now');
      expect(seen.single.headers['Authorization'], 'Bearer ta');
    });

    test('a server without Mission Control: 404, thrown as such', () async {
      await expectLater(
          client((_) => _json({'error': 'Not found'}, 404)).mcNow(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });

    test('a peer: 409 role peer is McPeerException naming the authority', () async {
      await expectLater(
        client((_) => _json({
              'role': 'peer',
              'authority': {'name': 'Beta', 'url': 'http://beta.test:7681'}
            }, 409)).mcNow(),
        throwsA(isA<McPeerException>().having((e) => e.authority.url, 'url', 'http://beta.test:7681')),
      );
    });

    test('a 409 that is not a peer answer is a refusal with the server\'s reason', () async {
      await expectLater(
        client((_) => _json({'reason': 'already parked'}, 409)).mcAddTodo('c1'),
        throwsA(isA<ApiException>()
            .having((e) => e is McPeerException, 'peer', isFalse)
            .having((e) => e.message, 'message', 'already parked')),
      );
    });

    test('to-do, to-do action and later post the contract bodies', () async {
      final api = client((req) => switch (req.url.path) {
            '/api/mc/todo' => _json({
                'todo': {'id': 't9', 'cardId': 'c1'},
                'parked': {'delivered': false, 'refused': 'the session is busy'}
              }, 200),
            _ => _json({'ok': true}, 200),
          });
      final r = await api.mcAddTodo('c1', text: 'do it at the desk');
      expect(r.todo?.id, 't9');
      expect(r.delivered, isFalse);
      expect(r.refused, 'the session is busy');
      await api.mcTodoAction('t 9', 'done');
      await api.mcLater('c1', 4);
      expect(seen.map((r) => '${r.method} ${r.url.path}'),
          ['POST /api/mc/todo', 'POST /api/mc/todo/t%209', 'POST /api/mc/later']);
      expect(jsonDecode(seen[0].body), {'cardId': 'c1', 'text': 'do it at the desk'});
      expect(jsonDecode(seen[1].body), {'action': 'done'});
      expect(jsonDecode(seen[2].body), {'cardId': 'c1', 'hours': 4});
    });

    test('a to-do without text sends no text field', () async {
      await client((_) => _json({'todo': null, 'parked': {'delivered': true}}, 200)).mcAddTodo('c1');
      expect(jsonDecode(seen.single.body), {'cardId': 'c1'});
    });
  });

  group('serverForAuthority', () {
    test('by url only (case, trailing slash and default port insensitive; the path counts)', () {
      expect(serverForAuthority([_a, _b], const McAuthority(url: 'HTTP://Beta.Test:7681/')), _b);
      const https = ServerConfig(name: 'S', baseUrl: 'https://s.test', bearerToken: 't');
      expect(serverForAuthority([_a, https], const McAuthority(url: 'https://s.test:443')), https);
      expect(serverForAuthority([_a, _b], const McAuthority(name: 'Beta', url: 'http://elsewhere:1')), isNull,
          reason: 'a same-named server elsewhere is another install: never by name');
      expect(serverForAuthority([_a, _b], const McAuthority(name: 'Beta')), isNull, reason: 'no url: not found');
      const p1 = ServerConfig(name: 'P1', baseUrl: 'https://h.test/wt1', bearerToken: 't');
      const p2 = ServerConfig(name: 'P2', baseUrl: 'https://h.test/wt2', bearerToken: 't');
      expect(serverForAuthority([p1, p2], const McAuthority(url: 'https://h.test/wt2/')), p2);
    });
  });

  group('McFeed', () {
    // What each server answers `/api/mc/now`, by base url: a status, or 0 for a dead link.
    late Map<String, int> status;
    late List<String> asked;
    final peerBody = {
      'role': 'peer',
      'authority': {'name': 'Beta', 'url': 'http://beta.test:7681'}
    };

    McFeed feed(List<ServerConfig> servers) => McFeed(
          servers: () => servers,
          client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
            asked.add('${sv.name} ${req.method} ${req.url.path}');
            final st = status[sv.baseUrl] ?? 404;
            if (st == 0) throw const SocketException('down');
            if (st == 409) return _json(peerBody, 409);
            if (st == 200) {
              if (req.method == 'POST') return _json({'todo': {'id': 't'}, 'parked': {'delivered': true}}, 200);
              return _json(nowFixture(), 200);
            }
            return _json({'error': 'Not found'}, st);
          })),
        );

    setUp(() {
      status = {};
      asked = [];
    });

    test('a peer names the authority, which is asked next and answers', () async {
      status = {_a.baseUrl: 409, _b.baseUrl: 200};
      final f = feed([_a, _c, _b]);
      await f.refresh();
      expect(f.status, McStatus.ok);
      expect(f.servedBy, _b);
      expect(f.now?.answerNow, hasLength(2));
      expect(asked, ['Alpha GET /api/mc/now', 'Beta GET /api/mc/now'], reason: 'straight to the named one');
      asked.clear();
      await f.refresh();
      expect(asked, ['Beta GET /api/mc/now'], reason: 'the server that answered is asked first');
    });

    test('actions go to the server that answered', () async {
      status = {_a.baseUrl: 409, _b.baseUrl: 200};
      final f = feed([_a, _b]);
      await f.refresh();
      asked.clear();
      final said = await f.addTodo(f.now!.answerNow.first);
      expect(said, contains('told to carry on'));
      expect(asked.first, 'Beta POST /api/mc/todo');
    });

    test('the authority is not in the list: says which server to add', () async {
      status = {_a.baseUrl: 409};
      final f = feed([_a, _c]);
      await f.refresh();
      expect(f.status, McStatus.notListed);
      expect(f.message, contains('Beta'));
      expect(f.message, contains('add that server'));
      expect(f.now, isNull);
    });

    test('the authority is listed but down: says it is not reachable, and why', () async {
      status = {_a.baseUrl: 409, _b.baseUrl: 0};
      final f = feed([_a, _b]);
      await f.refresh();
      expect(f.status, McStatus.unreachable);
      expect(f.message, "Mission Control's server (Beta) is not reachable: Server unreachable");
    });

    test('every server 404: "no Mission Control yet", never a crash or an empty list', () async {
      final f = feed([_a, _b]);
      await f.refresh();
      expect(f.status, McStatus.unsupported);
      expect(f.message, contains('no Mission Control yet'));
    });

    test('no server configured', () async {
      final f = feed(const []);
      await f.refresh();
      expect(f.status, McStatus.noServers);
    });

    test('a failed refresh keeps the last answer, with the reason beside it', () async {
      status = {_a.baseUrl: 200};
      final f = feed([_a]);
      await f.refresh();
      expect(f.status, McStatus.ok);
      status = {_a.baseUrl: 0};
      await f.refresh();
      expect(f.now?.answerNow, hasLength(2), reason: 'kept');
      expect(f.message, contains('Alpha: Server unreachable'));
      status = {_a.baseUrl: 200};
      await f.refresh();
      expect(f.message, isNull, reason: 'cleared by the next answer');
    });

    test('an ask made while one is out runs after it, never dropped', () async {
      var calls = 0;
      final f = McFeed(
        servers: () => [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          calls++;
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return _json(nowFixture(), 200);
        })),
      );
      final first = f.refresh();
      await f.refresh();
      await f.refresh();
      await first;
      expect(calls, 2, reason: 'the asks made meanwhile fold into ONE more');
      f.dispose();
    });

    test('polls only while active', () async {
      status = {_a.baseUrl: 200};
      final f = McFeed(
        servers: () => [_a],
        client: (sv) => ApiClient(sv, httpClient: MockClient((req) async {
          asked.add(req.url.path);
          return _json(nowFixture(), 200);
        })),
        pollInterval: const Duration(milliseconds: 20),
      );
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(asked, isEmpty, reason: 'not active: never asked');
      f.active = true;
      await Future<void>.delayed(const Duration(milliseconds: 70));
      expect(asked.length, greaterThanOrEqualTo(2));
      f.active = false;
      final n = asked.length;
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(asked.length, n, reason: 'stopped');
      f.dispose();
    });
  });
}
