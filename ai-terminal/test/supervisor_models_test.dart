// #466 - the supervisor's answer, parsed tolerantly: a full authority answer keeps
// every field the Journal page shows; an older or non-authority server's answer, and
// wrong types anywhere, parse to "not said", never a crash; a body that is not a state
// at all is unknown (null), never an empty state. Also the client's route.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:1', bearerToken: 't');

Map<String, dynamic> _full(int now) => {
      'enabled': true,
      'role': 'authority',
      'at': now - 30000,
      'now': now,
      'everyMs': 60000,
      'complete': false,
      'servers': [
        {'name': 'Office', 'ok': true, 'reason': null, 'sessions': 2},
        {'name': 'Laptop', 'ok': false, 'reason': 'HTTP 502', 'sessions': 0},
      ],
      'sessions': [
        {
          'id': 'n1',
          'server': 'Office',
          'name': 'Alpha',
          'cwd': '/w/a',
          'status': 'waiting',
          'agent': 'claude',
          'clients': 1,
          'by': 'agent',
          'parentId': 'p1',
          'leadId': null,
          'replaces': ['old'],
          'children': [],
          'goal': 'Ship the widget',
          'headline': 'Asking about colours',
          'now': 'Waiting',
          'prompt': null,
          'items': [
            {'ref': '#7', 'title': 'Widget', 'state': 'in-progress'},
          ],
          'wait': {
            'on': 'you',
            'what': 'pick a colour',
            'at': now - 600000,
            'target': {'kind': 'lead'},
            'checkBy': 30,
          },
          'reason': {'kind': 'you', 'text': 'x'},
          'orphan': {'state': 'orphan', 'parentId': 'p1', 'since': now - 400000},
          'journal': {'openedAt': now - 900000, 'via': 'api', 'spawnedBy': 'Office'},
        },
      ],
      'orphans': ['n1'],
      'needsYou': ['n1', 'gone'],
      'live': [],
      'readyToClose': [],
      'history': [
        {
          'key': 'Office|h1',
          'id': 'h1',
          'machine': 'Office',
          'name': 'Epsilon',
          'cwd': '/w/e',
          'agent': 'claude',
          'via': 'api',
          'openedAt': now - 7200000,
          'closedAt': now - 3600000,
          'why': 'handed-off',
          'by': null,
          'spawnedBy': null,
          'parentId': null,
          'goal': 'Fix the parser',
          'replaces': [],
          'successorId': 's1',
          'headline': 'Parser fixed',
          'did': 'Wrote the fix',
          'items': [
            {'ref': '#12', 'state': 'done'},
          ],
          'wait': null,
        },
      ],
    };

