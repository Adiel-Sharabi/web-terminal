import 'dart:async';
import 'dart:convert';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/resource_monitor.dart';
import 'package:ai_terminal/widgets/format_utils.dart';
import 'package:ai_terminal/widgets/resource_stats.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// #152 levels 1-3 in the companion: parsing `GET /api/resources`, and the two
/// readouts built from it.
///
/// The rule every one of these tests is really about: an unknown number renders
/// as `—`, never as `0`. The server works to keep "cannot measure" apart from
/// "idle" — a CPU figure needs two process snapshots to divide, so an honest one
/// does not exist until the second arrives — and a client that renders both as
/// `0%` throws that away, making the least-measurable server look like the
/// emptiest one to start work on.

Map<String, dynamic> okBody({Object? sessionReading}) => <String, dynamic>{
      'ts': 1,
      'cpuCount': 20,
      'machine': {
        'cpuPct': 18,
        'windowMs': 5000,
        'memory': {
          'usedBytes': 30064771072,
          'totalBytes': 68501942272,
          'availBytes': 38437171200,
          'usedPct': 44,
          'pageReadsPerSec': null,
        },
      },
      'sampling': {'ok': true, 'windowMs': 6000, 'ts': 2},
      'webTerminal': {'cpuPct': 1.2, 'rssBytes': 1503238553, 'procCount': 27, 'topName': 'claude.exe'},
      'sessions': {'alive': sessionReading, 'gone': null},
    };

