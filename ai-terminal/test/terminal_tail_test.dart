// #194 Part 1 - the pure terminal-tail rule (terminalTailLines) and its one
// load-bearing end-to-end case: extracting a CHA-positioned, space-free dialog
// through a REAL xterm buffer must come back with readable, SPACED words.
//
// #190 established WHY this matters: Claude's folder-trust dialog writes not one
// literal space anywhere - every word is placed with CHA (ESC[<col>G). A byte
// matcher over the raw stream reads "Quicksafetycheck:Isthis..."; the xterm
// buffer has already turned that into spaced text via its cells, which is the
// entire justification for reading the BUFFER (see util/terminal_tail.dart's
// own doc) instead of raw scrollback bytes. This file proves that justification
// against a REAL Terminal, not merely asserted in a comment.
//
// EVERY non-ASCII character and every ESC below is built from a code point or
// hex escape (String.fromCharCode, \x1B), and the source file itself is kept
// ASCII-only. #190 lost four attempts to a literal non-ASCII character: it is
// invisible in a diff and gets normalised to an ordinary space in transit, and
// when that hits BOTH the fixture and the assertion together the positive case
// still passes while proving nothing. Keeping the file ASCII-only leaves
// nothing to normalise.
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/util/terminal_tail.dart';

// Built from code points, never typed - same rule as probe-trust-prompt.js and
// tests/composer-marker.spec.js (#190).
const _esc = '\x1B'; // ESC
final _caret = String.fromCharCode(0x276F); // the composer/selector cursor glyph
final _mid = String.fromCharCode(0x00B7); // middle dot, the footer's separator

void main() {
  group('terminalTailLines - the pure rule', () {
    test('fewer rows than N: returns everything non-blank', () {
      const lines = ['one', 'two'];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 4,
      );
      expect(out, ['one', 'two']);
    });

    test('all-blank buffer: empty', () {
      const lines = ['', '   ', '', '', ''];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 4,
      );
      expect(out, isEmpty);
    });

    test('trailing blanks are skipped', () {
      const lines = ['alpha', 'beta', '', '', ''];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 4,
      );
      expect(out, ['alpha', 'beta']);
    });

    test('blank rows BETWEEN content are DROPPED, not preserved', () {
      // Decision (stated in terminal_tail.dart's own doc): a fixed small
      // budget must not be spent on a separator row a TUI dialog routinely
      // draws between its question and its option list - dropping every
      // blank, not merely the trailing ones, is what keeps both the question
      // and both options inside a 4-line budget in the dialog test below.
      const lines = ['question', '', 'option1', 'option2', ''];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 4,
      );
      expect(out, ['question', 'option1', 'option2']);
    });

    test('N larger than the viewport: still just the non-blank rows, in order', () {
      const lines = ['a', 'b', 'c'];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 100,
      );
      expect(out, ['a', 'b', 'c']);
    });

    test('N caps the result to the LAST maxLines non-blank rows', () {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 2,
      );
      expect(out, ['d', 'e']);
    });

    test('trailing whitespace on a row is trimmed; leading indentation is kept', () {
      const lines = ['  indented', 'trailing   '];
      final out = terminalTailLines(
        rowCount: lines.length,
        rowText: (i) => lines[i],
        maxLines: 4,
      );
      expect(out, ['  indented', 'trailing']);
    });

    test('zero rows or zero maxLines: empty, never an error', () {
      expect(
        terminalTailLines(rowCount: 0, rowText: (i) => 'x'),
        isEmpty,
      );
      expect(
        terminalTailLines(rowCount: 3, rowText: (i) => 'x', maxLines: 0),
        isEmpty,
      );
    });
  });

  group('terminalTailLines - the trust dialog through a REAL Terminal (#190)', () {
    // The question, CHA-positioned exactly as documented
    // (scripts/rig/probe-trust-prompt.js:104) - a real fragment of the real
    // captured sentence, not the whole thing.
    final question =
        '$_esc[2GQuick$_esc[8Gsafety$_esc[15Gcheck:$_esc[22GIs$_esc[25Gthis';
    // The default row - BYTE-IDENTICAL to the TRUST_DIALOG capture in
    // tests/composer-marker.spec.js:35.
    final defaultRow =
        '$_esc[2m$_esc[38;2;177;185;249m$_caret$_esc[4GNo,$_esc[8Gexit$_esc[39m';
    // The other option, same CHA technique - CLAUDE.md documents every row of
    // this dialog being placed this way; none of them carry a literal space.
    final trustRow =
        '$_esc[4GYes,$_esc[9GI$_esc[11Gtrust$_esc[17Gthis$_esc[22Gfolder';
    final footer =
        '$_esc[2GEnter$_esc[8Gto$_esc[11Gconfirm$_esc[19G$_mid'
        '$_esc[21GEsc$_esc[25Gto$_esc[28Gcancel';
    final dialog = [question, defaultRow, trustRow, footer].join('\r\n');

    test('the fixture itself carries not one literal space - the whole premise', () {
      expect(dialog.contains(' '), isFalse);
    });

    test('reconstructs readable, SPACED words from a byte stream with none', () {
      final terminal = Terminal(maxLines: 200);
      terminal.resize(48, 8);
      terminal.write(dialog);

      final buffer = terminal.buffer;
      final tail = terminalTailLines(
        rowCount: buffer.viewHeight,
        rowText: (i) => buffer.lines[buffer.scrollBack + i].getText(),
      );
      final screen = tail.join('\n');

      // THE LOAD-BEARING ASSERTION. Red against any implementation that reads
      // raw bytes (scrollback, or an ANSI-stripped stream) instead of buffer
      // cells - see the naive comparison right below, over the exact same
      // bytes, which proves the negative half.
      expect(screen, matches(RegExp(r'Yes,\s+I\s+trust')));
      expect(screen, contains('No, exit'));
    });

    test('RED case: an ANSI-stripped read of the SAME bytes cannot match', () {
      // What GET /api/sessions/:id/scrollback - or any byte-level matcher -
      // would see: escapes stripped, columns never reconstructed. This is the
      // comparison the buffer-read design beats; if this ALSO matched the
      // spaced regex, the assertion above would be proving nothing.
      final stripped = trustRow.replaceAll(RegExp('$_esc\\[[0-9]*G'), '');
      expect(stripped, 'Yes,Itrustthisfolder');
      expect(stripped, isNot(matches(RegExp(r'Yes,\s+I\s+trust'))));
    });
  });
}
