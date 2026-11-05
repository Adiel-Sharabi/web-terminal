// #428 - the companion's view of cluster resource leases (#412): the wire parsing of
// `GET /api/leases` (times moved onto this device's clock, a malformed body is unknown,
// never "none"), the client's handling of the authority being unreachable (503 is an
// error carrying the authority's name, never an empty table), and the Leases section's
// three states - empty, holders with a queue, authority down.
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/lease_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

// The authority's clock runs 1 h behind this device in every fixture below: a parse that
// ignored `now` would show the holder as held for an hour more than it was.
const _authNow = 1000000000;
const _skew = 3600 * 1000;
final _received = DateTime.fromMillisecondsSinceEpoch(_authNow + _skew);

Map<String, dynamic> _lease(String id, String resource, String state,
        {int position = 0, String server = 'Office', String? sessionId, String? role, int ago = 60, int ttlLeft = 600}) =>
    {
      'id': id,
      'resource': resource,
      'state': state,
      'position': position,
      'holder': {'server': server, 'sessionId': sessionId},
      'role': role,
      'meta': null,
      'ttlSec': 3600,
      'heartbeatSec': 0,
      'requestedAt': _authNow - ago * 1000,
      'grantedAt': state == 'held' ? _authNow - ago * 1000 : null,
      'expiresAt': state == 'held' ? _authNow + ttlLeft * 1000 : null,
      'lastHeartbeatAt': _authNow,
      if (state == 'held') 'heldForSec': ago else 'waitingForSec': ago,
    };

const _holderSid = 'aaaaaaaa-1111-4111-8111-111111111111';
const _waiterSid = 'bbbbbbbb-2222-4222-8222-222222222222';

Map<String, dynamic> _table() => {
      'authority': 'Office',
      'now': _authNow,
      'resources': [
        {
          'resource': 'vm:AM8-SanityVM',
          'holder': _lease('L1', 'vm:AM8-SanityVM', 'held', sessionId: _holderSid.toUpperCase(), ago: 720),
          'queue': [
            // out of order on the wire: the view lines them up by position
            _lease('L3', 'vm:AM8-SanityVM', 'queued', position: 2, server: 'Home', ago: 30),
            _lease('L2', 'vm:AM8-SanityVM', 'queued', position: 1, server: 'XPS', sessionId: _waiterSid, ago: 240),
          ],
        },
        {
          'resource': 'controller:172.168.1.20',
          'holder': _lease('L4', 'controller:172.168.1.20', 'held', server: 'Home', role: 'flash', ago: 5),
          'queue': [],
        },
      ],
      'released': [],
    };

Session _session(String id, String name) => Session(
      id: id,
      name: name,
      cwd: '/w',
      status: 'working',
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: _server,
    );