void main() {
  group('ServerResources.fromJson', () {
    test('reads all three levels', () {
      final r = ServerResources.fromJson(okBody(sessionReading: {
        'cpuPct': 15.0,
        'rssBytes': 756273152,
        'procCount': 9,
        'topName': 'claude.exe',
      }));
      expect(r.samplingOk, isTrue);
      expect(r.machine!.cpuPct, 18);
      expect(r.machine!.memUsedPct, 44);
      expect(r.webTerminal!.procCount, 27);
      expect(r.forSession('alive')!.rssBytes, 756273152);
      expect(r.forSession('alive')!.topName, 'claude.exe');
      expect(r.cpuCount, 20);
    });

    test('a session with no process tree is null, not a zeroed reading', () {
      final r = ServerResources.fromJson(okBody());
      expect(r.sessions.containsKey('gone'), isTrue);
      expect(r.forSession('gone'), isNull);
    });

    test('the DEGRADED body still carries the machine', () {
      // Levels 2/3 absent because the box could not run the process query; the
      // machine reading never depended on it and must survive.
      final r = ServerResources.fromJson(<String, dynamic>{
        'ts': 1,
        'cpuCount': 8,
        'machine': {
          'cpuPct': 7,
          'windowMs': 5000,
          'memory': {'usedBytes': 1, 'totalBytes': 2, 'usedPct': 50},
        },
        'sampling': {'ok': false, 'reason': 'timeout'},
        'webTerminal': null,
        'sessions': <String, dynamic>{},
      });
      expect(r.samplingOk, isFalse);
      expect(r.samplingReason, 'timeout');
      expect(r.machine!.cpuPct, 7);
      expect(r.webTerminal, isNull);
      expect(r.sessions, isEmpty);
    });

    test('a malformed field becomes null rather than a number the UI would trust', () {
      final r = ServerResources.fromJson(<String, dynamic>{
        'machine': {'cpuPct': 'lots', 'memory': 'nope'},
        'sampling': {'ok': true, 'windowMs': 'soon'},
        'webTerminal': {'cpuPct': null, 'rssBytes': null, 'procCount': null},
        'sessions': {'a': 'not-an-object'},
      });
      expect(r.machine!.cpuPct, isNull);
      expect(r.machine!.memUsedPct, isNull);
      expect(r.windowMs, 0);
      expect(r.webTerminal!.cpuPct, isNull);
      expect(r.webTerminal!.procCount, 0);
      expect(r.forSession('a'), isNull);
    });

    test('a server-supplied image name is capped before it reaches a tooltip', () {
      // Nothing on the wire bounds `topName`, and a peer supplies it. It only ever
      // reaches a Text/Tooltip so there is nothing to inject — but an unbounded
      // string still ruins the readout it lands in, and every other externally
      // supplied string in this app is capped.
      final r = ServerResources.fromJson(okBody(sessionReading: {
        'cpuPct': 1,
        'rssBytes': 1,
        'procCount': 1,
        'topName': 'a' * 5000,
      }));
      expect(r.forSession('alive')!.topName!.length, lessThanOrEqualTo(49));
      expect(r.forSession('alive')!.topName, endsWith('…'));
    });

    test('a name that fits is left exactly as it is', () {
      final r = ServerResources.fromJson(okBody(sessionReading: {
        'cpuPct': 1, 'rssBytes': 1, 'procCount': 1, 'topName': 'claude.exe',
      }));
      expect(r.forSession('alive')!.topName, 'claude.exe');
    });

    test('an empty body does not throw', () {
      final r = ServerResources.fromJson(const <String, dynamic>{});
      expect(r.samplingOk, isFalse);
      expect(r.machine, isNull);
    });

    // --- #165 ---------------------------------------------------------------
    test('reads headroom and the paging rate', () {
      final r = ServerResources.fromJson(okBody());
      expect(r.machine!.memAvailBytes, 38437171200);
      expect(r.machine!.memPageReadsPerSec, isNull);
    });

    test('a server too old to report either reads null, never 0', () {
      // A 0 says "no memory left" and "not paging" about a box that simply predates
      // the fields. Both are claims, and both are wrong in the dangerous direction.
      final r = ServerResources.fromJson(<String, dynamic>{
        'machine': {
          'cpuPct': 7,
          'memory': {'usedBytes': 1, 'totalBytes': 2, 'usedPct': 50},
        },
        'sampling': {'ok': true},
        'sessions': <String, dynamic>{},
      });
      expect(r.machine!.memAvailBytes, isNull);
      expect(r.machine!.memPageReadsPerSec, isNull);
      expect(r.machine!.memUsedPct, 50);
    });

    test('a malformed headroom or rate becomes null rather than a trusted number', () {
      final r = ServerResources.fromJson(<String, dynamic>{
        'machine': {
          'memory': {'availBytes': 'lots', 'pageReadsPerSec': 'many'},
        },
        'sampling': {'ok': true},
        'sessions': <String, dynamic>{},
      });
      expect(r.machine!.memAvailBytes, isNull);
      expect(r.machine!.memPageReadsPerSec, isNull);
    });
  });

  // The colour is the glanceable judgement, and #165's whole argument is that it
  // cannot be keyed on the percentage: 98% on a 32 GB box is unusable and 98% on a
  // 640 GB box has 12.7 GB of room. Only the absolute figure separates them.
  group('headroomColor (#165)', () {
    final theme = ThemeData.dark();
    const gb = 1024 * 1024 * 1024;

    test('below the red floor is an error colour', () {
      expect(headroomColor(theme, (0.65 * gb).round()), theme.colorScheme.error);
    });

    test('between red and amber warns', () {
      expect(headroomColor(theme, 3 * gb), kWarnAmber);
    });

    test('above the amber floor is neutral — no colour noise on a healthy box', () {
      expect(headroomColor(theme, 12 * gb), isNull);
      expect(headroomColor(theme, kHeadroomAmberBytes), isNull);
    });

    test('unknown headroom is never coloured — a dash is not a warning', () {
      expect(headroomColor(theme, null), isNull);
    });

    test('the thresholds are absolute byte counts, not percentages', () {
      // 98% used on a very large box still has room, and must not go red.
      expect(headroomColor(theme, 12 * gb), isNull);
      // The same percentage on a small box is the reported failure.
      expect(headroomColor(theme, (0.65 * gb).round()), theme.colorScheme.error);
    });
  });

  group('formatting', () {
    test('bytes read at a glance', () {
      expect(formatBytesShort(1503238553), '1.4 GB');
      expect(formatBytesShort(756273152), '721 MB');
      expect(formatBytesShort(null), '—');
    });

    test('a sub-1% reading keeps its detail — 0.4% is not "doing nothing"', () {
      expect(formatPctShort(0.4), '0.4%');
      expect(formatPctShort(18), '18%');
      expect(formatPctShort(0), '0%');
      expect(formatPctShort(null), '—');
    });
  });

  group('SessionResourceChip', () {
    setUp(() => ResourceMonitor.instance.resetForTests());
    tearDown(() => ResourceMonitor.instance.resetForTests());

    Future<void> pump(WidgetTester tester) => tester.pumpWidget(const MaterialApp(
          home: Scaffold(
            body: SessionResourceChip(baseUrl: 'http://s', sessionId: 'alive'),
          ),
        ));

    testWidgets('renders nothing while the view is off', (tester) async {
      await pump(tester);
      expect(find.textContaining('%'), findsNothing);
      expect(find.text('—'), findsNothing);
    });

    testWidgets('renders the session\'s own tree once a reading arrives', (tester) async {
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(okBody(sessionReading: {
          'cpuPct': 15.0,
          'rssBytes': 756273152,
          'procCount': 9,
          'topName': 'claude.exe',
        })),
      );
      await pump(tester);
      expect(find.text('15% · 721 MB'), findsOneWidget);
    });

    testWidgets('a server that cannot measure shows a dash, never 0%', (tester) async {
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(<String, dynamic>{
          'sampling': {'ok': false, 'reason': 'unsupported-platform'},
          'sessions': <String, dynamic>{},
        }),
      );
      await pump(tester);
      expect(find.text('—'), findsOneWidget);
      expect(find.textContaining('0%'), findsNothing);
    });

    testWidgets('a server that has not answered yet shows nothing at all', (tester) async {
      // The first seconds after switching the view on must not look like a
      // fleet of broken sessions.
      ResourceMonitor.instance.seedForTests('http://s', null);
      await pump(tester);
      expect(find.text('—'), findsNothing);
    });
  });

  group('ServerResourceLine', () {
    setUp(() => ResourceMonitor.instance.resetForTests());
    tearDown(() => ResourceMonitor.instance.resetForTests());

    Future<void> pump(WidgetTester tester) => tester.pumpWidget(const MaterialApp(
          home: Scaffold(body: ServerResourceLine(baseUrl: 'http://s')),
        ));

    testWidgets('renders nothing while the view is off', (tester) async {
      await pump(tester);
      expect(find.textContaining('CPU'), findsNothing);
    });

    testWidgets('shows the machine AND web-terminal\'s own footprint', (tester) async {
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(okBody()),
      );
      await pump(tester);
      // Separating the two is the point: "this box is loaded" and "MY sessions
      // are loading it" are different answers.
      expect(find.textContaining('CPU 18%'), findsOneWidget);
      // #165 — headroom leads, the percentage follows it as context.
      expect(find.textContaining('RAM 35.8 GB free of 63.8 GB (44%)'), findsOneWidget);
      expect(find.textContaining('WT 1.2% · 1.4 GB'), findsOneWidget);
    });

    // --- #165: headroom leads, pressure appears, colour keys on the absolute ------
    testWidgets('a server too old to report headroom falls back to the percentage',
        (tester) async {
      // It must never read "0 B free" for a server that simply predates the field —
      // that inverts the readout on the box the user is most likely to reach for.
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(<String, dynamic>{
          'machine': {
            'cpuPct': 18,
            'windowMs': 5000,
            'memory': {'usedBytes': 30064771072, 'totalBytes': 68501942272, 'usedPct': 44},
          },
          'sampling': {'ok': true, 'windowMs': 6000, 'ts': 2},
          'sessions': <String, dynamic>{},
        }),
      );
      await pump(tester);
      expect(find.textContaining('RAM 44%'), findsOneWidget);
      expect(find.textContaining('free'), findsNothing);
      expect(find.textContaining('0 B'), findsNothing);
    });

    testWidgets('a measured paging rate is shown; an unmeasured one is not',
        (tester) async {
      // 0/s is what a healthy box reads, so a null rate must render as nothing at all
      // rather than borrow the appearance of a calm machine.
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(okBody()),
      );
      await pump(tester);
      expect(find.textContaining('paging'), findsNothing);

      ResourceMonitor.instance.resetForTests();
      final body = okBody();
      (body['machine']! as Map<String, dynamic>)['memory'] = {
        'usedBytes': 30064771072,
        'totalBytes': 68501942272,
        'availBytes': 697932185,
        'usedPct': 98,
        'pageReadsPerSec': 951.0,
      };
      ResourceMonitor.instance.seedForTests('http://s', ServerResources.fromJson(body));
      await pump(tester);
      expect(find.textContaining('paging 951/s'), findsOneWidget);
    });

    testWidgets('a failed process query still shows the machine', (tester) async {
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(<String, dynamic>{
          'machine': {
            'cpuPct': 7,
            'windowMs': 5000,
            'memory': {'usedBytes': 1, 'totalBytes': 2, 'usedPct': 50},
          },
          'sampling': {'ok': false, 'reason': 'timeout'},
          'sessions': <String, dynamic>{},
        }),
      );
      await pump(tester);
      expect(find.textContaining('CPU 7%'), findsOneWidget);
      expect(find.textContaining('WT —'), findsOneWidget);
    });
  });

  group('ResourceMonitor', () {
    setUp(() => ResourceMonitor.instance.resetForTests());
    tearDown(() => ResourceMonitor.instance.resetForTests());

    test('is off by default — nothing is polled until asked for', () {
      expect(ResourceMonitor.instance.enabled, isFalse);
    });

    test('backgrounding stops the polling without switching the view off', () {
      // A phone in a pocket must not keep asking every server for a process
      // query — but the view has to be there, still on, when the user returns.
      ResourceMonitor.instance.seedForTests('http://s', null);
      expect(ResourceMonitor.instance.enabled, isTrue);
      ResourceMonitor.instance.stopForeground();
      expect(ResourceMonitor.instance.enabled, isTrue);
      ResourceMonitor.instance.startForeground();
      expect(ResourceMonitor.instance.enabled, isTrue);
    });

    const server = ServerConfig(name: 's', baseUrl: 'http://s', bearerToken: 't');

    test('a reading that arrives after the view is switched off is discarded', () async {
      // The race: a poll is in flight (up to 25s against a slow server), the user
      // switches the view off, the map is emptied — and then the answer lands and
      // refills it. Nothing renders, because notify is skipped while disabled, so the
      // numbers sit there invisibly and are painted as CURRENT the moment the view is
      // switched back on, however many hours later. That is precisely the frozen
      // reading the clear-on-disable exists to prevent.
      final gate = Completer<void>();
      final m = ResourceMonitor.instance;
      m.httpClientFactory = () => MockClient((_) async {
            await gate.future;
            return http.Response(jsonEncode(okBody(sessionReading: {
              'cpuPct': 15.0, 'rssBytes': 756273152, 'procCount': 9, 'topName': 'claude.exe',
            })), 200);
          });
      m.seedForTests('http://s', null);
      m.updateServers(const [server]);
      final polling = m.refresh();
      await m.setEnabled(false);
      gate.complete();
      await polling;
      expect(m['http://s'], isNull);
      expect(m.reading('http://s', 'alive'), isNull);
    });

    test('backgrounding drops the readings — an hour later they are not "current"', () {
      final m = ResourceMonitor.instance;
      m.seedForTests('http://s', ServerResources.fromJson(okBody()));
      expect(m['http://s'], isNotNull);
      m.stopForeground();
      expect(m['http://s'], isNull);
      // Still ON — the view returns with the app, it just holds no stale numbers.
      expect(m.enabled, isTrue);
    });

    test('one unreachable server does not blank the rest of the fleet', () async {
      // Future.wait fails the WHOLE wait on the first error, which would discard every
      // other server's answer and skip the notify.
      final m = ResourceMonitor.instance;
      m.httpClientFactory = () => MockClient((req) async {
            if (req.url.host == 'bad') throw Exception('unreachable');
            return http.Response(jsonEncode(okBody()), 200);
          });
      m.seedForTests('http://good', null);
      m.updateServers(const [
        ServerConfig(name: 'good', baseUrl: 'http://good', bearerToken: 't'),
        ServerConfig(name: 'bad', baseUrl: 'http://bad', bearerToken: 't'),
      ]);
      await m.refresh();
      expect(m['http://good'], isNotNull);
      expect(m['http://good']!.machine!.cpuPct, 18);
      expect(m['http://bad'], isNull);
    });

    test('reading() yields null when sampling failed, so no caller can see a 0', () {
      ResourceMonitor.instance.seedForTests(
        'http://s',
        ServerResources.fromJson(<String, dynamic>{
          'sampling': {'ok': false, 'reason': 'timeout'},
          'sessions': {'alive': {'cpuPct': 99, 'rssBytes': 1}},
        }),
      );
      expect(ResourceMonitor.instance.reading('http://s', 'alive'), isNull);
    });
  });
}
