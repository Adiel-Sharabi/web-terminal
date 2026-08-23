import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/resource_monitor.dart';
import 'package:ai_terminal/widgets/format_utils.dart';
import 'package:ai_terminal/widgets/resource_stats.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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
        'memory': {'usedBytes': 30064771072, 'totalBytes': 68501942272, 'usedPct': 44},
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
      expect(find.textContaining('RAM 44%'), findsOneWidget);
      expect(find.textContaining('WT 1.2% · 1.4 GB'), findsOneWidget);
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
