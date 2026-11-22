// Issue #486: a crash zero-filled the Windows prefs file; the plugin's
// unguarded decode then threw before runApp and the app had no window.
import 'dart:async';
import 'dart:io';

import 'package:ai_terminal/screens/startup_error_screen.dart';
import 'package:ai_terminal/services/prefs_file_guard.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_windows/path_provider_windows.dart';
import 'package:shared_preferences_windows/shared_preferences_windows.dart';

const good = '{"flutter.wt.servers":"[]","flutter.wt.termFontSize":14.0}';
const older = '{"flutter.wt.servers":"[\\"older\\"]"}';
final fixedNow = DateTime(2026, 11, 22, 12, 39, 28);

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
    expect(corruptCopies(), ['$prefsFileName.corrupt-20261122-123928']);
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
}