void main() {
  test('a full authority answer keeps every field the page shows', () {
    final received = DateTime(2026, 11, 15, 12);
    final now = received.millisecondsSinceEpoch - 5000; // the authority's clock is 5 s behind
    final s = SupervisorState.fromJson(_full(now), receivedAt: received)!;
    expect(s.isAuthority, isTrue);
    expect(s.enabled, isTrue);
    expect(s.everyMs, 60000);
    expect(s.complete, isFalse);
    expect(s.skewMs, 5000);
    expect(s.local(now), received.millisecondsSinceEpoch);
    expect(s.silent.map((x) => '${x.name} ${x.reason}'), ['Laptop HTTP 502']);
    expect(s.needsYou, ['n1', 'gone']);
    expect(s.nodesOf(s.needsYou).map((n) => n.id), ['n1'], reason: 'an id with no node is skipped');

    final n = s.node('n1')!;
    expect(n.server, 'Office');
    expect(n.name, 'Alpha');
    expect(n.clients, 1);
    expect(n.goal, 'Ship the widget');
    expect(n.headline, 'Asking about colours');
    expect(n.items.single.ref, '#7');
    expect(n.wait!.on, 'you');
    expect(n.wait!.what, 'pick a colour');
    expect(n.wait!.at, now - 600000);
    expect(n.wait!.targetKind, 'lead');
    expect(n.wait!.checkBy, 30);
    expect(n.leadGone, isTrue);
    expect(n.leadUnknown, isFalse);
    expect(n.openedAt, now - 900000);

    final e = s.history.single;
    expect(e.name, 'Epsilon');
    expect(e.machine, 'Office');
    expect(e.why, 'handed-off');
    expect(e.closedAt, now - 3600000);
    expect(e.goal, 'Fix the parser');
    expect(e.headline, 'Parser fixed');
    expect(e.did, 'Wrote the fix');
    expect(e.successorId, 's1');
    expect(e.items.single.ref, '#12');
    expect(e.items.single.title, isNull);
    expect(e.items.single.state, 'done');
  });

  test('an authority before its first scan, or switched off, is an empty state', () {
    final first = SupervisorState.fromJson(
        {'role': 'authority', 'at': null, 'everyMs': 60000, 'complete': false, 'servers': [], 'sessions': []},
        receivedAt: DateTime(2026))!;
    expect(first.at, isNull);
    expect(first.sessions, isEmpty);
    expect(first.history, isEmpty);
    expect(first.skewMs, 0, reason: 'no served now: no skew');
    final off = SupervisorState.fromJson({'role': 'authority', 'enabled': false}, receivedAt: DateTime(2026))!;
    expect(off.enabled, isFalse);
    expect(off.needsYou, isEmpty);
  });

  test('a peer names the authority; role none names nobody', () {
    final peer = SupervisorState.fromJson({'role': 'peer', 'authority': {'name': 'Office'}}, receivedAt: DateTime(2026))!;
    expect(peer.isAuthority, isFalse);
    expect(peer.authorityName, 'Office');
    expect(peer.enabled, isTrue, reason: 'absent reads as on');
    final none = SupervisorState.fromJson({'role': 'none', 'authority': null}, receivedAt: DateTime(2026))!;
    expect(none.role, 'none');
    expect(none.authorityName, isNull);
  });

  test('wrong types anywhere are "not said", never a crash', () {
    final s = SupervisorState.fromJson({
      'role': 'authority',
      'at': 'soon',
      'servers': 'x',
      'needsYou': [1, 'a', null],
      'sessions': [
        5,
        {'name': 'no id'},
        {
          'id': 'k',
          'clients': '3',
          'items': ['x', {'state': 'done'}, {'ref': '#1'}],
          'wait': {'on': 5},
          'orphan': {'since': 1},
          'journal': 'yes',
        },
      ],
      'history': [null, 'x', {}],
    }, receivedAt: DateTime(2026))!;
    expect(s.at, isNull);
    expect(s.servers, isEmpty);
    expect(s.needsYou, ['a']);
    final k = s.sessions.single;
    expect(k.id, 'k');
    expect(k.clients, 0);
    expect(k.items.map((i) => i.ref), ['#1'], reason: 'an item with neither ref nor title is dropped');
    expect(k.wait, isNull);
    expect(k.orphan, isNull);
    expect(k.openedAt, isNull);
    expect(s.history, hasLength(1), reason: 'an empty map is an entry with nothing said');
  });

  test('a body that is not a state is unknown (null), never an empty state', () {
    for (final body in <dynamic>[null, [], 'x', 3, <String, dynamic>{}, {'enabled': true}]) {
      expect(SupervisorState.fromJson(body, receivedAt: DateTime(2026)), isNull, reason: '$body');
    }
  });

  group('ApiClient.supervisorState', () {
    ApiClient client(http.Response Function(http.Request) answer, List<String> asked) =>
        ApiClient(_office, httpClient: MockClient((req) async {
          asked.add('${req.method} ${req.url.path} ${req.headers['Authorization']}');
          return answer(req);
        }));

    test('reads the route with the bearer token', () async {
      final asked = <String>[];
      final s = await client((_) => http.Response(jsonEncode({'role': 'peer', 'authority': {'name': 'Home'}}), 200), asked)
          .supervisorState();
      expect(asked, ['GET /api/supervisor/state Bearer t']);
      expect(s.authorityName, 'Home');
    });

    test('a server too old for the route throws its 404', () async {
      await expectLater(
          client((_) => http.Response('{"error":"nope"}', 404), []).supervisorState(),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });

    test('a body that is not a state is a transport-level failure', () async {
      await expectLater(client((_) => http.Response('[]', 200), []).supervisorState(),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 0)));
    });
  });
}