void main() {
  group('LeaseListing.fromJson', () {
    test('per resource: the holder and the queue in line order, times on this device\'s clock', () {
      final t = LeaseListing.fromJson(_table(), receivedAt: _received)!;
      expect(t.authority, 'Office');
      expect(t.resources.map((r) => r.resource), ['vm:AM8-SanityVM', 'controller:172.168.1.20']);
      final vm = t.resources.first;
      expect(vm.holder!.held, isTrue);
      expect(vm.holder!.sessionId, _holderSid, reason: 'ids compare lower-case');
      expect(vm.queue.map((l) => l.id), ['L2', 'L3']);
      // 720 s before the authority's now, on this device's clock - not 720 s + 1 h.
      expect(vm.holder!.sinceMs, _received.millisecondsSinceEpoch - 720 * 1000);
      expect(vm.holder!.expiresMs, _received.millisecondsSinceEpoch + 600 * 1000);
      expect(vm.queue.first.expiresMs, isNull, reason: 'a waiter has no expiry');
      expect(t.heldCount, 2);
      expect(t.waitingCount, 2);
    });

    test('forSession finds what a session holds and what it waits for', () {
      final t = LeaseListing.fromJson(_table(), receivedAt: _received)!;
      expect(t.forSession(_holderSid).map((l) => l.id), ['L1']);
      expect(t.forSession(_waiterSid.toUpperCase()).map((l) => l.id), ['L2']);
      expect(t.forSession('cccccccc-0000-4000-8000-000000000000'), isEmpty);
    });

    test('a body that is not a listing is unknown (null), never an empty table', () {
      expect(LeaseListing.fromJson({'error': 'x'}, receivedAt: _received), isNull);
      expect(LeaseListing.fromJson('nope', receivedAt: _received), isNull);
      expect(LeaseListing.fromJson({'resources': []}, receivedAt: _received)!.resources, isEmpty);
    });
  });

  group('ApiClient.leases', () {
    ApiClient client(int status, Object body) => ApiClient(_server,
        httpClient: MockClient((req) async {
          expect(req.url.path, '/api/leases');
          expect(req.headers['Authorization'], 'Bearer tok');
          return http.Response(body is String ? body : jsonEncode(body), status);
        }));

    test('200 is the table', () async {
      final t = await client(200, _table()).leases();
      expect(t.resources, hasLength(2));
    });

    test('503 (authority unreachable) throws with the server\'s words and the authority\'s name', () async {
      await expectLater(
        client(503, {'error': 'the lease authority is unreachable; no new lease can be granted', 'authority': 'Office'}).leases(),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 503)
            .having((e) => e.message, 'message', 'the lease authority is unreachable; no new lease can be granted (authority: Office)')),
      );
    });

    test('a malformed 200 throws: unknown is not "nobody holds anything"', () async {
      await expectLater(client(200, {'authority': 'Office'}).leases(), throwsA(isA<ApiException>()));
      await expectLater(client(200, '<html>').leases(), throwsA(isA<ApiException>()));
    });
  });

  group('LeasesPanel', () {
    final now = _received;
    Future<List<Session>> pump(WidgetTester tester, {LeaseListing? listing, String? down, List<Session> sessions = const []}) async {
      final opened = <Session>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SingleChildScrollView(
            child: LeasesPanel(
              listing: listing,
              down: down,
              now: now,
              sessionOf: (id) => sessions.where((s) => s.id == id).firstOrNull,
              onOpen: opened.add,
            ),
          ),
        ),
      ));
      return opened;
    }

    testWidgets('empty: says nothing is held, names the authority', (tester) async {
      await pump(tester, listing: const LeaseListing(authority: 'Office'));
      expect(find.byKey(const ValueKey('leases-empty')), findsOneWidget);
      expect(find.text('Lease authority: Office'), findsOneWidget);
      expect(find.byKey(const ValueKey('leases-down')), findsNothing);
    });

    testWidgets('holders and queue: who, since when, until when, and who waits in what order', (tester) async {
      final t = LeaseListing.fromJson(_table(), receivedAt: _received)!;
      final holder = _session(_holderSid, 'sanity release');
      final opened = await pump(tester, listing: t, sessions: [holder]);
      final vm = find.byKey(const ValueKey('lease-res-vm:AM8-SanityVM'));
      expect(vm, findsOneWidget);
      expect(find.descendant(of: vm, matching: find.text('sanity release on Office')), findsOneWidget);
      final until = TimeOfDay.fromDateTime(DateTime.fromMillisecondsSinceEpoch(_received.millisecondsSinceEpoch + 600 * 1000));
      final hhmm = '${until.hour.toString().padLeft(2, '0')}:${until.minute.toString().padLeft(2, '0')}';
      expect(find.descendant(of: vm, matching: find.text('for 12m · until $hhmm')), findsOneWidget);
      expect(find.descendant(of: vm, matching: find.text('#1 waiting')), findsOneWidget);
      expect(find.descendant(of: vm, matching: find.text('#2 waiting')), findsOneWidget);
      // a waiter whose session is not listed here: its machine and session id
      expect(find.descendant(of: vm, matching: find.text('XPS · session bbbbbbbb')), findsOneWidget);
      // a script with no session: its machine and that it has none
      expect(find.descendant(of: vm, matching: find.text('Home · a script, no session')), findsOneWidget);
      expect(find.descendant(of: vm, matching: find.text('for 4m')), findsOneWidget);
      final ctl = find.byKey(const ValueKey('lease-res-controller:172.168.1.20'));
      expect(find.descendant(of: ctl, matching: find.text('Home · a script (flash), no session')), findsOneWidget);

      // tap through to the holder's session
      await tester.tap(find.byKey(const ValueKey('lease-open-L1')));
      expect(opened.map((s) => s.id), [_holderSid]);
      // an unlisted holder is plain text, not a dead link
      expect(find.byKey(const ValueKey('lease-open-L2')), findsNothing);
    });

    testWidgets('authority down: says the table is unknown, and lists nothing', (tester) async {
      await pump(tester, down: 'Home says the lease authority is unreachable; no new lease can be granted (authority: Office)');
      expect(find.byKey(const ValueKey('leases-down')), findsOneWidget);
      expect(find.textContaining('Who holds what is unknown: Home says the lease authority is unreachable'), findsOneWidget);
      expect(find.byKey(const ValueKey('leases-empty')), findsNothing);
    });

    testWidgets('before the first answer it says reading, not empty', (tester) async {
      await pump(tester);
      expect(find.byKey(const ValueKey('leases-reading')), findsOneWidget);
      expect(find.byKey(const ValueKey('leases-empty')), findsNothing);
    });
  });

  group('SessionLeaseLines', () {
    testWidgets('a waiter says what it waits for, its place, and who holds it - a link to that session', (tester) async {
      final t = LeaseListing.fromJson(_table(), receivedAt: _received)!;
      final holder = _session(_holderSid, 'sanity release');
      final waiter = _session(_waiterSid, 'bug hunt');
      final lines = sessionLeases(t, waiter, (id) => id == _holderSid ? holder : null);
      final opened = <Session>[];
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: SessionLeaseLines(leases: lines, onOpen: opened.add, now: _received)),
      ));
      expect(find.text('Waiting for vm:AM8-SanityVM'), findsOneWidget);
      expect(find.text('#1 in line · 4m · held by'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('lease-holder-link-L2')));
      expect(opened.map((s) => s.id), [_holderSid]);
    });

    testWidgets('a holder says what it holds, for how long and how many wait', (tester) async {
      final t = LeaseListing.fromJson(_table(), receivedAt: _received)!;
      final holder = _session(_holderSid, 'sanity release');
      final lines = sessionLeases(t, holder, (_) => null);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(body: SessionLeaseLines(leases: lines, now: _received)),
      ));
      expect(find.text('Holds vm:AM8-SanityVM'), findsOneWidget);
      expect(find.textContaining('12m · until '), findsOneWidget);
      expect(find.textContaining('2 waiting'), findsOneWidget);
    });
  });
}
