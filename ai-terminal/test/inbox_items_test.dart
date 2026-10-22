// #383 - the questions inbox's pure rules: which sessions and background agents are
// items, as what, in what order (built on the board's own rules), the dashboard badge,
// the prose gate, the background-agent wire shape, and the paragraph cut that the
// reading direction is decided on.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/work_board_screen.dart' show BoardColumn, boardColumnOf;
import 'package:ai_terminal/util/inbox_items.dart';
import 'package:ai_terminal/util/text_direction.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 't');

Session _s(
  String id, {
  String status = 'idle',
  String? waitingFor,
  Map<String, dynamic>? reason,
  int? lastActivity,
  ServerConfig server = _home,
  String? agent = 'claude',
  String? claudeSessionId,
  bool hidden = false,
}) =>
    Session.fromJson(server, {
      'id': id,
      'name': id,
      'cwd': '/w',
      'status': status,
      'notifyLevel': 'important',
      'agent': agent,
      'waitingFor': waitingFor,
      'reason': reason,
      'lastActivity': lastActivity,
      'claudeSessionId': claudeSessionId,
      if (hidden) 'brief': {'v': 1, 'reporting': 'on', 'items': [], 'hidden': true},
    });

SessionRecap _recap(String reply, {String at = '2026-10-22T10:00:00Z'}) => SessionRecap.fromJson({
      'name': 'x',
      'cwd': '/w',
      'status': 'idle',
      'reply': {'text': reply, 'at': at},
    });

BackgroundAgentRow _agent(String id, {String? waitingFor, String? sessionId, int? startedAt, ServerConfig server = _home}) =>
    BackgroundAgentRow(server: server, id: id, sessionId: sessionId, name: 'agent-$id', waitingFor: waitingFor, startedAt: startedAt);

