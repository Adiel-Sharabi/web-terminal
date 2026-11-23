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

  test('a timestamp no DateTime can hold is not said, never a crash later', () {
    final s = SupervisorState.fromJson({
      'role': 'authority',
      'at': 9e15,
      'now': -9e15,
      'sessions': [
        {'id': 'k', 'wait': {'on': 'you', 'at': 9e15}, 'orphan': {'state': 'orphan', 'since': double.infinity}},
      ],
      'history': [
        {'id': 'h', 'closedAt': -9e15, 'openedAt': 8640000000000000},
      ],
    }, receivedAt: DateTime(2026))!;
    expect(s.at, isNull);
    expect(s.skewMs, 0, reason: 'no usable now: no skew');
    expect(s.sessions.single.wait!.at, isNull);
    expect(s.sessions.single.orphan!.since, isNull);
    expect(s.history.single.closedAt, isNull);
    expect(s.history.single.openedAt, 8640000000000000, reason: 'the edge itself is a real time');
    final skewed = SupervisorState.fromJson({'role': 'authority', 'now': 0}, receivedAt: DateTime(2026))!;
    expect(skewed.local(8640000000000000), isNull, reason: 'a skew past the edge is not a time either');
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

  group('#498 a card that explains itself', () {
    SupervisorCard card(Map<String, dynamic> extra) =>
        SupervisorState.fromJson({'role': 'authority', 'enabled': true, 'cards': [{'id': 'k1', 'text': 'Type continue', ...extra}]},
                receivedAt: DateTime(2026))!
            .cards
            .single;

    test("keeps the server's title, what Approve does, the target session and Later's time", () {
      final c = card({
        'cls': 'wake',
        'title': 'Wake it up',
        'does': 'Approve types the supervisor\'s message into "Alpha".',
        'laterUntil': 1234,
        'target': {
          'status': 'idle',
          'headline': 'waiting for CI',
          'items': [
            {'ref': '#7', 'title': 'Fix the thing', 'state': 'in-progress'},
            'junk',
          ],
        },
      });
      expect(c.title, 'Wake it up');
      expect(c.does, contains('Approve types'));
      expect(c.targetStatus, 'idle');
      expect(c.targetHeadline, 'waiting for CI');
      expect([for (final i in c.targetItems) i.ref], ['#7'], reason: 'a malformed item is dropped, never a crash');
      expect(c.laterUntil, 1234);
      expect(c.types, isTrue);
    });

    test('an older server sends none of it: all "not said", so the card renders as it was', () {
      final c = card({'cls': 'wake'});
      expect([c.title, c.does, c.targetStatus, c.targetHeadline, c.laterUntil], everyElement(isNull));
      expect(c.targetItems, isEmpty);
      expect(card({'target': 'x', 'does': 3}).does, isNull);
    });

    test('a close or a replacement types nothing: its "Edit" starts empty', () {
      expect(card({'cls': 'close'}).types, isFalse);
      expect(card({'cls': 'spawn'}).types, isFalse);
      expect(card({'cls': 'nudge'}).types, isTrue);
    });
  });

  test('#498 a case keeps what the owner is asked; an older server says none of it', () {
    SupervisorCase one(Map<String, dynamic> extra) =>
        SupervisorState.fromJson({'role': 'authority', 'enabled': true, 'cases': [{'id': 'k9', 'line': 'fact', ...extra}]},
                receivedAt: DateTime(2026))!
            .cases
            .single;
    final c = one({
      'laterUntil': 77,
      'owner': {'kind': 'stuck', 'title': 'It is not moving on', 'ask': 'Write to it.', 'whyYou': 'paused', 'checking': true},
    });
    expect([c.ownerKind, c.title, c.ask, c.whyYou, c.laterUntil], ['stuck', 'It is not moving on', 'Write to it.', 'paused', 77]);
    expect(c.checking, isTrue);
    final old = one({});
    expect([old.ownerKind, old.title, old.ask, old.whyYou, old.laterUntil], everyElement(isNull));
    expect(old.checking, isFalse);
    expect(one({'owner': 'x'}).ownerKind, isNull);
  });

  test('#498 ApiClient.decideSupervisorCase posts the action with only the fields given', () async {
    final asked = <(String, String)>[];
    final c = ApiClient(_office, httpClient: MockClient((req) async {
      asked.add((req.url.path, req.body));
      return http.Response('{"ok":true}', 200);
    }));
    await c.decideSupervisorCase('k9', action: 'write', text: 'go on');
    await c.decideSupervisorCase('k9', action: 'later', hours: 1);
    await c.decideSupervisorCase('k9', action: 'tell', note: 'it waits on me');
    await c.decideSupervisorCase('k9', action: 'resolve', how: 'nothing needed');
    expect(asked, [
      ('/api/supervisor/cases/k9', jsonEncode({'action': 'write', 'text': 'go on'})),
      ('/api/supervisor/cases/k9', jsonEncode({'action': 'later', 'hours': 1})),
      ('/api/supervisor/cases/k9', jsonEncode({'action': 'tell', 'note': 'it waits on me'})),
      ('/api/supervisor/cases/k9', jsonEncode({'action': 'resolve', 'how': 'nothing needed'})),
    ]);
    final refuse = ApiClient(_office, httpClient: MockClient((_) async => http.Response(jsonEncode({'reason': 'The supervisor is paused.'}), 409)));
    await expectLater(refuse.decideSupervisorCase('k9', action: 'tell', note: 'x'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', 'The supervisor is paused.')));
  });

  group('ApiClient.decideSupervisorCard', () {
    late List<(String, String)> asked;
    ApiClient client(http.Response answer) => ApiClient(_office, httpClient: MockClient((req) async {
          asked.add((req.url.path, req.body));
          return answer;
        }));
    setUp(() => asked = []);

    test('posts the decision with only the fields given', () async {
      final c = client(http.Response('{"ok":true}', 200));
      await c.decideSupervisorCard('k/1', decision: 'send', text: 'hi there');
      await c.decideSupervisorCard('k/1', decision: 'tell', note: 'mine', dontAsk: true);
      await c.decideSupervisorCard('k/1', decision: 'later', hours: 3);
      expect(asked, [
        ('/api/supervisor/cards/k%2F1', jsonEncode({'decision': 'send', 'text': 'hi there'})),
        ('/api/supervisor/cards/k%2F1', jsonEncode({'decision': 'tell', 'note': 'mine', 'dontAsk': true})),
        ('/api/supervisor/cards/k%2F1', jsonEncode({'decision': 'later', 'hours': 3})),
      ]);
    });

    test("a refusal throws the server's plain-words reason, then the bare code from an older server", () async {
      await expectLater(
          client(http.Response(jsonEncode({'refused': 'draft', 'reason': 'That session has unsent text in its box.'}), 409))
              .decideSupervisorCard('k1', decision: 'approve'),
          throwsA(isA<ApiException>().having((e) => e.message, 'message', 'That session has unsent text in its box.')));
      await expectLater(client(http.Response(jsonEncode({'refused': 'draft'}), 409)).decideSupervisorCard('k1', decision: 'approve'),
          throwsA(isA<ApiException>().having((e) => e.message, 'message', 'draft')));
      await expectLater(
          client(http.Response(jsonEncode({'error': 'text must be one line'}), 400)).decideSupervisorCard('k1', decision: 'send', text: 'x'),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 400)));
    });
  });
}
