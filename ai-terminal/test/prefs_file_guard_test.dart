// Issue #486: a crash zero-filled the Windows prefs file; the plugin's
// unguarded decode then threw before runApp and the app had no window.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ai_terminal/app_boot.dart';
import 'package:ai_terminal/screens/startup_error_screen.dart';
import 'package:ai_terminal/services/prefs_file_guard.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_windows/path_provider_windows.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_windows/shared_preferences_windows.dart';

const good = '{"flutter.wt.servers":"[]","flutter.wt.termFontSize":14.0}';
const older = '{"flutter.wt.servers":"[\\"older\\"]"}';
final fixedNow = DateTime(2026, 11, 22, 12, 39, 28);

/// A store whose load fails, as the real one did on the zero-filled file.
class _ThrowingStore extends ServerStore {
  _ThrowingStore() : super.forTest();
  @override
  Future<void> init() async => throw const FormatException('Unexpected character');
}

/// The plugin's own path call, pointed at a temp dir.
class _TempPath extends PathProviderWindows {
  _TempPath(this.dir);
  final String dir;
  @override
  Future<String?> getApplicationSupportPath() async => dir;
}

void main() {
  late Directory dir;
  late File live;
  late File lastGood;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('prefs_guard_');
    live = File('${dir.path}${Platform.pathSeparator}$prefsFileName');
    lastGood = File('${live.path}$lastGoodSuffix');
  });
  tearDown(() => dir.deleteSync(recursive: true));

  void zeroFill(File f, [int n = 4096]) => f.writeAsBytesSync(List<int>.filled(n, 0));
  List<String> corruptCopies() => dir
      .listSync()
      .map((e) => e.path.split(Platform.pathSeparator).last)
      .where((n) => n.startsWith('$prefsFileName.corrupt-'))
      .toList();

  Future<PrefsGuardResult> guard() =>
      guardPrefsFile(dir, now: fixedNow, retryDelay: Duration.zero);

  test('zero-filled file + a last-good copy: restored, damaged file kept', () async {
    zeroFill(live);
    lastGood.writeAsStringSync(older);

    final r = await guard();

    expect(r.recovery, PrefsRecovery.restoredFromBackup);
    expect(live.readAsStringSync(), older);
    expect(corruptCopies(), ['$prefsFileName.corrupt-20261122-123928000']);
    expect(File(r.corruptCopy!).readAsBytesSync().every((b) => b == 0), isTrue);
    expect(r.message, contains('restored the copy saved'));
  });

  test('zero-filled file and no copy: starts fresh, damaged file kept', () async {
    zeroFill(live);

    final r = await guard();

    expect(r.recovery, PrefsRecovery.startedFresh);
    expect(live.existsSync(), isFalse);
    expect(corruptCopies(), hasLength(1));
    expect(r.message, contains('default settings'));
  });

  test('a damaged last-good copy is never restored', () async {
    zeroFill(live);
    zeroFill(lastGood);

    final r = await guard();

    expect(r.recovery, PrefsRecovery.startedFresh);
    expect(live.existsSync(), isFalse);
  });

  test('empty file and a non-object are damage too (the plugin would silently start empty)',
      () async {
    for (final body in ['', '[1,2]', '"x"']) {
      live.writeAsStringSync(body);
      lastGood.writeAsStringSync(older);
      final r = await guard();
      expect(r.recovery, PrefsRecovery.restoredFromBackup, reason: 'body=$body');
      for (final c in corruptCopies()) {
        File('${dir.path}${Platform.pathSeparator}$c').deleteSync();
      }
    }
  });

  test('a good file is untouched and becomes the last-good copy', () async {
    live.writeAsStringSync(good);
    lastGood.writeAsStringSync(older);

    final r = await guard();

    expect(r.recovery, PrefsRecovery.none);
    expect(r.message, isNull);
    expect(live.readAsStringSync(), good);
    expect(lastGood.readAsStringSync(), good);
    expect(corruptCopies(), isEmpty);
    expect(File('${lastGood.path}.tmp').existsSync(), isFalse);
  });

  test('no file (first run): nothing created', () async {
    final r = await guard();
    expect(r.recovery, PrefsRecovery.none);
    expect(dir.listSync(), isEmpty);
  });

  test('a file mid-write by another window is retried, not moved aside', () async {
    live.writeAsStringSync('{"flutter.wt.servers":'); // half a write
    final done = guardPrefsFile(dir,
        now: fixedNow, retryDelay: const Duration(milliseconds: 50));
    Timer(const Duration(milliseconds: 20), () => live.writeAsStringSync(good));

    final r = await done;

    expect(r.recovery, PrefsRecovery.none);
    expect(live.readAsStringSync(), good);
    expect(corruptCopies(), isEmpty);
  });

  test('a restore that cannot be staged leaves the damaged file in place (nothing lost)',
      () async {
    zeroFill(live);
    lastGood.writeAsStringSync(older);
    Directory('${live.path}.tmp').createSync(); // the staging write must fail

    await expectLater(guard(), throwsA(isA<FileSystemException>()));

    // Still damaged, so the next launch shows the error screen and retries;
    // the good copy is untouched, so a later launch can still restore it.
    expect(live.readAsBytesSync().every((b) => b == 0), isTrue);
    expect(lastGood.readAsStringSync(), older);
    expect(corruptCopies(), isEmpty);
  });

  // The guard-level test below would also pass if a locked read were judged
  // damage, because renaming a file this process holds open throws too (the
  // wrong guard firing). This one pins the predicate itself.
  test('a locked read throws instead of reading as damage', () {
    live.writeAsStringSync(good);
    final lock = live.openSync(mode: FileMode.append)..lockSync();
    try {
      expect(() => readUsablePrefs(live), throwsA(isA<FileSystemException>()));
    } finally {
      lock
        ..unlockSync()
        ..closeSync();
    }
  }, skip: Platform.isWindows ? false : 'only Windows locks block reads');

  test('a file that cannot be READ is never judged damaged', () async {
    live.writeAsStringSync(good);
    final lock = live.openSync(mode: FileMode.append)..lockSync();
    try {
      await expectLater(guard(), throwsA(isA<FileSystemException>()));
    } finally {
      lock
        ..unlockSync()
        ..closeSync();
    }
    expect(live.readAsStringSync(), good);
    expect(corruptCopies(), isEmpty);
  }, skip: Platform.isWindows ? false : 'only Windows locks block reads');

  group('the real Windows plugin', () {
    SharedPreferencesWindows plugin() =>
        SharedPreferencesWindows()..pathProvider = _TempPath(dir.path);

    test('premise: it throws on a zero-filled file', () async {
      zeroFill(live);
      await expectLater(plugin().getAll(), throwsA(isA<FormatException>()));
    });

    test('after the guard it reads the restored settings', () async {
      zeroFill(live);
      lastGood.writeAsStringSync(older);

      await guard();

      expect(await plugin().getAll(), {'flutter.wt.servers': '["older"]'});
    });
  });

  testWidgets('a startup failure draws the error instead of nothing', (t) async {
    await t.pumpWidget(const StartupErrorApp(error: FormatException('Unexpected character')));
    expect(find.text('AiTerminal could not start'), findsOneWidget);
    expect(find.textContaining('Unexpected character'), findsOneWidget);
  });

  group('bootApp - the order before the first frame', () {
    Widget real(String? notice) => Text(notice ?? 'no notice', textDirection: TextDirection.ltr);
    PrefsGuardResult nothing() => const PrefsGuardResult(PrefsRecovery.none);

    setUp(() => SharedPreferences.setMockInitialValues(const {}));

    test('the store is not even CREATED before the guard has run', () async {
      final calls = <String>[];
      await bootApp(
        guard: () async {
          calls.add('guard');
          return nothing();
        },
        store: () {
          calls.add('store');
          return ServerStore.forTest();
        },
        app: real,
      );
      expect(calls, ['guard', 'store']);
    });

    test('a store that throws draws the error screen, never nothing', () async {
      final root = await bootApp(
        guard: () async => nothing(),
        store: _ThrowingStore.new,
        app: real,
        settingsDir: () async => 'SETTINGS-DIR',
      );
      expect(root, isA<StartupErrorApp>());
      expect((root as StartupErrorApp).settingsDir, 'SETTINGS-DIR');
    });

    test('a settings folder that cannot be looked up still draws the error screen', () async {
      final root = await bootApp(
        guard: () async => nothing(),
        store: _ThrowingStore.new,
        app: real,
        settingsDir: () async => throw const FileSystemException('offline share'),
      );
      expect(root, isA<StartupErrorApp>());
      expect((root as StartupErrorApp).settingsDir, isNull);
    });

    test('a guard that throws is not fatal: the store still decides', () async {
      final root = await bootApp(
        guard: () async => throw const FileSystemException('locked'),
        store: ServerStore.forTest,
        app: real,
      );
      expect((root as Text).data, 'no notice');
    });
  });

  // The whole path on the real plugin and the real store: what a unit test of
  // each piece missed once (the store read the file before the guard ran).
  group('end to end on the real Windows plugin and ServerStore', () {
    // What the plugin writes: the key carries its `flutter.` prefix and the
    // server list is itself a JSON string.
    final savedWithServer = jsonEncode({
      'flutter.${ServerStore.storageKey}': jsonEncode([
        {'name': 'n', 'baseUrl': 'https://example.test', 'bearerToken': 't'},
      ]),
    });
    late SharedPreferencesStorePlatform before;

    setUp(() {
      before = SharedPreferencesStorePlatform.instance;
      SharedPreferencesStorePlatform.instance =
          SharedPreferencesWindows()..pathProvider = _TempPath(dir.path);
      SharedPreferences.resetStatic();
    });
    tearDown(() {
      SharedPreferencesStorePlatform.instance = before;
      SharedPreferences.resetStatic();
    });

    Widget real(String? notice) => Text(notice ?? 'no notice', textDirection: TextDirection.ltr);

    test('premise: without the guard a zero-filled file kills the load', () async {
      zeroFill(live);
      final root = await bootApp(
        guard: () async => const PrefsGuardResult(PrefsRecovery.none),
        store: ServerStore.forTest,
        app: real,
      );
      expect(root, isA<StartupErrorApp>());
    });

    test('with the guard the app starts, with its servers and the notice', () async {
      zeroFill(live);
      lastGood.writeAsStringSync(savedWithServer);
      final store = ServerStore.forTest();

      final root = await bootApp(
        guard: () => guardPrefsFile(dir, now: fixedNow, retryDelay: Duration.zero),
        store: () => store,
        app: real,
      );

      expect(root, isA<Text>());
      expect((root as Text).data, contains('restored the copy saved'));
      expect(store.servers.map((s) => s.baseUrl), ['https://example.test']);
    });
  });
}
