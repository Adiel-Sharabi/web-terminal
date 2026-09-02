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
// U+00A0 NO-BREAK SPACE. The one character that separates Claude's COMPOSER from its
// folder-trust SELECTOR, both of which draw the same U+276F caret (#190). Built from a
// code point for the reason the header states: a literal here would be normalised to an
// ordinary space, and it would take the negative assertions below down with it silently.
final _nbsp = String.fromCharCode(0x00A0);

// ---------------------------------------------------------------------------
// The real-Terminal trust-dialog fixture. At FILE scope because two groups now
// need it - #190's "can the buffer reconstruct spaced words" and #210's "does
// this screen end in a composer" - and a second copy of a byte-exact capture is
// the drift this repo keeps paying for.
// ---------------------------------------------------------------------------

// The question, CHA-positioned exactly as documented
// (scripts/rig/probe-trust-prompt.js:104) - a real fragment of the real
// captured sentence, not the whole thing.
final _question =
    '$_esc[2GQuick$_esc[8Gsafety$_esc[15Gcheck:$_esc[22GIs$_esc[25Gthis';
// The default row - BYTE-IDENTICAL to the TRUST_DIALOG capture in
// tests/composer-marker.spec.js:35. Note what it does NOT contain: a space of any
// kind after the caret. That absence is #210's whole discrimination.
final _defaultRow =
    '$_esc[2m$_esc[38;2;177;185;249m$_caret$_esc[4GNo,$_esc[8Gexit$_esc[39m';
// The other option, same CHA technique - CLAUDE.md documents every row of
// this dialog being placed this way; none of them carry a literal space.
final _trustRow =
    '$_esc[4GYes,$_esc[9GI$_esc[11Gtrust$_esc[17Gthis$_esc[22Gfolder';
final _footer =
    '$_esc[2GEnter$_esc[8Gto$_esc[11Gconfirm$_esc[19G$_mid'
    '$_esc[21GEsc$_esc[25Gto$_esc[28Gcancel';
final _dialog = [_question, _defaultRow, _trustRow, _footer].join('\r\n');

// A session that has been running for a while, which is every real one.
// WITHOUT this filler the buffer holds exactly viewHeight lines, scrollBack
// is 0, and an implementation reading `buffer.lines[i]` (the TOP of
// scrollback) passes every assertion below while showing ancient content on
// any real session. Review caught exactly that. The filler is what makes the
// indexing load-bearing.
Terminal dialogTerminal() {
  final terminal = Terminal(maxLines: 500);
  terminal.resize(48, 8);
  for (var i = 0; i < 50; i++) {
    terminal.write('scrollback filler row $i\r\n');
  }
  terminal.write(_dialog);
  return terminal;
}

List<String> tailOf(Terminal terminal) {
  final buffer = terminal.buffer;
  // The SAME rule the screen uses - not a second copy of `scrollBack + i`,
  // which is how a test comes to agree with a bug instead of catching it.
  final w = terminalTailWindow(
    lineCount: buffer.lines.length,
    viewHeight: buffer.viewHeight,
  );
  return terminalTailLines(
    rowCount: w.rows,
    rowText: (i) => buffer.lines[w.base + i].getText(),
  );
}

