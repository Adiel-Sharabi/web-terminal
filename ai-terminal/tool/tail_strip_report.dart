// #210 — renders the captures from `scripts/rig/probe-tail-strip.js` through the SAME
// vendored xterm the app ships, and reports the one number the fix needs:
// how far above the last non-blank row Claude's composer caret actually sits.
//
// It is a REPORT, not a test. It lives under tool/ so `flutter test` never picks it up,
// and it SKIPS rather than fails when the captures are absent — they are deliberately not
// checked in (#146: an Agent View frame names every Claude session on the machine, and
// this is a public repo; the idle frame carries a status line naming a project and a
// user). Keep the numbers, drop the bytes.
//
// Run:  node scripts/rig/rig.js up
//       node scripts/rig/probe-tail-strip.js
//       cd ai-terminal && flutter test tool/tail_strip_report.dart
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/util/terminal_tail.dart';

// Built from code points, never typed — a literal U+00A0 normalises to an ordinary space
// and would make this report quietly agree with a broken rule (#190).
//
// THIS IS THE ONE PLACE THE MARKER IS RE-STATED RATHER THAN IMPORTED, and it is worth
// saying why: the registry that owns it is JavaScript (`lib/agents.js`), and Dart cannot
// import it. The probe next door DOES import it, deliberately, so the capture side can
// never confirm itself. Here the cost is bounded — this is a dev report, ships in no
// build, and gates nothing. If it ever drifts from the registry, the numbers it prints
// stop matching the app's behaviour, which is the failure you would be looking at anyway.
// Nothing in `lib/` may copy the marker; it reads the published one from /api/agents.
final _caret = String.fromCharCode(0x276F);
final _nbsp = String.fromCharCode(0x00A0);
final _composer = RegExp('$_caret$_nbsp');

void main() {
  test('render the #210 captures and report the composer distance', () {
    // The capture directory is passed IN, never hardcoded: scripts/scratch-dirs.js is
    // its single owner and resolves differently off Windows, so a literal path here
    // would be both a second copy of that rule and a Windows-only assumption in a file
    // with no other reason to be one. probe-tail-strip.js prints the exact command.
    final capturesDir = Platform.environment['WT_TAIL_CAPTURES'] ?? '';
    if (capturesDir.isEmpty) {
      // ignore: avoid_print
      print('set WT_TAIL_CAPTURES to the directory probe-tail-strip.js printed.');
      return;
    }
    final dir = Directory(capturesDir);
    final manifest = File('$capturesDir/manifest.json');
    if (!dir.existsSync() || !manifest.existsSync()) {
      // ignore: avoid_print
      print('NO CAPTURES at $capturesDir — run scripts/rig/probe-tail-strip.js first.');
      return;
    }

    final entries = (jsonDecode(manifest.readAsStringSync()) as List)
        .cast<Map<String, dynamic>>();

    for (final e in entries) {
      final name = e['name'] as String;
      final cols = e['cols'] as int;
      final bytes = File(e['file'] as String).readAsStringSync();

      final term = Terminal(maxLines: 2000);
      term.resize(cols, 30);
      term.write(bytes);

      final buffer = term.buffer;
      final w = terminalTailWindow(
        lineCount: buffer.lines.length,
        viewHeight: buffer.viewHeight,
      );
      String row(int i) => buffer.lines[w.base + i].getText();

      // The last non-blank row's index, and the composer caret's, both in RAW rows —
      // which is what kComposerScanRows counts, blanks included.
      var lastContent = -1;
      var caretRow = -1;
      for (var i = w.rows - 1; i >= 0; i--) {
        final t = row(i);
        if (lastContent < 0 && t.trim().isNotEmpty) lastContent = i;
        if (caretRow < 0 && _composer.hasMatch(t)) caretRow = i;
      }

      final tail = terminalTailLines(rowCount: w.rows, rowText: row);
      final distance = (caretRow < 0 || lastContent < 0) ? -1 : lastContent - caretRow;

      // ignore: avoid_print
      print('''

######## $name (cols=$cols, ${bytes.length} bytes) ########
  viewHeight ............ ${buffer.viewHeight}
  last non-blank row .... $lastContent
  composer caret row .... ${caretRow < 0 ? 'ABSENT' : caretRow}
  DISTANCE (raw rows) ... ${distance < 0 ? 'n/a' : distance}
  strip tail is ......... ${tail.length} rows
  endsInComposer @ scanRows 4/6/7(default)/8/12:
    ${[4, 6, kComposerScanRows, 8, 12].map((n) => '$n=${terminalEndsInComposer(rowCount: w.rows, rowText: row, composer: _composer, scanRows: n)}').join('  ')}''');
    }
  });
}