void main() {
  group('inboxItemsOf (8.1)', () {
    test('question, permission, menu and reported rows are a, b, e and d', () {
      final items = inboxItemsOf([
        _s('q', status: 'waiting', waitingFor: 'question', lastActivity: 1),
        _s('p', status: 'waiting', waitingFor: 'permission', lastActivity: 2),
        _s('m', reason: {'kind': 'menu', 'text': '', 'since': 3, 'source': 'status'}),
        _s('r', reason: {'kind': 'you', 'text': 'pick', 'since': 4, 'source': 'reported'}),
      ]);
      expect([for (final i in items) (i.session!.id, i.kind)], [
        ('q', InboxKind.question),
        ('p', InboxKind.permission),
        ('m', InboxKind.menu),
        ('r', InboxKind.reported),
      ]);
      expect(items.every((i) => i.blocking), isTrue);
    });

    test('blocking before background; inside each, the OLDEST wait first, an unknown start last', () {
      final items = inboxItemsOf(
        [
          _s('young', status: 'waiting', waitingFor: 'question', lastActivity: 900),
          _s('prose', lastActivity: 10),
          _s('old', reason: {'kind': 'you', 'text': '', 'since': 100, 'source': 'reported'}, lastActivity: 999),
          _s('unknown', status: 'waiting', waitingFor: 'permission'),
        ],
        recaps: {'${_home.baseUrl}|prose': _recap('Which one should I take?')},
        agents: {
          _home.baseUrl: [_agent('a1', waitingFor: 'approve the plan', startedAt: 5)],
        },
      );
      expect([for (final i in items) i.key.split('|').last], ['old', 'young', 'unknown', 'a1', 'prose'],
          reason: 'reason.since outranks lastActivity; the background agent started at 5, the prose at 10');
      expect(items.map((i) => i.blocking), [true, true, true, false, false]);
    });

    test('a waiting row with no waitingFor is still an item, so nothing the board counts is missing', () {
      final items = inboxItemsOf([_s('w', status: 'waiting')]);
      expect(items.single.kind, InboxKind.waiting);
      expect(items.single.blocking, isTrue);
    });

    test('a question item carries the live question read for its row', () {
      final q = PendingQuestion.fromJson({
        'pending': true,
        'question': {
          'toolUseId': 't',
          'questions': [
            {'question': 'Which?', 'options': [{'label': 'A'}]},
          ],
        },
      });
      final items = inboxItemsOf([_s('q', status: 'waiting', waitingFor: 'question')], questions: {'${_home.baseUrl}|q': q});
      expect(items.single.question, same(q));
    });
  });

  group('inboxBadgeCount (8.2)', () {
    test('counts blocking items only, and equals the board\'s Needs-you count for the same rows', () {
      final rows = [
        _s('q', status: 'waiting', waitingFor: 'question'),
        _s('p', status: 'waiting', waitingFor: 'permission'),
        _s('w', status: 'waiting'),
        _s('m', reason: {'kind': 'menu', 'text': '', 'source': 'status'}),
        _s('r', reason: {'kind': 'you', 'text': '', 'source': 'reported'}),
        _s('h', status: 'waiting', waitingFor: 'question', hidden: true),
        _s('idle'),
        _s('working', status: 'working', reason: {'kind': 'working', 'text': '', 'source': 'status'}),
        _s('self', reason: {'kind': 'self', 'text': 'CI', 'source': 'reported'}),
      ];
      final board = rows.where((s) => boardColumnOf(s) == BoardColumn.needsYou).length;
      expect(inboxBadgeCount(rows), 6);
      expect(inboxBadgeCount(rows), board);
      expect(inboxBadgeCount([_s('idle')]), 0);
    });
  });

  group('prose gating (8.8)', () {
    final asks = _recap('Done.\n\nShould I push it?');
    Map<String, SessionRecap?> recap(String id) => {'${_home.baseUrl}|$id': asks};

    test('an idle agent row with no report and a question in its last paragraph is an item', () {
      final items = inboxItemsOf([_s('c', lastActivity: 5)], recaps: recap('c'));
      expect(items.single.kind, InboxKind.prose);
      expect(items.single.blocking, isFalse);
      expect(items.single.reply!.text, contains('push it?'));
    });

    test('a row that reported a self or done wait is not an item', () {
      for (final kind in ['self', 'done']) {
        final s = _s('c', reason: {'kind': kind, 'text': 'x', 'source': 'reported'});
        expect(proseCandidate(s), isFalse, reason: kind);
        expect(inboxItemsOf([s], recaps: recap('c')), isEmpty, reason: kind);
      }
    });

    test('a working, hidden or agent-less row is never a candidate; a reply with no question is not an item', () {
      expect(proseCandidate(_s('c', status: 'working')), isFalse);
      expect(proseCandidate(_s('c', hidden: true)), isFalse);
      expect(proseCandidate(_s('c', agent: null)), isFalse);
      expect(proseCandidate(_s('c')), isTrue);
      expect(inboxItemsOf([_s('c')], recaps: {'${_home.baseUrl}|c': _recap('All done.')}), isEmpty);
    });

    test('"not a question" dismisses THAT reply; a newer one asks again', () {
      final s = _s('c');
      final dismissed = {proseDismissKey(s, asks.reply!)};
      expect(inboxItemsOf([s], recaps: recap('c'), dismissed: dismissed), isEmpty);
      final newer = _recap('Should I push it now?', at: '2026-10-22T11:00:00Z');
      expect(inboxItemsOf([s], recaps: {'${_home.baseUrl}|c': newer}, dismissed: dismissed), hasLength(1));
    });
  });

  group('background agents (8.13)', () {
    test('a row with waitingFor is an item; one without is not; a matching conversation maps to its session', () {
      final row = _s('pty', claudeSessionId: 'abc');
      final items = inboxItemsOf([row], agents: {
        _home.baseUrl: [
          _agent('a1', waitingFor: 'approve', sessionId: 'abc'),
          _agent('a2', waitingFor: 'approve', sessionId: 'zzz'),
          _agent('a3'),
        ],
        // The same conversation id on ANOTHER server is not this session.
        _office.baseUrl: [_agent('a4', waitingFor: 'x', sessionId: 'abc', server: _office)],
      });
      expect(items.map((i) => i.key), ['${_home.baseUrl}|agent|a1', '${_home.baseUrl}|agent|a2', '${_office.baseUrl}|agent|a4']);
      expect(items.map((i) => i.kind).toSet(), {InboxKind.background});
      expect(items[0].session, same(row));
      expect(items[1].session, isNull);
      expect(items[2].session, isNull);
    });

    test('review N: keys stay unique for rows with no id, and a session already blocking gets no second card', () {
      final blocked = _s('pty', status: 'waiting', waitingFor: 'permission', claudeSessionId: 'abc');
      BackgroundAgentRow noId(String? conv) =>
          BackgroundAgentRow(server: _home, sessionId: conv, name: 'n', waitingFor: 'approve');
      final items = inboxItemsOf([blocked], agents: {
        _home.baseUrl: [
          _agent('a1', waitingFor: 'approve', sessionId: 'abc'), // its session is the blocking item
          noId('zzz'),
          noId('zzz'),
          noId(null),
          noId(null),
        ],
      });
      final keys = items.map((i) => i.key).toList();
      expect(keys.toSet(), hasLength(keys.length), reason: 'a duplicate ValueKey is a crash');
      expect(items.where((i) => i.kind == InboxKind.background), hasLength(4));
      expect(keys, isNot(contains('${_home.baseUrl}|agent|a1')));
      expect(items.first.kind, InboxKind.permission);
    });

    test('BackgroundAgentRow.fromJson keeps the fields and drops a row with no id and no conversation', () {
      final r = BackgroundAgentRow.fromJson(_home, {
        'id': 'x1',
        'sessionId': 'abc',
        'name': 'lint',
        'cwdTail': 'repo',
        'waitingFor': ' approve ',
        'startedAt': 7,
      })!;
      expect((r.id, r.sessionId, r.name, r.cwdTail, r.waitingFor, r.startedAt), ('x1', 'abc', 'lint', 'repo', 'approve', 7));
      expect(BackgroundAgentRow.fromJson(_home, {'name': 'nothing to key on'}), isNull);
      expect(BackgroundAgentRow.fromJson(_home, 'x'), isNull);
    });

    test('ApiClient.backgroundAgents: the list, null when unavailable, and a 404 is thrown for the caller', () async {
      var reply = http.Response(jsonEncode({'available': true, 'agents': [{'id': 'a', 'waitingFor': 'w'}, {'name': 'x'}]}), 200);
      final c = ApiClient(_home, httpClient: MockClient((req) async {
        expect(req.url.path, '/api/dashboard/background-agents');
        return reply;
      }));
      expect((await c.backgroundAgents())!.single.id, 'a');
      reply = http.Response(jsonEncode({'available': false}), 200);
      expect(await c.backgroundAgents(), isNull);
      reply = http.Response('', 404);
      await expectLater(c.backgroundAgents(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)));
    });
  });

  group('paragraphs and direction (8.11)', () {
    final hebrew = String.fromCharCodes([0x05E9, 0x05DC, 0x05D5, 0x05DD]);

    test('paragraphsOf cuts at blank lines, never inside a fence', () {
      expect(paragraphsOf('a\nb\n\n  \nc'), ['a\nb', 'c']);
      expect(paragraphsOf('x\n\n```\none\n\ntwo\n```\n\ny'), ['x', '```\none\n\ntwo\n```', 'y']);
      expect(paragraphsOf('\n\n'), isEmpty);
    });

    test('uniformDirectionOf: one direction for agreeing paragraphs, null for mixed', () {
      expect(uniformDirectionOf('hello\n\nworld'), TextDirection.ltr);
      expect(uniformDirectionOf('$hebrew\n\n2. $hebrew'), TextDirection.rtl);
      expect(uniformDirectionOf('$hebrew\n\nEnglish'), isNull);
      expect(uniformDirectionOf(''), TextDirection.ltr);
    });
  });
}