// Ask #210's rule about a whole Terminal, through the same window rule the screen
// uses. Mirrors tailOf so the two can never disagree about which rows are on screen.
bool endsInComposerOf(Terminal terminal, RegExp? composer, {int? scanRows}) {
  final buffer = terminal.buffer;
  final w = terminalTailWindow(
    lineCount: buffer.lines.length,
    viewHeight: buffer.viewHeight,
  );
  return terminalEndsInComposer(
    rowCount: w.rows,
    rowText: (i) => buffer.lines[w.base + i].getText(),
    composer: composer,
    scanRows: scanRows ?? kComposerScanRows,
  );
}

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

  group('terminalTailWindow - the ONE indexing rule, and the #81 clamp', () {
    test('a long buffer names the visible window, not the top of scrollback', () {
      // The case every long-lived session is in. A base-less read
      // (`buffer.lines[i]`) would name rows 0..7 -- ancient scrollback.
      final w = terminalTailWindow(lineCount: 5000, viewHeight: 24);
      expect(w.base, 4976);
      expect(w.rows, 24);
    });

    test('exactly viewHeight lines: base 0, the whole screen', () {
      final w = terminalTailWindow(lineCount: 24, viewHeight: 24);
      expect(w.base, 0);
      expect(w.rows, 24);
    });

    test('a SHORT buffer clamps smaller, never wrong', () {
      // The documented invariant says this cannot happen. It is clamped anyway
      // because the caller runs inside `Terminal.write`, where a throw kills
      // the widget subtree in release (#81) -- and this asserts the clamp
      // answers with the whole screen rather than with garbage.
      final w = terminalTailWindow(lineCount: 3, viewHeight: 24);
      expect(w.base, 0);
      expect(w.rows, 3);
    });

    test('degenerate inputs produce an empty window, never a throw', () {
      for (final w in [
        terminalTailWindow(lineCount: 0, viewHeight: 24),
        terminalTailWindow(lineCount: 24, viewHeight: 0),
        terminalTailWindow(lineCount: 0, viewHeight: 0),
      ]) {
        expect(w.base, 0);
        expect(w.rows, 0);
      }
    });

    test('every index it names is in bounds, across a wide sweep', () {
      for (var lineCount = 0; lineCount <= 60; lineCount++) {
        for (var viewHeight = 0; viewHeight <= 30; viewHeight++) {
          final w = terminalTailWindow(
              lineCount: lineCount, viewHeight: viewHeight);
          expect(w.base, greaterThanOrEqualTo(0));
          expect(w.rows, greaterThanOrEqualTo(0));
          expect(w.base + w.rows, lessThanOrEqualTo(lineCount),
              reason: 'lineCount=$lineCount viewHeight=$viewHeight');
        }
      }
    });
  });

  group('terminalTailLines - the trust dialog through a REAL Terminal (#190)', () {
    test('the fixture itself carries not one literal space - the whole premise', () {
      expect(_dialog.contains(' '), isFalse);
    });

    test('the fixture really does push the dialog past scrollBack', () {
      final buffer = dialogTerminal().buffer;
      expect(buffer.viewHeight, 8);
      expect(buffer.lines.length, greaterThan(buffer.viewHeight));
    });

    test('RED case: a BASE-LESS read returns ancient scrollback, not the dialog', () {
      // What `buffer.lines[i]` (no base) sees. If this ever matched the dialog,
      // the assertion below would be proving nothing about the indexing - which
      // was true of this file before the filler existed.
      final buffer = dialogTerminal().buffer;
      final wrong = terminalTailLines(
        rowCount: buffer.viewHeight,
        rowText: (i) => buffer.lines[i].getText(),
      ).join('\n');
      expect(wrong, contains('scrollback filler'));
      expect(wrong, isNot(contains('trust')));
    });

    test('reconstructs readable, SPACED words from a byte stream with none', () {
      final screen = tailOf(dialogTerminal()).join('\n');

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
      final stripped = _trustRow.replaceAll(RegExp('$_esc\\[[0-9]*G'), '');
      expect(stripped, 'Yes,Itrustthisfolder');
      expect(stripped, isNot(matches(RegExp(r'Yes,\s+I\s+trust'))));
    });
  });

  group('terminalEndsInComposer - #210', () {
    // EXACTLY what lib/agents.js publishes for Claude on GET /api/agents, built from
    // code points rather than typed. tests/agents-api.spec.js pins the server end of
    // this pair; if the two ever disagree, one of them is red.
    final composer = RegExp('$_caret$_nbsp');

    // An ordinary idle Claude screen: some output, then the composer box, then the
    // FIXED FOOTER that #210 is about - mode hint, status line, update notice.
    // Deliberately ASCII apart from the caret and the NBSP, so nothing else in this
    // fixture can be normalised.
    Terminal composerTerminal({int cols = 48}) {
      final terminal = Terminal(maxLines: 500);
      terminal.resize(cols, 10);
      for (var i = 0; i < 50; i++) {
        terminal.write('scrollback filler row $i\r\n');
      }
      terminal.write([
        'I have updated the file as requested.',
        '',
        '+${'-' * 30}+',
        '| $_caret$_nbsp${' ' * 27}|',
        '+${'-' * 30}+',
        '  bypass permissions on (shift+tab to cycle)',
        '  ctx:50% | 7d:2% | project | branch',
        '  Update installed - restart to apply',
      ].join('\r\n'));
      return terminal;
    }

    test('THE DEFECT: the tail of an idle screen is the footer, every time', () {
      // Not a hypothetical and not a screenshot - this is #210's report reproduced
      // from bytes. The last four non-blank rows carry no information about this
      // session at all, and the composer row itself is the FIFTH from the end, so
      // no maxLines tweak could ever have reached it.
      final tail = tailOf(composerTerminal());
      expect(tail, [
        '+${'-' * 30}+',
        '  bypass permissions on (shift+tab to cycle)',
        '  ctx:50% | 7d:2% | project | branch',
        '  Update installed - restart to apply',
      ]);
      expect(
        tail.any((l) => l.contains(_caret)),
        isFalse,
        reason: 'the composer row is already past maxLines - the rule cannot reach it',
      );
    });

    test('so the strip stays QUIET on it', () {
      expect(endsInComposerOf(composerTerminal(), composer), isTrue);
    });

    test('a WRAPPED footer still fits inside the window (#146 was a width bug)', () {
      // Review found the first version of this test decorative: it asked at 52 columns
      // against a fixture whose widest row is 44, so nothing wrapped and it could not
      // fail independently of the 48-column case.
      //
      // 40 columns DOES wrap the mode-hint row, which is what the constant's headroom is
      // for - a narrow screen spends extra rows on the same footer. The first assertion
      // proves the wrap actually happened, so the second is not passing by accident.
      final narrow = tailOf(composerTerminal(cols: 40));
      expect(
        narrow,
        isNot(equals(tailOf(composerTerminal(cols: 48)))),
        reason: 'if nothing wrapped, the assertion below tests nothing new',
      );
      expect(endsInComposerOf(composerTerminal(cols: 40), composer), isTrue);
    });

    test('THE FLAGSHIP: the trust dialog is NOT a composer, so the strip SHOWS', () {
      // The one screen this feature exists for. Same caret, no NBSP - #190's whole
      // finding, and the reason a bare U+276F could never have served here.
      expect(endsInComposerOf(dialogTerminal(), composer), isFalse);
      expect(tailOf(dialogTerminal()).join('\n'), contains('trust'));
    });

    test('LOAD-BEARING NEGATIVE: caret + ORDINARY space must not match', () {
      // If normalisation ever hits the rule and this fixture together, both become
      // ordinary spaces and every POSITIVE test above still passes while proving
      // nothing. This is the assertion that goes red instead. Do not delete it, and
      // do not "simplify" either character into a literal.
      final rows = ['agent output', '$_caret regular space, not NBSP'];
      expect(
        terminalEndsInComposer(
          rowCount: rows.length,
          rowText: (i) => rows[i],
          composer: composer,
        ),
        isFalse,
      );
    });

    test('a null marker FAILS OPEN - Codex, a plain shell, an unloaded catalogue', () {
      // The direction that matters. No marker must mean the pre-#210 behaviour
      // (show the tail), never a guess that hides a session parked on a dialog.
      expect(endsInComposerOf(composerTerminal(), null), isFalse);
    });

    test('the scan is BOUNDED, so a stale composer above a dialog cannot hide it', () {
      // Claude renders inline, not on the alternate screen (#146, measured twice), so
      // a previous frame's composer can still be on screen ABOVE a live dialog. An
      // unbounded search would find it and call the screen idle.
      final rows = <String>[
        '| $_caret$_nbsp  |', // a stale composer, far above
        for (var i = 0; i < 20; i++) 'dialog row $i',
      ];
      expect(
        terminalEndsInComposer(
          rowCount: rows.length,
          rowText: (i) => rows[i],
          composer: composer,
        ),
        isFalse,
        reason: 'row 0 is 20 rows up, well past kComposerScanRows',
      );
    });

    test('REGRESSION: trailing blank rows must not hide the composer (the rig caught this)', () {
      // The FIRST cut of this rule counted up from the viewport floor, and the rig
      // falsified it on its first run against a real screen: Claude put its content in
      // rows 0..12 of a 30-row viewport, so the caret sat at row 9 with SEVENTEEN blank
      // rows beneath the footer. No window size could reach it, and the whole rule was a
      // silent no-op that shipped no behaviour change at all.
      //
      // Every synthetic fixture in this file passed against that version, because none of
      // them had trailing blanks. That is the lesson worth keeping, not the off-by-one:
      // a screen is not the same shape as a window.
      const content = 13;
      const view = 30;
      final rows = [
        for (var i = 0; i < view; i++)
          i == 9 ? '| $_caret$_nbsp  |' : (i < content ? 'row $i' : ''),
      ];
      expect(
        terminalEndsInComposer(
          rowCount: rows.length,
          rowText: (i) => rows[i],
          composer: composer,
        ),
        isTrue,
        reason: 'the anchor is the last row WITH CONTENT, not the viewport floor',
      );
    });

    test('kComposerScanRows sits where the MEASUREMENT put it', () {
      // Pins the constant to scripts/rig/probe-tail-strip.js's numbers, rendered through
      // this app's own xterm by tool/tail_strip_report.dart. Distances, caret above the
      // last non-blank row: idle 120 cols = 3, idle 52 cols = 4, slash menu = 16,
      // Agent View = 20, /usage = no caret at all.
      //
      // The phone is the case that sets the floor - a scan of 4 is measured to MISS it -
      // and the slash menu is the case that sets the ceiling.
      bool atDistance(int d) {
        final rows = [
          for (var i = 0; i < 40; i++) i == 39 - d ? '| $_caret$_nbsp |' : 'row $i',
          for (var i = 0; i < 9; i++) '',
        ];
        return terminalEndsInComposer(
          rowCount: rows.length,
          rowText: (i) => rows[i],
          composer: composer,
        );
      }

      expect(atDistance(3), isTrue, reason: 'idle at 120 cols');
      expect(atDistance(4), isTrue, reason: 'idle at 52 cols - a phone footer is a row taller');
      expect(atDistance(5), isTrue, reason: 'headroom for a footer carrying an update notice');

      // THE BINDING CASE. A slash menu narrowed by typing (`/usa`) brings the caret back
      // down to 9 - far closer than the bare menu's 16, which is the number a first cut
      // of this constant was set against. If this ever goes true, the strip has started
      // hiding on a screen that swallows the next Enter.
      expect(atDistance(9), isFalse, reason: 'a NARROWED slash menu must keep SHOWING');
      expect(atDistance(14), isFalse, reason: 'an exact-match slash menu');
      expect(atDistance(16), isFalse, reason: 'the full slash menu');
      expect(atDistance(20), isFalse, reason: 'Agent View must keep SHOWING');

      // And the boundary itself, from both sides, so the constant cannot drift silently.
      expect(atDistance(6), isTrue);
      expect(atDistance(7), isFalse, reason: 'kComposerScanRows = 7 means distances 0..6');
    });

    test('the bound is inclusive at its edge, and excludes one row beyond it', () {
      List<String> withComposerAt(int fromBottom, int total) => [
            for (var i = 0; i < total; i++)
              i == total - 1 - fromBottom ? '| $_caret$_nbsp |' : 'row $i',
          ];
      bool ask(List<String> rows, int scan) => terminalEndsInComposer(
            rowCount: rows.length,
            rowText: (i) => rows[i],
            composer: composer,
            scanRows: scan,
          );
      expect(ask(withComposerAt(3, 30), 4), isTrue, reason: 'the last row of the scan');
      expect(ask(withComposerAt(4, 30), 4), isFalse, reason: 'one row beyond it');
    });

    test('terminalStripLines composes the two, and IS what the screen calls', () {
      // The screen must not re-derive `endsInComposer ? [] : tail` at its call site:
      // a test written against a mirrored composition passes while the screen carries
      // the bug. This asserts the composition itself.
      List<String> strip(Terminal t, RegExp? c) {
        final buffer = t.buffer;
        final w = terminalTailWindow(
          lineCount: buffer.lines.length,
          viewHeight: buffer.viewHeight,
        );
        return terminalStripLines(
          rowCount: w.rows,
          rowText: (i) => buffer.lines[w.base + i].getText(),
          composer: c,
        );
      }

      // idle composer -> nothing at all, and so no reserved height either
      expect(strip(composerTerminal(), composer), isEmpty);
      // the trust dialog -> the dialog, exactly as before #210
      expect(strip(dialogTerminal(), composer).join('\n'), contains('trust'));
      // no marker -> the pre-#210 behaviour on BOTH screens
      expect(strip(composerTerminal(), null), isNotEmpty);
      expect(strip(dialogTerminal(), null).join('\n'), contains('trust'));
    });

    test('degenerate inputs answer false, never throw', () {
      String never(int i) => throw StateError('must not be read');
      expect(
        terminalEndsInComposer(rowCount: 0, rowText: never, composer: composer),
        isFalse,
      );
      expect(
        terminalEndsInComposer(
          rowCount: 5,
          rowText: never,
          composer: composer,
          scanRows: 0,
        ),
        isFalse,
      );
    });
  });
}
