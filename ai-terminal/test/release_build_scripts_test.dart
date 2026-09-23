// #278 — a release build's version comes from pubspec.yaml and nowhere else.
//
// 1.66.12+152 was built from a stale checkout whose pubspec said 1.66.9 and whose
// vendored xterm predated #237's fix. The build scripts took the version as arguments
// and passed them to --build-name/--build-number, which OVERRIDE pubspec.yaml, so the
// binary carried a label its source did not. Every device installed it and kept
// underlining every word.
//
// `scripts/release-preflight.sh` is now the one owner of that rule (version from
// pubspec, refuse a checkout behind origin/master). This test is a SOURCE gate, the
// same shape as tests/app-input-path.spec.js: no behavioural test can see a build
// script quietly growing a `--build-name` again, so it reads the scripts themselves.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _releaseScripts = ['scripts/build-windows.sh', 'scripts/build-apk.sh'];
const _preflightLine = r'source "$SRC/scripts/release-preflight.sh" "$@"';

/// Lines that are not comments, so this file's own explanation can name the flags.
Iterable<String> _codeLines(File f) => f
    .readAsLinesSync()
    .map((l) => l.trim())
    .where((l) => l.isNotEmpty && !l.startsWith('#'));

void main() {
  group('#278 release builds take their version from pubspec.yaml only', () {
    for (final path in _releaseScripts) {
      test('$path runs the shared release preflight', () {
        final f = File(path);
        expect(f.existsSync(), isTrue, reason: '$path is a release script');
        expect(_codeLines(f), contains(_preflightLine),
            reason: '$path must source the preflight, which reads the version '
                'from pubspec.yaml and refuses a checkout behind origin/master');
      });
    }

    test('no build script overrides the pubspec version', () {
      final scripts = Directory('scripts')
          .listSync()
          .whereType<File>()
          .where((f) => f.path.endsWith('.sh'));
      expect(scripts, isNotEmpty);
      for (final f in scripts) {
        for (final line in _codeLines(f)) {
          expect(line.contains('--build-name') || line.contains('--build-number'),
              isFalse,
              reason: '${f.path}: "$line" overrides pubspec.yaml, so the label '
                  'would stop proving which source was built (#278)');
        }
      }
    });

    test('the preflight refuses a checkout that is behind origin/master', () {
      final lines = _codeLines(File('scripts/release-preflight.sh')).toList();
      expect(lines.any((l) => l.contains('merge-base --is-ancestor origin/master HEAD')),
          isTrue,
          reason: 'a branch missing merged fixes is exactly what shipped #237');
      expect(lines.any((l) => l.contains(r"sed -n 's/^version:")), isTrue,
          reason: 'the version must be read from pubspec.yaml');
    });
  });
}
